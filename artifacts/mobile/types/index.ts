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
  hideMockMarkets: boolean;
  analyticsConsent: boolean;
  pushConsent: boolean;
  role: UserRole;
  viewMode: 'simple' | 'detailed';
  isPremium: boolean;
}

export type MatchStatus = 'prematch' | 'live' | 'finished';
export type BOFormat = 'BO1' | 'BO3' | 'BO5';
export type MapSide = 'radiant' | 'dire';

export interface Team {
  id: string;
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
  order: number;
}

export interface DraftBan {
  heroId: string;
  heroName: string;
  side: MapSide;
  order: number;
}

export interface Draft {
  picks: DraftPick[];
  bans: DraftBan[];
  radiantSynergy: number;
  direSynergy: number;
  radiantCounter: number;
  direCounter: number;
  radiantScalingScore: number;
  direScalingScore: number;
  radiantEarlyGameScore: number;
  direEarlyGameScore: number;
  comfortHeroes: { heroName: string; side: MapSide; masteryScore: number }[];
}

export interface LiveSnapshot {
  snapshotId: string;
  gameTimeSeconds: number;
  radiantKills: number;
  direKills: number;
  netWorthRadiant: number;
  netWorthDire: number;
  xpRadiant: number;
  xpDire: number;
  towersRadiant: number;
  towersDire: number;
  barracksRadiant: number;
  barracksDire: number;
  roshanAlive: boolean;
  aegisHolder: MapSide | null;
  buybacksAvailableRadiant: number;
  buybacksAvailableDire: number;
  lastBigEvent: string | null;
  snapshotAge: number;
  sourceId: string;
}

export interface Match {
  id: string;
  team1: Team;
  team2: Team;
  team1Side: MapSide;
  team2Side: MapSide;
  tournamentName: string;
  tournamentTier: 1 | 2 | 3;
  format: BOFormat;
  status: MatchStatus;
  currentMapNumber: number;
  team1MapsWon: number;
  team2MapsWon: number;
  startTime: Date;
  currentMap?: MapState;
  liveSnapshot?: LiveSnapshot;
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
  bookmakerId: string;
  bookmakerName: string;
  isMock: boolean;
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
  rawProbability: number;
  edge: number;
  ev: number;
  confidence: number;
  modelVersion: string;
  featureSnapshotId: string;
  calibrationMethod: 'none' | 'isotonic' | 'platt' | 'temperature_scaling';
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
   * Минимальная уверенность модели в %. Единственный численный фильтр —
   * minOdds/minEdge убраны до подключения платных букмекерских кэфов
   * (см. replit.md → Bookmakers roadmap).
   */
  minConfidence: number;
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
  hitRate: number;
  avgOdds: number;
  profitUnits: number;
  roi: number;
  maxDrawdown: number;
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
  isMock: boolean;
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

export type FilterBookmaker = 'all' | 'fonbet' | 'liga_stavok' | 'betfair' | 'betboom' | 'pari' | 'mock';
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
  hideMockMarkets: boolean;
}
