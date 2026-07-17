---
name: Totals ladder centering
description: Центр ladder тоталов — из активной модели, не из эвристики
---
Правило: центр прематч-ladder = exp(mean(log-prediction))/linesScale активной модели; после live-override центра линии пересобираются заново.
**Why:** константная эвристика центра расходилась с моделью — линии ladder не покрывали реальный диапазон вероятностей.
**How to apply:** при изменении масштаба label или linesScale в market-моделях проверить пересчёт центра в analytics-роуте.
