/**
 * Fixed-size circular buffer для последних N pino-записей.
 * Используется для self-serve выгрузки логов из админки (для дебага продакшена).
 *
 * Хранит сырую NDJSON-строку pino + распарсенные ts/level для фильтрации.
 * Лимит ~20000 записей (~20MB при средней строке 1KB) — покрывает несколько
 * часов работы при умеренной нагрузке. При флуде ошибок — последние ~20к строк.
 *
 * O(1) push (никаких splice), O(n) read с последовательным обходом.
 */

export const MAX_ENTRIES = 20000;

export type LogEntry = {
  ts: number;
  level: number;
  raw: string;
};

// Кольцевой буфер: всегда длиной MAX_ENTRIES (заполняется null-ами лениво).
const ring: (LogEntry | null)[] = new Array(MAX_ENTRIES).fill(null);
let writeIdx = 0;  // куда пишется следующая запись
let filled = 0;    // сколько слотов реально заполнено (<= MAX_ENTRIES)

export function pushLog(line: string): void {
  if (!line) return;
  let ts = Date.now();
  let level = 30;
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed.time === "number") ts = parsed.time;
    if (typeof parsed.level === "number") level = parsed.level;
  } catch {
    // не JSON — оставляем дефолты, всё равно сохраняем строку
  }
  ring[writeIdx] = { ts, level, raw: line.endsWith("\n") ? line : line + "\n" };
  writeIdx = (writeIdx + 1) % MAX_ENTRIES;
  if (filled < MAX_ENTRIES) filled++;
}

/**
 * Возвращает копию записей в хронологическом порядке (от старых к новым),
 * после применения фильтров. Безопасно для итерации/стрима.
 */
export function getLogs(opts: {
  sinceMs?: number;
  untilMs?: number;
  minLevel?: number;
  limit?: number;
} = {}): LogEntry[] {
  const out: LogEntry[] = [];
  const startIdx = filled < MAX_ENTRIES ? 0 : writeIdx;
  for (let i = 0; i < filled; i++) {
    const e = ring[(startIdx + i) % MAX_ENTRIES];
    if (!e) continue;
    if (opts.sinceMs != null && e.ts < opts.sinceMs) continue;
    if (opts.untilMs != null && e.ts > opts.untilMs) continue;
    if (opts.minLevel != null && e.level < opts.minLevel) continue;
    out.push(e);
  }
  if (opts.limit != null && out.length > opts.limit) {
    return out.slice(-opts.limit);
  }
  return out;
}

export function getLogStats(): {
  count: number;
  capacity: number;
  oldestTs: number | null;
  newestTs: number | null;
  byLevel: Record<string, number>;
} {
  const byLevel: Record<string, number> = {};
  let oldestTs: number | null = null;
  let newestTs: number | null = null;
  const startIdx = filled < MAX_ENTRIES ? 0 : writeIdx;
  for (let i = 0; i < filled; i++) {
    const e = ring[(startIdx + i) % MAX_ENTRIES];
    if (!e) continue;
    if (oldestTs == null) oldestTs = e.ts;
    newestTs = e.ts;
    const name =
      e.level >= 60 ? "fatal" :
      e.level >= 50 ? "error" :
      e.level >= 40 ? "warn" :
      e.level >= 30 ? "info" :
      e.level >= 20 ? "debug" : "trace";
    byLevel[name] = (byLevel[name] ?? 0) + 1;
  }
  return {
    count: filled,
    capacity: MAX_ENTRIES,
    oldestTs,
    newestTs,
    byLevel,
  };
}
