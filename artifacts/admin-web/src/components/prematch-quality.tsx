import { countText, finiteCount, objectValue, rateText } from '@/lib/quality-view';
import { formatMetric } from '@/lib/utils';

const REASONS: Record<string, string> = {
  missing_observation_provenance: 'Нет подтверждения времени наблюдения',
  observed_after_start: 'Источник наблюдал уже начавшийся матч',
  invalid_received_time: 'Некорректное время получения',
  invalid_probability: 'Некорректная вероятность',
  start_time_unknown: 'Фактическое время старта неизвестно',
  conflicting_start_time: 'Источники расходятся во времени старта',
  prediction_after_actual_start: 'Прогноз или данные получены после старта',
  observation_after_prediction: 'Данные получены позже создания прогноза',
  conflicting_result: 'Источники расходятся в результате',
};

export function PrematchQuality({ data, details = false }: { data: unknown; details?: boolean }) {
  const metrics = objectValue(data);
  const validation = objectValue(metrics.validation);
  const available = validation.state === 'validated_subset' && (finiteCount(metrics.resolved) ?? 0) > 0;
  const rows = [
    ['Все сохранённые прогнозы', countText(validation.allRecords)],
    ['Подтверждены до старта', countText(validation.validatedRecords)],
    ['Подтверждены, исход известен', countText(metrics.resolved)],
    ['Не подтверждены · исключены', countText(validation.unvalidatedRecords)],
    ['Точность попаданий', available ? rateText(metrics.accuracy) : '—'],
    ['Brier · меньше лучше', available ? formatMetric(typeof metrics.brierScore === 'number' ? metrics.brierScore : null) : '—'],
  ];
  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold">{available ? 'Качество по подтверждённым прогнозам' : 'Качество пока не подтверждено'}</p>
      <p className="text-xs text-muted-foreground">
        {typeof validation.note === 'string' ? validation.note : 'Нет подтверждённых сведений о времени создания прогнозов. Исторические счётчики не подтверждают качество.'}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3 p-2 bg-background border border-border/50">
            <span className="text-xs text-muted-foreground">{label}</span>
            <span className="font-mono text-xs font-bold shrink-0">{value}</span>
          </div>
        ))}
      </div>
      {details && Array.isArray(validation.excludedReasons) && validation.excludedReasons.length > 0 && (
        <div className="space-y-1 border-t border-border pt-3">
          <p className="text-xs font-semibold">Почему записи не участвуют в оценке</p>
          {validation.excludedReasons.map((raw, index) => {
            const row = objectValue(raw);
            const reason = typeof row.reason === 'string' ? row.reason : 'unknown';
            return <div key={`${reason}-${index}`} className="flex justify-between gap-3 text-xs text-muted-foreground">
              <span>{REASONS[reason] ?? 'Подтверждение отсутствует'}</span><span>{countText(row.count)}</span>
            </div>;
          })}
        </div>
      )}
    </div>
  );
}
