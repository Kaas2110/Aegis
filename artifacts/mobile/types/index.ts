import type { LiveDataQuality } from '../lib/liveFreshness';
export type Language = 'ru' | 'en';

export type UserRole = 'user' | 'admin';

export interface UserSettings {
  language: Language;
  minOdds: number;
  minEdge: number;
  minConfidence: number;
  favoriteTeamIds: number[]; // OpenDota team_id
  selectedBookmakerIds: string[];
  showOnlyPositiveEV: boolean;
  hideStaleData: boolean;
  analyticsConsent: boolean;
  pushConsent: boolean;
  role: UserRole;
  viewMode: 'simple' | 'detailed';
  isPremium: boolean;
}

export type MatchStatus = 'prematch' | 'live' | 'between_maps' | 'finished';
export type BOFormat = 'BO1' | 'BO3' | 'BO5' | 'unknown';
export type MapSide = 'radiant' | 'dire';

export interface Team {
  id: string;
  provider?: "opendota" | "pandascore";
  openDotaId?: number;
  name: string;
  shortName: string;
  logoPlaceholder: string;
  region: string;
  eloRating: number;
  recentForm: ('W' | 'L')[];
}

export interface Player {
  id: string;
  name: string;
  teamId: string;
  role: string;
  rating: number;
}

export interface Hero {
  id: string;
  name: string;
  roles: string[];
  patchWinrate: number;
  patchPickrate: number;
}

export interface DraftPick {
  heroId: string;
  heroName: string;
  side: MapSide;
  order: number | null;
}

export interface DraftBan {
  heroId: string;
  heroName: string;
  side: MapSide;
  order: number | null;
}

export interface Draft {
  picks: DraftPick[];
  bans: DraftBan[];
  bansKnown?: boolean;
  orderKnown?: boolean;
  radiantSynergy: number | null;
  direSynergy: number | null;
  radiantCounter: number | null;
  direCounter: number | null;
  radiantScalingScore: number | null;
  direScalingScore: number | null;
  radiantEarlyGameScore: number | null;
  direEarlyGameScore: number | null;
  comfortHeroes: { heroName: string; side: MapSide; masteryScore: number }[];
}

// LiveSnapshot — данные текущего матча. Поля `null` означают «источник не отдаёт».
// OpenDota /api/live даёт ТОЛЬКО: kills, gold (через radiant_lead), game_time,
// building_state (декодируется в towers/barracks). Остальное (xp, buybacks,
// roshan, aegis) НЕ доступно ни от OD, ни от Stratz Pulse — поэтому null.
// UI должен скрывать null-поля, не рендерить плейсхолдеры.
export interface LiveSnapshot {
  snapshotId: string;
  fetchedAt?: string;
  gameTimeSeconds: number;
  radiantKills: number;
  direKills: number;
  netWorthRadiant: number;
  netWorthDire: number;
  xpRadiant: number | null;
  xpDire: number | null;
  towersRadiant: number | null; // null until the upstream bit layout is verified
  towersDire: number | null;
  barracksRadiant: number | null;
  barracksDire: number | null;
  roshanAlive: boolean | null;
  aegisHolder: MapSide | null;
  buybacksAvailableRadiant: number | null;
  buybacksAvailableDire: number | null;
  lastBigEvent: string | null;
  snapshotAge: number;
  sourceId: string;
}

export interface Match {
  id: string;
  source?: "opendota" | "pandascore";
  openDotaMatchId?: number;
  team1: Team;
  team2: Team;
  team1Side: MapSide | "unknown";
  team2Side: MapSide | "unknown";
  tournamentName: string;
  tournamentTier: 1 | 2 | 3;
  format: BOFormat;
  formatKnown?: boolean;
  status: MatchStatus;
  currentMapNumber: number;
  team1MapsWon: number;
  team2MapsWon: number;
  startTime: Date;
  /** Verified series start; never the activation time of a later OD map. */
  seriesStartsAt?: string;
  /** Время окончания матча (из deactivate_time OpenDota). Присутствует только для status='finished'. */
  finishedAt?: Date;
  currentMap?: MapState;
  liveSnapshot?: LiveSnapshot;
  /** State progression quality; HTTP receipt does not establish event freshness. */
  liveDataQuality?: LiveDataQuality;
  draft?: Draft;
  isFavorite: boolean;
}

export interface MapState {
  mapNumber: number;
  gameTimeSeconds: number;
  score: { radiant: number; dire: number };
}

export interface TimelinePoint {
  gameTimeSec: number;
  modelProbTeam1: number;
  marketProbTeam1: number;
  event?: string;
}

export type MarketType =
  | 'match_winner'
  | 'map_winner'
  | 'first_blood'
  | 'first_tower'
  | 'first_roshan'
  | 'total_kills'
  | 'total_duration'
  | 'kills_handicap'
  | 'map_handicap'
  | 'correct_score'
  | 'net_worth_lead'
  | 'comeback'
  | 'draft_advantage'
  | 'over_under_maps'
  | 'first_barracks';

export interface BookmakerOdds {
  expiresAt?: string;
  scope?: 'series' | 'map';
  mapNumber?: number;
  sourceEventId?: string;
  fetchedAt?: string;
  bookmakerId: string;
  bookmakerName: string;
  oddsTeam1: number;
  oddsTeam2: number;
  impliedProbTeam1: number;
  impliedProbTeam2: number;
  fairProbTeam1: number;
  fairProbTeam2: number;
  freshness: number;
  snapshotAge: number;
}

export interface Prediction {
  predictionId: string;
  matchId: string;
  marketType: MarketType;
  marketLabel: string;
  modelProbability: number;
  calibratedProbability: number;
  marketFairProbability: number;
  rawProbability: number | null;
  edge: number | null;
  ev: number | null;
  confidence: number | null;
  expiresAt?: string;
  provenance?: {source: string; basis: string; qualityStatus: string; featuresVersion: number | null; modelCreatedAt?: string | null; modelVersions?: string[]; reportedBrierScore?: number | null; trainingDataAsOf?: string | null};
  modelVersion: string;
  featureSnapshotId: string;
  calibrationMethod: string;
  createdAt: Date;
  freshnessScore: number;
  dataQualityScore: number;
  isStale: boolean;
  stalenessWarning?: string;
  inputFeaturesJson: Record<string, unknown>;
  explanationJson: PredictionExplanation;
}

export interface PredictionExplanation {
  topFactors: { factor: string; impact: number; description: string }[];
  summary: string;
  confidenceBreakdown: { component: string; score: number }[];
}

export interface Market {
  id: string;
  matchId: string;
  type: MarketType;
  label: string;
  prediction: Prediction;
  bestOdds: BookmakerOdds;
  allBookmakerOdds: BookmakerOdds[];
}

export interface Alert {
  id: string;
  matchId?: string;
  teamId?: string;
  /**
   * Какие типы рынков отслеживать. Пустой массив = любой рынок.
   * Заменил собой одиночное `marketType` (мульти-выбор удобнее).
   */
  marketTypes: MarketType[];
  /**
   * Минимальная уверенность модели в %.
   */
  minConfidence: number;
  /**
   * Минимальный edge (модель vs букмекер) в %. Опционально.
   * Применяется только если у matched market есть bookmaker odds — иначе фильтр
   * пропускается (правило срабатывает по minConfidence).
   * См. Phase 2 M3 (мастер-план): возвращён после восстановления Bovada wiring.
   */
  minEdge?: number;
  /**
   * Минимальный bookmaker odds (≥). Опционально. Применяется к bestOdds.oddsTeam{1,2}
   * выбранной стороны. Пропускается если нет реальных кэфов.
   */
  minOdds?: number;
  /**
   * Только матчи любимых команд (favoriteTeamIds из настроек).
   */
  onlyFavoriteTeams: boolean;
  bookmakerId?: string;
  mode: 'live' | 'prematch' | 'any';
  label: string;
  createdAt: Date;
  isActive: boolean;
  lastTriggeredAt?: Date;
}

export interface BacktestParams {
  /** Сколько дней назад смотреть в `prematch_outcomes` */
  periodDays: number;
  /** Минимальная уверенность модели (0..1) */
  minConfidence: number;
  /** Минимальный справедливый коэффициент (1/p) */
  minOdds: number;
}

export interface BacktestKpis {
  numberOfBets: number;
  hitRate: number | null;
  avgOdds: number | null;
  profitUnits: number | null;
  roi: number | null;
  maxDrawdown: number | null;
  brierScore: number | null;
}

export interface BacktestEquityPoint {
  date: string;
  units: number;
  bet: number;
  result: 'win' | 'loss';
}

export interface BacktestConfBucket {
  label: string;
  count: number;
  hitRate: number;
}

export interface BacktestResult {
  ok: boolean;
  state: 'quality_unavailable' | 'validated_subset';
  oddsMode: 'synthetic_fair_odds';
  validation: {policy: string; note: string; unvalidatedRecords: number; excludedReasons: Array<{reason: string; count: number}>};
  params: BacktestParams;
  kpis: BacktestKpis;
  equityCurve: BacktestEquityPoint[];
  confidenceBuckets: BacktestConfBucket[];
  message?: string;
  generatedAt?: string;
}

export interface CalibrationBucket {
  bucketLabel: string;
  predictedProb: number;
  actualWinRate: number;
  count: number;
}

export interface SourceHealth {
  sourceId: string;
  sourceName: string;
  sourceType: string;
  isHealthy: boolean;
  lastSuccessfulSync: Date;
  errorCount: number;
  avgLatencyMs: number;
}

export interface ProductEvent {
  eventId: string;
  eventName: string;
  userId?: string;
  anonymousId: string;
  sessionId: string;
  timestamp: Date;
  screenName: string;
  appVersion: string;
  platform: string;
  locale: string;
  correlationId: string;
  matchId?: string;
  marketId?: string;
  predictionId?: string;
  modelVersion?: string;
  minOddsFilter?: number;
  minEdgeFilter?: number;
  minConfidenceFilter?: number;
  bookmarkerId?: string;
  properties?: Record<string, unknown>;
}

export type FilterBookmaker = 'none' | 'bovada' | 'fonbet' | 'liga_stavok' | 'pari' | 'betboom' | 'x1stavka' | 'olimp' | 'betfair';
export type FilterMinOdds = 1.2 | 1.5 | 2.0 | 3.0 | number;
export type FilterMode = 'prematch' | 'live' | 'finished' | 'all';
export type FilterEventType = 'all' | 'winner' | 'map_winner' | 'match_winner' | 'total_kills' | 'total_duration';

export interface Filters {
  bookmaker: FilterBookmaker;
  minOdds: number;
  minEdge: number;
  minConfidence: number;
  eventType: FilterEventType;
  mode: FilterMode;
  onlyPositiveEV: boolean;
  hideStaleData: boolean;
}
