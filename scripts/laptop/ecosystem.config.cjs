/**
 * PM2 ecosystem — запускает все три сервиса Aegis на ноутбуке.
 * Использование:
 *   pm2 start scripts/laptop/ecosystem.config.cjs
 *   pm2 save && pm2 startup   ← автозапуск при загрузке системы
 */

const path = require("path");
const root = path.resolve(__dirname, "../..");

// Загружаем .env из корня
require("dotenv").config({ path: path.join(root, ".env") });

module.exports = {
  apps: [
    {
      name: "aegis-api",
      cwd: root,
      script: "pnpm",
      args: "--filter @workspace/api-server run dev",
      env: {
        PORT: "8080",
        NODE_ENV: "production",
        ML_SERVICE_URL: "http://localhost:8090",
        ML_SERVICE_TOKEN: process.env.ML_SERVICE_TOKEN || "local-ml-token",
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "5s",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: path.join(root, "logs/api-error.log"),
      out_file: path.join(root, "logs/api-out.log"),
    },
    {
      name: "aegis-ml",
      cwd: root,
      script: "pnpm",
      args: "--filter @workspace/ml-service run dev",
      env: {
        PORT: "8090",
        ML_SERVICE_TOKEN: process.env.ML_SERVICE_TOKEN || "local-ml-token",
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "5s",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: path.join(root, "logs/ml-error.log"),
      out_file: path.join(root, "logs/ml-out.log"),
    },
    {
      name: "aegis-admin",
      cwd: root,
      script: "pnpm",
      args: "--filter @workspace/admin-web run dev",
      env: {
        PORT: "24276",
        BASE_PATH: "/admin-web/",
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "5s",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: path.join(root, "logs/admin-error.log"),
      out_file: path.join(root, "logs/admin-out.log"),
    },
  ],
};
