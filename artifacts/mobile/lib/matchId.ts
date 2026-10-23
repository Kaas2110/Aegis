/**
 * F5 (Phase 9): нормализация Match.id → числовой match_id для эндпоинтов
 * (`/api/analytics/match-summary?matchId=N`).
 *
 * Match.id формируется в `LiveDataService` как `${source}_${rawId}`:
 *   - `od_7898912345` — OpenDota live (only raw.match_id)
 *   - `up_<panda_event_id>` — PandaScore upcoming
 *   - synth-* — no real match_id, so OD summaries are unavailable.
 *
 * Берём только канонический шаблон `od_<digits>$`. Всё остальное
 * (фолбэки/незнакомые префиксы) → null → caller прячет кнопку «Сводка».
 */
export function positiveSafeId(value: unknown): number | null {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^[1-9]\d*$/.test(String(value))) return null;
  const id=Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

export function extractNumericMatchId(matchId: string | undefined | null): number | null {
  if (!matchId) return null;
  const m = String(matchId).match(/^od_([1-9]\d*)$/);
  if (!m) return null;
  return positiveSafeId(m[1]);
}
