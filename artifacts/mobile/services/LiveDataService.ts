import type {TeamIdentityStatuses} from '../lib/teamIdentityStatus';
import { apiFetch } from '../lib/api';
/**
 * Сервис живых данных — подключает OpenDota + The Odds API + Analytics Engine.
 * Только реальные данные. Если апстрим пуст — отдаём пустой список.
 */

import type { Match, Market, Team, Prediction, BookmakerOdds } from '@/types';
import { positiveSafeId } from '../lib/matchId';
import { readLiveDataQuality, observedStateAge, matchStatePredictionEligible, liveValueComparisonAllowed } from '../lib/liveFreshness';
import type { LiveDataQuality } from '../lib/liveFreshness';



// Реальная структура OpenDota /api/live (плоская, без scoreboard)
interface OpenDotaLiveMatch {
  live_freshness?: unknown;
  match_id?: number | string;
  activate_time?: number;
  series_start_time?: string | null;
  series_identity_verified?: boolean;
  lobby_id?: string;
  league_id?: number;
  series_type?: number;
  source?: "opendota" | "pandascore";
  number_of_games?: number;
  radiant_series_wins?: number;
  dire_series_wins?: number;
  // Подмешивается на бэке (routes/matches.ts → enrichWithPandaScoreRunning):
  // true = OD держит устаревший снапшот предыдущей карты (Map уже закончилась
  // в PS, новая в драфте). UI показывает «Серия N-M, готовимся к карте X»
  // вместо фейкового live-снапшота со старыми kill'ами и таймером.
  between_maps?: boolean;
  /** Unix-timestamp (сек) окончания матча. Если установлен — матч завершён. */
  deactivate_time?: number;
  // Плоские поля (не вложенный scoreboard)
  radiant_score?: number;      // убийства Radiant
  dire_score?: number;         // убийства Dire
  radiant_lead?: number;       // преимущество по networth (>0 = radiant впереди)
  game_time?: number;          // время игры в секундах
  spectators?: number;
  building_state?: number;
  // Команды
  team_name_radiant?: string;
  team_name_dire?: string;
  team_id_radiant?: number;
  team_id_dire?: number;
  // Подмешивается на бэке (routes/matches.ts → enrichWithLeagueNames)
  league_name?: string;
  league_tier?: string;
  // Подмешивается на бэке (routes/matches.ts → enrichWithPandaScoreRunning)
  current_map?: number;    // номер текущей карты (1-based)
  ps_match_id?: number;    // ID матча в PandaScore (для букмекеров)
  // Live picks can be observed from OD players; bans/order may be unknown.
  draft?: {
    picks: Array<{ heroId: number; heroName: string; side: 'radiant' | 'dire'; order: number | null }>;
    bans: Array<{ heroId: number; heroName: string; side: 'radiant' | 'dire'; order: number | null }>;
    bansKnown?: boolean;
    orderKnown?: boolean;
    source: 'opendota';
    basis?: 'observed_live_lineup';
    fetchedAt: string;
  };
}

export interface OddsData {
  eventId: string;
  team1: string;
  team2: string;
  commenceTime: string;
  bookmakers: Array<{
    bookmakerId: string;
    bookmakerName: string;
    team1Odds: number;
    team2Odds: number;
    lastUpdate: string;
    expiresAt?: string;
    scope?: 'series' | 'map';
    mapNumber?: number;
    sourceEventId?: string;
  }>;
}

interface AnalyticsPrediction {
  betType: string;
  labelRu: string;
  probTeam1: number;
  probTeam2: number;
  confidence: number | null;
  edge: number | null;
  ev: number | null;
  generatedAt: string;
  expiresAt: string;
  modelVersion: string;
  rawProbability?: number | null;
  calibrationMethod?: string;
  provenance?: Prediction["provenance"];
  bookmakerOdds1?: number;
  bookmakerOdds2?: number;
  mainFactors: Array<{ name: string; impact: number; direction: string }>;
}

export interface EnrichedMatch {
  match: Match;
  markets: Market[];
  /**
   * Статус прогноза:
   *  - 'pending'     — обогащение ещё не запускалось (карточка-скелет)
   *  - 'ready'       — модель посчитала прогноз, markets[] заполнен
   *  - 'unavailable' — попытка была, но модель вернула null (нет данных по
   *                    команде, дим-mismatch, ML-сервис упал и т.д.).
   *                    UI должен показать «Прогноз недоступен», а НЕ 50/50.
   */
  predictionStatus: 'pending' | 'ready' | 'unavailable';
  analyticsResult?: {
    predictions: AnalyticsPrediction[];
    modelVersion: string;
    generatedAt: string;
    resolvedTeams?: {team1Id: number | null; team2Id: number | null};
    teamIdentity?: TeamIdentityStatuses;
    liveDataQuality?: LiveDataQuality;
    /** Reserved for a future measured, identity-bound quote/event alignment contract. */
    bookmakerEventAlignmentVerified?: boolean;
  };
  /**
   * Полный список букмекеров с котировками для этого матча. Передаётся
   * на экран деталей чтобы пользователь мог в попап-пикере выбрать,
   * чьи коэффициенты использовать (см. match/[id].tsx → BookmakerPicker).
   * Пустой массив = котировок нет ни от одного букмекера.
   */
  availableBookmakers: BookmakerOdds[];
  /** Preserve all scoped quotes when the selected source changes. */
  oddsData?: OddsData;
}

function formatBOFormat(seriesType?: number): Match['format'] {
  if (seriesType === 0) return 'BO1';
  if (seriesType === 1) return 'BO3';
  if (seriesType === 2) return 'BO5';
  return 'unknown';
}

function buildTeam(name: string, id: number | undefined, side: 'radiant' | 'dire', provider: 'opendota' | 'pandascore' = 'opendota'): Team {
  // Если ни OpenDota, ни локальный enrichment имени не дали — показываем
  // нейтральный «Без названия» вместо «Team Radiant»/«Team Dire», чтобы
  // пользователь не путал плейсхолдер с реальной фракционной меткой.
  const hasRealName = !!name && name.trim().length > 0;
  const displayName = hasRealName ? name : 'Без названия';
  const shortBase = hasRealName ? name.replace(/^team\s+/i, '') : (side === 'radiant' ? 'R' : 'D');
  return {
    id: id ? String(id) : `${side}_anon`,
    provider,
    openDotaId: provider === "opendota" && id && id > 0 ? id : undefined,
    name: displayName,
    shortName: shortBase.substring(0, 3).toUpperCase(),
    logoPlaceholder: (hasRealName ? name : '?').substring(0, 2).toUpperCase(),
    region: 'Unknown',
    eloRating: 1720,
    recentForm: [],
  };
}

export function openDotaToMatch(raw: OpenDotaLiveMatch, fetchedAt?: string): Match {
  const provider = raw.source === 'pandascore' || Number(raw.match_id ?? 0) < 0 ? 'pandascore' : 'opendota';
  // OD uses JSON strings for uint64 match IDs. Accept a canonical positive
  // safe integer in either representation, never a lobby ID or a PS event ID.
  const odId = provider === 'opendota' ? positiveSafeId(raw.match_id) ?? undefined : undefined;
  const liveDataQuality = provider === 'opendota' ? readLiveDataQuality(raw.live_freshness) : undefined;
  const hasSnapshot = !!odId && [raw.radiant_score,raw.dire_score,raw.radiant_lead,raw.game_time].every(v => typeof v === 'number' && Number.isFinite(v)) && raw.game_time! >= 0;
  // OpenDota /api/live uses flat fields (no nested scoreboard)
  const radiantKills = raw.radiant_score ?? 0;
  const direKills = raw.dire_score ?? 0;
  const gameSec = raw.game_time ?? 0;
  const nwLead = raw.radiant_lead ?? 0; // positive = radiant leads

  // Sanity-check: OpenDota изредка отдаёт «застрявший» снапшот предыдущего матча
  // (gameSec=0, но score=32:43, или микро-gameSec с десятками киллов). Если на
  // первой минуте (game_time<5min, включая 0) уже >30 убийств — это абсурд,
  // не отдаём liveSnapshot, чтобы UI не показывал мусорные цифры. Сам матч
  // (статус, draft) отдаём — может прийти живой snapshot на следующем 60s tick.
  const totalKills = radiantKills + direKills;
  const sanityFail = gameSec < 300 && totalKills > 30;

  const team1 = buildTeam(raw.team_name_radiant ?? '', raw.team_id_radiant, 'radiant', provider);
  const team2 = buildTeam(raw.team_name_dire ?? '', raw.team_id_dire, 'dire', provider);

  // Lineup observations do not imply measured synergy/counter scores.
  // The separate draft-score endpoint supplies any available aggregates.
  const draftFromOd = raw.draft && (raw.draft.picks.length > 0 || raw.draft.bans.length > 0)
    ? {
        picks: raw.draft.picks.map(p => ({
          heroId: String(p.heroId),
          heroName: p.heroName,
          side: p.side,
          order: p.order,
        })),
        bans: raw.draft.bans.map(b => ({
          heroId: String(b.heroId),
          heroName: b.heroName,
          side: b.side,
          order: b.order,
        })),
        bansKnown: raw.draft.bansKnown,
        orderKnown: raw.draft.orderKnown,
        radiantSynergy: null, direSynergy: null,
        radiantCounter: null, direCounter: null,
        radiantScalingScore: null, direScalingScore: null,
        radiantEarlyGameScore: null, direEarlyGameScore: null,
        comfortHeroes: [],
      }
    : undefined;

  return {
    // F5 (Phase 9): синтетический fallback должен быть НЕЧИСЛОВЫМ, иначе
    // `extractNumericMatchId` (lib/matchId.ts) пропустит его как валидный OD
    // match_id и summary-кнопка покажется для матча, для которого в БД нет
    // prematch_outcomes. Префикс `synth-` ломает строгий regex намеренно.
    id: odId ? `od_${odId}` : provider === 'pandascore' ? `pslive_${raw.ps_match_id ?? Math.abs(Number(raw.match_id ?? 0))}` : `synth-${raw.lobby_id ?? Date.now()}`,
    source: provider,
    openDotaMatchId: odId,
    liveDataQuality,
    team1,
    team2,
    team1Side: provider === 'opendota' ? 'radiant' : 'unknown',
    team2Side: provider === 'opendota' ? 'dire' : 'unknown',
    // Сначала имя лиги (если бэк обогатил), иначе fallback с ID, иначе общий «Pro Match».
    tournamentName: (raw.league_name && raw.league_name.trim().length > 0)
      ? raw.league_name.trim()
      : raw.league_id ? `Лига #${raw.league_id}` : 'Pro Match',
    tournamentTier: raw.league_tier === 'premium' ? 1 : raw.league_tier === 'professional' ? 2 : 2,
    format: provider === 'pandascore' ? upcomingFormat(raw.number_of_games) : formatBOFormat(raw.series_type),
    formatKnown: provider === 'pandascore' ? [1,3,5].includes(raw.number_of_games ?? -1) : [0,1,2].includes(raw.series_type ?? -1),
    status: raw.deactivate_time && raw.deactivate_time * 1000 < Date.now()
      ? 'finished'
      : raw.between_maps ? 'between_maps' : 'live',
    finishedAt: raw.deactivate_time && raw.deactivate_time * 1000 < Date.now()
      ? new Date(raw.deactivate_time * 1000)
      : undefined,
    currentMapNumber: raw.current_map ?? (raw.radiant_series_wins ?? 0)+(raw.dire_series_wins ?? 0)+1,
    team1MapsWon: raw.radiant_series_wins ?? 0,
    team2MapsWon: raw.dire_series_wins ?? 0,
    startTime: new Date((raw.activate_time ?? Date.now() / 1000) * 1000),
    seriesStartsAt: raw.series_identity_verified && raw.series_start_time && Number.isFinite(Date.parse(raw.series_start_time)) ? raw.series_start_time : undefined,
    isFavorite: false,
    currentMap: hasSnapshot ? {
      mapNumber: raw.current_map ?? 1,
      gameTimeSeconds: gameSec,
      score: { radiant: radiantKills, dire: direKills },
    } : undefined,
    // Если sanity-check провалился — НЕ отдаём liveSnapshot вообще.
    // OpenDota /api/live даёт только 5 реальных полей: kills, gold (через
    // radiant_lead), game_time, building_state. xp/buybacks/roshan/aegis
    // отсутствуют в источнике — ставим null, UI их скрывает.
    liveSnapshot: sanityFail || !hasSnapshot || raw.between_maps || !!raw.deactivate_time ? undefined : {
      fetchedAt: liveDataQuality?.receivedAt ?? fetchedAt,
      snapshotId: `snap_od_${raw.match_id}`,
      gameTimeSeconds: gameSec,
      radiantKills,
      direKills,
      netWorthRadiant: Math.max(0, nwLead),
      netWorthDire: Math.max(0, -nwLead),
      xpRadiant: null,
      xpDire: null,
      // The former 34-bit layout was not verified against the 32-bit GC
      // field. Do not publish guessed tower/barracks counts as observations.
      towersRadiant: null,
      towersDire: null,
      barracksRadiant: null,
      barracksDire: null,
      roshanAlive: null,
      aegisHolder: null,
      buybacksAvailableRadiant: null,
      buybacksAvailableDire: null,
      lastBigEvent: null,
      snapshotAge: observedStateAge(liveDataQuality) ?? Infinity,
      sourceId: 'opendota',
    },
    draft: draftFromOd,
  };
}

/**
 * Метки букмекеров для отображения (source id → русское/бренд-название).
 * Дублирует SOURCE_LABELS в routes/bookmakers.ts — держим синхронизированными.
 */
const BOOKMAKER_LABELS: Record<string, string> = {
  bovada: 'Bovada',
  fonbet: 'Fonbet',
  liga_stavok: 'Лига Ставок',
  pari: 'PARI',
  betboom: 'BetBoom',
  x1stavka: '1xStavka',
  olimp: 'Olimp.bet',
};

/**
 * Запрашивает кэф пары команд из BookmakerWorker in-memory кэша (без апстрим-нагрузки).
 * Возвращает OddsData-совместимый объект с winner-кэфами от всех букмекеров, у
 * которых есть данные по этой паре, или undefined если для пары ничего нет.
 */
async function fetchBookmakerForMatch(match: Match): Promise<OddsData | undefined> {
  try {
    if (!match.seriesStartsAt || !Number.isFinite(Date.parse(match.seriesStartsAt))) return undefined;
    const t1 = encodeURIComponent(match.team1.name);
    const t2 = encodeURIComponent(match.team2.name);
    const resp = await apiFetch(`/api/bookmakers/for-match?team1=${t1}&team2=${t2}&startsAt=${encodeURIComponent(match.seriesStartsAt)}`);
    if (!resp.ok) return undefined;
    const data = await resp.json();
    return bookmakerResponseToOdds(match,data);

  } catch {
    return undefined;
  }
}

export function bookmakerResponseToOdds(match: Match, data: any): OddsData | undefined {
  if (!data?.found || !Array.isArray(data.sources)) return undefined;
  const counts=new Map<string,number>();
  for(const s of data.sources) counts.set(s.source,(counts.get(s.source)??0)+1);
  const bookmakers: OddsData['bookmakers']=[];
  for(const s of data.sources){
    if(typeof s.source!=='string' || counts.get(s.source)!==1 || s.scope!=='series' || s.error || s.stale || s.unavailable)continue;
    const lastUpdate=s.receivedAt ?? s.updatedAt ?? '';
    const common={bookmakerId:s.source,bookmakerName:BOOKMAKER_LABELS[s.source]??s.source,lastUpdate,expiresAt:s.expiresAt,sourceEventId:String(s.eventId??'')};
    if(s.markets?.winner) bookmakers.push({...common,scope:'series',team1Odds:s.markets.winner.team1,team2Odds:s.markets.winner.team2});
    for(const m of s.markets?.mapWinners??[]) if(Number.isInteger(m.map)&&m.map>0)bookmakers.push({...common,scope:'map',mapNumber:m.map,team1Odds:m.team1,team2Odds:m.team2});
  }
  return bookmakers.length ? {eventId:match.id,team1:match.team1.name,team2:match.team2.name,commenceTime:match.seriesStartsAt??'',bookmakers} : undefined;
}

async function fetchAnalytics(match: Match, _odds?: OddsData, signal?: AbortSignal): Promise<EnrichedMatch['analyticsResult']> {
  // Локальный таймаут 5s + поддержка внешнего AbortSignal — чтобы один зависший
  // /predict не блокировал последовательный enrichment остальных карточек.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  try {
    const snap = match.liveSnapshot;
    // ВАЖНО: НЕ шлём 1720-stub ELO. buildTeam ставит eloRating=1720 как заглушку
    // когда у нас нет реального рейтинга. Если послать его на сервер — math-модель
    // получит elo1==elo2 и выдаст 50/50. Шлём undefined → сервер резолвит реальный
    // рейтинг из DB по teamId, либо честно отдаёт «прогноз недоступен».
    const realElo1 = match.team1.eloRating === 1720 ? undefined : match.team1.eloRating;
    const realElo2 = match.team2.eloRating === 1720 ? undefined : match.team2.eloRating;
    const body = {
      matchId: match.id,
      matchSource: match.source,
      status: match.status,
      team1: {
        name: match.team1.name,
        provider: match.team1.provider,
        elo: realElo1,
        form: match.team1.recentForm,
        // teamId — числовой OpenDota id; нужен для вызова ML-модели
        // (LightGBM v3 prematch_winner). Если id отсутствует — сервер не сможет
        // ML-предсказать и явно отдаст «прогноз недоступен» вместо math 50/50.
        teamId: /^\d+$/.test(match.team1.id) ? Number(match.team1.id) : undefined,
      },
      team2: {
        name: match.team2.name,
        provider: match.team2.provider,
        elo: realElo2,
        form: match.team2.recentForm,
        teamId: /^\d+$/.test(match.team2.id) ? Number(match.team2.id) : undefined,
      },
      format: match.formatKnown === false ? 'unknown' : match.format,
      tournamentTier: match.tournamentTier,
      // Контекст серии — счёт по картам и номер текущей карты. Без этого сервер
      // хардкодит «Победитель карты 1» даже на 3-й карте серии 1-1.
      seriesContext: {
        seriesScore1: match.team1MapsWon ?? 0,
        seriesScore2: match.team2MapsWon ?? 0,
        currentMapNumber: match.currentMapNumber ?? 1,
      },
      // ВАЖНО: stub-draft (все 8 значений = 0.5) НЕ шлём. Раньше openDotaToMatch
      // строил draftFromOd с заглушками 0.5/0.5 для synergy/counter/scaling/early —
      // и сервер, видя «есть драфт», тянул match_winner к 50/50 вместо чистого
      // elo-расчёта. Реальные эти метрики мобилка не считает (нужна hero_matchups
      // таблица на бэке), так что шлём draft только если кто-то проставил != 0.5.
      draft: (() => {
        const d = match.draft;
        if (!d || [d.radiantSynergy,d.direSynergy,d.radiantCounter,d.direCounter,d.radiantScalingScore,d.direScalingScore,d.radiantEarlyGameScore,d.direEarlyGameScore].every(v=>v==null)) return undefined;
        const allStub =
          d.radiantSynergy === 0.5 && d.direSynergy === 0.5 &&
          d.radiantCounter === 0.5 && d.direCounter === 0.5 &&
          d.radiantScalingScore === 0.5 && d.direScalingScore === 0.5 &&
          d.radiantEarlyGameScore === 0.5 && d.direEarlyGameScore === 0.5;
        if (allStub) return undefined;
        return {
          synergy1: d.radiantSynergy ?? undefined, synergy2: d.direSynergy ?? undefined,
          counter1: d.radiantCounter ?? undefined, counter2: d.direCounter ?? undefined,
          scaling1: d.radiantScalingScore ?? undefined, scaling2: d.direScalingScore ?? undefined,
          early1: d.radiantEarlyGameScore ?? undefined, early2: d.direEarlyGameScore ?? undefined,
        };
      })(),
      // Live-фичи. xp/buybacks/aegis сейчас всегда null (OD не даёт), но мы
      // оставляем поля как Optional null чтобы серверная live-модель видела
      // «фича отсутствует» вместо ложного 0. towers/barracks — РЕАЛЬНЫЕ из
      // building_state; aegis-holder остаётся null до интеграции замены источника.
      liveSnapshot: snap ? {
        netWorthLead: snap.netWorthRadiant - snap.netWorthDire,
        killsLead: snap.radiantKills - snap.direKills,
        towerLead: snap.towersRadiant != null && snap.towersDire != null ? snap.towersRadiant - snap.towersDire : null,
        barracksLost: snap.barracksRadiant != null && snap.barracksDire != null ? (6 - snap.barracksRadiant) + (6 - snap.barracksDire) : null,
        aegisHolder: snap.aegisHolder === 'radiant' ? 1 : snap.aegisHolder === 'dire' ? 2 : null,
        buybackDisadv: snap.buybacksAvailableRadiant != null && snap.buybacksAvailableDire != null
          ? Math.max(0, snap.buybacksAvailableRadiant - snap.buybacksAvailableDire)
          : null,
        gameTimeSec: snap.gameTimeSeconds,
      } : undefined,

    };

    const resp = await apiFetch(`/api/analytics/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!resp.ok) return undefined;
    const result = await resp.json() as {
      predictions: AnalyticsPrediction[];
      modelVersion: string;
      generatedAt: string;
    };
    const resolved = result as NonNullable<EnrichedMatch['analyticsResult']>;
    applyResolvedTeamIds(match,resolved.resolvedTeams);
    return resolved;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export function applyResolvedTeamIds(
  match:{team1:Pick<Team,'openDotaId'>;team2:Pick<Team,'openDotaId'>},
  resolved?:{team1Id:number|null;team2Id:number|null},
):void {
  // New backend null invalidates an old cached mapping. Missing evidence from
  // an older backend must leave the previously known provider ID unchanged.
  if(!resolved)return;
  for(const [team,key] of [[match.team1,'team1Id'],[match.team2,'team2Id']] as const) {
    if(resolved[key]===null)team.openDotaId=undefined;
    else {const id=positiveSafeId(resolved[key]);if(id!==null)team.openDotaId=id;}
  }
}

/**
 * Конвертирует raw-bookmaker'ов из OddsData в наш формат BookmakerOdds.
 * Возвращает [] если котировок нет — экран должен сам обработать пустой случай.
 */
function buildBookmakerOptions(oddsData?: OddsData, match?: Match): BookmakerOdds[] {
  if (!oddsData) return [];
  const maxAge=match?.status==='prematch' && match.startTime.getTime()>Date.now() ? 3600 : 195;
  const expires=(b:OddsData['bookmakers'][number])=>b.expiresAt?Date.parse(b.expiresAt):Math.min(Date.parse(b.lastUpdate)+maxAge*1000,maxAge===3600?match!.startTime.getTime():Infinity);
  const valid=oddsData.bookmakers.filter(b=>['series','map'].includes(b.scope??'') && (b.scope!=='map'||Number.isInteger(b.mapNumber)&&b.mapNumber!>0)
    && Number.isFinite(b.team1Odds)&&b.team1Odds>1&&Number.isFinite(b.team2Odds)&&b.team2Odds>1&&ageSeconds(b.lastUpdate)<maxAge&&expires(b)>Date.now());
  const key=(b:OddsData['bookmakers'][number])=>b.bookmakerId+'|'+b.scope+'|'+(b.mapNumber??'');
  const counts=new Map<string,number>();for(const b of valid)counts.set(key(b),(counts.get(key(b))??0)+1);
  return valid.filter(b=>counts.get(key(b))===1).map(b=>{
    const fair=(1/b.team1Odds)/(1/b.team1Odds+1/b.team2Odds);
    return {bookmakerId:b.bookmakerId,bookmakerName:b.bookmakerName,scope:b.scope,mapNumber:b.mapNumber,sourceEventId:b.sourceEventId,
      oddsTeam1:b.team1Odds,oddsTeam2:b.team2Odds,impliedProbTeam1:1/b.team1Odds,impliedProbTeam2:1/b.team2Odds,
      fairProbTeam1:fair,fairProbTeam2:1-fair,fetchedAt:b.lastUpdate,expiresAt:new Date(expires(b)).toISOString(),freshness:1,snapshotAge:ageSeconds(b.lastUpdate)};
  });
}
function bookmakerChoices(oddsData:OddsData|undefined, match:Match):BookmakerOdds[]{
  const choices=buildBookmakerOptions(oddsData,match).filter(b=>b.scope==='series'||b.mapNumber===match.currentMapNumber);
  return choices.filter((b,i)=>choices.findIndex(a=>a.bookmakerId===b.bookmakerId)===i);
}

export function ageSeconds(at?: string, now = Date.now()): number {
  const ts = at ? Date.parse(at) : NaN;
  return Number.isFinite(ts) && ts <= now + 5000 ? Math.max(0, (now - ts) / 1000) : Infinity;
}

export function findExactOdds(match: Match, events: OddsData[] = []): OddsData | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const t1=norm(match.team1.name), t2=norm(match.team2.name);
  if (!t1 || !t2 || t1 === t2) return undefined;
  const candidates = events.filter(o => {
    const same=norm(o.team1)===t1 && norm(o.team2)===t2;
    const reverse=norm(o.team2)===t1 && norm(o.team1)===t2;
    const eventTime=Date.parse(o.commenceTime);
    return (same||reverse) && Number.isFinite(eventTime) && Math.abs(eventTime-Date.parse(match.seriesStartsAt??'')) <= 2*3600000;
  });
  if(candidates.length !== 1) return undefined;
  const o=candidates[0];
  if(norm(o.team1)===t1)return o;
  return {...o,team1:o.team2,team2:o.team1,bookmakers:o.bookmakers.map(b=>({...b,team1Odds:b.team2Odds,team2Odds:b.team1Odds}))};
}

export function analyticsToMarkets(match: Match, analytics: NonNullable<EnrichedMatch['analyticsResult']>, oddsData?: OddsData, selectedBookmakerId?: string): Market[] {
  // Both list-feed quality and inference-response quality must remain eligible.
  if (!matchStatePredictionEligible(match) || (match.status === 'live' && !matchStatePredictionEligible({...match,liveDataQuality:readLiveDataQuality(analytics.liveDataQuality)}))) return [];
  const canCompareValue = match.status !== 'live' || liveValueComparisonAllowed(readLiveDataQuality(analytics.liveDataQuality), analytics.bookmakerEventAlignmentVerified);
  const seriesKnown=match.format !== 'unknown' && match.formatKnown !== false;
  const quotes=buildBookmakerOptions(oddsData,match);
  const empty: BookmakerOdds = {bookmakerId:'no_bookmaker',bookmakerName:'Нет данных',oddsTeam1:0,oddsTeam2:0,impliedProbTeam1:0,impliedProbTeam2:0,fairProbTeam1:0,fairProbTeam2:0,freshness:0,snapshotAge:Infinity};
  const mainTypes=seriesKnown ? ['match_winner','map_winner','total_kills','total_duration'] : ['map_winner','total_kills','total_duration'];
  return analytics.predictions.filter(p=>mainTypes.includes(p.betType) && Number.isFinite(p.probTeam1) && p.probTeam1>=0 && p.probTeam1<=1 && Number.isFinite(Date.parse(p.generatedAt)) && Date.parse(p.expiresAt)>Date.now()).map((p,i)=>{
    const all=quotes.filter(b=>p.betType==='match_winner' ? seriesKnown && b.scope==='series'
      : p.betType==='map_winner' ? b.scope==='map' && b.mapNumber===match.currentMapNumber : false);
    const selected=selectedBookmakerId ? all.find(b=>b.bookmakerId===selectedBookmakerId) : all[0];
    const book=selected??empty;
    const usable = book.oddsTeam1>1 && !!book.expiresAt && Date.parse(book.expiresAt)>Date.now();
    const pred: Prediction = {
      predictionId:'pred_'+match.id+'_'+p.betType,matchId:match.id,marketType:p.betType as Market['type'],marketLabel:p.labelRu,
      modelProbability:p.probTeam1,calibratedProbability:p.probTeam1,rawProbability:p.rawProbability??null,
      marketFairProbability:book.fairProbTeam1,edge:usable&&canCompareValue?p.probTeam1-book.fairProbTeam1:null,ev:usable&&canCompareValue?p.probTeam1*book.oddsTeam1-1:null,
      confidence:p.confidence,modelVersion:p.modelVersion,featureSnapshotId:'snap_'+match.id,calibrationMethod:p.calibrationMethod??'unknown',
      createdAt:new Date(p.generatedAt),expiresAt:p.expiresAt,provenance:p.provenance,freshnessScore:1,dataQualityScore:0,isStale:false,
      inputFeaturesJson:{},explanationJson:{topFactors:[],summary:p.provenance?.source==='derived'?'Расчёт из прогноза модели; качество старой модели ещё не подтверждено.':'Прогноз сохранённой модели; качество ещё не подтверждено.',confidenceBreakdown:[]},
    };
    return {id:'mkt_'+match.id+'_'+p.betType+'_'+i,matchId:match.id,type:p.betType as Market['type'],label:p.labelRu,prediction:pred,bestOdds:book,allBookmakerOdds:all};
  });
}

/**
 * Пере-собирает Market[] из уже сохранённого analyticsResult с другим
 * выбранным букмекером. Используется match/[id].tsx когда пользователь
 * меняет букмекера в попап-пикере — без повторного запроса к серверу.
 */
export function rebuildMarketsForBookmaker(
  enriched: EnrichedMatch,
  selectedBookmakerId: string,
): Market[] {
  if (!matchStatePredictionEligible(enriched.match)) return [];
  if (!enriched.analyticsResult) return enriched.markets.map(m=>({...m,
    bestOdds:{bookmakerId:'no_bookmaker',bookmakerName:'Нет данных',oddsTeam1:0,oddsTeam2:0,impliedProbTeam1:0,impliedProbTeam2:0,fairProbTeam1:0,fairProbTeam2:0,freshness:0,snapshotAge:Infinity},
    allBookmakerOdds:[],prediction:{...m.prediction,edge:null,ev:null,marketFairProbability:0}}));
  // Восстанавливаем псевдо-OddsData из сохранённого списка — чтобы переиспользовать
  // analyticsToMarkets без дублирования логики.
  const fakeOdds: OddsData = enriched.oddsData ?? {
    eventId: enriched.match.id,
    team1: enriched.match.team1.name,
    team2: enriched.match.team2.name,
    commenceTime: '',
    bookmakers: enriched.availableBookmakers.map(b => ({
      bookmakerId: b.bookmakerId,
      bookmakerName: b.bookmakerName,
      team1Odds: b.oddsTeam1,
      team2Odds: b.oddsTeam2,
      lastUpdate: b.fetchedAt ?? '',expiresAt:b.expiresAt,scope:b.scope,mapNumber:b.mapNumber,sourceEventId:b.sourceEventId,
    })),
  };
  return analyticsToMarkets(
    enriched.match,
    enriched.analyticsResult,
    fakeOdds,
    selectedBookmakerId,
  );
}

// ── Глобальный кэш матчей (matchId → EnrichedMatch) ──────────────────────
// Позволяет экрану деталей матча найти реальные данные без повторного запроса.
// Bounded LRU: 100 матчей × ~10 KB ≈ 1 MB макс. Map сохраняет порядок вставки;
// при переполнении выкидываем самые старые.
const MATCH_CACHE_MAX = 100;
const matchCache = new Map<string, EnrichedMatch>();

function cachePut(em: EnrichedMatch): void {
  if (matchCache.has(em.match.id)) matchCache.delete(em.match.id);
  matchCache.set(em.match.id, em);
  if (matchCache.size > MATCH_CACHE_MAX) {
    const oldest = matchCache.keys().next().value;
    if (oldest !== undefined) matchCache.delete(oldest);
  }
}

export function getCachedMatch(id: string): EnrichedMatch | undefined {
  const cached = matchCache.get(id);
  if (!cached) return undefined;
  const markets = cached.analyticsResult ? rebuildMarketsForBookmaker(cached, cached.markets[0]?.bestOdds.bookmakerId ?? '') : [];
  const eligible = matchStatePredictionEligible(cached.match);
  const snap = cached.match.liveSnapshot;
  return {...cached, match:{...cached.match, liveSnapshot: snap && eligible ? {...snap,snapshotAge:observedStateAge(cached.match.liveDataQuality) ?? Infinity} : undefined}, markets, predictionStatus:cached.predictionStatus==='pending'?'pending':markets.length?'ready':'unavailable'};
}

export function getCachedMarkets(matchId: string): Market[] {
  return getCachedMatch(matchId)?.markets ?? [];
}

function cacheEnriched(list: EnrichedMatch[]): void {
  list.forEach(cachePut);
}

export interface LiveDataResult {
  liveMatches: EnrichedMatch[];
  prematchMatches: EnrichedMatch[];
  noData: boolean;
  sources: string[];
  fetchedAt: string;
}

/**
 * Колбэки для прогрессивной отрисовки на экране списка:
 * — onShellsReady получает «скелеты» матчей (без markets) сразу после
 *   /api/matches/live + /api/matches/upcoming, чтобы UI показал карточки
 *   мгновенно без ожидания ML;
 * — onMatchEnriched дёргается по одному per-match в порядке списка
 *   (первый матч — первым). Гарантия: вызывается только если есть реальные
 *   live-данные (если апстрим пуст — не дёргается, всё уже в onShellsReady).
 */
export interface FetchLiveDataCallbacks {
  /** Detail reload: enrich only an exact match returned by the current feed. */
  onlyMatchId?: string;
  onShellsReady?: (partial: Omit<LiveDataResult, 'fetchedAt'> & { fetchedAt: string }) => void;
  onMatchEnriched?: (em: EnrichedMatch, index: number) => void;
  /**
   * Внешний сигнал отмены — если экран запустил новый loadData раньше, чем
   * старый успел дообогатить все матчи, передаёт сюда AbortSignal от нового
   * вызова, чтобы старый цикл не звал onMatchEnriched поверх свежих данных.
   */
  signal?: AbortSignal;
}

/** Resolve a direct URL from real feeds, without a list-screen cache dependency. */
export async function loadMatchForDetail(id: string, signal?: AbortSignal): Promise<EnrichedMatch | undefined> {
  if (!/^(?:od_|up_|pslive_)[1-9]\d*$/.test(id)) return undefined;
  const result = await fetchLiveData({onlyMatchId:id,signal});
  if (signal?.aborted) return undefined;
  const found = [...result.liveMatches,...result.prematchMatches].find(em=>em.match.id===id);
  if (!found) matchCache.delete(id);
  return found;
}

// PandaScore upcoming-объект (нужны только поля для маппинга в Match).
interface UpcomingRaw {
  id?: number | string;
  begin_at?: string | null;
  number_of_games?: number;
  opponents?: Array<{ opponent?: { id?: number; name?: string; acronym?: string | null } }>;
  league?: { id?: number; name?: string };
  serie?: { full_name?: string };
  tournament?: { name?: string };
  league_name?: string;          // подмешано бэком
  league_tier?: string;
}

function upcomingFormat(n?: number): Match['format'] {
  if (n === 1) return 'BO1';
  if (n === 3) return 'BO3';
  if (n === 5) return 'BO5';
  return 'unknown';
}

export function upcomingToMatch(raw: UpcomingRaw): Match | null {
  const team1Name = (raw.opponents?.[0]?.opponent?.name ?? '').trim();
  const team2Name = (raw.opponents?.[1]?.opponent?.name ?? '').trim();
  if (!team1Name || !team2Name) return null;

  const team1Id = raw.opponents?.[0]?.opponent?.id;
  const team2Id = raw.opponents?.[1]?.opponent?.id;
  const tournament = (raw.league_name?.trim()
    || raw.league?.name?.trim()
    || raw.serie?.full_name?.trim()
    || raw.tournament?.name?.trim()
    || 'Pro Match');
  const startMs = raw.begin_at ? Date.parse(raw.begin_at) : NaN;
  if (!Number.isFinite(startMs)) return null;

  const team1 = buildTeam(team1Name, team1Id, 'radiant', 'pandascore');
  const team2 = buildTeam(team2Name, team2Id, 'dire', 'pandascore');

  return {
    id: `up_${raw.id ?? `${team1Name}_${team2Name}_${startMs}`}`,
    team1, team2,
    source: 'pandascore',
    team1Side: 'unknown',
    team2Side: 'unknown',
    tournamentName: tournament,
    tournamentTier: raw.league_tier === 'premium' ? 1 : 2,
    format: upcomingFormat(raw.number_of_games),
    formatKnown: [1,3,5].includes(raw.number_of_games ?? -1),
    status: 'prematch',
    currentMapNumber: 1,
    team1MapsWon: 0,
    team2MapsWon: 0,
    startTime: new Date(startMs),
    seriesStartsAt: new Date(startMs).toISOString(),
    isFavorite: false,
  };
}

export async function fetchLiveData(cbs?: FetchLiveDataCallbacks): Promise<LiveDataResult> {
  const fetchedAt = new Date().toISOString();
  try {
    // 1. Fetch live + upcoming matches + odds
    const [liveResp, upcomingResp, oddsResp] = await Promise.allSettled([
      apiFetch(`/api/matches/live`, {signal:cbs?.signal}).then(r => r.json()),
      apiFetch(`/api/matches/upcoming`, {signal:cbs?.signal}).then(r => r.json()),
      apiFetch(`/api/odds/dota2`, {signal:cbs?.signal}).then(r => r.json()),
    ]);
    const upcomingData = upcomingResp.status === 'fulfilled'
      ? (upcomingResp.value as { noData: boolean; data: UpcomingRaw[] })
      : null;

    const liveData = liveResp.status === 'fulfilled' ? liveResp.value as {
      noData: boolean;
      _field_meta?: {fetchedAt?: string};
      sources: Array<{ source: string; data: OpenDotaLiveMatch[]; fetchedAt?: string }>;
    } : null;

    const oddsData = oddsResp.status === 'fulfilled' ? oddsResp.value as {
      noData: boolean;
      data: OddsData[];
    } : null;

    // Берём первый источник, у которого есть реальные данные. Сначала OpenDota
    // (полный live game state), затем PandaScore /running fallback (только
    // имена команд + турнир + счёт серии, но это уже актуальные матчи).
    const sourcesArr = liveData?.sources ?? [];
    const liveSourceWithData = sourcesArr.find(
      s => Array.isArray(s.data) && s.data.length > 0 && (s.source === 'opendota' || s.source === 'pandascore')
    );
    const rawMatches = liveSourceWithData?.data ?? [];
    const hasRealData = !liveData?.noData && Array.isArray(rawMatches) && rawMatches.length > 0;

    // 2. Convert OpenDota live data to our Match format (если есть).
    // Завершённые матчи (deactivate_time > 1ч назад) скрываем полностью.
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const matches = hasRealData
      ? (rawMatches as OpenDotaLiveMatch[]).slice(0, cbs?.onlyMatchId ? undefined : 10)
          .map(raw => openDotaToMatch({...raw, source: liveSourceWithData?.source as 'opendota' | 'pandascore'}, liveSourceWithData?.fetchedAt ?? liveData?._field_meta?.fetchedAt))
          .filter(m=>!cbs?.onlyMatchId || m.id===cbs.onlyMatchId)
          .filter(m => {
            if (m.status !== 'finished') return true;
            return m.finishedAt ? Date.now() - m.finishedAt.getTime() < ONE_HOUR_MS : true;
          })
      : [];

    // Маппим upcoming PandaScore → Match. Дедуп по парам команд против live.
    const upcomingRaws = Array.isArray(upcomingData?.data) ? upcomingData!.data : [];
    const prematchMatches: Match[] = upcomingRaws
      .map(upcomingToMatch)
      .filter((m): m is Match => m !== null)
      .filter(m=>!cbs?.onlyMatchId || m.id===cbs.onlyMatchId)
      .filter(m => !matches.some(lm => lm.team1.id === m.team1.id && lm.team2.id === m.team2.id))
      .slice(0, 30);

    // При отсутствии матчей показываем пустое состояние без демонстрационных данных.
    if (matches.length === 0 && prematchMatches.length === 0) {
      return {
        liveMatches: [],
        prematchMatches: [],
        noData: true,
        sources: [],
        fetchedAt,
      };
    }

    // Сначала отдаём «скелеты» в UI — пользователь видит реальные карточки
    // мгновенно, без ожидания ML. Прогноз догружается ниже через пул.
    const liveShells: EnrichedMatch[] = matches.map(match => ({
      match, markets: [], predictionStatus: 'pending', availableBookmakers: [],
    }));
    const prematchShells: EnrichedMatch[] = prematchMatches.map(match => ({
      match, markets: [], predictionStatus: 'pending', availableBookmakers: [],
    }));
    const sources = [
      ...(matches.length > 0 ? ['opendota'] : []),
      ...(upcomingData && !upcomingData.noData && prematchMatches.length > 0 ? ['pandascore'] : []),
      ...(oddsData?.noData === false ? ['the_odds_api'] : []),
    ];
    cacheEnriched([...liveShells, ...prematchShells]);
    cbs?.onShellsReady?.({
      liveMatches: liveShells,
      prematchMatches: prematchShells,
      noData: false,
      sources,
      fetchedAt,
    });

    // 3. Run analytics через bounded parallel pool (concurrency=3) с
    // ORDERED EMISSION: воркеры могут завершать jobs в любом порядке (быстрые
    // прематчи раньше медленного live), но `onMatchEnriched(em, i)`
    // вызывается строго в порядке index. Это сохраняет UX-инвариант
    // «первая карточка обновляется первой» даже при параллельной обработке.
    // Live идут первыми (приоритет — самый верх списка), за ними прематч
    // (отсортированы PandaScore по begin_at). Прематч-предикты кэшируются
    // на сервере 4 часа (routes/analytics.ts → PREMATCH_PREDICT_TTL_MS).
    const ENRICH_CONCURRENCY = 3;

    const findOdds = (match: Match) => findExactOdds(match, oddsData?.data);

    const enrichOne = async (match: Match): Promise<EnrichedMatch> => {
      // Между картами драфта нет, OD-снапшот устарел — модели нечего считать.
      // Сразу возвращаем «unavailable» без обращения к /predict, чтобы не жечь
      // ML и не ловить мусорные 50/50 на стейл-данных.
      if (match.status === 'between_maps') {
        const em: EnrichedMatch = {
          match, markets: [], predictionStatus: 'unavailable',
          availableBookmakers: buildBookmakerOptions(undefined),
        };
        cachePut(em);
        return em;
      }
      // Запрашиваем The Odds API и Bovada параллельно — BookmakerWorker отдаёт
      // из in-memory кэша (<5ms), поэтому параллельный fetch не добавляет latency.
      const [matchingOdds, bookmakerOdds] = await Promise.all([
        Promise.resolve(match.format === 'unknown' || match.formatKnown === false ? undefined : findOdds(match)),
        match.format === 'unknown' || match.formatKnown === false ? Promise.resolve(undefined) : fetchBookmakerForMatch(match),
      ]);
      // Предпочитаем Bovada (реально работает с Replit IP); The Odds API — fallback.
      // Quotes currently available here price the series, not an individual
      // map. Unknown BO permits stored live map predictions, not series odds.
      const effectiveOdds = match.format === 'unknown' || match.formatKnown === false ? undefined : bookmakerOdds ?? matchingOdds;
      const analyticsResult = await fetchAnalytics(match, effectiveOdds, cbs?.signal);
      const markets = analyticsResult
        ? analyticsToMarkets(match, analyticsResult, effectiveOdds)
        : [];
      const availableBookmakers = bookmakerChoices(effectiveOdds,match);
      // Прогноз считаем ready только если бэк реально вернул predictions[].
      // null analyticsResult = модель скипнула (нет команд / dim mismatch / ml-service down)
      // → UI должен показать «Прогноз недоступен», а не подсовывать 50/50.
      const predictionStatus: EnrichedMatch['predictionStatus'] =
        markets.length > 0 ? 'ready' : 'unavailable';
      const em: EnrichedMatch = { match, markets, predictionStatus, analyticsResult, availableBookmakers, oddsData:effectiveOdds };
      cachePut(em);
      return em;
    };

    type Job = { match: Match; index: number; isLive: boolean };
    const jobs: Job[] = [
      ...matches.map((m, i) => ({ match: m, index: i, isLive: true })),
      ...prematchMatches.map((m, i) => ({ match: m, index: matches.length + i, isLive: false })),
    ];

    const enrichedLive: EnrichedMatch[] = [...liveShells];
    const enrichedPrematch: EnrichedMatch[] = [...prematchShells];

    // Буфер для ordered emission: results[i] заполняется по факту завершения
    // job i; nextEmit двигается вперёд только когда results[nextEmit] готов.
    const results: (EnrichedMatch | undefined)[] = new Array(jobs.length);
    const done: boolean[] = new Array(jobs.length).fill(false);
    let nextEmit = 0;
    const tryEmit = () => {
      while (nextEmit < jobs.length && done[nextEmit]) {
        const em = results[nextEmit];
        const job = jobs[nextEmit];
        if (em && job && !cbs?.signal?.aborted) {
          cbs?.onMatchEnriched?.(em, job.index);
        }
        nextEmit++;
      }
    };

    let nextJob = 0;
    const worker = async () => {
      while (true) {
        if (cbs?.signal?.aborted) return;
        const myIdx = nextJob++;
        if (myIdx >= jobs.length) return;
        const job = jobs[myIdx];
        if (!job) continue;
        try {
          const em = await enrichOne(job.match);
          if (cbs?.signal?.aborted) return;
          if (job.isLive) enrichedLive[job.index] = em;
          else enrichedPrematch[job.index - matches.length] = em;
          results[myIdx] = em;
        } catch {
          // Один упавший /predict не валит цикл — карточка остаётся с пустым
          // markets[] и UI покажет «данные собираются». results[myIdx]
          // = undefined, в emit-цикле такой слот скипается, но nextEmit
          // продолжает двигаться, не блокируя последующих.
        } finally {
          done[myIdx] = true;
          tryEmit();
        }
      }
    };

    const workers = Array.from({ length: Math.min(ENRICH_CONCURRENCY, jobs.length) }, worker);
    await Promise.all(workers);

    return {
      liveMatches: enrichedLive,
      prematchMatches: enrichedPrematch,
      noData: false,
      sources,
      fetchedAt,
    };
  } catch {
    // Сбой источников не должен превращаться в фиктивный live-матч.
    return {
      liveMatches: [],
      prematchMatches: [],
      noData: true,
      sources: [],
      fetchedAt,
    };
  }
}
