import pino from "pino";
import { Writable } from "node:stream";
import { pushLog } from "./logBuffer";

/**
 * Pino-логгер с двумя выходами:
 *   1) stdout — попадает в логи Replit/контейнера
 *   2) ring-buffer в памяти — доступен через GET /api/admin/logs/export
 *
 * Pretty-formatting в dev отключён, чтобы оба потока получали одинаковый JSON
 * (ring-buffer хранит NDJSON, pino-pretty работает в worker-thread и не пишет
 * в наш writable). В dev можно подсмотреть форматированно, прогнав stdout
 * вручную через `| pino-pretty`.
 */

const ringStream = new Writable({
  write(chunk, _enc, cb) {
    try {
      pushLog(chunk.toString());
    } catch {
      // никогда не валим логгер из-за ошибки буфера
    }
    cb();
  },
});

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
    ],
  },
  pino.multistream([
    { stream: process.stdout },
    { stream: ringStream },
  ]),
);
