/**
 * A4: in-memory heartbeat-регистр для фоновых воркеров.
 *
 * Каждый воркер вызывает `recordHeartbeat(name, ...)` после каждого тика.
 * Endpoint `/api/admin/workers/config` отдаёт текущие значения, чтобы UI мог
 * показать «когда последний раз пульсировал».
 *
 * Это in-memory (сбрасывается при рестарте api-server) и НЕ предназначено для
 * SLO — это операционный сигнал «жив / не жив».
 */

export type WorkerName = 'liveWorker' | 'scheduler';

export interface WorkerHeartbeat {
  lastTickAt: string | null;
  lastStatus: 'ok' | 'error' | 'idle';
  lastError: string | null;
  totalTicks: number;
  lastDurationMs: number | null;
}

const heartbeats: Record<WorkerName, WorkerHeartbeat> = {
  liveWorker: { lastTickAt: null, lastStatus: 'idle', lastError: null, totalTicks: 0, lastDurationMs: null },
  scheduler:  { lastTickAt: null, lastStatus: 'idle', lastError: null, totalTicks: 0, lastDurationMs: null },
};

export function recordHeartbeat(
  name: WorkerName,
  patch: { ok: boolean; durationMs?: number; error?: string | null },
): void {
  const h = heartbeats[name];
  h.lastTickAt = new Date().toISOString();
  h.lastStatus = patch.ok ? 'ok' : 'error';
  h.lastError = patch.ok ? null : (patch.error ?? null);
  h.totalTicks += 1;
  if (typeof patch.durationMs === 'number') h.lastDurationMs = patch.durationMs;
}

export function getHeartbeats(): Record<WorkerName, WorkerHeartbeat> {
  // structuredClone-light: возвращаем «снимок», чтобы клиент не мутировал состояние
  return {
    liveWorker: { ...heartbeats.liveWorker },
    scheduler:  { ...heartbeats.scheduler },
  };
}
