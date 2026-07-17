> ⚠️ **УСТАРЕЛ (май 2026, эпоха «Dota Edge Analyzer»).** Актуальные доки: переезд/деплой — `docs/laptop-deploy.md` + `docs/migration-replit.md`; RuStore — `docs/rustore-release.md`. Оставлен для истории.

# Dota Edge Analyzer — Полная инструкция по развёртыванию

## Обзор архитектуры

```
┌─────────────────────────────────────────────────────────────────┐
│                          Клиент                                 │
│    Expo Mobile App (iOS/Android/Web)                            │
│    Сборка: Expo EAS Build                                       │
└─────────────────────┬───────────────────────────────────────────┘
                      │ HTTPS
┌─────────────────────▼───────────────────────────────────────────┐
│                   Node.js API Server                            │
│    Express 5, порт 8080                                         │
│    Роуты: /api/matches, /api/odds, /api/analytics, /api/ml     │
│    Хостинг: Replit Deployments (или VPS)                        │
└──────────┬──────────────────────────────┬───────────────────────┘
           │                              │
┌──────────▼────────┐          ┌──────────▼───────────────────────┐
│  Python ML        │          │  PostgreSQL                      │
│  FastAPI сервис   │          │  (Replit встроенная или внешняя) │
│  LightGBM модели  │          │  Данные матчей, веса моделей     │
│  Хостинг: VPS     │          │  Хостинг: Replit/Supabase/Neon  │
└───────────────────┘          └──────────────────────────────────┘
           │
┌──────────▼──────────────────────────────────────────────────────┐
│  OpenDota API (бесплатно, без ключа)                            │
│  The Odds API (нужен ключ)                                      │
│  PandaScore API (нужен ключ)                                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## ЭТАП 1 — Подготовка API-ключей

| Сервис | Для чего | Цена | Лимит |
|--------|----------|------|-------|
| [The Odds API](https://the-odds-api.com) | Коэффициенты | Бесплатно 500 запр/мес | Требует ключ |
| [PandaScore](https://pandascore.co) | Предстоящие матчи | Бесплатно 1 000 запр/час | Требует ключ |
| [OpenDota](https://www.opendota.com/api-keys) | Live матчи | Бесплатно без ключа | Рекомендуется ключ для надёжности |
| [STRATZ](https://stratz.com/api) | Draft-данные | Бесплатно | Bearer-токен |

### Добавить переменные окружения в Replit Secrets:
```
ODDS_API_KEY=ваш_ключ_от_the_odds_api
PANDASCORE_API_KEY=ваш_ключ_от_pandascore
OPENDOTA_API_KEY=ваш_ключ_от_opendota (опционально)
STRATZ_TOKEN=ваш_токен_от_stratz (опционально)
PROXY_URL=http://user:pass@host:port (опционально, для РФ-букмекеров)
SESSION_SECRET=длинная_случайная_строка
DATABASE_URL=postgresql://...
```

---

## ЭТАП 2 — Node.js API Server

### Вариант A: Replit Deployments (рекомендуется для начала)

1. Открыть проект в Replit
2. Нажать **Deploy → Background Worker**
3. Entry command: `pnpm --filter @workspace/api-server run build && node artifacts/api-server/dist/index.js`
4. Настроить Secrets (см. Этап 1)
5. Нажать **Deploy**

**Стоимость:** $0.01/час CPU + $0.0000025/GB·сек памяти. При 100MB RAM 24/7 ≈ **$3–7/мес**.

### Вариант B: Railway.app

```bash
# railway.json
{
  "build": { "builder": "nixpacks" },
  "deploy": {
    "startCommand": "pnpm --filter @workspace/api-server run build && node artifacts/api-server/dist/index.js",
    "healthcheckPath": "/api/healthz"
  }
}
```

**Стоимость:** Hobby $5/мес = 512MB RAM + 1 vCPU. Достаточно для старта.

### Вариант C: VPS (DigitalOcean / Hetzner)

```bash
# На сервере (Ubuntu 22.04)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
npm install -g pnpm pm2

git clone <repo_url> /app
cd /app && pnpm install

# PM2 process manager
pm2 start "pnpm --filter @workspace/api-server run start" --name dea-api
pm2 save && pm2 startup
```

**Стоимость:** Hetzner CPX11 (2 vCPU, 2GB RAM) = **€4.15/мес** (~$4.5). Отличный вариант.

---

## ЭТАП 3 — Python ML-сервис (LightGBM)

### Структура сервиса

```
ml-service/
├── main.py              # FastAPI приложение
├── models/
│   ├── match_winner.pkl # Обученные LightGBM модели (15 штук)
│   ├── map_winner.pkl
│   └── ...
├── training/
│   ├── fetch_data.py    # Скачивает данные с OpenDota API
│   ├── feature_eng.py   # Извлечение 48 признаков
│   ├── train.py         # Обучение + валидация + сохранение
│   └── schedule.py      # Cron-задача переобучения
├── requirements.txt
└── Dockerfile
```

### Ключевые зависимости (requirements.txt)

```txt
fastapi==0.111.0
uvicorn==0.29.0
lightgbm==4.3.0
scikit-learn==1.4.2
pandas==2.2.1
numpy==1.26.4
httpx==0.27.0
apscheduler==3.10.4  # Автопереобучение
joblib==1.4.0
```

### main.py (скелет FastAPI-сервиса)

```python
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import lightgbm as lgb
import numpy as np
import joblib
import os

app = FastAPI(title="DEA ML Service")

# Загружаем модели при старте
MODELS = {}
MODEL_DIR = os.getenv("MODEL_DIR", "./models")
BET_TYPES = [
    "match_winner", "map_winner", "first_blood", "first_tower",
    "first_roshan", "total_kills", "total_duration", "kills_handicap",
    "map_handicap", "correct_score", "net_worth_lead", "comeback",
    "draft_advantage", "over_under_maps", "first_barracks",
]
for bt in BET_TYPES:
    model_path = f"{MODEL_DIR}/{bt}.pkl"
    if os.path.exists(model_path):
        MODELS[bt] = joblib.load(model_path)

class PredictRequest(BaseModel):
    elo1: float; elo2: float
    form1: float; form2: float      # 0..1
    h2h_win_rate: float             # 0..1
    draft_synergy1: float; draft_synergy2: float
    draft_counter1: float; draft_counter2: float
    scaling1: float; scaling2: float
    early_score1: float; early_score2: float
    net_worth_lead: float = 0.0     # live only
    kills_lead: float = 0.0
    tower_lead: float = 0.0
    game_time_sec: float = 0.0
    is_live: bool = False
    tournament_tier: int = 2
    format_bo: int = 3              # 1, 3, 5

class PredictResponse(BaseModel):
    bet_type: str
    prob_team1: float
    prob_team2: float
    confidence: float
    model_version: str

@app.post("/predict/{bet_type}", response_model=PredictResponse)
async def predict(bet_type: str, req: PredictRequest):
    if bet_type not in MODELS:
        raise HTTPException(404, f"Model '{bet_type}' not loaded")
    
    # Формируем вектор признаков (порядок должен совпадать с обучением)
    features = np.array([[
        req.elo1, req.elo2, req.elo1 - req.elo2,
        req.form1, req.form2, req.form1 - req.form2,
        req.h2h_win_rate,
        req.draft_synergy1, req.draft_synergy2,
        req.draft_counter1, req.draft_counter2,
        req.scaling1, req.scaling2,
        req.early_score1, req.early_score2,
        req.net_worth_lead, req.kills_lead, req.tower_lead,
        req.game_time_sec, int(req.is_live),
        req.tournament_tier, req.format_bo,
    ]])
    
    model = MODELS[bet_type]
    prob = float(model.predict(features)[0])
    
    return PredictResponse(
        bet_type=bet_type,
        prob_team1=prob,
        prob_team2=1 - prob,
        confidence=0.75,  # Из calibrated probability
        model_version="lgbm_v1.0.0",
    )

@app.get("/health")
async def health():
    return {"status": "ok", "loaded_models": list(MODELS.keys())}
```

### Скрипт обучения (training/train.py)

```python
"""
Обучение LightGBM-модели для одного типа ставки.
Данные: исторические про-матчи OpenDota за последние 6-12 мес (3-4 патча).
"""
import lightgbm as lgb
import pandas as pd
import numpy as np
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import brier_score_loss
import httpx, joblib, asyncio
from datetime import datetime, timedelta

CURRENT_PATCHES = ["7.36", "7.37", "7.38"]  # Обновлять при выходе патча

async def fetch_historical_matches(days=180):
    """OpenDota Pro Matches API — возвращает ~500-2000 матчей"""
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            "https://api.opendota.com/api/proMatches",
            params={"limit": 5000},
        )
        matches = resp.json()
    
    # Фильтрация по дате (последние N дней)
    cutoff = (datetime.now() - timedelta(days=days)).timestamp()
    recent = [m for m in matches if m.get("start_time", 0) > cutoff]
    return recent

def build_features(match: dict) -> dict:
    """Извлечение признаков из данных матча OpenDota."""
    return {
        "elo1": match.get("radiant_elo", 1700),
        "elo2": match.get("dire_elo", 1700),
        "form1": match.get("radiant_form", 0.5),
        "form2": match.get("dire_form", 0.5),
        # ... остальные 40+ признаков
    }

def train_model(df: pd.DataFrame, target: str, bet_type: str):
    X = df.drop(columns=["match_winner", "map_winner", "start_time"])
    y = df[target]
    
    # Временная кросс-валидация (не перемешивать матчи во времени!)
    tscv = TimeSeriesSplit(n_splits=5)
    
    params = {
        "objective": "binary",
        "metric": "binary_logloss",
        "learning_rate": 0.05,
        "num_leaves": 31,
        "feature_fraction": 0.8,
        "bagging_fraction": 0.8,
        "bagging_freq": 5,
        "verbose": -1,
    }
    
    brier_scores = []
    for train_idx, val_idx in tscv.split(X):
        X_train, X_val = X.iloc[train_idx], X.iloc[val_idx]
        y_train, y_val = y.iloc[train_idx], y.iloc[val_idx]
        
        ds_train = lgb.Dataset(X_train, label=y_train)
        ds_val = lgb.Dataset(X_val, label=y_val)
        
        model = lgb.train(
            params, ds_train,
            num_boost_round=500,
            valid_sets=[ds_val],
            callbacks=[lgb.early_stopping(50), lgb.log_evaluation(100)],
        )
        
        preds = model.predict(X_val)
        bs = brier_score_loss(y_val, preds)
        brier_scores.append(bs)
        print(f"Fold Brier: {bs:.4f}")
    
    print(f"\n[{bet_type}] Avg Brier Score: {np.mean(brier_scores):.4f}")
    
    # Финальное обучение на всех данных
    ds_full = lgb.Dataset(X, label=y)
    final_model = lgb.train(params, ds_full, num_boost_round=500)
    joblib.dump(final_model, f"models/{bet_type}.pkl")
    print(f"Saved models/{bet_type}.pkl")
    return final_model

if __name__ == "__main__":
    matches = asyncio.run(fetch_historical_matches(days=180))
    df = pd.DataFrame([build_features(m) for m in matches])
    
    for bet_type, target in [
        ("match_winner", "radiant_win"),
        ("first_blood", "first_blood_time_lt_5min"),
        # ... остальные типы
    ]:
        train_model(df, target, bet_type)
```

### Автопереобучение (training/schedule.py)

```python
"""
Запускает переобучение каждые 14 дней или при обнаружении нового патча.
"""
from apscheduler.schedulers.background import BackgroundScheduler
import subprocess, logging

logger = logging.getLogger(__name__)

def retrain_all():
    logger.info("Starting scheduled retraining...")
    result = subprocess.run(["python", "training/train.py"], capture_output=True)
    if result.returncode == 0:
        logger.info("Retraining successful")
    else:
        logger.error(f"Retraining failed: {result.stderr.decode()}")

scheduler = BackgroundScheduler()
scheduler.add_job(retrain_all, "interval", days=14, id="retrain")
scheduler.start()
```

### Развёртывание ML-сервиса

**Минимальные требования:** 2GB RAM (для LightGBM + FastAPI), 2 vCPU

```bash
# Dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
# Предобучить модели при первом деплое или загрузить из S3
RUN python training/train.py
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

```bash
# На VPS (Hetzner CPX21: 3 vCPU, 4GB = €6.77/мес)
docker build -t dea-ml .
docker run -d -p 8000:8000 --name dea-ml \
  -e OPENDOTA_API_KEY=xxx \
  dea-ml
```

**Добавить переменную в API-сервер:**
```
ML_SERVICE_URL=http://<vps_ip>:8000
```

---

## ЭТАП 4 — База данных PostgreSQL

### Вариант A: Replit встроенная БД
- Бесплатно в рамках тарифа Replit
- Уже настроена переменная `DATABASE_URL`
- Ограничение: 1GB хранилища

### Вариант B: Supabase (рекомендуется)
1. Зарегистрироваться на [supabase.com](https://supabase.com)
2. Создать проект → скопировать Connection String
3. Добавить в Secrets: `DATABASE_URL=postgresql://...`

**Стоимость:** Бесплатно до 500MB. Pro — $25/мес = 8GB.

### Вариант C: Neon (serverless Postgres)
- Бесплатно до 512MB
- Автопауза при неактивности → экономия
- [neon.tech](https://neon.tech)

### Миграции
```bash
pnpm --filter @workspace/db run push  # Применить схему в dev
pnpm --filter @workspace/db run push --env production  # Применить в prod
```

---

## ЭТАП 5 — Мобильное приложение (Expo EAS Build)

### Установка

```bash
npm install -g @expo/eas-cli
eas login
eas build:configure
```

### eas.json

```json
{
  "cli": { "version": ">= 12.0.0" },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal"
    },
    "preview": {
      "distribution": "internal",
      "android": { "buildType": "apk" }
    },
    "production": {
      "autoIncrement": true
    }
  },
  "submit": {
    "production": {
      "android": { "serviceAccountKeyPath": "./google-play-key.json" },
      "ios": { "appleId": "ваш@email.com", "ascAppId": "id приложения" }
    }
  }
}
```

### Сборка и публикация

```bash
# Preview APK (Android, для внутреннего тестирования)
eas build --profile preview --platform android

# Production build для iOS
eas build --profile production --platform ios

# Production build для Android (Google Play)
eas build --profile production --platform android

# Публикация в магазины
eas submit --profile production --platform all
```

### Настройка Backend URL в приложении

```typescript
// artifacts/mobile/constants/config.ts
export const API_BASE = __DEV__
  ? 'https://ваш-dev-domain.replit.dev'
  : 'https://ваш-prod-domain.replit.app';
```

---

## ЭТАП 6 — Мониторинг и логирование

### Sentry (трекинг ошибок)

```bash
# В api-server
pnpm --filter @workspace/api-server add @sentry/node
```

```typescript
// app.ts
import * as Sentry from '@sentry/node';
Sentry.init({ dsn: process.env.SENTRY_DSN });
```

```bash
# В Expo app
npx expo install @sentry/react-native
```

**Стоимость:** Бесплатно до 5k ошибок/мес.

### Uptime-мониторинг

- [UptimeRobot](https://uptimerobot.com) — бесплатно, проверяет `/api/healthz` каждые 5 минут
- Алерты в Telegram при падении

---

## Итоговая оценка стоимости

### Минимальный старт (MVP, ~100 пользователей)

| Компонент | Сервис | Стоимость/мес |
|-----------|--------|---------------|
| API Server | Replit Deployments | $7–15 |
| База данных | Replit DB (встроенная) | $0 |
| ML Service | Не обязателен на старте | — |
| Мобильное приложение | Expo EAS Preview | $0 |
| Мониторинг | UptimeRobot Free | $0 |
| API-ключи | The Odds API Free (500 req/мес) | $0 |
| **Итого** | | **$7–15/мес** |

### Рост (1 000–10 000 пользователей)

| Компонент | Сервис | Стоимость/мес |
|-----------|--------|---------------|
| API Server | Hetzner CPX11 (VPS) | €4.15 (~$5) |
| База данных | Supabase Pro | $25 |
| ML Service | Hetzner CPX21 (4GB RAM) | €6.77 (~$8) |
| CDN | Cloudflare Free | $0 |
| Мобильное приложение | Expo EAS Production | $99/мес (AppStore/PlayStore) |
| Мониторинг | Sentry Developer | $0 |
| **Итого** | | **~$140/мес** |

### Enterprise (10 000+ пользователей)

| Компонент | Стоимость/мес |
|-----------|---------------|
| Load Balanced API (2x) | $40 |
| Managed PostgreSQL | $50–100 |
| GPU-сервер для ML (A100/H100) | $200–500 |
| CDN + DDoS защита | $20 |
| **Итого** | **$310–660/мес** |

---

## Пошаговый чеклист запуска

- [ ] Получить API-ключи (The Odds API, PandaScore)
- [ ] Добавить в Replit Secrets
- [ ] Задеплоить Node.js API (Replit Deploy / Railway)
- [ ] Убедиться что `/api/healthz` отвечает в prod
- [ ] Настроить eas.json с prod URL
- [ ] Запустить `eas build --profile preview` → протестировать APK
- [ ] Убедиться что live данные приходят (раздел с зелёной точкой "OpenDota")
- [ ] (Опционально) Развернуть Python ML-сервис на VPS
- [ ] Настроить UptimeRobot на healthz endpoint
- [ ] Запустить `eas submit` для публикации в магазины

---

## FAQ

**Q: Нужен ли Python ML-сервис с самого начала?**
A: Нет. На старте математические модели (math_v1.0.0) уже в продакшне. ML-сервис добавляется когда накопятся реальные данные (минимум 3-6 месяцев).

**Q: Как часто переобучать ML-модели?**
A: Раз в 14 дней или при выходе нового патча (обычно раз в 6-8 недель). APScheduler запускает это автоматически.

**Q: Почему LightGBM а не нейронная сеть?**
A: Для табличных данных (матчи, статистика) LightGBM превосходит нейронные сети на датасетах <1M строк. Быстрее обучается, лучше интерпретируется, меньше требует памяти. При 10k+ матчах — рассмотреть CatBoost или Temporal Fusion Transformer для time-series.

**Q: Где взять исторические данные для обучения?**
A: OpenDota `/api/proMatches` + `/api/matches/{id}`. Premium key (`OPENDOTA_API_KEY`) даёт 3000 req/min = 50 req/s, неограниченно/месяц, $0.0001 за запрос (404/429/500 не тарифицируются). Без ключа — free tier 60 req/min, 3000 req/day.
