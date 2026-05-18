/**
 * F5 (Phase 9): нормализация Match.id → числовой match_id для эндпоинтов
 * (`/api/analytics/match-summary?matchId=N`).
 *
 * Match.id формируется в `LiveDataService` как `${source}_${rawId}`:
 *   - `od_7898912345` — OpenDota live (raw.match_id или raw.lobby_id)
 *   - `up_<panda_event_id>` — PandaScore upcoming
 *   - fallback `od_${Date.now()}` или `up_${team1}_${team2}_${startMs}` —
 *     это «синтетика» БЕЗ настоящего match_id, для них summary бессмыслен.
 *
 * Берём только канонические шаблоны `(od|up)_<digits>$`. Всё остальное
 * (фолбэки/незнакомые префиксы) → null → caller прячет кнопку «Сводка».
 */
export function extractNumericMatchId(matchId: string | undefined | null): number | null {
  if (!matchId) return null;
  const m = String(matchId).match(/^(?:od|up)_(\d+)$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}
