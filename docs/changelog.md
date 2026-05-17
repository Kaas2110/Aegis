# Aegis — Changelog

Историческая хронология крупных изменений. Свежее — сверху. Актуальный snapshot
проекта см. в `replit.md`. Подробная архитектура — `docs/architecture.md`.

## 2026-05-17 — Phase 5 A3 Model Management UI DONE

Закрыли отложенный пункт админки — раздел `/models` в `artifacts/admin-web`.

**Backend:** новый endpoint `GET /api/admin/models/:id/calibration` —
читает `model_versions.metadata.calibration` (isotonic bins + sampleSize) и
`metadata.featureImportance` (top-15 по |weight|). При отсутствии калибровки
возвращает `identity:true, bins:[]`. Edge cases: 400 на не-числовой id,
404 на отсутствующую модель. OpenAPI: схемы `AdminModelCalibrationResponse`
/ `Block` / `Bin` / `FeatureImportanceItem`, codegen прогнан.

**Frontend:** `pages/models.tsx` через `useGetAdminModelsHistory` —
таблица последних 50 версий с `kind/version/engine/testAcc/Brier/N/createdAt`
+ бейдж ACTIVE/shadow. Кнопка «Активировать» вызывает `useActivateAdminModel`
с `window.confirm`, тостом, инвалидацией кэшей `/models` и `/models/history`.
Expandable row через chevron открывает панель калибровки: Recharts LineChart
(x = mid сырой p, y = калиброванная p) + diagonal `y=x` ReferenceLine как
референс, плюс горизонтальные бары feature importance top-15. Когда bins
пусты или identity — текстовая подсказка вместо графика, никаких fake-данных.
Роут `/models` в `App.tsx`, навигация — иконка Layers, лейбл «Модели».

Активация безопасна — серверная транзакция в `routes/admin.ts:728` атомарно
деактивирует конкурента с тем же `(kind, featuresVersion, engine)`. Сессия
админа через HttpOnly cookie, токен не уходит на клиент.

## 2026-05-17 — Phase 9 баг-лист зафиксирован (после live-теста на iPhone)

Пользователь прогнал Phase 2 UI на эмуляторе и нашёл 8 проблем (F1-F8). Все
записаны в `.local/session_plan.md` → «Фаза 9 — баг-фиксы», в `replit.md`
Roadmap добавлена сводка. Фаза 9 запускается **после** Фазы 3 ML (L1-L9) —
сейчас кода не трогаем, только бэклог.

Краткая сводка:
- **P0:** F1 завершённые матчи в «Лайв» с прогнозами, F2 чипы коэф 1.2+/1.5+
  не подключены к `applyFilters`, F3 вкладка «Бэктест» снова видна (нужно
  вернуть `href: null`).
- **P1:** F4 «Сравнение коэф.» в табе Длительности рендерит имена команд
  вместо «ТБ/ТМ», F5 «Сводка матча» = «Некорректный ID» (matchId не доходит),
  F6 «Сравнение команд» все «—» (мелкие team_id без данных).
- **P2:** F7 Bovada events=0 (нужна диагностика сырого JSON), F8 e2e алертов.

Корень для F3 (исторический): Phase 2 M4 раскрыл вкладку «Бэктест» (7391
outcomes уже хватает по числам), но UX ещё не готов и пользователь хочет
обратно скрыть. Запомнить: «достаточно данных» ≠ «готов UI».

## 2026-05-17 — Phase 4 B3 (lazy Wave-3) + Phase 5 A1/A4 + Phase 7 laptop-deploy

- **Phase 4 B3 — lazy Wave-3 cache** в `services/PredictionModel.ts`. `refreshWave3Data`
  получила опциональный `hint = { teamIds, accountIds }`:
  - hint=undefined → старое поведение, грузим всё (используется warmup'ом
    `loadActiveModel` и hot-reload'ом scheduler'а).
  - hint={…} → инкрементальная подгрузка только нужных строк через `inArray`
    в `team_recent_form` / `team_h2h` / `player_hero_stats` / `player_ratings`.
  - Добавлены `triedWave3TeamIds` / `triedWave3AccountIds` Sets и `wave3FullyLoaded`
    флаг, чтобы не ходить в БД повторно за «пустыми» ID. `resetWave3Caches()`
    срабатывает по TTL (30 мин) или при следующем full-refresh.
  - Оба inference-callsite в `predictMatchWinner` (player-glicko fallback и
    Wave-3 extraFeats) теперь зовут `refreshWave3Data` с хинтом из текущего
    матча — экономит десятки тысяч строк на каждый predict при росте БД.
- **Phase 5 A4 — worker heartbeats**. Новый модуль `services/workerHeartbeats.ts`
  с in-memory регистром (`liveWorker`, `scheduler`): `lastTickAt`, `lastStatus`
  (`ok|error|idle`), `lastError`, `totalTicks`, `lastDurationMs`. `LiveWorker.ts`
  и `SchedulerWorker.ts` вызывают `recordHeartbeat` после каждого тика
  (`pollOnce` / `tickOnce`). `GET /api/admin/workers/config` отдаёт их под
  ключом `heartbeats`, POST тоже возвращает свежий снимок.
- **OpenAPI**: `WorkerHeartbeat` schema + `AdminWorkersConfig.heartbeats`
  (required, оба воркера). Прогнан `pnpm --filter @workspace/api-spec run codegen`,
  типы регенерированы.
- **Phase 5 A1 — coverage cards на dashboard**. `pages/dashboard.tsx` использует
  `useGetAdminCoverage` (хук уже был сгенерирован) и рендерит 6 ячеек:
  Drafts 90d/365d (% с цветовой шкалой <50% dire / 50-80% primary / ≥80%
  radiant), Parsed 60d (+cruise-ready флаг), Outcomes (+live-train ready),
  Team form 30d, Live snapshots 24h. У каждой ячейки русский tooltip-hint
  «что это значит и какой порог нужен».
- **Phase 5 A4 UI — heartbeats panel** в `pages/workers.tsx`. WorkerFlagsPanel
  под флагами теперь рисует grid 2×1: для каждого воркера показывает status,
  возраст последнего тика (если >5 мин — красным «stale»), totalTicks,
  длительность тика и lastError. In-memory подписан явно.
- **Phase 7 — `docs/laptop-deploy.md`**. Пошаговая инструкция переезда фоновой
  работы с Replit на личный ноут: предусловия (Node 24 / pnpm 9 / Python /
  PG), smoke-test (вручную прогнать `scripts/run-*.sh`), вариант A (crontab),
  вариант B (systemd с готовыми unit-файлами `aegis-api.service`,
  `aegis-ml.service`, `aegis-replay-parse.service`, и timer'ами
  `aegis-daily.timer` / `aegis-hourly.timer` / `aegis-enrichment.timer`),
  мониторинг через `journalctl` + admin-web heartbeats, бэкап PG, чек-лист.
  Зафиксировано решение НЕ переносить `parse:cycle` в SchedulerWorker
  (см. user prefs) и держать `DISABLE_AUTO_RETRAIN=true` до явного разрешения.

## 2026-05-17 — Phase 2 Mobile UI: M3 (alerts +minEdge/minOdds) + M5 (getFieldState)

- **M3 (Phase 2)**: вернул `minEdge` / `minOdds` в правила алертов как опциональные
  фильтры. `types/index.ts::Alert` получил `minEdge?: number` (порог перевеса в %)
  и `minOdds?: number` (минимальный bookmaker odds). `alerts.tsx` модал — две
  новых строки чипов (`MIN_EDGE_OPTIONS` 3/5/8/12/20% + `MIN_ODDS_OPTIONS`
  1.5/1.8/2.0/2.5/3.0), значение `undefined` = «—» = фильтр не применять.
  Карточка правила отображает их в ruleMeta (`перевес ≥ +X% · коэф ≥ Y`).
  `NotificationService.checkAndNotify` после проверки `minConfidence` дополнительно
  пропускает срабатывание если у side есть реальные odds (>0) и `sideOdds < minOdds`
  или `(winnerProb × sideOdds − 1) × 100 < minEdge`. Если odds нет (Bovada не
  покрыла рынок) — фильтр пропускается, правило работает по уверенности.
- **M5 (Phase 2)**: `MatchCard` теперь использует существующий `lib/availability.ts::getFieldState`
  для свежести live-снапшота (`snap.snapshotAge` секунды). При `stale-hard` (>3 мин)
  счёт `K/K + game_time` скрывается, на его месте — плашка «обновляется…» (warning
  цвет). При `stale-soft` (90s-3min) — рядом с game time появляется значок ⟳.
  Между картами всё ещё показываем `team1MapsWon · team2MapsWon` (отдельный ветка
  `isBetweenMaps`). Помогает избежать «застывших» счётов при потере апстрима.
- **M1/M2/M4/M6**: было уже сделано ранее (`marketsMap` + `BookmakerDropdown` в
  header через `filters.bookmaker`, match/[id].tsx использует тот же global
  picker, backtest tab раскрыт, прогрессивный скоринг через
  `predictionStatus pending/ready/unavailable` уже в `MatchCard`).

## 2026-05-17 — A2 daily-ingest button (фасад над shell-пайплайнами)

- **A2 (Фаза 5)**: admin job runner расширен — `POST /api/admin/jobs/run` теперь
  принимает не только pnpm-скрипты из `ALLOWED_RUN_SCRIPTS`, но и shell-обёртки
  из нового whitelist `SHELL_SCRIPTS` (`sh:daily` → `bash scripts/run-daily.sh`,
  `sh:enrichment` → `bash scripts/run-enrichment-pipeline.sh`). Shell-скрипты
  args не принимают (`{error: 'shell scripts do not accept args'}`). Любой
  `script` вне обоих whitelist-ов → 400 с обоими списками. `GET /api/admin/jobs`
  отдаёт `allowedShellScripts` рядом с `allowedScripts`.
- **UI**: в `pages/workers.tsx` PRESETS появилась новая секция ★ «Полные
  пайплайны (целиком)» с двумя кнопками — DAILY (~25-40 мин, 11 пресетов в
  правильном порядке) и ENRICH (тяжёлый, ~1.7ч). Job stream + полоса прогресса
  работают тем же механизмом, что и индивидуальные пресеты.
- **Зачем**: точечный запуск отдельных скриптов уже был; теперь можно одной
  кнопкой прогнать полный daily-батч из admin-web вместо терминала.

## 2026-05-17 — A5 full feature registry + B1 _field_meta

- **A5 full (Фаза 5)**: `docs/feature-registry.json` расширен с 5 примеров до полного
  реестра 51 фичи всех моделей (18 prematch_team + 11 prematch_hero + 6 prematch_extra
  + 9 live_winner + 7 live_totals). Машинно-читаемые поля: `valueType`, `rangeMin/Max`,
  `unit`, `nullable`, `computedBy`, `sourceTables[]`, `engines[]`, `usedInBuckets[]`,
  плюс русские `label_ru`/`shortHint_ru`/`longDescription_ru`. `artifacts/admin-web/src/data/feature-registry.json`
  — symlink на `docs/feature-registry.json` (единый источник истины, без рассинхрона;
  Vite ходит по симлинку).
- **Feature Explorer UI**: на странице `/admin-web/metrics` добавлена карточка
  «Реестр фичей моделей» с фильтром по id/названию/таблице, группировкой по
  5 секциям и раскрытием каждой строки (clickable row → грид с подробным описанием,
  computedBy, sourceTables, engines, rangeMin/Max).
- **B1 _field_meta (Фаза 4)**: `routes/matches.ts /live` теперь возвращает блок
  `_field_meta` с `fetchedAt`, `cacheTtlSec` и `sources` (freshness=transient/permanent,
  maxAgeSec, sourceTable) для opendota_live, stratz_live (DORMANT), pandascore_running,
  team_names, league_names. Mobile использует чтобы показывать «обновлено N сек назад»
  и отличать permanent (имена команд, лига — из БД) от transient (live kills/networth —
  из upstream).

## 2026-05-17 — Mobile UI cap, between-maps timeout, admin retrain button, A5 sample

Batch правок по мастер-плану (Фазы 2/4/5/7):

- **M3 (10-fav cap)**: `app/(tabs)/settings.tsx::FavoriteTeamsCard.toggle()` — лимит
  `MAX_FAVORITES=10` с Alert при попытке добавить 11-ю. Подпись `Выбрано N/10`.
- **M4 (Backtest UI)**: убран `href: null` из `_layout.tsx` для `app/(tabs)/backtest.tsx`
  (≥7391 outcomes, условие выполнено).
- **M2/M6**: подтверждены как уже реализованные (per-map drafts TODO ≠ bookmakers;
  прогрессивный плейсхолдер «Данные собираются» уже в `MatchCard.tsx`).
- **B2 (between-maps timeout)**: `routes/matches.ts` — `_latest_end_at_sec` добавлен
  в `psRunningToLiveShape` + `enrichWithPandaScoreRunning`; `dropStaleBetweenMaps()`
  с `BETWEEN_MAPS_TIMEOUT_MS=20min` применён к обоим веткам /live (kept + ml-enriched).
- **B4 (PandaScore filter)**: PS upcoming endpoint фильтрует матчи с `winner_id` ≠ null
  и без обоих opponent.name.
- **P1 (Daily Ingest)**: `scripts/run-daily.sh` переписан на 11 шагов в правильном
  порядке (добавлены hero-matchups, hero-synergy, player-glicko, team-extended).
- **P5 / Admin manual retrain**: на `dashboard.tsx` добавлена кнопка «Переобучить
  модели» (через `useTriggerAdminRetrain`) с confirm и сообщением о статусе.
  Auto-retrain toggle уже был в `workers.tsx::WorkerFlagsPanel`.
- **A5 sample**: создан `docs/feature-registry.json` (5 примеров: team_glicko,
  team_recent_form_30d_wr, h2h_365d_wr, peer_synergy_diff,
  live_radiant_networth_advantage). Ждём подтверждения формата перед расширением
  до всех ~80 фич и подключением к UI на `/metrics`.

Typecheck: api-server / admin-web / mobile — все зелёные.

## 2026-05-16 (день) — T0.5a Stratz live enrichment подключён

Live snapshot теперь обогащается данными Stratz live API параллельно с OpenDota:

- **Schema (live_snapshots)**: добавлены nullable JSONB-колонки `stratzMatchMeta`
  (avgRank, gameState, gameMinute, delay, roshanRespawnSec, liveWinRateRadiant,
  prematchWinRateRadiant, prematchDurationMin), `stratzPlayers` (массив 10
  rich per-player записей: gold/networth/xpm/gpm/items/respawn/impPerMinute),
  precomputed `xpAdvantage` (Σ R.xpm·gameMinute − Σ D.xpm·gameMinute) и
  `networthAdvantage` (Σ R.networth − Σ D.networth), а также таймстамп
  `stratzFetchedAt` (null если fetch упал).
- **Client `lib/stratzLive.ts`**: GraphQL `live.match(id)` запрос; round-robin
  токенов через `ApiKeysService.getStratzToken()`; fetch с 8s timeout, при
  CF challenge — fallback на curl (зеркало `scripts/lib/stratz.ts`);
  in-memory TTL=30s cache per matchId; circuit-breaker (20 подряд null →
  30 мин cooldown, чтобы не выжигать квоту при пустом апстриме); INFO-лог
  null'ов rate-limited 1/10.
- **LiveWorker**: `fetchLiveMatchDetailBatch(changed.map(id), concurrency=4)`
  параллельно с OD-парсингом, merge в snapshot row перед insert. Fail-soft —
  упавший Stratz fetch → snapshot без Stratz-полей. Лог-тэг `stratz-live`
  печатает `requested/enriched` каждый poll.

**Cleanup**: `aegis_holder`, `buyback_log`, `vision_score`, `teamfight events`
явно помечены **post-mortem only** (через OD replay-parse T0.7) во всех
докуменациях — Stratz live их физически не отдаёт.

**Текущий статус**: код активен, но Stratz live API эпизодически пуст
(см. replit.md). Circuit breaker корректно отрабатывает. Поля начнут
наполняться автоматически когда Stratz восстановит upstream.

**Post-review исправления (architect feedback)**:
- Breaker разделён по классу ошибки: `null_upstream` (20 подряд → 30 мин) и
  `transport_error` (10 подряд → 5 мин). Раньше серия транзиентных 502 от
  CF могла открыть 30-минутный cooldown даже при живом апстриме.
- T0.7 `ingest:parsed` — три записи (match_parsed insert + pro_matches.is_parsed
  update + queue.status update) обёрнуты в одну транзакцию. Раньше прерывание
  процесса между ними оставляло несогласованное состояние.

## 2026-05-16 (день) — OpenDota premium key + T0.7 infra (replay-parse)

**OpenDota key подключён** во все 13 call sites (api-server: LiveWorker,
OutcomeTracker, SchedulerWorker, routes/matches; scripts: ingest-{matches,
teams,leagues,drafts,hero-stats,hero-matchups,players-heroes},
backfill-live-snapshots). Helper `withOpenDotaKey(url)` в
`artifacts/api-server/src/lib/openDotaUrl.ts` + `scripts/src/lib/openDotaUrl.ts`
идемпотентно append'ит `?api_key=...`. Эффект сразу: 0 HTTP 429 в LiveWorker,
`liveMatches` подскочило с 2-3 до 53 за poll, scheduler daily refresh проходит
полностью без падений.

**Фаза A backfill drafts**: новый флаг `--all-365d` у `ingest:drafts` снимает
`MIN_AVG_GLICKO` фильтр и берёт ВСЕ матчи за последние 365 дней без драфта
(~23 270 на момент запуска). Запущено в фоне через setsid (nohup в Replit
tool shells живёт не дольше родительского bash).

**T0.7 infra (replay-parse)** — управляемый pipeline:
- Схема: `pro_matches.is_parsed`/`parsed_at` (2 новые колонки), `match_parse_queue`
  (status: queued/parsed/failed/timeout, attempts, jobId), `match_parsed`
  (одна JSONB-таблица с `payloadSchemaVersion` для эволюции схемы, поля
  players/objectives/teamfights/draftTimings).
- Скрипты: `parse:request` (POST /api/request/{id}, идемпотентно ставит в
  очередь, дефолт 500 матчей за запуск с 0.5s rate-limit) + `ingest:parsed`
  (для queued старше 90s тянет /matches/{id}, при version!=null сохраняет в
  match_parsed; >2h в queued → timeout).
- Admin endpoint `GET /api/admin/parse-queue/stats` — visibility статуса
  очереди, покрытия (proMatchesParsed / proMatchesLast180dParsed), latest
  parsedAt, oldest queued.
- **НЕ подключено в scheduler** — ручной запуск до явного «да» от пользователя.
- **НЕ тренируем модели** на новых post-mortem фичах до накопления покрытия
  ≥80% за 180d (правило из replit.md).

## 2026-05-16 (ночь, 2) — Mobile screens поверх T8/T9 endpoints

Два новых Expo-экрана + nav-кнопки в `app/match/[id].tsx`:

- **`app/match/compare/[ids].tsx`** — T8 сравнение команд. Маршрут
  `/match/compare/<aId>-<bId>`. Дёргает `/api/analytics/team-compare`, рендерит
  две колонки (рейтинг, форма 30/90/weighted, состав/Glicko, стиль/pace,
  энтропия пиков, side-bias) + H2H блок (winsA-winsB, период) + diff-сводка
  «перевес в пользу A/B». Графа недоступна → em-dash в конкретной ячейке;
  весь раздел скрывается если ни одна сторона не отдала данных.
- **`app/match/summary/[id].tsx`** — T9 пост-матч сводка. Маршрут
  `/match/summary/<matchId>`. Дёргает `/api/analytics/match-summary`,
  показывает: prematch outcome (модель, вероятность Radiant, уверенность,
  timestamp), факт+калибровка (победитель, счёт, длительность, попадание/Δ),
  market predictions (свёрнутые по marketType с русскими подписями), агрегат
  live snapshots (count, first/last, game time).

**Навигация в `match/[id].tsx`:** к существующей кнопке `bar-chart`
(сравнение коэффициентов) добавлены `users` (compare команд, показывается
только при валидных числовых team1.id/team2.id) и `file-text` (summary). У
всех трёх — `accessibilityLabel` + `accessibilityHint` для screen-reader'ов.

**Code-review fixes:** убран синтез «Radiant vs Dire» когда обе команды null
(теперь явный «Команды не указаны»), добавлены a11y props.

mobile typecheck зелёный.

## 2026-05-16 (ночь) — T3–T11 endpoints + cleanup

Завершён массовый scaffolding T3-T11 без новых ML-тренировок (по правилу
«сначала данные, потом обучение»).

**Новый сервис** `artifacts/api-server/src/services/features/teamProfile.ts` —
агрегирует T3-T7 фичи команды одним вызовом, fail-soft по секциям, pure SQL:
- T3 **seriesMomentum** — активная серия из `bo3_series` + winrate последних серий
- T4 **dynamicForm** — 30d/90d winrate + recency-weighted exp-decay + winStreak
- T5 **eloDecomp** — `avg(player_ratings)` по составу + tierLevel 1/2/3 от `teams.rating`
- T6 **styles** — avgDuration/firstBloodRate/kills для pace + aggression label
- T7 **entropy** — Shannon-нормализованная по picks + radiantBias side-preference

**Новые HTTP endpoints в `routes/analytics.ts`:**
- `GET /api/analytics/team-profile?teamId=N` — отдаёт TeamProfile целиком
- `GET /api/analytics/team-compare?teamAId=&teamBId=` (**T8**) — два профиля +
  `team_h2h` (period_days DESC) + diff-сводка (ratingDelta, weightedFormDelta,
  avgPlayerRatingDelta, tier A/B)
- `GET /api/analytics/match-summary?matchId=N` (**T9**) — `prematch_outcome` +
  calibration (`hit`/`delta`) + последние market predictions свёрнутые по
  marketType + агрегат live_snapshots (first/last/count/lastGameTime)

Smoke-test реальных данных: PARIVISION (id=9572001) — tier-3, weighted form 71%,
entropy 0.93, win streak 6, 6 known players. compare PARIVISION vs Team Falcons
отдаёт оба профиля + diff. match-summary 8813650766 показывает LR-v2 prematch
prob 0.60 → LightGBM v3 переобновил до 0.65 через минуту live.

**T10 Bovada wiring** — уже работало: `BookmakerDropdown` в header
`app/(tabs)/index.tsx`, `filters.bookmaker` в `applyFilters` мержит маркеты
через `rebuildMarketsForBookmaker`. Доделывать нечего пока букмекер один.

**T11 cleanup (частично):**
- Удалён `artifacts/api-server/src/services/PinnacleScraper.ts` (0 импортов).
  `/api/odds/pinnacle/dota2` → stub, отдаёт `noData:true`, чтобы старые клиенты
  не падали на 404.
- Удалён `artifacts/mobile/services/adapters/TheOddsApiAdapter.ts` (0 импортов).
- Удалён `scripts/src/hello.ts` (template-заглушка).
- Inactive lgbm/lr модели в `model_versions` НЕ трогаем — риск регресса.

**T0.7 OD replay-parse** — отложен: OD 429 на Replit-IP блокирует ingest
запросов на post-mortem replay. Вернёмся когда лимит освободится или будет
прокси.

**Что отложено до явного «да» от пользователя:** mobile-экраны
(`app/match/compare/[a]-[b].tsx`, `app/match/[id]/summary.tsx`) поверх новых
endpoints, и любая ML-тренировка. По правилу из replit.md — сначала аудит
датасета, потом одна выборка 365d, потом обучение.

## 2026-05-16 (поздний вечер) — T3.5 live totals LightGBM

До T3.5 показатели «прогноз тоталов на live» были экстраполяцией темпа
(`current_kills / current_min × full_duration`), не ML. Теперь две регрессионные
LightGBM-модели смотрят на live-снапшот и предсказывают **финальный**
`total_kills` и `duration_sec`.

**Новые модели в `model_versions`** (engine='lightgbm', featuresVersion=1):
- `live_total_kills` — regression на `log(final_kills + 1)`. blob 72.3 KB,
  test r2=0.134, rmse=0.246 (log-space), residual_std=0.285.
- `live_total_duration` — regression на `log(final_duration_sec)`. blob 66.5 KB,
  test r2=0.150, rmse=0.239, residual_std=0.266.

**Trainer:** `scripts/src/train-live-totals.ts` (`pnpm --filter @workspace/scripts
run train:live-totals`). JOIN `live_snapshots × pro_matches`, sub-sample до
≤5 снапшотов/матч в окнах [3,8,15,25,40]min, фильтр `game_time_sec ∈ [60,
duration]`. 15 525 joined rows → 1 952 sub-sampled (468 матчей) за 180d окно.

**Feature view v1 (7 фич, OD-only — Stratz xp/nw advantage добавятся в v2 через
~7d после T0.5a):** `[bias, game_min, kills_so_far, kill_rate_per_min,
kill_diff_abs, nw_lead_kgold, building_state_norm]`. Top importance:
nw_lead_kgold > kill_rate_per_min > kill_diff_abs (kills), nw_lead_kgold >
kill_diff_abs > kill_rate_per_min (duration). Физически осмысленно: net-worth
лидерство и темп килов — самые сильные предикторы исхода.

**Inference path:** `services/MarketLgbm.ts::predictLiveTotalsFor(snapshot)` →
`{mean, std}` в log-space + активные версии моделей. LiveWorker вызывает
после snapshot-insert (только при `game_time >= 60`) и пишет 2 строки в
`predictions` per snapshot: `marketType='live_total_kills'|'live_total_duration'`,
`modelProbTeam1=mean`, `modelProbTeam2=std` (переиспользование колонок без
schema migration). Fail-soft — circuit-breaker MarketLgbm покрывает.

**Parity-инвариант:** `buildLiveTotalsFeatures` дублируется в trainer и
api-server, формулы обязаны быть байт-в-байт идентичны (та же дисциплина
ml-contract §3 для LR↔LightGBM). См. doc-comment в обеих копиях.

**Mobile UI интеграция (доделано тем же днём):**
`GET /api/analytics/totals-ladder` получил опциональный `matchId`. Если матч в
live + есть строка `predictions[market_type IN
('live_total_kills','live_total_duration')]` свежее 180с — бэк подменяет
прематч-LGB `(mean, std)` на эту запись, отдаёт `liveSource: true,
modelVersion: lgbm-live_total_*-...` и `confidence: 0.78`. `TotalsLadder.tsx`
теперь передаёт `matchId={match.id}` и при `liveSource` показывает бейдж
«⚡ live-модель (по текущему счёту/нетворту)». Прематч-режим и матчи без
свежего снапшота продолжают работать на прематч-LGB как раньше.

**Не сделано в T3.5 (выносится в follow-up):**
- v2 feature set с Stratz xpAdvantage_kxp / networthAdvantage_kgold после
  накопления `live_snapshots.stratz_match_meta` (~7 дней).
- 50% interval из quantile моделей (как у `market_total_duration_q25/q75`) —
  пока используем log-нормаль `(mean, std)`.

## 2026-05-16 (вечер) — T0.5a Stratz live enrichment

Stratz GraphQL schema introspection показала: Stratz live API **не отдаёт**
`numBuybacks`, `hasAegis`, vision/wards, teamfight events (Valve публикует
realtime лишь то, что есть в game-state JSON — buyback/aegis/vision видны
только в полном replay, который доступен после матча). **Изначальный план T0.5**
(«xp/buybacks/aegis/per-hero gold») пересмотрен: реалистично доступно через
Stratz live только то, что **физически передаётся в стрим**.

**Что добавлено в `live_snapshots` (5 новых колонок, all nullable, fail-soft):**

- `stratz_match_meta` JSONB — avgRank, gameState (PRE/DRAFT/STRATEGY/PLAY/POST_GAME),
  gameMinute, delay, roshanRespawnSec, **liveWinRateRadiant** (Stratz собственная
  live-модель — кандидат на stacking-фичу), prematchWinRateRadiant, prematchDurationMin.
- `stratz_players` JSONB (Array<10>) — per-player gold, goldSpent, networth, gpm, xpm,
  kills/deaths/assists, lastHits/denies, heroDamage, towerDamage, respawnTimer,
  impPerMinute, items (6 slot IDs), level.
- `xp_advantage` integer — Σ(R.xpm)·gameMinute − Σ(D.xpm)·gameMinute, precomputed для
  быстрого использования в ML без перебора JSONB.
- `networth_advantage` integer — Σ R.networth − Σ D.networth.
- `stratz_fetched_at` TIMESTAMPTZ — когда Stratz ответил (null если fetch упал
  или матч не найден в Stratz league API).

**Реализация:**
- `artifacts/api-server/src/lib/stratzLive.ts` — клиент `fetchLiveMatchDetail(id)` +
  батч `fetchLiveMatchDetailBatch(ids, concurrency=4)`. Curl-fallback (TLS-JA3
  bypass) зеркало `scripts/src/lib/stratz.ts`. 30s in-memory TTL cache per match.
- `LiveWorker.pollOnce()` — между дедупом и `db.insert(liveSnapshotsTable)`
  делает Stratz batch и merge'ит результат в каждую row. Fail-soft на каждом
  уровне: упавший fetch → snapshot пишется без Stratz полей.
- Round-robin токен через `ApiKeysService.getStratzToken()`.

**Gotcha найден и исправлен:** Stratz schema требует `live { match(id: $id) }`,
не `match(matchId:)` как было в первой версии query. До исправления — все
fetches возвращали GraphQL error → null. После: матчи которых нет в Stratz
league (pubs/scrims из OD `/api/live`) возвращают `data.live.match: null` —
тоже корректно, snapshot пишется без Stratz полей.

**Что НЕ покрыто T0.5a и переехало в T0.7 (OD replay-parse, post-mortem):**
buybacks (`buyback_log[]`), aegis_holder (chat events), vision_score, teamfight
timeline. Это **архитектурный лимит realtime источников**, не наш баг —
заполнится backfill'ом после конца матча.

Документы синхронизированы: `docs/data-availability-rules.md` §2.4a + §4 +
§6.1 + §8.5, `docs/ml-feature-audit.md` §1.5 + §T0.5a, `replit.md` roadmap.

## 2026-05-16 — T0+T8 mini retrain после обогащения БД

Большая ML-итерация T0→T12. Сегодня закрыты T0 (audit), T1 (`ml-contract.md`),
T2 (`data-availability-rules.md`), T3-T7 spec (`ml-features-spec.md`), T12
(`replit.md` trim 313→168), параллельный трек обогащения БД (drafts 4017→5634,
players-heroes +24%, glicko 893→1093, recent-form/h2h/team-extended пересчитаны),
mini retrain всех 18 bucket'ов (LR×fv×tier + LGBM×fv×tier) с 5 новыми фичами:
`synergy_diff`, `early_game_score_diff`, `late_game_score_diff`,
`counter_bans_diff`, `player_hero_recency_diff` (HERO_DIM=11, EXTRA_DIM=6).

**SOTA после retrain:** `v3/prematch_winner` LGBM **76.8%** (baseline 57.9%),
`v3/prematch_winner_t2` LGBM **79.6%** (baseline 57.9%). Все новые фичи в
importance top-15 — ROI подтверждён.

**Знакомые риски:** `v3/t1` LGBM 60.5% vs LR 71.6% — overfit на 646 примерах,
маршрутизация сейчас предпочитает LGBM (−11 п.п. на t1). `v2/t1` LGBM 51.1% ниже
baseline 56.8% (overfit + drift). Для T8 (large retrain после T0.5/T0.7/T3-T7)
нужен bucket-level switch LGBM↔LR по cross-validated acc или отказ от LGBM на
маленьких bucket'ах. Полная таблица retrain — `docs/ml-feature-audit.md` §T8.

**Новые API хелперы (T2 §8):** `lib/availability.ts` на сервере и в mobile с
едиными константами `FRESH_MS/STALE_SOFT_MS/STALE_HARD_MS/LIKELY_ENDED_MS`
(90s/3min/25min/5min) и `getFieldState()` для 7-state UI. `_field_meta` и
between_maps timeout отложены до CL с T0.5 (одна сетевая правка).

## 2026-05-14 — Live drafts enrichment + icons

OpenDota `/api/live` пики/баны не отдаёт, но `/api/matches/{id}` возвращает
`picks_bans` уже на стадии драфта (до старта матча) и обновляет их по ходу.
В `routes/matches.ts` добавлен `enrichLiveMatchesWithDrafts`:

- Параллельный фетч (concurrency=4) `/matches/{id}` для всех pro-live с валидным `match_id`.
- Per-match in-memory cache 60s + bounded LRU 200 записей (~1MB макс).
- Hero names из `hero_stats` (lazy cache 1h, fallback `Hero #${id}`).
- Маппинг team=0→radiant, team=1→dire; раздельные массивы picks/bans.
- Fail-soft: упавший фетч → матч без `draft`, UI показывает «Драфт ещё не стартовал».
- На клиенте `LiveDataService.openDotaToMatch` собирает `Draft` объект; synergy/counter/scaling = 0.5.

**Icon fonts:** `@expo/vector-icons` (Feather/MaterialCommunityIcons/Ionicons) на вебе и
при первом старте на нативе нужно явно регистрировать через `useFonts({ ...Feather.font, ... })`
— без этого иконки рендерятся пустыми квадратами. Добавлено в `app/_layout.tsx`.

**Прогрессивная отрисовка списка матчей:** `fetchLiveData(cbs)` принимает колбэки
`onShellsReady` (карточки появляются мгновенно) и `onMatchEnriched` (ML-предсказания
прилетают по одному в порядке списка — первый матч обогащается первым).

## 2026-05-13 — Wave 5 ML quality

Реализованы 9 улучшений из deep-research-report. Все модели переобучены.

**Live-winner model fv=8:**
- Признаки расширены с 6 до 9: добавлены `is_real_live`, `has_draft`, `recency_days_norm`.
- Временно́й split с 1-day gap + composite score (brier + 0.3×logLoss) для champion selection.
- Test acc=80.2%, Δacc=+22.9pp vs prematch-only baseline, brier=0.145.
- LiveWinnerModel.ts: backward-compat с 6-весовыми моделями (dim-bounded dot product).
- LiveWorker.ts: передаёт `isRealLive=1`, `hasDraft`, `recencyDaysNorm=0`.

**Prematch team features 5→12 dim:**
- Новые: `radiant_side_logit` (logit(radiant WR), ≈+0.08), `recency_days_norm`,
  `series_type_norm` (BO1=0/BO3=0.5/BO5=1), `map_no_norm` (ROW_NUMBER по серии),
  `tier_t1`, `tier_t2`, `tier_t3` (OHE).
- Все 4 train-скрипта (train-model, train-lightgbm) и PredictionModel.ts обновлены.
- LightGBM v3 test: acc=78.5% brier=0.153; v3/t2: acc=78.9% brier=0.155.

**Quantile regression для total_duration:**
- ml-service: `task_type="quantile"` с `alpha` param (LGBMRegressor objective="quantile").
- 2 новые модели: `market_total_duration_q25` (α=0.25) и `market_total_duration_q75` (α=0.75).
- CLI alias `--market total_duration_quantiles` обучает оба за один вызов.

## 2026-05-12 — Live-snapshot backfill + patch-aware training

`live_snapshots` имеет колонку `source` ('live' | 'backfill'). Backfill-снапшоты не прунятся.

- **`backfill:live-snapshots`** — разовый/incremental backfill из OpenDota `/api/matches/{id}`.
  Rate-limit 1200ms/req (~50 матчей/мин). Идемпотентен.
- **Авто-обогащение в SchedulerWorker**: Phase 4.5 — перед `train:live-model` считает
  distinct snapshot-outcome пары. Если < 100 матчей — запускает backfill автоматически
  (--limit 300, ~6 мин).
- **`pruneLiveSnapshots`**: удаляет только `source='live'` строки.
- **`liveSnapshotPruneDays`** = 365 дней.

**Patch-aware training dataset:** `app_settings` хранит:
- `trainWindowDays` (default 365, 30–730) — макс. глубина истории.
- `trainMaxPatches` (default 4, 1–20) — макс. число последних патчей.
- `trainMinSamples` (default 1000, 50–100 000) — минимум для запуска обучения.
- Эффективная граница = `max(windowCutoff, patchCutoff)`. Передаётся во все 4 train-скрипта.

## 2026-05-11 — Production automation (Wave «C») + admin-web

**Auto schema bootstrap** при старте api-server: `ensureSchema()` спавнит
`pnpm --filter @workspace/db run push` если таблиц нет. Отключается `AUTO_DB_PUSH=false`.

**Cold-start retrain**: первый tick шедулера (T+30s) при `pro_matches < 100` запускает
full retrain pipeline сразу.

**Full retrain pipeline (15 шагов)** — при новом патче (через 7 дней) или раз в 30 дней.
Каждый non-critical шаг — в собственном `runScriptSafe`. Падает только при сбое
`ingest:teams`/`ingest:matches`/`train:model`. Все спавны имеют timeout (30 мин,
для compute — 10 мин), SIGTERM→SIGKILL escalation.

**Daily refresh** между full retrain'ами: teams + matches[5] + drafts + players-heroes
+ recent-form + h2h + player-glicko. Все non-fatal.

**Admin web:** артефакт `artifacts/admin-web` (React + Vite, slug `admin-web`,
previewPath `/admin-web/`). Страницы: `/login`, `/`, `/settings`, `/metrics`,
`/operations`. UI на русском, амбер-палитра.

**Admin auth:** `POST /api/admin/login { token }` сравнивает с `ADMIN_TOKEN` через
`timingSafeEqual` (троттл 10/15мин на IP) и выставляет HttpOnly-cookie
`aegis_admin_session` (24h). Все `/api/admin/*` через `requireAdminSession`.
Legacy `X-Admin-Token` header больше не принимается.

**Per-model retrain UI:** `POST /api/admin/models/retrain` (body `{script, label?, market?}`)
+ `runTrainScriptManual` с whitelist'ом скриптов/флагов. Hot-reload в память.

**Admin → внешние API-интеграции с override:** таблица `api_key_overrides (env_name PK, value)`.
`services/ApiKeysService.ts` — единый `getApiKey(name)` с in-memory кешем (TTL 30s) и fallback
ENV→override. `KNOWN_INTEGRATIONS` (11 записей с `howToGet` инструкциями).
Endpoints `GET/PUT /api/admin/integrations`.

**Букмекеры (6 источников):** Fonbet, Лига Ставок, PARI, BetBoom, 1xStavka, Olimp.bet.
Управляется ENV-флагом `BOOKMAKERS_ENABLED=true` (default false).
При выключенном флаге → HTTP 503. На РФ-проде включается без `PROXY_URL`.

## 2026-05-11 — Миграция из старого workspace

- Старый Postgres был внутренним и недоступен — DB пересобрана с нуля через
  `pnpm --filter @workspace/db run push`.
- Код восстановлен из public GitHub repo (`Kaas2110/Market-Edge`) поверх
  scaffold'ов monorepo.
- `ADMIN_TOKEN` перевыпущен (старый, утёкший в чате, инвалидирован).

## Wave 3 «proper» — per-player Glicko (DONE для v3 LR)

Таблица `player_ratings` (account_id PK, rating, rd, games, wins, last_match_*).
`compute:player-glicko` крутит Glicko-1 multi-opponent batch updates по
pro_matches × match_drafts (RD time-decay c=63, period=30d). 5-я v3-extra фича —
`player_glicko_diff = (avg(rad) − avg(dire)) / 200`. v3 dim 16 → **17**.

Активно: LR v3 (`prematch_winner` + `prematch_winner_t2`). LightGBM v3 пока
заблокирован объёмом данных (нужно ≥80 матчей с обоими полными account_ids).

## Wave 4 — ML upgrade → gradient boosting (DONE для prematch + derived markets)

- `artifacts/ml-service` (FastAPI + LightGBM + sklearn IsotonicRegression).
- `model_versions.engine` enum logreg|lightgbm + binary_blob bytea.
- Тренировка: 12 prematch jobs (3 fv × 4 buckets) + 3 market jobs.
- Inference: HTTP, 200ms timeout, 60s circuit-breaker per-domain, фолбэк на logreg.
- Per-(rId,dId) кеш market-предсказаний 60s.
- Wired в `routes/analytics.ts::popular-markets` (FB/totals override) и `totals-ladder`
  (per-line override через `probLogNormalOver`).

## 2026-05-16 — T12: trim replit.md → changelog

В рамках большой ML-итерации (план T0→T12) сжали `replit.md` со 313 до ~140 строк.
Перенесены сюда DONE-блоки 2026-05-14 и 2026-05-15. В `replit.md` остался только
живой контракт: stack, скрипты, env, API-эндпоинты, user preferences, pointers,
активный roadmap.

## 2026-05-15 — Email-аутентификация (User-auth)

Добавлен User-auth (email + password) для мобильного клиента — Apple/Google
Sign-In появятся только после публикации в App Store / Play.

**Server (`routes/userAuth.ts`):**
- `POST /api/auth/register` { email, password } → 201 `{ token, user }`
- `POST /api/auth/login` { email, password } → 200 `{ token, user }`
- `POST /api/auth/logout` → 200 `{ ok: true }` (stateless, для логирования)
- `GET /api/auth/me` `Authorization: Bearer <token>` → `{ user }`

Пароли: `scrypt(N=16384, keylen=64)` из `node:crypto`, хранение `${salt}$${hash}`.
Токен: `${userId}.${expiresAtMs}.${hmacSha256(SESSION_SECRET)}` — stateless,
TTL 30 дней. Login защищён от timing side-channel (всегда тратим время на verify).
Per-IP throttle 20 попыток / 15 мин.

**DB (`lib/db/src/schema/users.ts`):** таблица `app_users` (id, email,
password_hash, created_at, last_login_at). Уникальный индекс по `lower(email)`.

**Mobile:** `services/AuthService.ts` (AsyncStorage обёртка), `context/AuthContext.tsx`
(`useAuth()` hook, гидратация токена + фоновый `/me` для проверки), `app/auth.tsx`
(login/register с переключателем mode), `app/index.tsx` (роутинг
`onboarding → auth → (tabs)`), карточка «Аккаунт» в `app/(tabs)/settings.tsx`
с email и кнопкой «Выйти».

ENV: `SESSION_SECRET` обязателен (используется и для admin-сессий).

## 2026-05-15 — Перерыв между картами + честные прогнозы

Серия BO3/BO5 после конца карты висит в "перерыве" 1–5 мин до старта следующей.
В это окно OD и PandaScore рассинхронизированы: OD ещё помнит прошлую карту
(может вернуть `game_time>0` и старый draft), PandaScore уже показывает новую
(`begin_at` будущее). Раньше UI видел "ЛАЙВ N:NN" со старыми героями и 50/50
прогнозом — пользователь не понимал, что происходит.

**Server (`routes/matches.ts`):** `enrichWithPandaScoreRunning` сравнивает OD live +
PS running с tolerance 60s. Если PS считает матч начавшимся, а OD ещё показывает
старую карту — ставим `between_maps: true` на OD-объекте. `psRunningToLiveShape`
(PS-only fallback) тоже проставляет `between_maps` если `begin_at > now`.
`enrichLiveMatchesWithDrafts` пропускает `between_maps:true` матчи (OD-драфт
принадлежит прошлой карте).

**Mobile:** `MatchStatus = 'live' | 'between_maps' | ...`. `MatchCard` рисует
пилюлю «ПЕРЕРЫВ» вместо «ЛАЙВ N:NN», скрывает counter. Detail header показывает
«ПЕРЕРЫВ» + score по картам (не по убийствам). Detail tab «Прогнозы» — «Прогноз
недоступен — перерыв». HomeScreen фильтр «Live» включает `between_maps`.
`NotificationService.isLiveLike` тоже включает `between_maps`.

## 2026-05-15 — Map_winner labelRu + честный draft

Три связанных бага: (1) на 3-й карте серии 1-1 рынок назывался «Победитель карты 1»
(сервер хардкодил mapNumber=1); (2) match_winner регулярно был 50/50 даже когда
ELO команд явно разный; (3) Draft Score block был полностью скрыт.

**Root cause 50/50:** `openDotaToMatch` в LiveDataService строил `draftFromOd` со
**stub-значениями 0.5/0.5** для synergy/counter/scaling/early. Мобилка слала их
в `/api/analytics/predict` как `draft.synergy1=0.5,...`, и
`BetTypeModels.predictMatchWinner` тянул вероятность к 50/50.

**Fixes:** `AnalyticsEngine.MatchInput.seriesContext` принимает `currentMapNumber`,
дефолт `s1+s2+1`. Мобилка шлёт `seriesContext` с `seriesScore1/2 + currentMapNumber`.
Мобилка **НЕ шлёт stub-draft**: если все 8 значений === 0.5, поле опускается → сервер
падает на чистый ELO + form + h2h. Detail screen: блок Draft Score показывает
ActivityIndicator + текст «Синергия и контрпики считаются на бэкенде — для этого
матча данные ещё не готовы».

TODO (future): реальные synergy/counter/scaling/early считать на бэке из
`hero_matchups` + `hero_stats` + draft picks (есть в схеме, не используется в
`/predict`). Тогда блок будет наполняться автоматически.

## 2026-05-14 — UX поведение списка (v2): прогрессивная отрисовка + ordered emission

`fetchLiveData(cbs)` поддерживает прогрессивную отрисовку с параллельным
обогащением и ordered emission:

1. После `/api/matches/live` + `/api/matches/upcoming` колбэк `onShellsReady`
   получает скелеты — карточки появляются мгновенно, без ML. Под карточками
   `MatchCard.tsx` показывает «Данные собираются, скоро выдадим прогноз».
2. Bounded parallel pool (concurrency=3) обогащает live + prematch одновременно.
   Прематч-предикты кэшируются на сервере 4 часа
   (`predict:prematch:${matchId}:${t1}:${t2}:${format}`).
3. Ordered emission: `onMatchEnriched(em, i)` вызывается строго в порядке index
   через буфер. UX-инвариант «первая карточка обновляется первой» сохраняется.
4. AbortSignal: новый `loadData` отменяет старый цикл; внутри fetchAnalytics
   локальный 5s timeout + поддержка внешнего signal.

## 2026-05-14 — BookmakerWorker (smart wake-up 2026-05-15)

`services/BookmakerWorker.ts` — фоновый поллер букмекеров с тремя режимами:
- **live** — есть ≥1 live pro-матч → next tick через 3 мин
- **wake_for_start** — live=0, ближайший upcoming <60 мин → next tick на `(begin_at + 30s)`
- **idle** — live=0 и нет upcoming в окне 60 мин → next tick через 60 мин

Воркер автономен, делает loopback `fetch` к `/api/matches/live` и `/upcoming` через
withCache. Первый tick через 5s после старта. Per-source ошибки скипаются silently.

ENV: `DISABLE_BOOKMAKER_WORKER=true` или `BOOKMAKERS_ENABLED=false` отключают.
Stats: `GET /api/bookmakers/status`. Лог: `[bookmaker-worker] tick complete`.

**Per-match lookup:** `GET /api/bookmakers/for-match?team1=X&team2=Y[&team1Id=&team2Id=]`
— in-memory lookup из кэша воркера, корректно flip ориентации (winner/firstBlood).
Когда РФ-IP — 6 РФ-источников начнут отдавать данные автоматически без правок кода.

## 2026-05-14 — Live-воркер dedup (skippedUnchanged)

`LiveWorker.pollOnce` хеширует game_time + scores + radiant_lead + building_state +
draft (sorted heroes/accounts) и пропускает матчи с неизменившимся хешем. In-memory
`Map<matchId,hash>` чистится от завершённых матчей каждый тик. Stat
`skippedUnchanged` в `getWorkerStats()`. Без этого на каждый 60s-tick OpenDota
со stale-данными плодились дубликаты в `live_snapshots` / `predictions`.

## 2026-05-17 — peer_synergy фича добавлена в team_extended

- В `teamExtendedFeaturesTable` добавлена колонка `peer_synergy real` (0..1, null если данных мало).
- `compute:team-extended` теперь считает per-team peer-synergy: top-5 account_ids по играм за 365d → mean попарный winrate из `player_peers` (взвешен по games, мин. 10 совместных игр на пару, мин. 3 пары иначе null). Заполнено 1451/1998 команд.
- `EXTENDED_TEAM_FEATURE_DIM` поднят 6 → 7 (новая фича `peer_synergy_diff`, clipped ±0.4). Зеркальные правки в `scripts/src/lib/team-extended.ts` и `artifacts/api-server/src/lib/team-extended.ts`.
- `train:lightgbm`: историческим as-of снапшотам peer_synergy патчится из текущих значений (ростер топ-команд стабилен ~6мес, full chronological tracking слишком дорог). Команды без peer_synergy → 0 (нейтрал).
- Ретрейн всех LightGBM v1/v2/v3 × {fallback, t1, t2} 9 моделей. `peer_synergy_diff` попал в top-3 importance у v2/fallback (102), v2/t1 (72), v2/t2 (45); top-15 у v3/t1 (28); у v3/fallback/t2 за пределами top-15 (доминируют h2h + player_skill). Метрики: v3/fallback test_acc 76.7% (baseline 77.4%, в пределах ±2-3pp шума), v3/t2 79.6% (улучшение), v3/t1 63.7% (улучшение с 61.3% baseline).
- Также перетренированы market models (FB / total_kills / total_duration ± q25/q75) и live-winner v8 (acc 70.0%, brier 0.223, lift +17.13pp над прематч-baseline).

## 2026-05-17 — Фаза 8 D1+D2 DONE, P5 безопасная активация на ноуте

**D1 — FEATURE_VIEW_VERSION (единый источник правды о fv):**
- Новый файл `lib/db/src/feature-view.ts` экспортирует `FEATURE_VIEW.PREMATCH=3`,
  `LIVE_WINNER=1`, `LIVE_TOTALS=1`, `MARKET=1` + хелпер `currentFeatureViewFor(kind)`.
- `PredictionModel.loadActiveModel()` логирует warning `running on STALE featureView`
  если активная surface-модель имеет `featuresVersion < CURRENT`.
- Admin endpoint `/api/admin/models/:id/calibration` отдаёт `featureView: {modelFv, currentFv, stale}`.
- Admin UI `pages/models.tsx`: третья ячейка «Feature View» с amber-бордером + иконкой
  AlertTriangle когда `stale=true`.

**D2 — drift alarms:**
- `scripts/src/train-lightgbm.ts` сохраняет полный массив drift'ов (|Δrel|>10%)
  в `model_versions.metadata.drifts` (структура `{name, trainMean, testMean, rel}`).
- Admin endpoint `/admin/models/:id/calibration` возвращает поле `drifts` top-15
  по |rel|. OpenAPI schema `AdminModelDriftItem` + `AdminModelFeatureViewBlock`.
- Admin UI: новый блок «Data drift · top N» с горизонтальными бар-чартами,
  amber-подсветкой при |rel|>20%, summary-строкой про severe drifts.

**P5 — Auto-retrain safety gate (двухуровневый):**
- `SchedulerWorker.checkAutoRetrainGate()`: (1) `DISABLE_AUTO_RETRAIN=true` —
  killswitch (как раньше), (2) `AUTO_RETRAIN_CRON_HOUR_UTC=<0..23>` — обучение
  разрешено только в указанный час UTC. На Replit `DISABLE_AUTO_RETRAIN=true`
  остаётся (не мешаем cron-workflow'ам наполнения БД). На ноуте: kill снят +
  `AUTO_RETRAIN_CRON_HOUR_UTC=4` (~7 утра МСК).
- `lastTrainAt` НЕ обновляется при skipped — после снятия флага следующий retrain
  идёт без 30d-отложки.

Typecheck зелёный, server поднимается без warning'ов (активный fv=3=current).
