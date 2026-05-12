# Feature list для обучения моделей Dota 2: Prematch и Live

**Версия:** 1.0  
**Дата:** 2026-05-13  
**Назначение:** описание набора фичей, логики формирования обучающей выборки и приоритетного плана развития ML-моделей для анализатора событий Dota 2.

---

## 1. Ключевой вывод

Текущий Aegis уже имеет рабочую MVP-базу: prematch-модели, live winner-модель и market-модели. Но для полноценного prediction engine (движка прогнозирования), особенно под букмекерские события, feature set (набор признаков) нужно расширять в трех слоях:

1. **Prematch layer** — сила команд, составы, игроки, форма, патч, стиль, турнир.
2. **Draft layer** — пики, баны, matchup, synergy, comfort, timing curve.
3. **Live layer** — networth, XP, kills, objectives, Roshan, items, buybacks, vision, momentum.

Главный принцип: каждая фича должна иметь:

| Поле | Зачем нужно |
|---|---|
| `as_of_ts` | момент, на который фича была известна |
| `source` | источник данных |
| `source_age_sec` | возраст данных на момент прогноза |
| `missing_flag` | признак отсутствия данных |
| `window` | окно агрегации |
| `feature_version` | версия логики расчёта |

Без этого модель будет неуправляемой: offline-метрики будут выглядеть хорошо, а в live-контуре качество начнёт разваливаться из-за leakage (утечки будущей информации), missingness (пропусков) и online/offline skew (расхождения train и production данных).

---

## 2. Как формируется обучающая выборка

---

## 2.1. Prematch-модели

**Единица обучения:** одна карта Dota 2.

Одна строка датасета:

```text
match_id + map_no
```

**Момент фиксации фичей:** до начала карты.

Нельзя использовать ничего, что стало известно после `map_start_ts`:

- фактические события карты;
- итоговые киллы;
- длительность карты;
- итоговые объекты;
- Roshan;
- сломанные башни;
- win/loss после старта;
- full draft, если модель должна работать до драфта.

### Базовая структура строки

| Поле | Что означает |
|---|---|
| `match_id` | ID карты |
| `series_id` | ID серии BO1/BO3/BO5 |
| `map_no` | номер карты в серии |
| `radiant_team_id` | команда Radiant |
| `dire_team_id` | команда Dire |
| `scheduled_start_ts` | плановое время старта |
| `actual_start_ts` | фактическое время старта, если доступно |
| `patch_id` | версия патча |
| `tournament_id` | турнир |
| `tournament_tier` | T1/T2/T3 |
| `features_as_of_ts` | момент, на который собраны признаки |
| `target` | целевой исход, например Radiant win = 1 |

---

## 2.2. Draft-модели

**Единица обучения:** карта + состояние драфта.

Одна карта может дать несколько строк:

| Стадия | Что известно |
|---|---|
| до драфта | команды, турнир, патч, рейтинги |
| после первых банов | добавлены первые баны |
| после первых пиков | добавлены первые пики |
| после каждой следующей фазы | добавляется новое состояние драфта |
| после полного драфта | известны все 10 героев и все баны |

**Цель:** обновлять вероятность победы по мере появления пиков и банов.

Пример строки:

```text
match_id + map_no + draft_phase_id
```

### Базовая структура строки draft-модели

| Поле | Что означает |
|---|---|
| `match_id` | ID карты |
| `series_id` | ID серии |
| `map_no` | номер карты |
| `draft_phase_id` | стадия драфта |
| `radiant_picks_so_far` | известные пики Radiant |
| `dire_picks_so_far` | известные пики Dire |
| `radiant_bans_so_far` | известные баны Radiant |
| `dire_bans_so_far` | известные баны Dire |
| `pick_order_state` | последовательность пиков/банов |
| `features_as_of_ts` | момент расчёта признаков |
| `target` | итог карты |

---

## 2.3. Live-модели

**Единица обучения:** snapshot (снимок состояния карты) в конкретный момент времени.

Одна карта = много строк:

| Время | Пример строки |
|---|---|
| 0:00 | старт карты |
| 3:00 | первый live snapshot |
| 6:00 | следующий snapshot |
| 9:00 | следующий snapshot |
| ... | до конца карты |

Пример ключа строки:

```text
match_id + map_no + snapshot_ts
```

### Target для live-моделей

| Модель | Target |
|---|---|
| `live_winner` | Radiant win в конце карты |
| `next_roshan` | кто заберёт следующего Roshan |
| `next_tower` | какая команда сломает следующую башню |
| `total_kills_over_45_5` | итоговые убийства > 45.5 |
| `duration_over_38_5` | длительность карты > 38.5 минут |
| `next_5_min_kills` | количество убийств в следующие 5 минут |
| `next_objective_team` | команда, которая заберёт следующий объект |

---

# 3. Общие правила формирования фичей

---

## 3.1. Point-in-time join

Все фичи должны собираться **строго на момент прогноза**.

Например:

- если матч начался 13 мая в 18:00, prematch-фичи считаются только по данным до 18:00;
- если live snapshot на 12-й минуте, используются только события до 12-й минуты;
- нельзя подтягивать итоговую статистику карты в признаки, даже если она лежит в базе.

Это критично. Иначе модель будет ловить leakage (утечку будущей информации) и покажет красивую, но фейковую точность.

---

## 3.2. Окна агрегации

### Для prematch

| Окно | Зачем |
|---|---|
| последние 5 карт | текущая форма |
| последние 10 карт | короткий тренд |
| последние 20 карт | средняя форма |
| последние 30 дней | актуальная мета |
| последние 90 дней | стабильная сила |
| последние 365 дней | широкий historical baseline |

### Для live

| Окно | Зачем |
|---|---|
| последние 10 секунд | микро-события |
| последние 30 секунд | короткий импульс |
| последние 60 секунд | текущий tempo |
| последние 180 секунд | макро-сдвиг |
| последние 5 событий | event momentum |
| последние 10 событий | динамика карты |

---

## 3.3. Правила нормализации

| Тип фичи | Как нормализовать |
|---|---|
| Рейтинги | разница рейтингов / 200 или z-score |
| Winrate | Bayesian smoothing |
| Count-фичи | `log1p(value)` |
| Длительность | минуты или часы, затем robust z-score |
| Networth diff | делить на 10 000 |
| Kill diff | делить на 20 |
| Time features | делить на 3600 или использовать phase bucket |
| Hero IDs | one-hot, embedding или set representation |
| Categorical features | target encoding / one-hot / embeddings |
| Missing values | не заменять молча на 0; добавлять `has_feature` и `missing_reason` |

---

# 4. Prematch feature list

---

## 4.1. Контекст матча

| Фича | Как формируется |
|---|---|
| `bo_type` | BO1/BO3/BO5 из расписания турнира |
| `map_no` | номер карты в серии |
| `is_decider_map` | 1, если это решающая карта серии |
| `tournament_tier` | T1/T2/T3 по турниру и силе команд |
| `region` | регион турнира или команд |
| `lan_flag` | 1, если LAN, 0 если online |
| `stage_type` | group/playoff/final/qualifier |
| `days_since_last_match_radiant` | дней с последней карты Radiant |
| `days_since_last_match_dire` | дней с последней карты Dire |
| `rest_diff` | разница отдыха между командами |
| `same_day_maps_before_radiant` | сколько карт Radiant уже сыграли в этот день |
| `same_day_maps_before_dire` | сколько карт Dire уже сыграли в этот день |
| `time_of_day_local` | локальное время старта |
| `travel_region_shift` | смена региона/часового пояса для LAN |

**Зачем:** одна и та же команда по-разному играет BO1 online qualifier и BO5 LAN final.

---

## 4.2. Рейтинг и сила команд

| Фича | Как формируется |
|---|---|
| `elo_radiant` | рейтинг команды до матча |
| `elo_dire` | рейтинг команды до матча |
| `elo_diff_norm` | `(elo_radiant - elo_dire) / 200` |
| `glicko_mu_radiant` | средняя сила команды по Glicko |
| `glicko_mu_dire` | аналогично для Dire |
| `glicko_mu_diff` | разница Glicko-рейтингa |
| `glicko_sigma_radiant` | неопределенность рейтинга Radiant |
| `glicko_sigma_dire` | неопределенность рейтинга Dire |
| `glicko_sigma_diff` | разница неопределённости рейтинга |
| `trueskill_mu_diff` | разница TrueSkill |
| `trueskill_sigma_diff` | разница неопределенности TrueSkill |
| `team_rating_momentum_radiant` | изменение рейтинга за 30 дней |
| `team_rating_momentum_dire` | изменение рейтинга за 30 дней |
| `strength_of_schedule_30d` | средняя сила соперников за 30 дней |
| `strength_of_schedule_90d` | средняя сила соперников за 90 дней |
| `opponent_quality_index_diff` | разница качества последних соперников |
| `rating_volatility_radiant` | волатильность рейтинга Radiant |
| `rating_volatility_dire` | волатильность рейтинга Dire |

**Рекомендация:** не делать отдельные T1/T2/T3-модели как основные. Лучше shared model (общая модель) + tier-фича + иерархический rating prior (рейтинг-приор). Иначе на T1 будет оверфит из-за малого объема данных.

---

## 4.3. Форма команды

| Фича | Как формируется |
|---|---|
| `winrate_5_maps_radiant` | победы Radiant за последние 5 карт |
| `winrate_10_maps_radiant` | победы за последние 10 карт |
| `winrate_20_maps_radiant` | победы за последние 20 карт |
| `winrate_5_maps_dire` | аналогично для Dire |
| `winrate_10_maps_dire` | аналогично |
| `winrate_20_maps_dire` | аналогично |
| `recent_form_diff_5` | разница winrate за 5 карт |
| `recent_form_diff_10` | разница winrate за 10 карт |
| `recent_form_diff_20` | разница winrate за 20 карт |
| `stomp_rate_radiant` | доля быстрых побед с большим преимуществом |
| `stomp_rate_dire` | аналогично |
| `comeback_rate_radiant` | доля побед после отставания |
| `comeback_rate_dire` | аналогично |
| `throw_rate_radiant` | доля поражений после преимущества |
| `throw_rate_dire` | аналогично |
| `avg_game_duration_radiant` | средняя длительность карт |
| `avg_game_duration_dire` | аналогично |
| `avg_kills_per_map_radiant` | средние убийства |
| `avg_kills_per_map_dire` | аналогично |
| `avg_deaths_per_map_radiant` | средние смерти |
| `avg_deaths_per_map_dire` | аналогично |
| `avg_gold_diff_10m` | среднее преимущество по золоту к 10 минуте |
| `avg_gold_diff_20m` | среднее преимущество по золоту к 20 минуте |
| `avg_xp_diff_10m` | среднее преимущество по опыту к 10 минуте |
| `avg_xp_diff_20m` | среднее преимущество по опыту к 20 минуте |

**Как считать корректно:** все winrate через Bayesian smoothing (байесовское сглаживание), чтобы 2 победы из 2 карт не превращались в “100% силу”.

---

## 4.4. Roster-фичи

| Фича | Как формируется |
|---|---|
| `stable_five_flag` | 1, если текущая пятёрка играла вместе N карт |
| `days_since_roster_change` | дней с последнего изменения состава |
| `standin_flag` | 1, если есть замена |
| `standin_role` | роль stand-in игрока |
| `sub_count_30d` | количество замен за 30 дней |
| `shared_maps_core3` | сколько карт сыграли вместе 3 ключевых игрока |
| `shared_maps_core5` | сколько карт сыграли вместе все 5 |
| `captain_changed_flag` | сменился ли капитан/драфтер |
| `avg_player_tenure_days` | среднее время игроков в составе |
| `roster_stability_score` | агрегированный индекс стабильности |
| `new_roster_maps_played` | сколько карт сыграно текущим составом |
| `roster_winrate_current_5` | winrate именно текущего состава |
| `roster_winrate_current_10` | winrate текущего состава за 10 карт |
| `org_vs_roster_rating_gap` | разница рейтинга организации и текущего состава |

**Это P0-блок.** В Dota 2 сила “организации” без состава часто мусорная. Команда после решафла — это фактически другая команда.

---

## 4.5. Игроки и роли

| Фича | Как формируется |
|---|---|
| `avg_player_rating_radiant` | средний рейтинг 5 игроков |
| `avg_player_rating_dire` | средний рейтинг 5 игроков |
| `player_rating_diff` | разница средних рейтингов |
| `core_rating_diff` | разница рейтингов pos1/pos2/pos3 |
| `support_rating_diff` | разница рейтингов pos4/pos5 |
| `mid_rating_diff` | разница mid players |
| `carry_rating_diff` | разница carry players |
| `offlane_rating_diff` | разница offlane players |
| `pos4_rating_diff` | разница pos4 |
| `pos5_rating_diff` | разница pos5 |
| `role_entropy_radiant` | насколько стабильно игроки играют свои роли |
| `role_entropy_dire` | аналогично |
| `lane_pair_stability` | стабильность пар safe lane/offlane |
| `player_form_10_maps_diff` | форма игроков за 10 карт |
| `player_patch_delta_diff` | изменение качества игроков на текущем патче |
| `captain_rating_diff` | разница качества капитанов/драфтеров |
| `mid_lane_dominance_diff` | разница доминации mid lane |
| `carry_farm_efficiency_diff` | разница farm efficiency carry |
| `support_impact_diff` | разница impact саппортов |

**Особенно важны:** mid/carry/offlane diffs. В Dota 2 равная команда с сильным mid может иметь огромный edge на карте.

---

## 4.6. Командный стиль

| Фича | Как формируется |
|---|---|
| `kills_per_min_radiant` | убийства в минуту |
| `kills_per_min_dire` | убийства в минуту |
| `deaths_per_min_radiant` | смерти в минуту |
| `deaths_per_min_dire` | смерти в минуту |
| `fight_frequency_radiant` | частота драк |
| `fight_frequency_dire` | частота драк |
| `farm_priority_core1` | доля networth у carry |
| `farm_priority_core2` | доля networth у mid |
| `farm_gini` | концентрация экономики внутри команды |
| `first_blood_rate` | частота first blood |
| `tower_by_10_rate` | частота первой башни до 10 минуты |
| `tower_by_15_rate` | частота первой башни до 15 минуты |
| `roshan_control_rate` | доля первых Roshan |
| `highground_success_rate` | успешность заходов на highground |
| `avg_smokes_per_game` | среднее число smoke plays |
| `vision_control_score` | индекс контроля карты |
| `split_push_index` | склонность к split-push |
| `five_man_timing_rate` | склонность собираться впятером к timing push |
| `late_game_preference` | склонность играть в late game |
| `early_snowball_score` | способность быстро разгонять преимущество |

**Применение:** эти фичи нужны не только для winner, но и для total kills, duration, first blood, first tower, Roshan markets.

---

## 4.7. Patch/meta-фичи

| Фича | Как формируется |
|---|---|
| `patch_id` | текущий патч |
| `major_patch_id` | крупная версия патча |
| `minor_patch_id` | минорная версия патча |
| `patch_age_days` | сколько дней патчу |
| `days_since_hotfix` | дней с последнего мини-патча |
| `meta_volatility_index` | насколько сильно изменилась мета |
| `hero_meta_shift_score` | насколько пул команды совпадает с новой метой |
| `team_patch_winrate` | winrate команды на текущем патче |
| `player_patch_winrate` | winrate игроков на текущем патче |
| `hero_pool_patch_fit` | насколько комфортные герои команды сильны в патче |
| `patch_sample_size_team` | сколько карт команды на текущем патче |
| `patch_sample_size_player` | сколько карт игроков на текущем патче |
| `patch_tempo_avg` | средний tempo патча |
| `patch_duration_avg` | средняя длительность карт на патче |
| `patch_kills_avg` | среднее количество убийств на патче |

**Критично:** не использовать только hard cutoff 365 дней. Лучше decay-weighted sampling (выборка с затухающим весом): свежие карты имеют больший вес, старые — меньший.

---

## 4.8. Head-to-head и style clash

| Фича | Как формируется |
|---|---|
| `h2h_maps_365d` | сколько карт команды сыграли за год |
| `h2h_winrate_radiant` | winrate Radiant против Dire |
| `h2h_advantage` | `(h2h_wr - 0.5) × log(games + 1)` |
| `h2h_roster_aware_maps` | карты именно текущих составов |
| `h2h_org_aware_maps` | карты организаций без учета состава |
| `style_cosine_distance` | насколько стили команд различаются |
| `tempo_clash_score` | fast-paced команда против slow-paced |
| `draft_denial_matchup` | насколько одна команда банит героев другой |
| `region_clash_flag` | межрегиональный матчап |
| `lane_style_clash_score` | конфликт стилей по линиям |
| `late_game_clash_score` | одна команда любит late game, другая — ранний темп |

**Важно:** h2h должен быть roster-aware (с учетом состава), иначе исторические игры старого состава будут загрязнять модель.

---

# 5. Draft feature list

---

## 5.1. Hero pool и comfort

| Фича | Как формируется |
|---|---|
| `hero_pool_entropy_radiant` | ширина пула героев команды |
| `hero_pool_entropy_dire` | аналогично |
| `comfort_pick_score_radiant` | насколько пики комфортны игрокам |
| `comfort_pick_score_dire` | аналогично |
| `signature_hero_count` | число сигнатурных героев |
| `player_hero_games_sum` | суммарный опыт игроков на выбранных героях |
| `player_hero_winrate_adj` | winrate игрока на герое минус глобальный winrate героя |
| `hero_role_flex_prob` | вероятность, что герой может играть разные роли |
| `comfort_diff` | разница comfort score между командами |
| `out_of_pool_pick_count` | число героев вне привычного пула |
| `forced_pick_score` | насколько команда вынуждена брать неудобных героев |
| `signature_denied_before_pick` | были ли закрыты сигнатурные герои до пика |

---

## 5.2. Сила пиков

| Фича | Как формируется |
|---|---|
| `radiant_pick_strength` | сумма pro winrate выбранных героев Radiant |
| `dire_pick_strength` | сумма pro winrate выбранных героев Dire |
| `pick_strength_diff` | разница |
| `radiant_meta_score` | сумма pick rate героев Radiant |
| `dire_meta_score` | сумма pick rate героев Dire |
| `meta_score_diff` | разница |
| `radiant_contested_pick_score` | насколько герои были приоритетными в мете |
| `dire_contested_pick_score` | аналогично |
| `hero_patch_winrate_sum_radiant` | суммарная сила героев на текущем патче |
| `hero_patch_winrate_sum_dire` | аналогично |
| `hero_tier_sum_radiant` | сумма tier-рейтингa героев |
| `hero_tier_sum_dire` | аналогично |

---

## 5.3. Matchup и synergy

| Фича | Как формируется |
|---|---|
| `matchup_advantage` | сумма преимуществ по всем 25 парам героев 5×5 |
| `lane_matchup_score` | оценка линий: safe/offlane/mid |
| `mid_matchup_score` | сила mid matchup |
| `safelane_matchup_score` | сила safe lane |
| `offlane_matchup_score` | сила offlane |
| `teamfight_synergy_score` | насколько герои хорошо дерутся 5×5 |
| `push_score` | потенциал пуша |
| `pickoff_score` | потенциал ловить одиночные цели |
| `save_score` | наличие сейвов |
| `initiation_score` | наличие инициации |
| `counter_initiation_score` | наличие контр-инициации |
| `late_game_score` | сила в late game |
| `early_tempo_score` | сила раннего темпа |
| `roshan_lineup_score` | способность быстро забирать Roshan |
| `highground_siege_score` | способность ломать highground |
| `waveclear_score` | способность отпушивать линии |
| `stun_duration_score` | суммарный контроль |
| `silence_score` | наличие silence-контроля |
| `dispel_score` | наличие dispel |
| `heal_sustain_score` | sustain и лечение |
| `magic_damage_share` | доля магического урона |
| `physical_damage_share` | доля физического урона |
| `pure_damage_share` | доля pure damage |
| `damage_balance_score` | сбалансированность урона |

---

## 5.4. Баны

| Фича | Как формируется |
|---|---|
| `target_ban_score_radiant` | насколько Radiant забанил comfort heroes соперника |
| `target_ban_score_dire` | аналогично |
| `ban_priority_diff` | разница силы банов |
| `meta_ban_score` | насколько забанены сильные meta heroes |
| `signature_hero_denied_count` | сколько сигнатурных героев закрыли |
| `role_ban_pressure` | насколько баны ограничили конкретную роль |
| `draft_flexibility_after_bans` | насколько остался гибкий пул |
| `first_phase_ban_value` | ценность банов первой фазы |
| `second_phase_ban_value` | ценность банов второй фазы |
| `last_ban_counter_value` | насколько последний бан закрыл ключевой ответ |
| `ban_waste_score` | насколько баны были потрачены впустую |

---

## 5.5. Timing curve

| Фича | Как формируется |
|---|---|
| `lineup_power_0_10` | сила драфта в 0–10 минут |
| `lineup_power_10_20` | сила драфта в 10–20 минут |
| `lineup_power_20_30` | сила драфта в 20–30 минут |
| `lineup_power_30_40` | сила драфта в 30–40 минут |
| `lineup_power_40_plus` | сила драфта после 40 минут |
| `timing_peak_minute_radiant` | минута пика силы Radiant |
| `timing_peak_minute_dire` | минута пика силы Dire |
| `timing_peak_diff` | разница таймингов силы |
| `draft_snowball_score` | способность драфта снежком закрывать карту |
| `draft_comeback_score` | способность камбэкать после провала |

---

# 6. Live feature list

---

## 6.1. Базовое состояние карты

| Фича | Как формируется |
|---|---|
| `game_time_sec` | текущее время карты |
| `game_time_norm` | `elapsed_sec / 3600` |
| `game_phase` | early/mid/late в числовом виде |
| `radiant_score` | убийства Radiant |
| `dire_score` | убийства Dire |
| `kill_diff` | Radiant kills − Dire kills |
| `kill_diff_norm` | `kill_diff / 20` |
| `total_kills` | сумма убийств |
| `kill_pace` | убийства в минуту |
| `kill_pace_norm` | kill pace относительно среднего по патчу |
| `radiant_networth` | общий networth Radiant |
| `dire_networth` | общий networth Dire |
| `networth_diff` | разница networth |
| `nw_lead_norm` | `networth_diff / 10000` |
| `xp_diff` | разница опыта |
| `gold_slope_60s` | изменение networth за 60 секунд |
| `gold_slope_180s` | изменение networth за 180 секунд |
| `xp_slope_60s` | изменение XP за 60 секунд |
| `xp_slope_180s` | изменение XP за 180 секунд |

---

## 6.2. Объекты карты

| Фича | Как формируется |
|---|---|
| `has_building_state` | 1, если данные по зданиям доступны |
| `radiant_towers_lost` | число потерянных башен Radiant |
| `dire_towers_lost` | число потерянных башен Dire |
| `r_towers_lost_ratio` | потерянные башни / 11 |
| `d_towers_lost_ratio` | потерянные башни / 11 |
| `tower_diff` | разница сломанных башен |
| `barracks_diff` | разница бараков |
| `base_exposure_score` | насколько открыта база |
| `lane_pressure_top` | давление по верхней линии |
| `lane_pressure_mid` | давление по центру |
| `lane_pressure_bot` | давление по низу |
| `outpost_control_diff` | контроль outpost |
| `glyph_available_radiant` | доступен ли glyph |
| `glyph_available_dire` | доступен ли glyph |
| `fortification_status_diff` | преимущество по glyph/fortification |
| `tier2_remaining_diff` | разница оставшихся T2 |
| `highground_tower_remaining_diff` | разница T3/highground tower |

**Важно:** если building state отсутствует, не ставить 0 как будто башни целые. Нужно иметь отдельную фичу `has_building_state`.

---

## 6.3. Roshan, Aegis, Tormentor

| Фича | Как формируется |
|---|---|
| `roshan_alive_flag` | жив ли Roshan |
| `next_roshan_min_sec` | минимальное время до respawn |
| `next_roshan_max_sec` | максимальное время до respawn |
| `aegis_holder_team` | у кого Aegis |
| `aegis_remaining_sec` | сколько осталось Aegis |
| `cheese_flag` | есть ли Cheese |
| `refresher_shard_flag` | есть ли Refresher Shard |
| `tormentor_alive_radiant` | жив ли Tormentor Radiant |
| `tormentor_alive_dire` | жив ли Tormentor Dire |
| `tormentor_taken_diff` | разница по Tormentor |
| `roshan_control_score` | агрегированный контроль Roshan-зоны |
| `last_roshan_team` | кто забрал последнего Roshan |
| `roshan_kill_count_radiant` | сколько Roshan забрал Radiant |
| `roshan_kill_count_dire` | сколько Roshan забрал Dire |
| `time_since_last_roshan` | сколько секунд прошло с последнего Roshan |

---

## 6.4. Герои и экономика

| Фича | Как формируется |
|---|---|
| `hero_level_1_10` | уровни всех 10 героев |
| `hero_networth_1_10` | networth всех 10 героев |
| `hero_gpm_1_10` | GPM всех 10 героев |
| `hero_xpm_1_10` | XPM всех 10 героев |
| `core_networth_diff` | разница networth трёх коров |
| `carry_networth_diff` | разница carry |
| `mid_networth_diff` | разница mid |
| `offlane_networth_diff` | разница offlane |
| `support_networth_diff` | разница саппортов |
| `networth_share_core1` | доля экономики carry |
| `networth_share_core2` | доля экономики mid |
| `farm_distribution_gini` | концентрация экономики внутри команды |
| `level_timing_advantage` | преимущество по ключевым уровням 6/12/18/25 |
| `level_6_count_diff` | разница героев с 6 уровнем |
| `level_12_count_diff` | разница героев с 12 уровнем |
| `level_18_count_diff` | разница героев с 18 уровнем |
| `level_25_count_diff` | разница героев с 25 уровнем |

---

## 6.5. Предметы и power spikes

| Фича | Как формируется |
|---|---|
| `bkb_count_radiant` | количество BKB у Radiant |
| `bkb_count_dire` | количество BKB у Dire |
| `bkb_diff` | разница BKB |
| `blink_count_diff` | разница Blink Dagger |
| `save_item_count_diff` | Force/Glimmer/Lotus и т.д. |
| `damage_item_timing_score` | насколько быстро куплены ключевые damage items |
| `defensive_item_timing_score` | defensive items |
| `item_power_spike_score` | общий индекс power spike |
| `three_core_bkb_ready_flag` | у трёх core есть BKB |
| `neutral_item_tier_diff` | преимущество по neutral items |
| `ward_inventory_diff` | разница observer/sentry в инвентаре |
| `smoke_inventory_diff` | разница smoke |
| `dust_inventory_diff` | разница dust |
| `gem_holder_team` | у кого Gem |
| `rapier_flag` | есть ли Divine Rapier |
| `aghanim_count_diff` | разница Aghanim |
| `shard_count_diff` | разница Shard |

---

## 6.6. Кулдауны, buyback, смерть героев

| Фича | Как формируется |
|---|---|
| `alive_heroes_radiant` | сколько героев Radiant живы |
| `alive_heroes_dire` | сколько героев Dire живы |
| `dead_core_count_radiant` | сколько core-героев Radiant мертвы |
| `dead_core_count_dire` | аналогично |
| `max_respawn_timer_radiant` | максимальный таймер смерти |
| `max_respawn_timer_dire` | аналогично |
| `buyback_available_count_radiant` | число доступных buyback |
| `buyback_available_count_dire` | аналогично |
| `buyback_status_diff` | преимущество по buyback |
| `ultimate_ready_count_radiant` | сколько ультимейтов готовы |
| `ultimate_ready_count_dire` | аналогично |
| `key_spell_cd_score` | индекс ключевых cooldown |
| `bkb_cooldown_diff` | разница доступности BKB |
| `refresher_ready_count_diff` | разница Refresher Orb/Shard |
| `dead_without_buyback_core_count` | число core-героев мертвы без buyback |
| `teamfight_readiness_score` | готовность команды к драке |

---

## 6.7. Vision и map control

| Фича | Как формируется |
|---|---|
| `observer_wards_radiant` | активные observer wards |
| `observer_wards_dire` | аналогично |
| `sentry_wards_radiant` | sentry wards |
| `sentry_wards_dire` | аналогично |
| `deward_count_180s` | deward за 180 секунд |
| `deep_ward_score` | насколько глубокие варды |
| `river_control_score` | контроль реки |
| `enemy_jungle_control_score` | контроль чужого леса |
| `smoke_active_flag` | активен ли smoke |
| `smoked_heroes_count` | сколько героев в smoke |
| `map_occupancy_diff` | территориальное преимущество |
| `radiant_jungle_control` | контроль леса Radiant |
| `dire_jungle_control` | контроль леса Dire |
| `lane_vision_score_diff` | преимущество по обзору линий |
| `roshan_area_vision_diff` | преимущество по вижену вокруг Roshan |

---

## 6.8. Последние события

| Фича | Как формируется |
|---|---|
| `kills_last_60s` | убийства за 60 секунд |
| `kills_last_180s` | убийства за 180 секунд |
| `gold_swing_last_fight` | изменение золота после последней драки |
| `xp_swing_last_fight` | изменение опыта после последней драки |
| `objectives_last_180s` | объекты за 180 секунд |
| `buybacks_last_180s` | buyback за 180 секунд |
| `fight_count_180s` | число драк за 180 секунд |
| `last_fight_winner` | кто выиграл последнюю драку |
| `last_objective_team` | кто забрал последний объект |
| `momentum_score` | агрегированный индекс momentum |
| `kills_last_5_events_diff` | разница убийств за последние 5 событий |
| `objectives_last_5_events_diff` | разница объектов за последние 5 событий |
| `networth_swing_180s` | изменение networth-разрыва за 180 секунд |
| `xp_swing_180s` | изменение XP-разрыва за 180 секунд |
| `fight_location_last` | где была последняя драка |

---

# 7. Фичи под букмекерские события

---

## 7.1. Победа на карте

Основные блоки:

| Блок | Фичи |
|---|---|
| prematch | rating, roster, form, draft |
| live | networth, XP, kills, towers, Roshan, buybacks |
| draft | synergy, matchup, timing curve |
| quality | missing flags, source age |

---

## 7.2. First Blood

| Фича | Как формируется |
|---|---|
| `first_blood_rate_team` | историческая частота first blood команды |
| `first_blood_allowed_rate` | как часто команда отдаёт first blood |
| `lane_aggression_score` | агрессивность линий |
| `support_roam_score` | частота ранних перемещений pos4/pos5 |
| `hero_level1_strength` | сила героев на 1 уровне |
| `rune_fight_score` | склонность драться за руны |
| `early_kill_pressure` | агрегированный индекс раннего kill pressure |
| `pos4_early_impact_score` | раннее влияние pos4 |
| `mid_first_blood_risk` | риск FB на mid lane |
| `safe_lane_fb_pressure` | давление на safe lane |

---

## 7.3. Total Kills

| Фича | Как формируется |
|---|---|
| `expected_tempo_norm` | средний темп убийств команд |
| `kills_per_min_diff` | разница темпа |
| `death_rate_sum` | склонность обеих команд умирать |
| `draft_aggression_score` | агрессивность драфтов |
| `teamfight_frequency_sum` | суммарная частота драк |
| `snowball_score` | вероятность односторонней карты |
| `game_duration_expectation` | ожидаемая длительность |
| `live_kill_pace` | текущий темп убийств |
| `live_kill_pace_vs_expected` | отклонение от ожидания |
| `stomp_probability` | вероятность быстрой односторонней карты |
| `late_game_fight_density` | ожидаемая плотность драк в late game |

---

## 7.4. Total Duration

| Фича | Как формируется |
|---|---|
| `avg_duration_team_radiant` | средняя длительность Radiant |
| `avg_duration_team_dire` | средняя длительность Dire |
| `late_game_draft_score` | сила драфта в late game |
| `push_score_diff` | преимущество пуша |
| `highground_siege_score` | способность закрывать карту |
| `waveclear_score` | способность затягивать |
| `roshan_control_score` | контроль Roshan |
| `networth_snowball_slope` | скорость разрыва по networth |
| `base_exposure_score` | открытость базы |
| `buyback_density_late_game` | плотность buyback в late game |
| `comeback_probability_live` | вероятность камбэка |
| `aegis_highground_readiness` | готовность идти на highground с Aegis |

---

## 7.5. First Tower

| Фича | Как формируется |
|---|---|
| `tower_by_10_rate` | историческая частота первой башни |
| `lane_push_score` | способность давить линии |
| `catapult_timing_score` | игра вокруг катапульт |
| `offlane_pressure_score` | давление offlane |
| `safe_lane_stability` | устойчивость safe lane |
| `early_objective_score` | общий индекс ранних объектов |
| `summon_push_score` | наличие summon/push героев |
| `mid_tower_pressure_score` | давление на mid tower |
| `support_rotation_tower_score` | способность саппортов помогать ломать башни |

---

## 7.6. First Roshan

| Фича | Как формируется |
|---|---|
| `first_roshan_rate` | историческая частота первого Roshan |
| `roshan_lineup_score` | способность быстро убивать Roshan |
| `minus_armor_score` | наличие минус армора |
| `physical_damage_score` | физический урон |
| `map_control_score_15m` | контроль карты к 15 минуте |
| `aegis_timing_preference` | привычные тайминги Roshan команды |
| `live_roshan_area_control` | текущий контроль зоны Roshan |
| `roshan_vision_diff` | преимущество по вижену вокруг Roshan |
| `roshan_fight_readiness` | готовность к драке у Roshan |
| `roshan_sneak_probability` | вероятность скрытого Roshan |

---

## 7.7. Next objective

| Фича | Как формируется |
|---|---|
| `current_map_pressure` | текущее давление по карте |
| `nearest_objective_value` | ценность ближайшего объекта |
| `team_positioning_to_objective` | позиционирование команды относительно объекта |
| `vision_near_objective` | вижен вокруг объекта |
| `cooldown_readiness_for_objective` | готовность кулдаунов для драки |
| `objective_trade_score` | вероятность размена объектов |
| `time_since_last_objective` | время с последнего объекта |
| `objective_priority_by_draft` | приоритет объекта по драфту |

---

# 8. Feature registry

Нужно завести единый реестр фичей. Формат:

| Поле | Описание |
|---|---|
| `feature_name` | название фичи |
| `feature_family` | prematch/draft/live/market/quality |
| `entity_key` | team/player/hero/match/snapshot |
| `source_table` | исходная таблица |
| `calculation_logic` | формула расчёта |
| `as_of_rule` | правило отсечения будущих данных |
| `window` | окно агрегации |
| `normalization` | нормализация |
| `missing_policy` | что делать с пропуском |
| `priority` | P0/P1/P2 |
| `used_in_models` | список моделей |
| `owner` | кто отвечает |
| `version` | версия фичи |
| `test_coverage` | есть ли unit/integration тесты |
| `data_quality_check` | какие DQ-проверки применяются |

Пример:

| feature_name | family | source | logic | as_of_rule | priority |
|---|---|---|---|---|---|
| `elo_diff_norm` | prematch | `team_ratings` | `(elo_r - elo_d) / 200` | only before `map_start_ts` | P0 |
| `nw_lead_norm` | live | `live_snapshots` | `(nw_r - nw_d) / 10000` | only events before `snapshot_ts` | P0 |
| `has_building_state` | quality | `live_snapshots` | `building_state IS NOT NULL` | same snapshot | P0 |
| `comfort_pick_score` | draft | `player_heroes` | player hero adjusted winrate | only history before draft | P0 |

---

# 9. Минимальный P0-набор для первого production contour

Не нужно сразу делать 300 фичей. Для первой нормальной production-итерации нужен сильный P0-набор.

---

## 9.1. Prematch P0

| Блок | Фичи |
|---|---|
| Team strength | elo/glicko/trueskill diff, rating momentum, strength of schedule |
| Form | winrate 5/10/20, duration, kills, deaths |
| Roster | stable five, standin, days since roster change |
| Player | role ratings, core/support diff, player form |
| Patch | patch_id, patch_age, team patch winrate |
| Draft | pick strength, matchup advantage, comfort score, meta score |
| Quality | has_draft, has_roster, sample size, feature age |

---

## 9.2. Draft P0

| Блок | Фичи |
|---|---|
| Hero pool | hero_pool_entropy, comfort_pick_score, signature heroes |
| Pick strength | pick_strength_diff, meta_score_diff |
| Matchup | matchup_advantage, lane_matchup_score |
| Synergy | teamfight, push, save, initiation, waveclear |
| Timing | early/mid/late power curve |
| Bans | target_ban_score, signature_hero_denied_count |
| Quality | has_full_draft, draft_phase_id, missing heroes |

---

## 9.3. Live P0

| Блок | Фичи |
|---|---|
| Scoreboard | time, kills, kill diff, kill pace |
| Economy | networth diff, XP diff, networth slope |
| Objectives | towers, barracks, glyph, base exposure |
| Roshan | Roshan alive, Aegis holder, Aegis remaining |
| Items | BKB diff, blink diff, save items, power spike |
| Death/buyback | alive heroes, respawn timers, buyback availability |
| Momentum | last fight, gold swing, objectives last 180 sec |
| Priors | prematch logit, draft logit |
| Quality | source age, missing flags, real/synthetic flag |

---

# 10. Что нужно изменить в текущем подходе

| Сейчас | Как надо |
|---|---|
| 17 prematch-фичей | 80–150 prematch/draft-фичей с feature registry |
| 12 live-фичей | 100+ live-фичей по состоянию карты |
| tier-модели отдельно | shared model + tier feature + partial pooling |
| random/слабый split для части моделей | только time/patch-forward split |
| accuracy как ключевая метрика | logloss, Brier, calibration, ECE |
| live polling 60 секунд | event-driven pipeline, если есть live feed |
| null → 0 | explicit missing flags |
| prematch 0.5 при отсутствии | отдельная причина missing prior, не маскировать как реальную 50/50 |
| мало live-снапшотов | увеличить сбор live-данных, хранить event log |
| нет полноценного roster-aware слоя | завести roster_version и player-role mapping |

---

# 11. Модельная архитектура

---

## 11.1. Prematch

Рекомендуемый контур:

```text
Team/player rating prior
        ↓
Roster-aware features
        ↓
Draft-aware features
        ↓
LightGBM/CatBoost main model
        ↓
Calibration layer
        ↓
Probability output
```

### Рекомендуемые модели

| Модель | Роль |
|---|---|
| Logistic Regression | baseline/fallback |
| LightGBM | основной production champion |
| CatBoost | challenger, особенно при большом числе категорий |
| Glicko/TrueSkill | rating prior |
| Bayesian hierarchical model | стабилизация малых выборок T1/T3 |

---

## 11.2. Draft

```text
Current draft state
        ↓
Hero pool + comfort
        ↓
Hero matchup + synergy
        ↓
Timing curve
        ↓
Phase-aware model
        ↓
Updated win probability
```

### Рекомендуемые модели

| Модель | Роль |
|---|---|
| LightGBM/CatBoost | основной быстрый вариант |
| Factorization Machines | player × hero × team interactions |
| Set Transformer | продвинутый set-based draft encoder |
| Graph Neural Network | R&D для hero synergy graph |

---

## 11.3. Live

```text
Prematch prior
        ↓
Draft prior
        ↓
Current live state
        ↓
Rolling event windows
        ↓
Fast tabular live model
        ↓
Calibration
        ↓
Live probability
```

### Рекомендуемые модели

| Модель | Роль |
|---|---|
| Logistic Regression | быстрый fallback |
| LightGBM/CatBoost | основной tabular live champion |
| Survival/Hazard models | next objective / duration |
| Temporal CNN / LSTM / TFT | sequence challenger |
| Temporal GNN | R&D для spatial/fight graph |

---

# 12. Метрики качества

Accuracy не должна быть главной метрикой. Для вероятностных моделей важнее качество вероятности.

| Метрика | Зачем |
|---|---|
| `logloss` | главная метрика вероятностной ошибки |
| `Brier score` | среднеквадратичная ошибка вероятности |
| `ECE` | expected calibration error |
| `calibration slope/intercept` | качество калибровки |
| `ROC-AUC` | способность ранжировать |
| `PR-AUC` | полезно для редких событий |
| `lift over baseline` | улучшение против простого prior |
| `latency p95` | скорость ответа в production |
| `coverage` | доля матчей, где модель может дать прогноз |
| `abstention rate` | доля случаев, когда модель честно отказывается |

---

# 13. Валидация

---

## 13.1. Prematch validation

Правильный split:

```text
train: старые патчи / старые даты
calibration: следующий временной блок
test: самый новый блок
```

Нельзя:

- случайно перемешивать карты;
- класть карты одной серии одновременно в train и test;
- дробить BO3 на разные сплиты;
- тестировать на будущем патче, если в train есть информация после него.

---

## 13.2. Live validation

Правильный split:

```text
одна карта целиком либо в train, либо в test
```

Нельзя:

- snapshot одной и той же карты класть одновременно в train и test;
- обучаться на snapshot 35-й минуты и тестироваться на snapshot 10-й минуты этой же карты;
- смешивать real live и synthetic backfill без отдельного domain flag.

---

## 13.3. Calibration

Калибровку делать отдельно:

| Метод | Когда использовать |
|---|---|
| Platt scaling | если данных мало |
| Isotonic regression | если данных достаточно |
| Beta calibration | если вероятности системно смещены |
| Temperature scaling | для neural моделей |

---

# 14. Data quality и monitoring

| Что мониторить | Метрика |
|---|---|
| свежесть данных | `source_age_sec` |
| пропуски | missing rate по каждой фиче |
| schema drift | изменения структуры payload |
| feature drift | PSI/KS/JS divergence |
| prediction drift | изменение распределения вероятностей |
| calibration drift | ECE, Brier по времени |
| latency | p50/p95/p99 inference latency |
| data coverage | доля матчей с full draft/live feed |
| model fallback rate | как часто используется fallback |
| abstention rate | как часто модель не уверена |

---

# 15. Приоритетный roadmap

---

## Этап 1. Data foundation

**Цель:** убрать leakage, привести данные к point-in-time формату.

Задачи:

1. Завести `feature_registry`.
2. Добавить `as_of_ts`, `source_age_sec`, `missing_flag`, `feature_version`.
3. Разделить real live и synthetic backfill.
4. Сделать dataset manifests.
5. Пересобрать train/test split по времени и патчам.

---

## Этап 2. Prematch v2

**Цель:** усилить prematch-модель.

Задачи:

1. Добавить roster-aware features.
2. Добавить player-role features.
3. Добавить strength of schedule.
4. Добавить patch/meta features.
5. Перейти от отдельных tier-моделей к shared model + tier feature.
6. Перекалибровать модель по logloss/Brier/ECE.

---

## Этап 3. Draft model

**Цель:** строить вероятность по фазам драфта.

Задачи:

1. Материализовать draft state после каждого pick/ban.
2. Добавить comfort pick score.
3. Добавить matchup matrix.
4. Добавить synergy/timing curve.
5. Обучить phase-aware draft model.
6. Пробросить draft logit в live-модель.

---

## Этап 4. Live v2

**Цель:** расширить live-модель до полноценного состояния карты.

Задачи:

1. Добавить Roshan/Aegis/Tormentor.
2. Добавить items/power spikes.
3. Добавить buybacks/death timers.
4. Добавить rolling windows 60/180 sec.
5. Добавить momentum/fight features.
6. Добавить missingness features.
7. Перейти к event-driven state, если доступен live feed.

---

## Этап 5. Market models

**Цель:** пересобрать модели под букмекерские события.

Задачи:

1. Winner map.
2. Winner series.
3. First Blood.
4. First Tower.
5. First Roshan.
6. Total kills.
7. Total duration.
8. Next objective.
9. Time-to-event survival models.
10. Multi-horizon live probabilities.

---

# 16. Итоговая рекомендация

Для вашей задачи сначала нужно сделать не “более сложную нейросеть”, а **сильный, честно валидированный, калиброванный tabular system (табличный контур моделей)** с правильным live-state.

Порядок внедрения:

1. **Data correctness** — point-in-time joins, split по времени, missing flags.
2. **Prematch v2** — roster/player/patch/draft features.
3. **Draft phase model** — вероятность после каждого pick/ban.
4. **Live v2** — Roshan, items, buybacks, objectives, momentum.
5. **Market-specific models** — отдельные модели под конкретные события.
6. **Sequence/GNN challengers** — только после накопления качественного live-event датасета.

Самый быстрый прирост качества дадут:

1. roster-aware модель;
2. корректный prematch prior в live;
3. missingness/quality flags;
4. расширение live-фичей до Roshan/items/buybacks;
5. patch-forward validation вместо случайных split.
