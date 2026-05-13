/**
 * Сервис живых данных — подключает OpenDota + The Odds API + Analytics Engine.
 * При доступности — использует реальные данные. Fallback — mock.
 */

import { MOCK_MATCHES, buildMockMarkets } from '@/services/mock/mockData';
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
  dataSource: 'real' | 'mock';
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

function openDotaToMatch(raw: OpenDotaLiveMatch): Match {
  // OpenDota /api/live uses flat fields (no nested scoreboard)
  const radiantKills = raw.radiant_score ?? 0;
  const direKills = raw.dire_score ?? 0;
  const gameSec = raw.game_time ?? 0;
  const nwLead = raw.radiant_lead ?? 0; // positive = radiant leads

  const team1 = buildTeam(raw.team_name_radiant ?? '', raw.team_id_radiant, 'radiant');
  const team2 = buildTeam(raw.team_name_dire ?? '', raw.team_id_dire, 'dire');

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
    status: 'live',
    currentMapNumber: 1,
    team1MapsWon: raw.radiant_series_wins ?? 0,
    team2MapsWon: raw.dire_series_wins ?? 0,
    startTime: new Date((raw.activate_time ?? Date.now() / 1000) * 1000),
    isFavorite: false,
    currentMap: {
      mapNumber: 1,
      gameTimeSeconds: gameSec,
      score: { radiant: radiantKills, dire: direKills },
    },
    liveSnapshot: {
      snapshotId: `snap_od_${raw.match_id}`,
      gameTimeSeconds: gameSec,
      radiantKills,
      direKills,
      netWorthRadiant: 30000 + Math.max(0, nwLead),
      netWorthDire: 30000 + Math.max(0, -nwLead),
      xpRadiant: 0,
      xpDire: 0,
      towersRadiant: 7,
      towersDire: 7,
      barracksRadiant: 6,
      barracksDire: 6,
      roshanAlive: false,
      aegisHolder: null,
      buybacksAvailableRadiant: 5,
      buybacksAvailableDire: 5,
      lastBigEvent: null,
      snapshotAge: 15,
      sourceId: 'opendota',
    },
  };
}

async function fetchAnalytics(match: Match, odds?: OddsData): Promise<EnrichedMatch['analyticsResult']> {
  try {
    const snap = match.liveSnapshot;
    const body = {
      matchId: match.id,
      team1: { name: match.team1.name, elo: match.team1.eloRating, form: match.team1.recentForm },
      team2: { name: match.team2.name, elo: match.team2.eloRating, form: match.team2.recentForm },
      format: match.format,
      tournamentTier: match.tournamentTier,
      draft: match.draft ? {
        synergy1: match.draft.radiantSynergy, synergy2: match.draft.direSynergy,
        counter1: match.draft.radiantCounter, counter2: match.draft.direCounter,
        scaling1: match.draft.radiantScalingScore, scaling2: match.draft.direScalingScore,
        early1: match.draft.radiantEarlyGameScore, early2: match.draft.direEarlyGameScore,
      } : undefined,
      liveSnapshot: snap ? {
        netWorthLead: snap.netWorthRadiant - snap.netWorthDire,
        killsLead: snap.radiantKills - snap.direKills,
        towerLead: snap.towersRadiant - snap.towersDire,
        barracksLost: (6 - snap.barracksRadiant) + (6 - snap.barracksDire),
        aegisHolder: snap.aegisHolder === 'radiant' ? 1 : snap.aegisHolder === 'dire' ? 2 : null,
        buybackDisadv: Math.max(0, snap.buybacksAvailableRadiant - snap.buybacksAvailableDire),
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
      isMock: false,
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

  const odds1 = selectedBk?.oddsTeam1 ?? 2.0;
  const odds2 = selectedBk?.oddsTeam2 ?? 2.0;
  const fairProb1 = selectedBk?.fairProbTeam1 ?? 0.5;
  const isMock = !selectedBk;

  const bookOdds = (): BookmakerOdds => selectedBk ?? {
    bookmakerId: 'mock',
    bookmakerName: 'Нет данных',
    isMock,
    oddsTeam1: odds1,
    oddsTeam2: odds2,
    impliedProbTeam1: 1 / odds1,
    impliedProbTeam2: 1 / odds2,
    fairProbTeam1: fairProb1,
    fairProbTeam2: 1 - fairProb1,
    freshness: 0.9,
    snapshotAge: 30,
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
        // Edge/EV ВСЕГДА считаем локально под выбранного букмекера —
        // p.edge/p.ev с сервера соответствуют только первому букмекеру и
        // становятся некорректны при переключении в пикере.
        edge: p.probTeam1 - fairProb1,
        ev: p.probTeam1 * (odds1 - 1) - (1 - p.probTeam1),
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
const matchCache = new Map<string, EnrichedMatch>();

export function getCachedMatch(id: string): EnrichedMatch | undefined {
  return matchCache.get(id);
}

export function getCachedMarkets(matchId: string): Market[] {
  return matchCache.get(matchId)?.markets ?? [];
}

function cacheEnriched(list: EnrichedMatch[]): void {
  list.forEach(e => matchCache.set(e.match.id, e));
}

export interface LiveDataResult {
  liveMatches: EnrichedMatch[];
  prematchMatches: EnrichedMatch[];
  isMock: boolean;
  sources: string[];
  fetchedAt: string;
}

// PandaScore upcoming-объект (нужны только поля для маппинга в Match).
interface UpcomingRaw {
  id?: number | string;
  begin_at?: string | null;
  number_of_games?: number;
  // PandaScore реальные поля
  opponents?: Array<{ opponent?: { id?: number; name?: string; acronym?: string | null } }>;
  league?: { id?: number; name?: string };
  serie?: { full_name?: string };
  tournament?: { name?: string };
  league_name?: string;          // подмешано бэком
  league_tier?: string;
  // Mock-поля (см. routes/matches.ts → getMockUpcomingMatches)
  team1?: string;
  team2?: string;
  tournament_name?: string;
  format?: string;
}

function upcomingFormat(n?: number, fallback?: string): 'BO1' | 'BO3' | 'BO5' {
  if (n === 1) return 'BO1';
  if (n === 3) return 'BO3';
  if (n === 5) return 'BO5';
  if (fallback === 'bo1') return 'BO1';
  if (fallback === 'bo5') return 'BO5';
  return 'BO3';
}

function upcomingToMatch(raw: UpcomingRaw): Match | null {
  // Реальный PandaScore vs mock — поддерживаем оба формата.
  const isPandaScore = Array.isArray(raw.opponents);
  const team1Name = isPandaScore
    ? (raw.opponents?.[0]?.opponent?.name ?? '').trim()
    : (raw.team1 ?? '').trim();
  const team2Name = isPandaScore
    ? (raw.opponents?.[1]?.opponent?.name ?? '').trim()
    : (raw.team2 ?? '').trim();
  if (!team1Name || !team2Name) return null;

  const team1Id = isPandaScore ? raw.opponents?.[0]?.opponent?.id : undefined;
  const team2Id = isPandaScore ? raw.opponents?.[1]?.opponent?.id : undefined;
  const tournament = (raw.league_name?.trim()
    || raw.league?.name?.trim()
    || raw.serie?.full_name?.trim()
    || raw.tournament?.name?.trim()
    || raw.tournament_name?.trim()
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
    format: upcomingFormat(raw.number_of_games, raw.format),
    status: 'prematch',
    currentMapNumber: 1,
    team1MapsWon: 0,
    team2MapsWon: 0,
    startTime: new Date(startMs),
    isFavorite: false,
  };
}

export async function fetchLiveData(): Promise<LiveDataResult> {
  const fetchedAt = new Date().toISOString();
  // Закреплённый featured-матч (PARIVISION vs PlayTime, 1W Essence) запрашиваем
  // параллельно с остальными источниками — он всегда первый в списке live.
  const featuredPromise = buildFeaturedMatch().catch(() => null);
  try {
    // 1. Fetch live + upcoming matches + odds
    const [liveResp, upcomingResp, oddsResp] = await Promise.allSettled([
      fetch(`${API_BASE}/matches/live`).then(r => r.json()),
      fetch(`${API_BASE}/matches/upcoming`).then(r => r.json()),
      fetch(`${API_BASE}/odds/dota2`).then(r => r.json()),
    ]);
    const upcomingData = upcomingResp.status === 'fulfilled'
      ? (upcomingResp.value as { isMock: boolean; data: UpcomingRaw[] })
      : null;

    const liveData = liveResp.status === 'fulfilled' ? liveResp.value as {
      isMock: boolean;
      sources: Array<{ source: string; data: OpenDotaLiveMatch[] }>;
      mockData?: OpenDotaLiveMatch[];
    } : null;

    const oddsData = oddsResp.status === 'fulfilled' ? oddsResp.value as {
      isMock: boolean;
      data: OddsData[];
    } : null;

    const openDotaSource = liveData?.sources?.find(s => s.source === 'opendota');
    const rawMatches = openDotaSource?.data ?? liveData?.mockData ?? [];
    const hasRealData = !liveData?.isMock && Array.isArray(rawMatches) && rawMatches.length > 0;

    if (!hasRealData) {
      const mockMarkets = buildMockMarkets();
      const buildMock = (match: Match): EnrichedMatch => {
        const mkts = mockMarkets.filter(mkt => mkt.matchId === match.id);
        // Берём всех букмекеров из первого рынка — у mock-данных там полный список.
        const availableBookmakers = mkts[0]?.allBookmakerOdds ?? [];
        return { match, markets: mkts, availableBookmakers, dataSource: 'mock' as const };
      };
      const featured = await featuredPromise;
      const liveList = [
        ...(featured ? [featured] : []),
        ...MOCK_MATCHES.filter(m => m.status === 'live').map(buildMock),
      ];
      const prematchList = MOCK_MATCHES.filter(m => m.status === 'prematch').map(buildMock);
      cacheEnriched([...liveList, ...prematchList]);
      return {
        liveMatches: liveList,
        prematchMatches: prematchList,
        isMock: !featured, sources: featured ? ['featured', 'mock'] : ['mock'], fetchedAt,
      };
    }
    // 2. Convert OpenDota data to our Match format
    const matches = (rawMatches as OpenDotaLiveMatch[])
      .slice(0, 10) // Show max 10 live matches
      .map(openDotaToMatch);

    // 3. Run analytics for each match
    const enriched: EnrichedMatch[] = await Promise.all(
      matches.map(async (match): Promise<EnrichedMatch> => {
        // Find matching odds by team names (approximate match)
        const matchingOdds = oddsData?.data?.find(o =>
          o.team1.toLowerCase().includes(match.team1.name.toLowerCase().split(' ')[1] ?? '') ||
          o.team2.toLowerCase().includes(match.team2.name.toLowerCase().split(' ')[1] ?? '')
        );

        const analyticsResult = await fetchAnalytics(match, matchingOdds);
        const markets = analyticsResult
          ? analyticsToMarkets(match, analyticsResult, matchingOdds)
          : [];
        const availableBookmakers = buildBookmakerOptions(matchingOdds);

        return { match, markets, analyticsResult, availableBookmakers, dataSource: 'real' };
      })
    );

    const featured = await featuredPromise;
    const finalLive = featured ? [featured, ...enriched] : enriched;

    // Маппим upcoming PandaScore → Match. Без analytics (для prematch обычно
    // нет live-снапшота); markets пустые до старта матча. Этого достаточно для
    // карточки в списке: имя турнира, время старта, формат.
    const upcomingRaws = Array.isArray(upcomingData?.data) ? upcomingData!.data : [];
    const prematchMatches: Match[] = upcomingRaws
      .map(upcomingToMatch)
      .filter((m): m is Match => m !== null)
      .filter(m => !finalLive.some(em => em.match.team1.id === m.team1.id && em.match.team2.id === m.team2.id))
      .slice(0, 30);
    const prematchEnriched: EnrichedMatch[] = prematchMatches.map(match => ({
      match, markets: [], availableBookmakers: [], dataSource: 'real' as const,
    }));

    cacheEnriched([...finalLive, ...prematchEnriched]);
    return {
      liveMatches: finalLive,
      prematchMatches: prematchEnriched,
      isMock: false,
      sources: [
        ...(featured ? ['featured'] : []),
        'opendota',
        ...(upcomingData && !upcomingData.isMock ? ['pandascore'] : []),
        ...(oddsData?.isMock === false ? ['the_odds_api'] : []),
      ],
      fetchedAt,
    };
  } catch {
    const mockMarkets = buildMockMarkets();
    const buildMock = (match: Match): EnrichedMatch => {
      const mkts = mockMarkets.filter(mkt => mkt.matchId === match.id);
      const availableBookmakers = mkts[0]?.allBookmakerOdds ?? [];
      return { match, markets: mkts, availableBookmakers, dataSource: 'mock' as const };
    };
    const featured = await featuredPromise;
    const liveList = [
      ...(featured ? [featured] : []),
      ...MOCK_MATCHES.filter(m => m.status === 'live').map(buildMock),
    ];
    const prematchList = MOCK_MATCHES.filter(m => m.status === 'prematch').map(buildMock);
    cacheEnriched([...liveList, ...prematchList]);
    return {
      liveMatches: liveList,
      prematchMatches: prematchList,
      isMock: !featured,
      sources: featured ? ['featured', 'mock'] : ['mock'],
      fetchedAt,
    };
  }
}
