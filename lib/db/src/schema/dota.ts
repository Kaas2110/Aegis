/**
 * Схема БД для исторических данных Dota 2 и предсказаний модели.
 */

import {
  pgTable,
  bigint,
  integer,
  real,
  text,
  timestamp,
  jsonb,
  serial,
  boolean,
  index,
  uniqueIndex,
  customType,
} from 'drizzle-orm/pg-core';

// Кастомный bytea-тип, потому что drizzle-orm/pg-core не экспортирует bytea
// напрямую. Используется для хранения сериализованных моделей (pickle/joblib)
// LightGBM в Wave 4. Работает через Buffer на Node-стороне.
const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return 'bytea';
  },
});
import { sql } from 'drizzle-orm';
import { createInsertSchema } from 'drizzle-zod';
import { z } from 'zod/v4';

// ── РЕЙТИНГИ КОМАНД (snapshot из OpenDota /api/teams) ────────────────────
export const teamsTable = pgTable('teams', {
  teamId: bigint('team_id', { mode: 'number' }).primaryKey(),
  name: text('name'),
  tag: text('tag'),
  rating: real('rating'),
  wins: integer('wins'),
  losses: integer('losses'),
  lastMatchTime: bigint('last_match_time', { mode: 'number' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── ЛИГИ (snapshot из OpenDota /api/leagues) ─────────────────────────────
// Используется для обогащения live/upcoming матчей человеческими названиями
// турниров (вместо «Лига #15728»). Заполняется ingest:leagues, обновляется
// раз в неделю или по запросу.
export const leaguesTable = pgTable('leagues', {
  leagueId: bigint('league_id', { mode: 'number' }).primaryKey(),
  name: text('name'),
  tier: text('tier'),                   // 'premium' | 'professional' | 'amateur' | etc.
  ticket: text('ticket'),
  banner: text('banner'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── ИСТОРИЧЕСКИЕ ПРО-МАТЧИ (для обучения модели) ─────────────────────────
// series_id + series_type позволяют группировать карты в BO3-серии
// (series_type: 0=BO1, 1=BO3, 2=BO5).
// firstBloodTime / barracks_status — расширены в Wave 3.D (для bet-type ML).
export const proMatchesTable = pgTable('pro_matches', {
  matchId: bigint('match_id', { mode: 'number' }).primaryKey(),
  startTime: bigint('start_time', { mode: 'number' }).notNull(),
  duration: integer('duration').notNull(),
  radiantTeamId: bigint('radiant_team_id', { mode: 'number' }),
  direTeamId: bigint('dire_team_id', { mode: 'number' }),
  radiantName: text('radiant_name'),
  direName: text('dire_name'),
  radiantScore: integer('radiant_score'),
  direScore: integer('dire_score'),
  radiantWin: boolean('radiant_win').notNull(),
  leagueId: bigint('league_id', { mode: 'number' }),
  leagueName: text('league_name'),
  series_id: bigint('series_id', { mode: 'number' }),
  series_type: integer('series_type'),
  // Wave 3.D — derived market fields. Заполняются при ingest:matches (если
  // OpenDota /proMatches их отдаёт) и/или backfill через /matches/:id.
  firstBloodTime: integer('first_blood_time'),
  barracksStatusRadiant: integer('barracks_status_radiant'),
  barracksStatusDire: integer('barracks_status_dire'),
  towerStatusRadiant: integer('tower_status_radiant'),
  towerStatusDire: integer('tower_status_dire'),
  // T0.7 — флаг и таймстамп успешной replay-обработки OpenDota.
  // is_parsed=true ⇔ есть строка в match_parsed для этого match_id.
  isParsed: boolean('is_parsed').notNull().default(false),
  parsedAt: timestamp('parsed_at', { withTimezone: true }),
  ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  startTimeIdx: index('pro_matches_start_time_idx').on(t.startTime),
  radiantTeamIdx: index('pro_matches_radiant_team_idx').on(t.radiantTeamId),
  direTeamIdx: index('pro_matches_dire_team_idx').on(t.direTeamId),
  seriesIdx: index('pro_matches_series_idx').on(t.series_id),
  isParsedIdx: index('pro_matches_is_parsed_idx').on(t.isParsed),
}));

// ── T0.7: ОЧЕРЕДЬ ЗАПРОСОВ НА REPLAY-ПАРСИНГ OpenDota ───────────────────
// Идемпотентный трекер запросов `POST /api/request/{matchId}`.
// status: 'queued' (отправили request, ждём парсинга) | 'parsed' (готов,
// данные в match_parsed) | 'failed' (request вернул не-200) | 'timeout'
// (>2 часа в queued, OD не успел).
export const matchParseQueueTable = pgTable('match_parse_queue', {
  matchId: bigint('match_id', { mode: 'number' }).primaryKey(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  status: text('status').notNull(),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  // job_id из OD `POST /api/request/{matchId}` ответа.
  jobId: bigint('job_id', { mode: 'number' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  statusIdx: index('match_parse_queue_status_idx').on(t.status),
  requestedAtIdx: index('match_parse_queue_requested_at_idx').on(t.requestedAt),
}));

// ── T0.7: РАСПАРСЕННЫЕ ДАННЫЕ REPLAY ────────────────────────────────────
// Одна строка на матч. Все JSONB поля — копия соответствующих секций из
// OpenDota /api/matches/{id} после успешного парса (version != null).
//
// payloadSchemaVersion инкрементируется когда меняем структуру payload —
// позволяет вычислять «нужно ли реингестить» при эволюции фичей.
//
// players: Array<10>, каждый элемент:
//   { player_slot, account_id, hero_id, gold_t[], xp_t[], lh_t[], dn_t[],
//     kills_log[], buyback_log[], purchase_log[], lane_role, is_roaming,
//     obs_log[], sen_log[], ability_upgrades_arr[] }
// objectives: Array<{ time, type, slot?, key?, team? }> — towers, roshans, aegis, FB
// teamfights: Array<{ start, end, last_death, deaths, players[] }>
// draftTimings: Array<{ order, pick, active_team, hero_id, player_slot,
//                       extra_time, total_time_taken }>
export const matchParsedTable = pgTable('match_parsed', {
  matchId: bigint('match_id', { mode: 'number' }).primaryKey(),
  parsedAt: timestamp('parsed_at', { withTimezone: true }).notNull().defaultNow(),
  // Версия структуры payload (наша, не OD). Бамп при изменении набора сохраняемых полей.
  payloadSchemaVersion: integer('payload_schema_version').notNull().default(1),
  // Версия парсера OpenDota (поле `version` из /matches/{id}).
  odVersion: integer('od_version'),
  players: jsonb('players').notNull(),
  objectives: jsonb('objectives'),
  teamfights: jsonb('teamfights'),
  draftTimings: jsonb('draft_timings'),
}, (t) => ({
  parsedAtIdx: index('match_parsed_parsed_at_idx').on(t.parsedAt),
  schemaVerIdx: index('match_parsed_schema_ver_idx').on(t.payloadSchemaVersion),
}));

// ── ВЕРСИИ МОДЕЛЕЙ ────────────────────────────────────────────────────────
// kind = тип модели:
//   'prematch_winner' — обучена на исторических матчах (фичи: рейтинг команд, опыт)
//   'live_winner'     — обучена на live-снапшотах + результатах (фичи: NW lead,
//                       kills, towers, gameTime, прематч-вероятность как сильный prior)
// is_active хранится по каждому kind независимо — у нас может быть одновременно
// активная прематч-модель и активная live-модель.
export const modelVersionsTable = pgTable('model_versions', {
  id: serial('id').primaryKey(),
  version: text('version').notNull().unique(),
  kind: text('kind').notNull().default('prematch_winner'),
  algorithm: text('algorithm').notNull(),
  features: jsonb('features').$type<string[]>().notNull(),
  weights: jsonb('weights').$type<Record<string, number>>().notNull(),
  // Версия фичевектора. v1 = 5 фичей (только команды). v2 = 12 фичей
  // (команды + hero/draft, Волна 2). Обе версии одного kind могут быть
  // активны одновременно — инференс выбирает v2 если есть драфт, иначе v1.
  featuresVersion: integer('features_version').notNull().default(1),
  // Wave 4: тип ML-движка. 'logreg' — pure-JS logistic regression (исторический
  // дефолт, веса в `weights`). 'lightgbm' — gradient boosting, сериализованная
  // модель в `binaryBlob`, инференс через ml-service по HTTP с graceful
  // fallback на LR той же (kind, featuresVersion).
  engine: text('engine').notNull().default('logreg'),
  // Wave 4: бинарный блоб для не-JSON моделей (pickle/joblib LightGBM).
  // Для logreg-движка остаётся NULL — веса всё ещё в `weights` jsonb.
  binaryBlob: bytea('binary_blob'),
  trainAccuracy: real('train_accuracy'),
  testAccuracy: real('test_accuracy'),
  brierScore: real('brier_score'),
  trainSampleSize: integer('train_sample_size'),
  testSampleSize: integer('test_sample_size'),
  // Wave 5: метрики на «близких матчах» (subset тестового сета где
  // |elo_diff_norm| < hard_threshold ≈ 0.4 → ~80 ELO разница).
  // Главный показатель полезности модели — точность когда фаворит неочевиден.
  hardMatchAccuracy: real('hard_match_accuracy'),
  hardMatchBrier: real('hard_match_brier'),
  hardMatchCount: integer('hard_match_count'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  isActive: boolean('is_active').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  kindActiveIdx: index('model_versions_kind_active_idx').on(t.kind, t.isActive),
  // Гарантируем на уровне БД: НЕ БОЛЕЕ ОДНОЙ активной модели на каждую тройку
  // (kind, features_version, engine). Wave 4 добавил engine — это позволяет
  // одновременно держать активные logreg + lightgbm одной (kind, fv) пары:
  // по умолчанию инференс идёт через lightgbm (через ml-service), а LR
  // остаётся spare tire для случаев timeout/ошибки ml-service. До Wave 4
  // индекс был просто на (kind, fv) — и логически продолжает гарантировать
  // «не более одной активной LR + не более одной активной LightGBM» на (kind, fv).
  oneActivePerKindEngineIdx: uniqueIndex('model_versions_one_active_per_kind_engine_idx')
    .on(t.kind, t.featuresVersion, t.engine)
    .where(sql`${t.isActive} = true`),
}));

// ── ВОЛНА 2: ДРАФТЫ МАТЧЕЙ ────────────────────────────────────────────────
// picks/bans конкретных героев в каждом матче. Заполняется через OpenDota
// /api/matches/:id (1.1с/запрос — медленный бэкфилл). После заполнения
// фичи драфта (matchup advantage, pick strength) подаются в модель v2.
//
// Wave 3: добавлены account_ids — кто из игроков на каких героях. Нужно для
// player-on-hero фичи (Σ player_winrate_on_hero - global). Порядок массивов
// СОВПАДАЕТ с radiantPicks/direPicks (i-й account играет i-го героя).
export const matchDraftsTable = pgTable('match_drafts', {
  matchId: bigint('match_id', { mode: 'number' }).primaryKey(),
  radiantPicks: jsonb('radiant_picks').$type<number[]>().notNull(),  // [hero_id]×5
  direPicks: jsonb('dire_picks').$type<number[]>().notNull(),
  radiantBans: jsonb('radiant_bans').$type<number[]>().notNull(),    // длина 5-7
  direBans: jsonb('dire_bans').$type<number[]>().notNull(),
  radiantAccountIds: jsonb('radiant_account_ids').$type<number[]>(), // nullable для backfill
  direAccountIds: jsonb('dire_account_ids').$type<number[]>(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── ВОЛНА 2: СТАТИСТИКА ГЕРОЕВ В ПРО-СЦЕНЕ ───────────────────────────────
// Снапшот /api/heroStats. Обновляется раз в неделю или при смене патча.
// proPickRate / proBanRate / proWinRate — нормализованные доли (0..1).
export const heroStatsTable = pgTable('hero_stats', {
  heroId: integer('hero_id').primaryKey(),
  name: text('name').notNull(),                  // localized_name (Anti-Mage и т.п.)
  primaryAttr: text('primary_attr'),             // 'str' | 'agi' | 'int' | 'all'
  attackType: text('attack_type'),               // 'Melee' | 'Ranged'
  proPickCount: integer('pro_pick_count').notNull().default(0),
  proBanCount: integer('pro_ban_count').notNull().default(0),
  proWinCount: integer('pro_win_count').notNull().default(0),
  proPickRate: real('pro_pick_rate').notNull().default(0),    // pick / totalProMatches
  proBanRate: real('pro_ban_rate').notNull().default(0),
  proWinRate: real('pro_win_rate').notNull().default(0.5),    // wins / picks
  // Фазовые скоринги (0..1) — производятся из Stratz constants.heroes.roles
  // (CARRY/DURABLE/JUNGLER → late, NUKER/INITIATOR/SUPPORT/DISABLER → early).
  // Заливаются `ingest:hero-stats`. Используются в /api/analytics/draft-score.
  earlyGameScore: real('early_game_score').notNull().default(0.5),
  lateGameScore: real('late_game_score').notNull().default(0.5),
  patch: text('patch'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── ВОЛНА 2: СИНЕРГИЯ ГЕРОЕВ (ОДНА КОМАНДА) ──────────────────────────────
// Парная статистика «hero A + hero B играют ВМЕСТЕ» из Stratz heroStats.matchUp.with.
// Симметрична семантически, но Stratz отдаёт top-N партнёров на героя — поэтому
// храним обе направленности и при чтении пробуем (a,b) ИЛИ (b,a).
// Используется в /api/analytics/draft-score → бар «Синергия».
export const heroSynergyTable = pgTable('hero_synergy', {
  heroId: integer('hero_id').notNull(),
  withHeroId: integer('with_hero_id').notNull(),
  games: integer('games').notNull(),
  wins: integer('wins').notNull(),
  winRate: real('win_rate').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: uniqueIndex('hero_synergy_pk').on(t.heroId, t.withHeroId),
  withHeroIdx: index('hero_synergy_with_hero_idx').on(t.withHeroId),
}));

// ── ВОЛНА 2: МАТЧАПЫ ГЕРОЕВ ──────────────────────────────────────────────
// Парная статистика hero vs hero из OpenDota /api/heroes/:id/matchups.
// Используется для фичи matchup_advantage = Σ (winRate − 0.5) × log(games).
export const heroMatchupsTable = pgTable('hero_matchups', {
  heroId: integer('hero_id').notNull(),
  vsHeroId: integer('vs_hero_id').notNull(),
  games: integer('games').notNull(),
  wins: integer('wins').notNull(),
  winRate: real('win_rate').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: uniqueIndex('hero_matchups_pk').on(t.heroId, t.vsHeroId),
  vsHeroIdx: index('hero_matchups_vs_hero_idx').on(t.vsHeroId),
}));

// ── ВОЛНА 3: ИГРОКИ (PRO-СЦЕНА) ──────────────────────────────────────────
// Метаданные игроков (name, country). Источник — OpenDota /players/{id}.
export const playersTable = pgTable('players', {
  accountId: bigint('account_id', { mode: 'number' }).primaryKey(),
  personaName: text('persona_name'),
  proName: text('pro_name'),                // если pro
  countryCode: text('country_code'),
  lastSeen: bigint('last_seen', { mode: 'number' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── ВОЛНА 3: СТАТИСТИКА ИГРОК × ГЕРОЙ ────────────────────────────────────
// Источник — OpenDota /players/{id}/heroes (отдаёт за весь pro-стаж).
// Используется для фичи playerSkillDiff = Σ (player_winrate_on_hero - global_winrate)*log(games+1)
// по 5 пикам каждой стороны.
export const playerHeroStatsTable = pgTable('player_hero_stats', {
  accountId: bigint('account_id', { mode: 'number' }).notNull(),
  heroId: integer('hero_id').notNull(),
  games: integer('games').notNull().default(0),
  wins: integer('wins').notNull().default(0),
  // Скользящее «недавно» (last 90d) опционально, NULL если не известно.
  lastPlayed: bigint('last_played', { mode: 'number' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: uniqueIndex('player_hero_stats_pk').on(t.accountId, t.heroId),
  heroIdx: index('player_hero_stats_hero_idx').on(t.heroId),
}));

// ── ВОЛНА 3: PER-PLAYER GLICKO-1 РЕЙТИНГ ─────────────────────────────────
// Считается локально из pro_matches × match_drafts (никаких внешних API).
// Используется фичей v3 модели `player_glicko_diff` = avg(rad glicko) - avg(dire glicko) / 200.
// Дефолты при создании строки: rating=1500, RD=350.
export const playerRatingsTable = pgTable('player_ratings', {
  accountId: bigint('account_id', { mode: 'number' }).primaryKey(),
  rating: real('rating').notNull().default(1500),
  rd: real('rd').notNull().default(350),
  games: integer('games').notNull().default(0),
  wins: integer('wins').notNull().default(0),
  lastMatchTime: bigint('last_match_time', { mode: 'number' }),
  lastMatchId: bigint('last_match_id', { mode: 'number' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  ratingIdx: index('player_ratings_rating_idx').on(t.rating),
}));

// ── ВОЛНА 3: НЕДАВНЯЯ ФОРМА КОМАНД ───────────────────────────────────────
// Агрегация по pro_matches за окно. Пересчитывается локальной SQL-джобой
// (никаких внешних API). period_days = 30 / 90.
export const teamRecentFormTable = pgTable('team_recent_form', {
  teamId: bigint('team_id', { mode: 'number' }).notNull(),
  periodDays: integer('period_days').notNull(),
  games: integer('games').notNull(),
  wins: integer('wins').notNull(),
  winRate: real('win_rate').notNull(),
  avgKillsFor: real('avg_kills_for'),
  avgKillsAgainst: real('avg_kills_against'),
  avgDurationSec: real('avg_duration_sec'),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: uniqueIndex('team_recent_form_pk').on(t.teamId, t.periodDays),
}));

// ── ВОЛНА 3: HEAD-TO-HEAD ────────────────────────────────────────────────
// Двусторонняя таблица hero vs hero, ключ — отсортированная пара (low, high).
// winsLow = победы команды с меньшим teamId. periodDays = 365 (по умолчанию).
// ── РАСШИРЕННЫЕ TEAM-ФИЧИ (snapshot для prematch inference) ─────────────
// Один ряд на команду — текущее состояние "как сейчас". Используется
// PredictionModel.buildTeamFeatures для расширенных фичей v1 (Wave 5).
// Заполняется `compute:team-extended` за один chronological pass по pro_matches.
//
// При тренировке — те же значения вычисляются "as-of-match" в train-script'е
// (чтобы избежать leakage будущих игр), а здесь — финальное «текущее»
// состояние для inference.
export const teamExtendedFeaturesTable = pgTable('team_extended_features', {
  teamId: bigint('team_id', { mode: 'number' }).primaryKey(),
  winStreak: integer('win_streak').notNull().default(0),       // signed: +N подряд побед / -N поражений
  daysSinceLastMatch: real('days_since_last_match'),           // null если матчей не было
  matches30d: integer('matches_30d').notNull().default(0),
  avgDurationSec30d: real('avg_duration_sec_30d'),             // средняя длительность матча, секунды
  firstBloodRate30d: real('first_blood_rate_30d'),             // доля матчей где FB до 5 мин
  radiantWinrate: real('radiant_winrate'),                     // wr когда играли как radiant (cumulative)
  direWinrate: real('dire_winrate'),                           // wr когда играли как dire (cumulative)
  peerSynergy: real('peer_synergy'),                           // средний попарный winrate core-5 ростера из player_peers, 0..1 (null если нет данных)
  lastMatchTime: bigint('last_match_time', { mode: 'number' }),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
});

export const teamH2HTable = pgTable('team_h2h', {
  teamLowId: bigint('team_low_id', { mode: 'number' }).notNull(),
  teamHighId: bigint('team_high_id', { mode: 'number' }).notNull(),
  periodDays: integer('period_days').notNull(),
  games: integer('games').notNull(),
  winsLow: integer('wins_low').notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: uniqueIndex('team_h2h_pk').on(t.teamLowId, t.teamHighId, t.periodDays),
}));

// ── BO3 СЕРИИ (для stage-aware прогнозов) ────────────────────────────────
// LiveWorker группирует live-матчи по series_id и хранит прогресс серии:
// какие карты сыграны, кто победил, какой драфт. Map N + 1 предсказывается
// только когда map N finished. Также используется для correct_score без
// предположения iid карт.
export const bo3SeriesTable = pgTable('bo3_series', {
  seriesId: bigint('series_id', { mode: 'number' }).primaryKey(),
  teamAId: bigint('team_a_id', { mode: 'number' }),    // канонически меньшее teamId
  teamBId: bigint('team_b_id', { mode: 'number' }),
  format: integer('format').notNull(),                  // 1 = BO3, 2 = BO5
  // Прогресс: каждая карта = { mapNumber, matchId, finished, winnerSide ('radiant'|'dire'),
  //   radiantTeamId (тот что играет radiant в этой карте), draft? }
  maps: jsonb('maps').$type<Array<{
    mapNumber: number;
    matchId?: number;
    finished: boolean;
    winnerSide?: 'radiant' | 'dire';
    radiantTeamId?: number;
    direTeamId?: number;
    draft?: { radiantPicks: number[]; direPicks: number[] };
  }>>().notNull(),
  winsA: integer('wins_a').notNull().default(0),
  winsB: integer('wins_b').notNull().default(0),
  finished: boolean('finished').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── СНАПШОТЫ LIVE-МАТЧЕЙ (для воркера) ───────────────────────────────────
export const liveSnapshotsTable = pgTable('live_snapshots', {
  id: serial('id').primaryKey(),
  matchId: bigint('match_id', { mode: 'number' }).notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  gameTimeSec: integer('game_time_sec'),
  radiantTeamId: bigint('radiant_team_id', { mode: 'number' }),
  direTeamId: bigint('dire_team_id', { mode: 'number' }),
  radiantScore: integer('radiant_score'),
  direScore: integer('dire_score'),
  radiantLead: integer('radiant_lead'),
  buildingState: integer('building_state'),
  /** 'live' = реальный онлайн-снапшот; 'backfill' = синтетический из истории OpenDota */
  source: text('source').default('live'),
  rawPayload: jsonb('raw_payload').$type<Record<string, unknown>>(),
  // ── T0.5a Stratz live enrichment (всё nullable, fail-soft) ──────────────
  /** Stratz match-level meta: avgRank, gameState, gameMinute, delay, roshanRespawnSec, liveWinRateRadiant, prematchWinRateRadiant, prematchDurationMin */
  stratzMatchMeta: jsonb('stratz_match_meta').$type<{
    avgRank: number | null;
    gameState: string | null;
    gameMinute: number | null;
    delay: number | null;
    roshanRespawnSec: number | null;
    liveWinRateRadiant: number | null;
    prematchWinRateRadiant: number | null;
    prematchDurationMin: number | null;
  } | null>(),
  /** Stratz per-player rich array (10 элементов). null поля если Stratz не вернул. */
  stratzPlayers: jsonb('stratz_players').$type<Array<{
    steamAccountId: number | null;
    heroId: number | null;
    isRadiant: boolean;
    level: number | null;
    kills: number | null;
    deaths: number | null;
    assists: number | null;
    lastHits: number | null;
    denies: number | null;
    gold: number | null;
    goldSpent: number | null;
    networth: number | null;
    goldPerMinute: number | null;
    experiencePerMinute: number | null;
    heroDamage: number | null;
    towerDamage: number | null;
    respawnTimer: number | null;
    impPerMinute: number | null;
    items: number[];
  }> | null>(),
  /** Σ(Radiant.xpm)·gameMinute − Σ(Dire.xpm)·gameMinute. Precomputed для быстрого ML. */
  xpAdvantage: integer('xp_advantage'),
  /** Σ Radiant.networth − Σ Dire.networth. */
  networthAdvantage: integer('networth_advantage'),
  /** Когда Stratz отдал данные. null если fetch упал. */
  stratzFetchedAt: timestamp('stratz_fetched_at', { withTimezone: true }),
}, (t) => ({
  matchIdx: index('live_snapshots_match_idx').on(t.matchId),
  capturedIdx: index('live_snapshots_captured_idx').on(t.capturedAt),
}));

// ── ПРЕДСКАЗАНИЯ МОДЕЛИ (для бэктеста и калибровки) ──────────────────────
export const predictionsTable = pgTable('predictions', {
  id: serial('id').primaryKey(),
  matchId: bigint('match_id', { mode: 'number' }).notNull(),
  modelVersion: text('model_version').notNull(),
  marketType: text('market_type').notNull(),
  predictedAt: timestamp('predicted_at', { withTimezone: true }).notNull().defaultNow(),
  modelProbTeam1: real('model_prob_team1').notNull(),
  modelProbTeam2: real('model_prob_team2').notNull(),
  marketOdds1: real('market_odds1'),
  marketOdds2: real('market_odds2'),
  edge: real('edge'),
  ev: real('ev'),
  confidence: real('confidence'),
  features: jsonb('features').$type<Record<string, number>>(),
  outcome: text('outcome'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, (t) => ({
  matchIdx: index('predictions_match_idx').on(t.matchId),
  modelIdx: index('predictions_model_idx').on(t.modelVersion),
  // Composite для T3.5 live-override lookup в /api/analytics/totals-ladder:
  // WHERE match_id=? AND market_type=? ORDER BY predicted_at DESC LIMIT 1.
  matchMarketLatestIdx: index('predictions_match_market_latest_idx').on(t.matchId, t.marketType, t.predictedAt),
}));

// ── СНАПШОТЫ КОЭФФИЦИЕНТОВ (Pinnacle и др.) ──────────────────────────────
export const oddsSnapshotsTable = pgTable('odds_snapshots', {
  id: serial('id').primaryKey(),
  bookmaker: text('bookmaker').notNull(),
  externalEventId: text('external_event_id'),
  matchId: bigint('match_id', { mode: 'number' }),
  team1Name: text('team1_name'),
  team2Name: text('team2_name'),
  marketType: text('market_type').notNull().default('match_winner'),
  odds1: real('odds1'),
  odds2: real('odds2'),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  rawPayload: jsonb('raw_payload').$type<Record<string, unknown>>(),
}, (t) => ({
  bookmakerIdx: index('odds_snapshots_bookmaker_idx').on(t.bookmaker),
  capturedIdx: index('odds_snapshots_captured_idx').on(t.capturedAt),
  matchIdx: index('odds_snapshots_match_idx').on(t.matchId),
}));

// ── ИСХОДЫ ПРЕМАТЧ-ПРЕДСКАЗАНИЙ (никогда не удаляются) ───────────────────
// Хранит для каждого матча: что предсказала модель ДО старта vs реальный исход.
// Используется для построения метрик качества модели (accuracy, calibration,
// Brier score on out-of-sample data). Эта таблица — «золотой ledger» и не
// чистится prune-джобом, в отличие от live_snapshots.
export const prematchOutcomesTable = pgTable('prematch_outcomes', {
  id: serial('id').primaryKey(),
  matchId: bigint('match_id', { mode: 'number' }).notNull().unique(),
  modelVersion: text('model_version').notNull(),
  predictedAt: timestamp('predicted_at', { withTimezone: true }).notNull().defaultNow(),
  // Команды (для дебага и отчётов)
  radiantTeamId: bigint('radiant_team_id', { mode: 'number' }),
  direTeamId: bigint('dire_team_id', { mode: 'number' }),
  radiantName: text('radiant_name'),
  direName: text('dire_name'),
  leagueName: text('league_name'),
  // Прогноз модели до старта матча
  predictedRadiantWinProb: real('predicted_radiant_win_prob').notNull(),
  predictedConfidence: real('predicted_confidence'),
  // Реальный исход
  actualRadiantWin: boolean('actual_radiant_win'),
  actualRadiantScore: integer('actual_radiant_score'),
  actualDireScore: integer('actual_dire_score'),
  actualDurationSec: integer('actual_duration_sec'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  // Снапшот фичей (для последующего анализа что повлияло)
  features: jsonb('features').$type<Record<string, number>>(),
}, (t) => ({
  modelIdx: index('prematch_outcomes_model_idx').on(t.modelVersion),
  resolvedIdx: index('prematch_outcomes_resolved_idx').on(t.resolvedAt),
}));

// ── НАСТРОЙКИ ПРИЛОЖЕНИЯ (single-row, id=1) ──────────────────────────────
// Глобальный feature-flag store, управляемый из админки.
// Сейчас:
//  - useBookmakerOdds: включает/отключает запросы к Odds API на бэкенде.
//    Когда выключено, мобилка показывает «популярные рынки» вместо edge vs odds.
//  - liveSnapshotPruneDays: за сколько дней чистить live_snapshots (default 7).
export const appSettingsTable = pgTable('app_settings', {
  id: integer('id').primaryKey(),
  useBookmakerOdds: boolean('use_bookmaker_odds').notNull().default(false),
  liveSnapshotPruneDays: integer('live_snapshot_prune_days').notNull().default(7),
  // ── Настройки тренировочного датасета ─────────────────────────────────
  // trainWindowDays:  максимальное кол-во дней истории (hard cap)
  // trainMaxPatches:  максимальное кол-во последних патчей (берётся более
  //                   строгий из двух: патч-граница или дата-граница)
  // trainMinSamples:  минимум сэмплов для старта обучения (иначе skip)
  trainWindowDays: integer('train_window_days').notNull().default(365),
  trainMaxPatches: integer('train_max_patches').notNull().default(4),
  trainMinSamples: integer('train_min_samples').notNull().default(1000),
  notes: text('notes'),
  // ── Legacy monetization (зарезервировано под платную модель: $4/нед, $15/мес) ──
  // Колонки физически есть в БД, кодом сейчас не читаются, но сохраняем как
  // pass-through конфиг для будущего Lite/Premium gating. Не дропать.
  // feature_flags формат: { <feature_id>: { free: bool, basic: bool, premium: bool } }
  monetizationMode: text('monetization_mode'),
  featureFlags: jsonb('feature_flags').$type<Record<string, { free?: boolean; basic?: boolean; premium?: boolean }>>(),
  storeSettings: jsonb('store_settings').$type<Record<string, unknown>>(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── ОВЕРРАЙДЫ КЛЮЧЕЙ ВНЕШНИХ API ─────────────────────────────────────────
// Хранит per-key override значений ENV (ODDS_API_KEY, STRATZ_TOKEN, ...).
// Если строка есть и value не NULL — используется вместо process.env. Пустое
// значение или отсутствие строки — fallback на ENV. Управляется только из
// admin-web (эндпоинты /api/admin/integrations).
export const apiKeyOverridesTable = pgTable('api_key_overrides', {
  envName: text('env_name').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export type ApiKeyOverride = typeof apiKeyOverridesTable.$inferSelect;

// ── СОСТОЯНИЕ ШЕДУЛЕРА (single-row, id=1) ────────────────────────────────
// Отслеживает: текущий замеченный патч, время последней тренировки,
// время следующей запланированной тренировки.
export const schedulerStateTable = pgTable('scheduler_state', {
  id: integer('id').primaryKey(),
  lastPatchSeen: text('last_patch_seen'),
  lastPatchDetectedAt: timestamp('last_patch_detected_at', { withTimezone: true }),
  lastIngestAt: timestamp('last_ingest_at', { withTimezone: true }),
  lastTrainAt: timestamp('last_train_at', { withTimezone: true }),
  nextTrainDueAt: timestamp('next_train_due_at', { withTimezone: true }),
  lastCheckAt: timestamp('last_check_at', { withTimezone: true }),
  lastError: text('last_error'),
  notes: jsonb('notes').$type<Record<string, unknown>>(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── E0 Premium OD tables ─────────────────────────────────────────────────
//
// Три таблицы для новых данных из OpenDota premium endpoints.
// Наполняются скриптами ingest:od-scenarios / ingest:od-player-peers /
// ingest:od-distributions — запускаются из run-enrichment-pipeline.sh.
// Используются как дополнительные фичи в prematch ML моделях (шаг D).

/**
 * hero_scenarios — winrate героя по игровым сценариям из /api/scenarios/*.
 *
 * scenario_type: 'itemTimings' | 'laneRoles' | 'misc'
 * data: сырой массив от OD (jsonb, структура зависит от endpoint'а):
 *   itemTimings: [{item, time, games, wins, hero_id}]
 *   laneRoles:   [{hero_id, lane_role, time_0_30_min, games, wins}]
 *   misc:        [{scenario, is_win, games, wins}]
 *
 * Уникальный ключ: (hero_id, scenario_type). hero_id=0 для 'misc'.
 * Обновляется upsert (on conflict do update set data, fetched_at).
 */
export const heroScenariosTable = pgTable('hero_scenarios', {
  id: serial('id').primaryKey(),
  heroId: integer('hero_id').notNull(),
  scenarioType: text('scenario_type').notNull(), // 'itemTimings' | 'laneRoles' | 'misc'
  data: jsonb('data').$type<unknown[]>().notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  heroScenarioUniq: uniqueIndex('hero_scenarios_hero_scenario_uniq').on(t.heroId, t.scenarioType),
}));

/**
 * player_peers — с кем чаще играл pro-игрок и их winrate вместе.
 * Источник: /api/players/{account_id}/peers
 *
 * Используется в compute:team-extended как фича «средний peer-winrate
 * среди текущего ростера» — усиливает сигнал командной синергии.
 * Freshness: 7 дней (ingest:od-player-peers пропускает свежие строки).
 */
export const playerPeersTable = pgTable('player_peers', {
  id: serial('id').primaryKey(),
  accountId: bigint('account_id', { mode: 'number' }).notNull(),
  peerId: bigint('peer_id', { mode: 'number' }).notNull(),
  games: integer('games').notNull(),
  wins: integer('wins').notNull(),
  winrate: real('winrate').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  peerUniq: uniqueIndex('player_peers_account_peer_uniq').on(t.accountId, t.peerId),
}));

/**
 * hero_durations — распределение исходов по длительности матча per hero.
 * Источник: /api/heroes/{id}/durations
 *
 * data: [{duration_bin: number, games_played: number, wins: number}]
 * Используется как prior для total_duration модели (q25/q75 квантили).
 * Обновляется раз в неделю.
 */
export const heroDurationsTable = pgTable('hero_durations', {
  id: serial('id').primaryKey(),
  heroId: integer('hero_id').notNull().unique(),
  data: jsonb('data').$type<Array<{ duration_bin: number; games_played: number; wins: number }>>().notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * meta_distributions — агрегированные распределения из /api/distributions.
 *
 * kind: строковый ключ верхнего уровня ответа OD (например 'mmr',
 * 'country_mmr', 'ranks', 'mmr_estimates').
 * data: jsonb, структура per-kind.
 * Обновляется раз в неделю.
 */
export const metaDistributionsTable = pgTable('meta_distributions', {
  id: serial('id').primaryKey(),
  kind: text('kind').notNull().unique(),
  data: jsonb('data').$type<unknown>().notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Zod-схемы для вставки ────────────────────────────────────────────────
export const insertProMatchSchema = createInsertSchema(proMatchesTable);
export type InsertProMatch = z.infer<typeof insertProMatchSchema>;
export type ProMatch = typeof proMatchesTable.$inferSelect;

export const insertTeamSchema = createInsertSchema(teamsTable);
export type InsertTeam = z.infer<typeof insertTeamSchema>;
export type Team = typeof teamsTable.$inferSelect;

export const insertModelVersionSchema = createInsertSchema(modelVersionsTable);
export type InsertModelVersion = z.infer<typeof insertModelVersionSchema>;
export type ModelVersion = typeof modelVersionsTable.$inferSelect;

export const insertLiveSnapshotSchema = createInsertSchema(liveSnapshotsTable);
export type InsertLiveSnapshot = z.infer<typeof insertLiveSnapshotSchema>;
export type LiveSnapshot = typeof liveSnapshotsTable.$inferSelect;

export const insertPredictionSchema = createInsertSchema(predictionsTable);
export type InsertPrediction = z.infer<typeof insertPredictionSchema>;
export type Prediction = typeof predictionsTable.$inferSelect;

export const insertOddsSnapshotSchema = createInsertSchema(oddsSnapshotsTable);
export type InsertOddsSnapshot = z.infer<typeof insertOddsSnapshotSchema>;
export type OddsSnapshot = typeof oddsSnapshotsTable.$inferSelect;

export type SchedulerState = typeof schedulerStateTable.$inferSelect;

export const insertPrematchOutcomeSchema = createInsertSchema(prematchOutcomesTable);
export type InsertPrematchOutcome = z.infer<typeof insertPrematchOutcomeSchema>;
export type PrematchOutcome = typeof prematchOutcomesTable.$inferSelect;

export type AppSettings = typeof appSettingsTable.$inferSelect;

export const insertMatchDraftSchema = createInsertSchema(matchDraftsTable);
export type InsertMatchDraft = z.infer<typeof insertMatchDraftSchema>;
export type MatchDraft = typeof matchDraftsTable.$inferSelect;

export const insertHeroStatSchema = createInsertSchema(heroStatsTable);
export type InsertHeroStat = z.infer<typeof insertHeroStatSchema>;
export type HeroStat = typeof heroStatsTable.$inferSelect;

export const insertHeroMatchupSchema = createInsertSchema(heroMatchupsTable);
export type InsertHeroMatchup = z.infer<typeof insertHeroMatchupSchema>;
export type HeroMatchup = typeof heroMatchupsTable.$inferSelect;

export const insertHeroSynergySchema = createInsertSchema(heroSynergyTable);
export type InsertHeroSynergy = z.infer<typeof insertHeroSynergySchema>;
export type HeroSynergy = typeof heroSynergyTable.$inferSelect;

// ── Wave 3 типы ──────────────────────────────────────────────────────────
export type Player = typeof playersTable.$inferSelect;
export type InsertPlayer = typeof playersTable.$inferInsert;

export type PlayerHeroStat = typeof playerHeroStatsTable.$inferSelect;
export type InsertPlayerHeroStat = typeof playerHeroStatsTable.$inferInsert;

export type TeamRecentForm = typeof teamRecentFormTable.$inferSelect;
export type InsertTeamRecentForm = typeof teamRecentFormTable.$inferInsert;

export type TeamExtendedFeatures = typeof teamExtendedFeaturesTable.$inferSelect;
export type InsertTeamExtendedFeatures = typeof teamExtendedFeaturesTable.$inferInsert;

export type TeamH2H = typeof teamH2HTable.$inferSelect;
export type InsertTeamH2H = typeof teamH2HTable.$inferInsert;

export type Bo3Series = typeof bo3SeriesTable.$inferSelect;
export type InsertBo3Series = typeof bo3SeriesTable.$inferInsert;

export type League = typeof leaguesTable.$inferSelect;

// ── E0 Premium OD типы ────────────────────────────────────────────────────
export type HeroScenario = typeof heroScenariosTable.$inferSelect;
export type InsertHeroScenario = typeof heroScenariosTable.$inferInsert;

export type PlayerPeer = typeof playerPeersTable.$inferSelect;
export type InsertPlayerPeer = typeof playerPeersTable.$inferInsert;

export type HeroDuration = typeof heroDurationsTable.$inferSelect;
export type InsertHeroDuration = typeof heroDurationsTable.$inferInsert;

export type MetaDistribution = typeof metaDistributionsTable.$inferSelect;
export type InsertMetaDistribution = typeof metaDistributionsTable.$inferInsert;
export type InsertLeague = typeof leaguesTable.$inferInsert;
