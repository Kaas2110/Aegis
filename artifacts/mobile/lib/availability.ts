/**
 * Data availability helpers (Aegis).
 *
 * Реализация контракта `docs/data-availability-rules.md` §1, §7.
 *
 * Используется UI-компонентами для решения «как рендерить поле»:
 * fresh / stale-soft / stale-hard / likely-ended / historical / permanent /
 * between_maps.
 *
 * Запрещено компонентам сравнивать `Date.now() - x` напрямую — только через
 * `getFieldState()`. Это гарантирует, что пороги меняются в одном месте.
 */

// Пороги (миллисекунды). Должны совпадать с docs/data-availability-rules.md §1.
export const FRESH_MS = 90 * 1000;                     // 0-90s
export const STALE_SOFT_MS = 3 * 60 * 1000;            // 90s-3min
export const STALE_HARD_MS = 25 * 60 * 1000;           // 3-25min
export const LIVE_STALE_HARD_MS = STALE_HARD_MS;       // alias для backend symmetry
export const LIKELY_ENDED_MS = 6 * 60 * 60 * 1000;     // 25min-6h
// > LIKELY_ENDED_MS — historical

export type FieldState =
  | 'fresh'
  | 'stale-soft'
  | 'stale-hard'
  | 'likely-ended'
  | 'historical'
  | 'permanent-unavailable'
  | 'between-maps';

export interface FieldStateInput {
  /** Серверный timestamp когда поле было записано/обновлено. ISO string или Date. */
  capturedAt?: string | Date | null;
  /** Альтернатива capturedAt: возраст в **секундах** на момент серверного ответа. */
  ageSeconds?: number | null;
  /** Признак permanent_unavailable из `_field_meta` (см. T2 §4). */
  permanent?: boolean;
  /** Матч в состоянии between_maps — все live-поля скрыты независимо от age. */
  betweenMaps?: boolean;
  /** Текущее время для тестов. По умолчанию `Date.now()`. */
  now?: number;
}

/**
 * Возвращает состояние одного поля. Используй в JSX:
 * ```tsx
 * const state = getFieldState({ capturedAt: snap.capturedAt, betweenMaps: match.status === 'between_maps' });
 * if (state === 'permanent-unavailable' || state === 'between-maps') return null;
 * if (state === 'stale-hard' || state === 'likely-ended') return <Placeholder />;
 * return <Value spin={state === 'stale-soft'}>{snap.xpRadiant}</Value>;
 * ```
 */
export function getFieldState(input: FieldStateInput): FieldState {
  if (input.permanent) return 'permanent-unavailable';
  if (input.betweenMaps) return 'between-maps';

  let ageMs: number | null = null;
  if (typeof input.ageSeconds === 'number' && Number.isFinite(input.ageSeconds)) {
    ageMs = Math.max(0, input.ageSeconds * 1000);
  } else if (input.capturedAt != null) {
    const t = typeof input.capturedAt === 'string'
      ? Date.parse(input.capturedAt)
      : input.capturedAt.getTime();
    if (Number.isFinite(t)) {
      const now = input.now ?? Date.now();
      ageMs = Math.max(0, now - t);
    }
  }

  if (ageMs === null) {
    // Нет информации о возрасте — не знаем, fresh ли. Безопасный дефолт —
    // stale-soft: UI покажет, но с индикатором обновления.
    return 'stale-soft';
  }

  if (ageMs < FRESH_MS) return 'fresh';
  if (ageMs < STALE_SOFT_MS) return 'stale-soft';
  if (ageMs < STALE_HARD_MS) return 'stale-hard';
  if (ageMs < LIKELY_ENDED_MS) return 'likely-ended';
  return 'historical';
}

/**
 * Удобный предикат: можно ли показывать числовое значение поля.
 * `false` для between-maps / permanent / stale-hard / likely-ended.
 */
export function shouldRenderValue(state: FieldState): boolean {
  return state === 'fresh' || state === 'stale-soft' || state === 'historical';
}

/**
 * `true` если рядом со значением нужен индикатор «обновляется» (мини-спиннер).
 */
export function needsRefreshIndicator(state: FieldState): boolean {
  return state === 'stale-soft';
}

/**
 * `true` если вместо значения нужно показать плашку «данные обновляются».
 * НЕ путать с between-maps (там своя плашка «ПЕРЕРЫВ МЕЖДУ КАРТАМИ»).
 */
export function shouldShowStalePlaceholder(state: FieldState): boolean {
  return state === 'stale-hard';
}
