import app from "./app";
import { logger } from "./lib/logger";
import { ensureSchema } from "./lib/ensureSchema";
import { startLiveWorker } from "./services/LiveWorker";
import { startScheduler } from "./services/SchedulerWorker";
import { startOutcomeTracker } from "./services/OutcomeTracker";
import { loadActiveLiveModel } from "./services/LiveWinnerModel";
import { loadActiveMarketModels } from "./services/MarketLgbm";
import { primeApiKeysCache } from "./services/ApiKeysService";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Cold-start: если БД пустая (свежеразвёрнутый сервер без миграций) —
  // автоматически прогоняем drizzle-kit push. Безопасно: idempotent, при
  // существующей схеме просто no-op.
  await ensureSchema();

  // Прогреваем кеш overrides ключей API (admin-web → /api/admin/integrations).
  // Не fatal: при ошибке `getApiKey()` всё равно отрабатывает по ENV.
  await primeApiKeysCache().catch((err) => logger.warn({ err }, "ApiKeys cache prime failed"));

  // Поднимаем активную live-модель (не критично — может не существовать
  // на свежей системе, до первого ретрейна live-пайплайна).
  loadActiveLiveModel().catch((err) => logger.error({ err }, "Live model load failed"));
  loadActiveMarketModels().catch((err) => logger.error({ err }, "Market models load failed"));

  // Запускаем live-воркер: опрос OpenDota раз в минуту,
  // запись снапшотов и предсказаний в БД.
  if (process.env["DISABLE_LIVE_WORKER"] !== "true") {
    startLiveWorker();
  } else {
    logger.warn("LiveWorker disabled via DISABLE_LIVE_WORKER=true");
  }

  // Шедулер: ежедневная проверка патчей, переобучение через 7 дней после нового
  // патча или раз в 30 дней.
  if (process.env["DISABLE_SCHEDULER"] !== "true") {
    startScheduler();
  } else {
    logger.warn("Scheduler disabled via DISABLE_SCHEDULER=true");
  }

  // OutcomeTracker: раз в 6 часов добивает незарезолвленные прематч-предсказания,
  // подтягивая финальные исходы из OpenDota /matches/{id}. Эти данные питают
  // метрики качества модели в админке.
  if (process.env["DISABLE_OUTCOME_TRACKER"] !== "true") {
    startOutcomeTracker();
  } else {
    logger.warn("OutcomeTracker disabled via DISABLE_OUTCOME_TRACKER=true");
  }
});
