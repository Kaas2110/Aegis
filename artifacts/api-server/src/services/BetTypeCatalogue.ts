/** Public capability catalogue, not a model registry or a prediction response.
 * Keep the conditional set aligned with PredictionContract.supportedPredictions.
 * Legacy heuristic functions and research artifacts do not establish public support.
 */
export function buildBetTypeCatalogue() {
  const conditional = (id: string, labelRu: string, description: string, algorithm: string) => ({
    id, labelRu, description, algorithm,
    implementationStatus: 'implemented' as const,
    status: 'conditional' as const,
    available: null,
    reason: 'requires_model_and_match_evidence',
  });
  const unavailable = (id: string, labelRu: string, description: string, reason = 'not_in_public_prediction_contract') => ({
    id, labelRu, description, algorithm: null,
    implementationStatus: reason === 'training_target_not_validated' ? 'validation_blocked' as const : 'planned' as const,
    status: 'unavailable' as const,
    available: false,
    reason,
  });
  return {
    schemaVersion: 2,
    kind: 'capability_catalogue',
    availabilityScope: 'not_evaluated_for_match',
    availabilityNote: 'Каталог описывает контракт API. Наличие активной модели, нужных данных и актуального прогноза проверяется отдельно для каждого матча.',
    predictionEndpoint: '/api/analytics/predict',
    quality: {status: 'not_assessed_by_catalogue', metrics: null},
    plannedNote: 'planned означает отсутствие рынка в публичном прогнозе; это направление для проверки, без обещания срока или качества.',
    betTypes: [
      conditional('match_winner', 'Победитель матча', 'Кто выиграет весь матч (серию)',
        'Вероятность решающей карты либо расчёт серии из прогноза текущей карты, счёта серии и вероятности будущих карт; формат должен быть известен.'),
      conditional('map_winner', 'Победитель карты', 'Кто выиграет конкретную карту в серии',
        'Выход загруженной модели для доступной фазы: до карты, после полного драфта или live. Данные и срок действия прогноза проверяются перед выдачей.'),
      unavailable('first_blood', 'Первая кровь', 'Какая команда первой убьёт героя соперника', 'training_target_not_validated'),
      unavailable('first_tower', 'Первая башня', 'Какая команда первой разрушит башню соперника'),
      unavailable('first_roshan', 'Первый Рошан', 'Какая команда первой убьёт Рошана'),
      conditional('total_kills', 'Тотал убийств', 'Итоговое суммарное число убийств на карте',
        'Вероятности ТБ/ТМ из распределения итогового тотала: до карты или с учётом наблюдаемого счёта в live. Нужна модель, прошедшая проверку контракта тоталов.'),
      conditional('total_duration', 'Длительность карты', 'Итоговая длительность карты; в интерфейсе — минуты',
        'Вероятности ТБ/ТМ из распределения длительности в секундах: до карты или с учётом уже прошедшего времени в live. Нужна модель, прошедшая проверку контракта тоталов.'),
      unavailable('map_handicap', 'Гандикап по картам', 'Победа с форой по картам'),
      unavailable('correct_score', 'Точный счёт серии', 'Итоговый счёт серии'),
      unavailable('comeback', 'Камбэк (Live)', 'Отдельный рынок победы отстающей команды'),
      unavailable('net_worth_lead', 'Лидерство по NW', 'Лидерство по стоимости имущества в заданный момент'),
      unavailable('first_barracks', 'Первые казармы', 'Какая команда первой разрушит казарму соперника'),
      unavailable('over_under_maps', 'Тотал карт', 'Итоговое число сыгранных карт серии'),
      unavailable('kills_handicap', 'Гандикап по убийствам', 'Разница убийств на карте'),
      unavailable('draft_advantage', 'Преимущество в драфте', 'Отдельный прогноз преимущества состава героев'),
    ],
    totals: {
      targetScope: 'map',
      phases: ['prematch', 'live'],
      noBookmaker: 'model_lines_when_prediction_available',
      bookmaker: 'bookmaker_lines_and_odds_with_model_probabilities_when_available',
      missingModel: 'probabilities_unavailable',
      missingBookmakerLines: 'no_substitute_lines',
    },
  };
}
