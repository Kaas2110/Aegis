---
name: Bash tool background limits
description: Почему nohup/фоновые процессы в bash-туле не выживают
---
Правило: фоновые процессы (nohup/&) умирают при завершении bash-команды тула — process group убивается.
**Why:** запуск тренировки через nohup в фоне молча пропал вместе с логом.
**How to apply:** долгие задачи (тренировки, pg_dump) запускать foreground с timeout ≤120s; если дольше — резать на шаги или использовать workflow.
