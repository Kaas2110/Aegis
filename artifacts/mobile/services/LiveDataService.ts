/**
 * Сервис живых данных — подключает OpenDota + The Odds API + Analytics Engine.
 * Только реальные данные. Если апстрим пуст — отдаём пустой список.
 */

import { buildFeaturedMatch } from '@/services/featuredMatch';
import type { Match, Market, Team, Prediction, BookmakerOdds } from '@/types';

const API_BASE = '/api';

// Реальная структура OpenDota /api/live (плоская, без scoreboard)
interface OpenDotaLiveMatch {
  match_id?: number;
  activate_time?: number;
  lobby_id?: string;
  league_id?: number;
  series_type?: number;
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
  // Подмешивается на бэке (routes/matches.ts → enrichLiveMatchesWithDrafts):
  // picks/bans тянутся из OD /api/matches/{id}, кешируется 60s per-match.
  draft?: {
    picks: Array<{ heroId: number; heroName: string; side: 'radiant' | 'dire'; order: number }>;
    bans: Array<{ heroId: number; heroName: string; side: 'radiant' | 'dire'; order: number }>;
    source: 'opendota';
    fetchedAt: string;
  };
}

interface OddsData {
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
  }>;
}

interface AnalyticsPrediction {
  betType: string;
  labelRu: string;
  probTeam1: number;
  probTeam2: number;
  confidence: number;
  edge: number;
  ev: number;
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
  };
  /**
   * Полный список букмекеров с котировками для этого матча. Передаётся
   * на экран деталей чтобы пользователь мог в попап-пикере выбрать,
   * чьи коэффициенты использовать (см. match/[id].tsx → BookmakerPicker).
   * Пустой массив = котировок нет ни от одного букмекера.
   */
  availableBookmakers: BookmakerOdds[];
}

function formatBOFormat(seriesType?: number): 'BO1' | 'BO3' | 'BO5' {
  if (seriesType === 0) return 'BO1';
  if (seriesType === 1) return 'BO3';
  if (seriesType === 2) return 'BO5';
  return 'BO3';
}

function buildTeam(name: string, id: number | undefined, side: 'radiant' | 'dire'): Team {
  // Если ни OpenDota, ни локальный enrichment имени не дали — показываем
  // нейтральный «Без названия» вместо «Team Radiant»/«Team Dire», чтобы
  // пользователь не путал плейсхолдер с реальной фракционной меткой.
  const hasRealName = !!name && name.trim().length > 0;
  const displayName = hasRealName ? name : 'Без названия';
  const shortBase = hasRealName ? name.replace(/^team\s+/i, '') : (side === 'radiant' ? 'R' : 'D');
  return {
    id: id ? String(id) : `${side}_anon`,
    name: displayName,
    shortName: shortBase.substring(0, 3).toUpperCase(),
    logoPlaceholder: (hasRealName ? name : '?').substring(0, 2).toUpperCase(),
    region: 'Unknown',
    eloRating: 1720,
    recentForm: [],
  };
}

// Декодер OpenDota building_state. Стандартный битовый layout Dota 2:
//   bits  0..10 (11 bits) = Radiant towers (set bit = башня стоит)
//   bits 11..21 (11 bits) = Dire towers
//   bits 22..27 (6 bits)  = Radiant barracks
//   bits 28..33 (6 bits)  = Dire barracks
// Значение 0 (или undefined) трактуем как «информации нет» → возвращаем дефолты.
function decodeBuildingState(state: number | undefined): {
  towersRadiant: number; towersDire: number;
  barracksRadiant: number; barracksDire: number;
} {
  if (!state || state <= 0) {
    return { towersRadiant: 11, towersDire: 11, barracksRadiant: 6, barracksDire: 6 };
  }
  // ВАЖНО: JS bitwise — 32-битные знаковые, shift по модулю 32, sign-extension.
  // Биты 32-33 (Dire barracks bits 4-5) и bit31 (Dire barrack bit 3) читаются
  // с ошибкой через `state >> i`. Используем BigInt + Math.floor/(2**i) делением.
  const s = BigInt(state);
  const bitSet = (i: number): number => Number((s >> BigInt(i)) & 1n);
  let tR = 0, tD = 0, bR = 0, bD = 0;
  for (let i = 0;  i < 11; i++) tR += bitSet(i);
  for (let i = 11; i < 22; i++) tD += bitSet(i);
  for (let i = 22; i < 28; i++) bR += bitSet(i);
  for (let i = 28; i < 34; i++) bD += bitSet(i);
  return { towersRadiant: tR, towersDire: tD, barracksRadiant: bR, barracksDire: bD };
}

function openDotaToMatch(raw: OpenDotaLiveMatch): Match {
  // OpenDota /api/live uses flat fields (no nested scoreboard)
  const radiantKills = raw.radiant_score ?? 0;
  const direKills = raw.dire_score ?? 0;
  const gameSec = raw.game_time ?? 0;
  const nwLead = raw.radiant_lead ?? 0; // positive = radiant leads
  const buildings = decodeBuildingState(raw.building_state);

  // Sanity-check: OpenDota изредка отдаёт «застрявший» снапшот предыдущего матча
  // (gameSec=0, но score=32:43, или микро-gameSec с десятками киллов). Если на
  // первой минуте (game_time<5min, включая 0) уже >30 убийств — это абсурд,
  // не отдаём liveSnapshot, чтобы UI не показывал мусорные цифры. Сам матч
  // (статус, draft) отдаём — может прийти живой snapshot на следующем 60s tick.
  const totalKills = radiantKills + direKills;
  const sanityFail = gameSec < 300 && totalKills > 30;

  const team1 = buildTeam(raw.team_name_radiant ?? '', raw.team_id_radiant, 'radiant');
  const team2 = buildTeam(raw.team_name_dire ?? '', raw.team_id_dire, 'dire');

  // Если бэк подмешал picks/bans (раздельно по сторонам) — собираем Draft
  // объект с дефолтными scoreами 0.5: реальные synergy/counter считаются на
  // бэкенде в /api/analytics/explain, здесь нам важен сам список героев.
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
        radiantSynergy: 0.5, direSynergy: 0.5,
        radiantCounter: 0.5, direCounter: 0.5,
        radiantScalingScore: 0.5, direScalingScore: 0.5,
        radiantEarlyGameScore: 0.5, direEarlyGameScore: 0.5,
        comfortHeroes: [],
      }
    : undefined;

  return {
    id: `od_${raw.match_id ?? raw.lobby_id ?? Date.now()}`,
    team1,
    team2,
    team1Side: 'radiant',
    team2Side: 'dire',
    // Сначала имя лиги (если бэк обогатил), иначе fallback с ID, иначе общий «Pro Match».
    tournamentName: (raw.league_name && raw.league_name.trim().length > 0)
      ? raw.league_name.trim()
      : raw.league_id ? `Лига #${raw.league_id}` : 'Pro Match',
    tournamentTier: raw.league_tier === 'premium' ? 1 : raw.league_tier === 'professional' ? 2 : 2,
    format: formatBOFormat(raw.series_type),
    status: raw.deactivate_time && raw.deactivate_time * 1000 < Date.now()
      ? 'finished'
      : raw.between_maps ? 'between_maps' : 'live',
    finishedAt: raw.deactivate_time && raw.deactivate_time * 1000 < Date.now()
      ? new Date(raw.deactivate_time * 1000)
      : undefined,
    currentMapNumber: raw.current_map ?? 1,
    team1MapsWon: raw.radiant_series_wins ?? 0,
    team2MapsWon: raw.dire_series_wins ?? 0,
    startTime: new Date((raw.activate_time ?? Date.now() / 1000) * 1000),
    isFavorite: false,
    currentMap: {
      mapNumber: raw.current_map ?? 1,
      gameTimeSeconds: gameSec,
      score: { radiant: radiantKills, dire: direKills },
    },
    // Если sanity-check провалился — НЕ отдаём liveSnapshot вообще.
    // OpenDota /api/live даёт только 5 реальных полей: kills, gold (через
    // radiant_lead), game_time, building_state. xp/buybacks/roshan/aegis
    // отсутствуют в источнике — ставим null, UI их скрывает.
    liveSnapshot: sanityFail ? undefined : {
      snapshotId: `snap_od_${raw.match_id}`,
      gameTimeSeconds: gameSec,
      radiantKills,
      direKills,
      netWorthRadiant: 30000 + Math.max(0, nwLead),
      netWorthDire: 30000 + Math.max(0, -nwLead),
      xpRadiant: null,
      xpDire: null,
      towersRadiant: buildings.towersRadiant,
      towersDire: buildings.towersDire,
      barracksRadiant: buildings.barracksRadiant,
      barracksDire: buildings.barracksDire,
      roshanAlive: null,
      aegisHolder: null,
      buybacksAvailableRadiant: null,
      buybacksAvailableDire: null,
      lastBigEvent: null,
      snapshotAge: 15,
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
    const t1 = encodeURIComponent(match.team1.name);
    const t2 = encodeURIComponent(match.team2.name);
    const resp = await fetch(`${API_BASE}/bookmakers/for-match?team1=${t1}&team2=${t2}`);
    if (!resp.ok) return undefined;
    const data = await resp.json() as {
      found: boolean;
      sources: Array<{
        source: string;
        markets: { winner?: { team1: number; team2: number } };
      }>;
    };
    if (!data.found || !data.sources.length) return undefined;
    const bookmakers = data.sources
      .filter(s => s.markets.winner?.team1 && s.markets.winner?.team2)
      .map(s => ({
        bookmakerId: s.source,
        bookmakerName: BOOKMAKER_LABELS[s.source] ?? s.source,
        team1Odds: s.markets.winner!.team1,
        team2Odds: s.markets.winner!.team2,
        lastUpdate: '',
      }));
    if (!bookmakers.length) return undefined;
    return { eventId: match.id, team1: match.team1.name, team2: match.team2.name, commenceTime: '', bookmakers };
  } catch {
    return undefined;
  }
}

async function fetchAnalytics(match: Match, odds?: OddsData, signal?: AbortSignal): Promise<EnrichedMatch['analyticsResult']> {
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
      team1: {
        name: match.team1.name,
        elo: realElo1,
        form: match.team1.recentForm,
        // teamId — числовой OpenDota id; нужен для вызова ML-модели
        // (LightGBM v3 prematch_winner). Если id отсутствует — сервер не сможет
        // ML-предсказать и явно отдаст «прогноз недоступен» вместо math 50/50.
        teamId: /^\d+$/.test(match.team1.id) ? Number(match.team1.id) : undefined,
      },
      team2: {
        name: match.team2.name,
        elo: realElo2,
        form: match.team2.recentForm,
        teamId: /^\d+$/.test(match.team2.id) ? Number(match.team2.id) : undefined,
      },
      format: match.format,
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
        if (!d) return undefined;
        const allStub =
          d.radiantSynergy === 0.5 && d.direSynergy === 0.5 &&
          d.radiantCounter === 0.5 && d.direCounter === 0.5 &&
          d.radiantScalingScore === 0.5 && d.direScalingScore === 0.5 &&
          d.radiantEarlyGameScore === 0.5 && d.direEarlyGameScore === 0.5;
        if (allStub) return undefined;
        return {
          synergy1: d.radiantSynergy, synergy2: d.direSynergy,
          counter1: d.radiantCounter, counter2: d.direCounter,
          scaling1: d.radiantScalingScore, scaling2: d.direScalingScore,
          early1: d.radiantEarlyGameScore, early2: d.direEarlyGameScore,
        };
      })(),
      // Live-фичи. xp/buybacks/aegis сейчас всегда null (OD не даёт), но мы
      // оставляем поля как Optional null чтобы серверная live-модель видела
      // «фича отсутствует» вместо ложного 0. towers/barracks — РЕАЛЬНЫЕ из
      // building_state; aegis-holder остаётся null до интеграции замены источника.
      liveSnapshot: snap ? {
        netWorthLead: snap.netWorthRadiant - snap.netWorthDire,
        killsLead: snap.radiantKills - snap.direKills,
        towerLead: snap.towersRadiant - snap.towersDire,
        barracksLost: (6 - snap.barracksRadiant) + (6 - snap.barracksDire),
        aegisHolder: snap.aegisHolder === 'radiant' ? 1 : snap.aegisHolder === 'dire' ? 2 : null,
        buybackDisadv: snap.buybacksAvailableRadiant != null && snap.buybacksAvailableDire != null
          ? Math.max(0, snap.buybacksAvailableRadiant - snap.buybacksAvailableDire)
          : null,
        gameTimeSec: snap.gameTimeSeconds,
      } : undefined,
      bookmakerOdds: odds?.bookmakers[0] ? {
        odds1: odds.bookmakers[0].team1Odds,
        odds2: odds.bookmakers[0].team2Odds,
      } : undefined,
    };

    const resp = await fetch(`${API_BASE}/analytics/predict`, {
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
    return result;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Конвертирует raw-bookmaker'ов из OddsData в наш формат BookmakerOdds.
 * Возвращает [] если котировок нет — экран должен сам обработать пустой случай.
 */
function buildBookmakerOptions(oddsData?: OddsData): BookmakerOdds[] {
  if (!oddsData || oddsData.bookmakers.length === 0) return [];
  return oddsData.bookmakers.map(bk => {
    const o1 = bk.team1Odds;
    const o2 = bk.team2Odds;
    const fairProb1 = (1 / o1) / (1 / o1 + 1 / o2);
    return {
      bookmakerId: bk.bookmakerId,
      bookmakerName: bk.bookmakerName,
      oddsTeam1: o1,
      oddsTeam2: o2,
      impliedProbTeam1: 1 / o1,
      impliedProbTeam2: 1 / o2,
      fairProbTeam1: fairProb1,
      fairProbTeam2: 1 - fairProb1,
      freshness: 0.9,
      snapshotAge: 30,
    };
  });
}

function analyticsToMarkets(
  match: Match,
  analytics: NonNullable<EnrichedMatch['analyticsResult']>,
  oddsData?: OddsData,
  selectedBookmakerId?: string,
): Market[] {
  const allBookmakers = buildBookmakerOptions(oddsData);
  const selectedBk =
    allBookmakers.find(b => b.bookmakerId === selectedBookmakerId) ??
    allBookmakers[0];

  const hasBk = !!selectedBk;
  const odds1 = selectedBk?.oddsTeam1 ?? 0;
  const odds2 = selectedBk?.oddsTeam2 ?? 0;
  const fairProb1 = selectedBk?.fairProbTeam1 ?? 0;

  // Если букмекеров нет — placeholder с нулевыми кэфами. UI знает, что это
  // «нет данных от букмекера» (bookmakerId='no_bookmaker', odds=0) и не
  // показывает производные метрики edge/EV. Никаких синтетических 2.0/2.0,
  // которые бы выглядели как реальные котировки.
  const bookOdds = (): BookmakerOdds => selectedBk ?? {
    bookmakerId: 'no_bookmaker',
    bookmakerName: 'Нет данных',
    oddsTeam1: 0,
    oddsTeam2: 0,
    impliedProbTeam1: 0,
    impliedProbTeam2: 0,
    fairProbTeam1: 0,
    fairProbTeam2: 0,
    freshness: 0,
    snapshotAge: 0,
  };

  const mainTypes = ['match_winner', 'map_winner', 'total_kills', 'total_duration'];

  return analytics.predictions
    .filter(p => mainTypes.includes(p.betType))
    .map((p, i): Market => {
      const pred: Prediction = {
        predictionId: `pred_${match.id}_${p.betType}`,
        matchId: match.id,
        marketType: p.betType as Market['type'],
        marketLabel: p.labelRu,
        modelProbability: p.probTeam1,
        calibratedProbability: p.probTeam1 * 0.98,
        marketFairProbability: fairProb1,
        rawProbability: p.probTeam1,
        // Edge/EV считаем локально под выбранного букмекера. Если букмекера
        // нет совсем (hasBk=false) — обнуляем: считать «преимущество» против
        // несуществующего рынка нечестно и вводит в заблуждение.
        edge: hasBk ? p.probTeam1 - fairProb1 : 0,
        ev: hasBk ? p.probTeam1 * (odds1 - 1) - (1 - p.probTeam1) : 0,
        confidence: p.confidence,
        modelVersion: analytics.modelVersion,
        featureSnapshotId: `snap_${match.id}`,
        calibrationMethod: 'none',
        createdAt: new Date(analytics.generatedAt),
        freshnessScore: 0.9,
        dataQualityScore: 0.85,
        isStale: false,
        inputFeaturesJson: {},
        explanationJson: {
          topFactors: (p.mainFactors ?? []).map(f => ({
            factor: f.name,
            impact: f.impact,
            description: `${f.name}: влияние на прогноз`,
          })),
          summary: `Модель вычислила вероятность ${Math.round(p.probTeam1 * 100)}% для ${match.team1.name}`,
          confidenceBreakdown: [
            { component: 'ELO', score: 0.6 },
            { component: 'Форма', score: p.confidence },
          ],
        },
      };

      return {
        id: `mkt_${match.id}_${p.betType}_${i}`,
        matchId: match.id,
        type: p.betType as Market['type'],
        label: p.labelRu,
        prediction: pred,
        bestOdds: bookOdds(),
        // В allBookmakerOdds пишем ВСЕХ доступных букмекеров — чтобы экран
        // сравнения и пикер на match-detail могли показать полный список.
        allBookmakerOdds: allBookmakers.length > 0 ? allBookmakers : [bookOdds()],
      };
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
  if (!enriched.analyticsResult) return enriched.markets;
  // Восстанавливаем псевдо-OddsData из сохранённого списка — чтобы переиспользовать
  // analyticsToMarkets без дублирования логики.
  const fakeOdds: OddsData = {
    eventId: enriched.match.id,
    team1: enriched.match.team1.name,
    team2: enriched.match.team2.name,
    commenceTime: '',
    bookmakers: enriched.availableBookmakers.map(b => ({
      bookmakerId: b.bookmakerId,
      bookmakerName: b.bookmakerName,
      team1Odds: b.oddsTeam1,
      team2Odds: b.oddsTeam2,
      lastUpdate: '',
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
  return matchCache.get(id);
}

export function getCachedMarkets(matchId: string): Market[] {
  return matchCache.get(matchId)?.markets ?? [];
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
  onShellsReady?: (partial: Omit<LiveDataResult, 'fetchedAt'> & { fetchedAt: string }) => void;
  onMatchEnriched?: (em: EnrichedMatch, index: number) => void;
  /**
   * Внешний сигнал отмены — если экран запустил новый loadData раньше, чем
   * старый успел дообогатить все матчи, передаёт сюда AbortSignal от нового
   * вызова, чтобы старый цикл не звал onMatchEnriched поверх свежих данных.
   */
  signal?: AbortSignal;
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

function upcomingFormat(n?: number): 'BO1' | 'BO3' | 'BO5' {
  if (n === 1) return 'BO1';
  if (n === 3) return 'BO3';
  if (n === 5) return 'BO5';
  return 'BO3';
}

function upcomingToMatch(raw: UpcomingRaw): Match | null {
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

  const team1 = buildTeam(team1Name, team1Id, 'radiant');
  const team2 = buildTeam(team2Name, team2Id, 'dire');

  return {
    id: `up_${raw.id ?? `${team1Name}_${team2Name}_${startMs}`}`,
    team1, team2,
    team1Side: 'radiant',
    team2Side: 'dire',
    tournamentName: tournament,
    tournamentTier: raw.league_tier === 'premium' ? 1 : 2,
    format: upcomingFormat(raw.number_of_games),
    status: 'prematch',
    currentMapNumber: 1,
    team1MapsWon: 0,
    team2MapsWon: 0,
    startTime: new Date(startMs),
    isFavorite: false,
  };
}

export async function fetchLiveData(cbs?: FetchLiveDataCallbacks): Promise<LiveDataResult> {
  const fetchedAt = new Date().toISOString();
  // Featured-матч запрашиваем параллельно — используется только как fallback
  // когда OpenDota /api/live вернул пустой массив (нет реальных live-матчей).
  // Когда реальные данные есть, featured не добавляется, чтобы не показывать
  // замороженный снапшот рядом с актуальными live-данными.
  const featuredPromise = buildFeaturedMatch().catch(() => null);
  try {
    // 1. Fetch live + upcoming matches + odds
    const [liveResp, upcomingResp, oddsResp] = await Promise.allSettled([
      fetch(`${API_BASE}/matches/live`).then(r => r.json()),
      fetch(`${API_BASE}/matches/upcoming`).then(r => r.json()),
      fetch(`${API_BASE}/odds/dota2`).then(r => r.json()),
    ]);
    const upcomingData = upcomingResp.status === 'fulfilled'
      ? (upcomingResp.value as { noData: boolean; data: UpcomingRaw[] })
      : null;

    const liveData = liveResp.status === 'fulfilled' ? liveResp.value as {
      noData: boolean;
      sources: Array<{ source: string; data: OpenDotaLiveMatch[] }>;
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
      ? (rawMatches as OpenDotaLiveMatch[]).slice(0, 10)
          .map(openDotaToMatch)
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
      .filter(m => !matches.some(lm => lm.team1.id === m.team1.id && lm.team2.id === m.team2.id))
      .slice(0, 30);

    // Если нет ни live, ни прематчей — показываем featured как fallback,
    // чтобы экран не был пустым.
    if (matches.length === 0 && prematchMatches.length === 0) {
      const featured = await featuredPromise;
      const liveList: EnrichedMatch[] = featured ? [featured] : [];
      cacheEnriched(liveList);
      return {
        liveMatches: liveList,
        prematchMatches: [],
        noData: liveList.length === 0,
        sources: featured ? ['featured'] : [],
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

    const findOdds = (match: Match) => oddsData?.data?.find(o =>
      o.team1.toLowerCase().includes(match.team1.name.toLowerCase().split(' ')[1] ?? '') ||
      o.team2.toLowerCase().includes(match.team2.name.toLowerCase().split(' ')[1] ?? '')
    );

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
        Promise.resolve(findOdds(match)),
        fetchBookmakerForMatch(match),
      ]);
      // Предпочитаем Bovada (реально работает с Replit IP); The Odds API — fallback.
      const effectiveOdds = bookmakerOdds ?? matchingOdds;
      const analyticsResult = await fetchAnalytics(match, effectiveOdds, cbs?.signal);
      const markets = analyticsResult
        ? analyticsToMarkets(match, analyticsResult, effectiveOdds)
        : [];
      const availableBookmakers = buildBookmakerOptions(effectiveOdds);
      // Прогноз считаем ready только если бэк реально вернул predictions[].
      // null analyticsResult = модель скипнула (нет команд / dim mismatch / ml-service down)
      // → UI должен показать «Прогноз недоступен», а не подсовывать 50/50.
      const predictionStatus: EnrichedMatch['predictionStatus'] =
        analyticsResult && analyticsResult.predictions.length > 0 ? 'ready' : 'unavailable';
      const em: EnrichedMatch = { match, markets, predictionStatus, analyticsResult, availableBookmakers };
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
    // Полный отказ сети — показываем только featured если он есть.
    const featured = await featuredPromise;
    const liveList: EnrichedMatch[] = featured ? [featured] : [];
    cacheEnriched(liveList);
    return {
      liveMatches: liveList,
      prematchMatches: [],
      noData: liveList.length === 0,
      sources: featured ? ['featured'] : [],
      fetchedAt,
    };
  }
}
