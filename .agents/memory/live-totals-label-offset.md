---
name: Live totals label offset
description: log(kills+1) label — потребители должны передавать line+1
---
Правило: live-модели total_kills обучаются на label log(kills+1); при скоринге линии букмекера/ladder аргумент должен быть line+1, для duration — line*scale без сдвига.
**Why:** передача сырой line давала систематическое смещение вероятностей ТБ/ТМ (найдено architect-аудитом 2026-07).
**How to apply:** любой новый потребитель модели тоталов обязан проверить формулу label в train-скрипте и симметрично трансформировать линию.
