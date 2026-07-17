---
name: Backup split parts naming
description: Как резать бэкап на части ≤150MB, совместимые с present_asset
---
Правило: pg_dump -Fc → gzip → split -b 150m с суффиксом .gz; валидный gzip получается только после склейки cat всех частей по порядку.
**Why:** present_asset принимает только известные расширения (.gz да, .part-aa нет); каждая часть по отдельности не является валидным gzip — это нормально.
**How to apply:** restore = cat parts > dump.gz && gunzip && pg_restore --no-owner --no-privileges. Инструкции — docs/migration-replit.md и laptop-deploy.md Шаг 0.8.
