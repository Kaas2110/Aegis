import express, { type Express } from "express";
import cors from "cors";
import compression from "compression";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import referralsRouter from "./routes/referrals";
import { logger } from "./lib/logger";

const app: Express = express();

// Gzip/Brotli — JSON-ответы /api/matches/live и /api/analytics/popular-markets
// бывают по 30-100 KB; на мобильной сети это ощутимая экономия трафика и задержки.
app.use(compression());

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// CORS: same-origin admin-web mounted under /admin-web/ talks to /api/* through
// the shared proxy, so allow credentials so HttpOnly admin session cookie is sent.
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);
// Короткая реферальная ссылка /r/:code — для прода на ноуте, где api-server
// принимает трафик напрямую (на Replit до сервера доходит только /api/*).
app.use("/r", referralsRouter);

export default app;
