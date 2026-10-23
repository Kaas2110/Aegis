import type {UnifiedBookmakerEvent, UnifiedMarketTotal} from '../routes/bookmakers';
import {orientWinnerOutcomes} from './BookmakerMatcher';

type ObjectValue = Record<string, any>;
const rows = (value: unknown): ObjectValue[] => Array.isArray(value) ? value.filter(v => v && typeof v === 'object') : [];
const odds = (value: unknown): number | undefined => {
  const n = Number(value); return Number.isFinite(n) && n > 1 ? n : undefined;
};
const iso = (value: unknown, seconds = false): string | null => {
  const n = Number(value) * (seconds ? 1000 : 1);
  return Number.isFinite(n) && n > 0 && n < 8.64e15 ? new Date(n).toISOString() : null;
};

/** Match outcome sides by explicit labels, never array order. */
function pairedTotals(outcomes: ObjectValue[], scope: 'series'|'map', unit: 'kills'|'minutes'|'maps', map?: number): UnifiedMarketTotal[] {
  const groups = new Map<number, {over: number[]; under: number[]}>();
  for (const o of outcomes) {
    const line = Number(o.line), price = odds(o.odds);
    if (!Number.isFinite(line) || line <= 0 || !price || !['over','under'].includes(o.side)) continue;
    const pair = groups.get(line) ?? {over: [], under: []};
    pair[o.side as 'over'|'under'].push(price); groups.set(line, pair);
  }
  return [...groups].flatMap(([line, p]) => p.over.length === 1 && p.under.length === 1
    ? [{line, over: p.over[0]!, under: p.under[0]!, scope, unit, ...(map ? {map} : {})}] : []);
}

export function parseBovada(raw: unknown, receivedAt: string): UnifiedBookmakerEvent[] {
  if (!Array.isArray(raw)) throw new Error('Bovada schema_changed: expected grouped event array');
  const result: UnifiedBookmakerEvent[] = [];
  for (const group of rows(raw)) {
    if (!Array.isArray(group.events)) throw new Error('Bovada schema_changed: missing events array');
    for (const event of rows(group.events)) {
    const isDota = rows(group.path).some(p => /\/dota-2(?:\/|$)/i.test(p.link ?? ''))
      || /\/dota-2(?:\/|$)/i.test(event.link ?? '');
    if (!isDota || !event.id || !['U','O'].includes(event.status)) continue;
    const competitors = rows(event.competitors);
    if (competitors.length !== 2 || competitors.some(c => !c.name)) continue;
    const [team1,team2] = competitors.map(c => String(c.name));
    const markets: UnifiedBookmakerEvent['markets'] = {};
    for (const display of rows(event.displayGroups)) for (const market of rows(display.markets)) {
      if (market.status !== 'O') continue;
      const outcomes = rows(market.outcomes).filter(o => o.status === 'O');
      const description = String(market.description ?? '').toLowerCase();
      const period = String(market.period?.description ?? '').toLowerCase();
      const mapMatch = /^(?:live )?map (\d+)$/.exec(period);
      const map = mapMatch ? Number(mapMatch[1]) : undefined;
      const series = /^(?:live |full )?game$/.test(period);
      if (!series && !map) continue;
      if (description === 'moneyline') {
        const labelled = outcomes.map(o => {
          const participant = o.competitorId == null ? undefined : competitors.find(c => c.id === o.competitorId);
          const label = participant?.name ?? (map ? String(o.description ?? '').replace(new RegExp(' - Map '+map+'$', 'i'),'') : o.description);
          return {...o,description:label};
        });
        const winner = orientWinnerOutcomes(labelled, team1!, team2!);
        if (winner) {
          if (map) (markets.mapWinners ??= []).push({map, ...winner});
          else markets.winner = winner;
        }
      }
      const unit = series && description === 'total' ? 'maps'
        : map && description === 'under/over kills' ? 'kills'
        : map && /^(?:under\/over|total) (?:game |map )?(?:duration|time) \(minutes\)$/.test(description) ? 'minutes' : null;
      if (unit) {
        const values = pairedTotals(outcomes.map(o => ({line: o.price?.handicap, odds: o.price?.decimal,
          side: o.type === 'O' || /^over$/i.test(o.description) ? 'over' : o.type === 'U' || /^under$/i.test(o.description) ? 'under' : ''})),
        map ? 'map' : 'series', unit, map);
        const key = unit === 'kills' ? 'totalKills' : unit === 'minutes' ? 'totalDuration' : 'totalMaps';
        (markets[key] ??= []).push(...values);
      }
      if (series && description === 'correct score') for (const o of outcomes) {
        const score = String(o.description ?? '').replace(/\s/g,'').replace(':','-');
        const price = odds(o.price?.decimal);
        if (/^\d+-\d+$/.test(score) && price) (markets.correctScore ??= []).push({score,price});
      }
    }
    if (!Object.values(markets).some(v => !Array.isArray(v) || v.length)) continue;
    result.push({source:'bovada',eventId:String(event.id),team1:team1!,team2:team2!,
      startsAt:iso(event.startTime),status:event.live === true ? 'live' : event.live === false ? 'upcoming' : 'unknown',
      scope:'series',markets,receivedAt,updatedAt:receivedAt,sourceUpdatedAt:iso(event.lastModified)});
    }
  }
  return result;
}

/** Fonbet/PARI public objectModel.factors verifies 921=P1, 923=P2.
 * Unsupported factor IDs are deliberately not interpreted as generic totals. */
export function parseFonbetLine(raw: unknown, source: 'fonbet'|'pari', receivedAt: string): UnifiedBookmakerEvent[] {
  const body = raw as ObjectValue;
  if (!body || !Array.isArray(body.events) || !Array.isArray(body.sports) || !Array.isArray(body.customFactors))
    throw new Error(`${source} schema_changed: events/sports/customFactors missing`);
  const dota = new Set(rows(body.sports).filter(s => /\bdota\s*2\b/i.test(s.name ?? '')).map(s => s.id));
  const factors = new Map(rows(body.customFactors).map(f => [f.e, rows(f.factors)]));
  const blocked = new Set(rows(body.eventBlocks).map(e => e.eventId ?? e.e ?? e.id));
  const all = rows(body.events), result: UnifiedBookmakerEvent[] = [];
  for (const event of all) {
    if (!dota.has(event.sportId) || event.level !== 1 || !event.team1 || !event.team2 || blocked.has(event.id)) continue;
    const markets: UnifiedBookmakerEvent['markets'] = {};
    const winnerOf = (id: number) => {
      const fs = factors.get(id) ?? [];
      const a = fs.filter(f => f.f === 921), b = fs.filter(f => f.f === 923);
      const p1 = odds(a[0]?.v), p2 = odds(b[0]?.v);
      return a.length === 1 && b.length === 1 && p1 && p2 ? {team1:p1,team2:p2} : undefined;
    };
    markets.winner = winnerOf(event.id);
    for (const child of all.filter(e => e.parentId === event.id && e.level === 2 && !blocked.has(e.id))) {
      const matched = /^(\d+)-(?:я|ая) карта$/i.exec(child.name ?? '') ?? /^map (\d+)$/i.exec(child.name ?? '');
      if (!matched) continue;
      const winner = winnerOf(child.id);
      if (winner) (markets.mapWinners ??= []).push({map:Number(matched[1]),...winner});
    }
    if (!markets.winner && !markets.mapWinners?.length) continue;
    result.push({source,eventId:String(event.id),team1:event.team1,team2:event.team2,
      startsAt:iso(event.startTime,true),status:event.place === 'live' ? 'live' : event.place === 'line' ? 'upcoming' : 'unknown',
      scope:'series',markets,receivedAt,updatedAt:receivedAt});
  }
  return result;
}

/** Olympic v4 public labelled outcomes, including full per-event responses. */
export function parseOlimp(raw: unknown, live: boolean, receivedAt: string): UnifiedBookmakerEvent[] {
  if (!Array.isArray(raw)) throw new Error('Olimp schema_changed: expected operation array');
  const events: ObjectValue[] = [];
  for (const operation of rows(raw)) {
    const p = operation.payload;
    if (!p || typeof operation.operationId !== 'string') throw new Error('Olimp schema_changed: missing payload');
    if (p.team1Name) events.push(p);
    for (const competition of rows(p.competitionsWithEvents)) events.push(...rows(competition.events));
  }
  return events.flatMap(event => {
    if (!/\bdota\s*2\b/i.test(event.competitionName ?? '') || event.state !== 'OPEN' || !event.team1Name || !event.team2Name || (event.parentId && event.parentId !== '0')) return [];
    const markets: UnifiedBookmakerEvent['markets'] = {};
    const groups = new Map<string,ObjectValue[]>();
    for (const outcome of rows(event.outcomes)) {
      if (!odds(outcome.probability)) continue;
      const key = `${outcome.groupName}|${outcome.marketId}`;
      const g = groups.get(key) ?? []; g.push(outcome); groups.set(key,g);
    }
    for (const group of groups.values()) {
      const first = group[0]!, title = String(first.groupName), mapMatch = /^Карта (\d+)(?::|$)/i.exec(title);
      const map = mapMatch ? Number(mapMatch[1]) : undefined;
      const winners = group.filter(o => ['П1','П2'].includes(o.shortName));
      if ((title === 'Основные' || /^Карта \d+$/.test(title)) && winners.length === 2) {
        const winner = orientWinnerOutcomes(winners.map(o => ({description:String(o.unprocessedName).replace(/^Победа\s+/i,''),price:{decimal:o.probability}})),event.team1Name,event.team2Name);
        if (winner) { if(map)(markets.mapWinners ??= []).push({map,...winner});else markets.winner=winner; }
      }
      const unit = map && /Продолжительность в мин\./i.test(title) ? 'minutes'
        : map && /^Карта \d+$/.test(title) && group.every(o => /^Тотал Карты \d+ \(/i.test(o.unprocessedName)) ? 'kills'
        : title === 'Доп. Тотал' && first.marketId === 5 ? 'maps' : null;
      if (unit) {
        const values = pairedTotals(group.map(o => ({line:o.param,odds:o.probability,
          side:/\sбол$/i.test(o.unprocessedName)?'over':/\sмен$/i.test(o.unprocessedName)?'under':''})),map?'map':'series',unit,map);
        const key=unit==='kills'?'totalKills':unit==='minutes'?'totalDuration':'totalMaps';
        (markets[key] ??= []).push(...values);
      }
      if(title==='Точный счет') for(const o of group){
        const score=String(o.unprocessedName).replace(':','-'),price=odds(o.probability);
        if(/^\d+-\d+$/.test(score)&&price)(markets.correctScore ??= []).push({score,price});
      }
    }
    if (!Object.values(markets).some(v => !Array.isArray(v) || v.length)) return [];
    return [{source:'olimp',eventId:String(event.id),team1:event.team1Name,team2:event.team2Name,
      startsAt:iso(event.startDateTime,true),status:live?'live' as const:'upcoming' as const,scope:'series' as const,
      markets,receivedAt,updatedAt:receivedAt}];
  });
}
