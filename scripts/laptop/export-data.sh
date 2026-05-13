#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# Aegis — экспорт БД + моделей в один архив (Mac / Linux / Git Bash)
# Использование: bash scripts/laptop/export-data.sh
# Результат:    aegis-backup-YYYY-MM-DD.tar.gz
# ─────────────────────────────────────────────────────────────────
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[export]${NC} $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
error() { echo -e "${RED}[error]${NC} $*"; exit 1; }

DATE=$(date +%Y-%m-%d)
EXPORT_DIR="/tmp/aegis-export-$DATE"
ARCHIVE="$ROOT/aegis-backup-$DATE.tar.gz"

# ── Загружаем .env ────────────────────────────────────────────────
if [ -f .env ]; then
  export $(grep -v '^#' .env | grep -v '^$' | xargs)
fi
[ -z "$DATABASE_URL" ] && error "DATABASE_URL не задан. Заполни .env"

info "Создаю папку экспорта: $EXPORT_DIR"
rm -rf "$EXPORT_DIR"
mkdir -p "$EXPORT_DIR"

# ── 1. Дамп базы данных ───────────────────────────────────────────
info "Дамп PostgreSQL → $EXPORT_DIR/database.sql ..."
command -v pg_dump >/dev/null 2>&1 || error "pg_dump не найден. Установи PostgreSQL client tools."
pg_dump "$DATABASE_URL" \
  --no-owner --no-acl \
  --file="$EXPORT_DIR/database.sql" \
  && info "  БД: OK ($(du -sh "$EXPORT_DIR/database.sql" | cut -f1))"

# ── 2. Экспорт ML-моделей из БД (binary_blob + weights) ──────────
info "Экспортирую ML-модели из БД → $EXPORT_DIR/models/ ..."
mkdir -p "$EXPORT_DIR/models"

# Создаём скрипт для psql
cat > /tmp/aegis-export-models.sql << 'SQL'
-- LightGBM модели (binary_blob)
\copy (
  SELECT
    kind,
    engine,
    is_active,
    accuracy,
    brier_score,
    log_loss,
    train_size,
    feature_version,
    features_json::text,
    weights::text,
    encode(binary_blob, 'base64') as binary_blob_b64,
    created_at
  FROM model_versions
  ORDER BY kind, engine, created_at DESC
) TO '/tmp/aegis-models.csv' WITH CSV HEADER;
SQL

psql "$DATABASE_URL" -f /tmp/aegis-export-models.sql 2>/dev/null \
  && mv /tmp/aegis-models.csv "$EXPORT_DIR/models/model_versions.csv" \
  && info "  Модели: OK ($(wc -l < "$EXPORT_DIR/models/model_versions.csv") строк)"

# ── 3. Экспорт настроек приложения ───────────────────────────────
info "Экспортирую настройки → $EXPORT_DIR/app_settings.json ..."
psql "$DATABASE_URL" -t -A -c \
  "SELECT row_to_json(app_settings) FROM app_settings LIMIT 1;" \
  > "$EXPORT_DIR/app_settings.json" 2>/dev/null \
  && info "  Настройки: OK"

# ── 4. Статистика данных ──────────────────────────────────────────
info "Считаю статистику таблиц → $EXPORT_DIR/stats.txt ..."
psql "$DATABASE_URL" -c "
  SELECT
    schemaname,
    tablename,
    n_live_tup AS rows
  FROM pg_stat_user_tables
  ORDER BY n_live_tup DESC;
" > "$EXPORT_DIR/stats.txt" 2>/dev/null \
  && info "  Статистика: OK"

# ── 5. Метаданные экспорта ────────────────────────────────────────
cat > "$EXPORT_DIR/README.txt" << EOF
Aegis — резервная копия данных
Дата: $DATE
Репозиторий: https://github.com/Kaas2110/Market-Edge-Audit

Содержимое архива:
  database.sql         — полный дамп PostgreSQL (все таблицы)
  models/              — ML-модели (CSV: веса + метаданные)
    model_versions.csv — все версии моделей (LR веса как JSON, LGB как base64)
  app_settings.json    — настройки приложения
  stats.txt            — статистика таблиц

Восстановление базы данных:
  psql \$DATABASE_URL < database.sql

Примечание: LightGBM-модели хранятся в БД (таблица model_versions, поле binary_blob).
После восстановления дампа модели автоматически доступны без доп. действий.
EOF

# ── 6. Упаковка архива ────────────────────────────────────────────
info "Упаковываю архив → $ARCHIVE ..."
tar -czf "$ARCHIVE" -C /tmp "aegis-export-$DATE"
rm -rf "$EXPORT_DIR"

SIZE=$(du -sh "$ARCHIVE" | cut -f1)
info "═══════════════════════════════════════════════════════"
info "Готово! Архив: $ARCHIVE ($SIZE)"
info ""
info "Содержимое:"
info "  database.sql         — вся база PostgreSQL"
info "  models/              — ML-модели (веса + LGB-бинари)"
info "  app_settings.json    — настройки"
info "  stats.txt            — количество строк в таблицах"
info ""
info "Восстановление: psql \$DATABASE_URL < database.sql"
info "═══════════════════════════════════════════════════════"
