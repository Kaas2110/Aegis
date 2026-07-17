---
name: OpenDota free-mode quota
description: Как делить 3000 req/day OpenDota между воркерами без 429-штормов
---
Правило: суммарный дневной бюджет OD free = 3000 req (60 req/min) на ВСЕХ потребителей: LiveWorker (in-process), Hourly/Daily cron, Replay Parse Loop.
**Why:** агрессивный parse-loop (limit 1500, тик 10 мин) съедал квоту и вгонял LiveWorker в 429-backoff — live-матчи переставали обновляться.
**How to apply:** при настройке любого нового OD-потребителя считать бюджет; в parse-циклах ставить quota-guard (429 → пауза 65s, 3 подряд → abort тика). Premium включается ТОЛЬКО парой OPENDOTA_USE_PREMIUM=true + ключ.
