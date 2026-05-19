import { useState, useEffect, useRef } from "react";
import {
  useGetAdminWorkersConfig,
  useUpdateAdminWorkersConfig,
  useGetAdminJobs,
  useRunAdminJob,
  useGetAdminJobStatus,
  useGetAdminSettings,
  useUpdateAdminSettings,
  getGetAdminJobsQueryKey,
  getGetAdminWorkersConfigQueryKey,
  getGetAdminJobStatusQueryKey,
  getGetAdminSettingsQueryKey,
  type AdminJobSummary,
  type AdminWorkersConfig,
  type AdminJobsListResponse,
  type AdminJobStatusResponse,
  type AdminAppSettings,
  type AdminSettingsInput,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/utils";

// ─── helpers ────────────────────────────────────────────────────────────────

function statusColor(status: string) {
  if (status === "running") return "text-primary animate-pulse";
  if (status === "done") return "text-radiant";
  return "text-dire";
}

function fmtMs(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

// ─── preset scripts ──────────────────────────────────────────────────────────

type Preset = {
  label: string;
  script: string;
  args?: string[];
  description: string;
  phase: string;
};

const PRESETS: Preset[] = [
  // ── Полные shell-пайплайны (фасад над scripts/run-*.sh) ──
  { phase: "★ Полные пайплайны (целиком, в правильном порядке)",
    label: "DAILY · run-daily.sh",
    script: "sh:daily",
    description: "Полный daily-батч: 11 пресетов (teams → matches → leagues → hero-stats → hero-matchups → hero-synergy → recent-form → h2h → player-glicko → team-extended → bo3-series). ~25-40 мин. Лог: /tmp/ingest_logs/daily.log" },
  { phase: "★ Полные пайплайны (целиком, в правильном порядке)",
    label: "ENRICH · run-enrichment-pipeline.sh",
    script: "sh:enrichment",
    description: "Еженедельный enrichment: тяжёлые ingest:drafts (~1.7ч) + ingest:players-heroes. НЕ запускать в рабочее время. Лог: /tmp/ingest_logs/enrichment.log" },

  // ── Replay Parse (отдельная группа, запускается вручную при наполнении БД) ──
  { phase: "0. Replay Parse — один цикл (parse:request → 90s → ingest:parsed)",
    label: "00 · parse:cycle",   script: "parse:cycle",   description: "Ставит 500 матчей в очередь OD, ждёт 90s, сохраняет разобранные. ~6 мин. Запускать повторно пока match_parsed растёт." },
  { phase: "0. Replay Parse — один цикл (parse:request → 90s → ingest:parsed)",
    label: "00а · parse:request", script: "parse:request", args: ["--", "--limit", "500"], description: "Только шаг 1: поставить до 500 матчей в очередь OD-парсера" },
  { phase: "0. Replay Parse — один цикл (parse:request → 90s → ingest:parsed)",
    label: "00б · ingest:parsed", script: "ingest:parsed", args: ["--", "--limit", "500"], description: "Только шаг 2: сохранить до 500 разобранных матчей (запускать через 90+ сек после 00а)" },

  // ── Полный pipeline наполнения БД (порядок строгий) ──
  { phase: "1. Фундамент (независимы, можно параллельно)",
    label: "01 · ingest:teams",         script: "ingest:teams",         description: "Рейтинги команд (~1000)" },
  { phase: "1. Фундамент (независимы, можно параллельно)",
    label: "02 · ingest:leagues",       script: "ingest:leagues",       description: "Названия лиг" },
  { phase: "1. Фундамент (независимы, можно параллельно)",
    label: "03 · ingest:hero-stats",    script: "ingest:hero-stats",    description: "Мета: винрейт/пикрейт героев" },
  { phase: "1. Фундамент (независимы, можно параллельно)",
    label: "04 · ingest:hero-matchups", script: "ingest:hero-matchups", description: "Матрица противостояний героев (Stratz)" },
  { phase: "1. Фундамент (независимы, можно параллельно)",
    label: "05 · ingest:hero-synergy",  script: "ingest:hero-synergy",  description: "Синергия пар героев" },
  { phase: "1. Фундамент (независимы, можно параллельно)",
    label: "06 · ingest:matches 3",     script: "ingest:matches", args: ["3"], description: "~300 свежих про-матчей (основа для всего ниже)" },

  { phase: "2. Данные матчей (после 06 · ingest:matches)",
    label: "07 · ingest:drafts",        script: "ingest:drafts",        description: "Пики/баны + account_id игроков" },

  { phase: "3. Данные игроков (после 07 · ingest:drafts)",
    label: "09 · ingest:players-heroes",  script: "ingest:players-heroes",  description: "Статистика игроков по героям (свежесть 7d)" },
  { phase: "3. Данные игроков (после 07 · ingest:drafts)",
    label: "10 · ingest:od-player-peers", script: "ingest:od-player-peers", description: "Винрейт игроков в паре (OD Premium)" },

  { phase: "4. OD Премиум — фичи героев (независимы)",
    label: "11 · ingest:od-scenarios",     script: "ingest:od-scenarios",     description: "Тайминги предметов / роли на лейне (OD)" },
  { phase: "4. OD Премиум — фичи героев (независимы)",
    label: "12 · ingest:od-distributions", script: "ingest:od-distributions", description: "Длительности матчей + мета-распределения (OD)" },

  // ── E1 OD-расширение (2026-05-18) — 8 новых источников ────────────────
  // Все добавляют ДОП. колонки в feature vectors, ничего не заменяют.
  // Автозаливка идёт через workflow «Data Enrichment» (steps 10-17/17).
  // Дёргать вручную нужно только при первичном наполнении или ускорении.
  { phase: "5. E1 OD-расширение — независимые (запускать в любом порядке)",
    label: "20 · ingest:od-pro-players", script: "ingest:od-pro-players",
    description: "Справочник pro-аккаунтов с team_id (1 запрос, ~3600 строк, weekly)" },
  { phase: "5. E1 OD-расширение — независимые (запускать в любом порядке)",
    label: "21 · ingest:od-hero-benchmarks", script: "ingest:od-hero-benchmarks",
    description: "Перцентили GPM/XPM/kills/LH/dmg героев (~127 req, ~7 сек, weekly)" },
  { phase: "5. E1 OD-расширение — независимые (запускать в любом порядке)",
    label: "22 · ingest:od-hero-item-popularity", script: "ingest:od-hero-item-popularity",
    description: "Start/early/mid/late game шмотки героев (~127 req, ~7 сек, weekly)" },

  { phase: "6. E1 OD-расширение — командные (после 01 · ingest:teams)",
    label: "23 · ingest:od-team-rosters", script: "ingest:od-team-rosters",
    description: "Текущий ростер + games/wins per player (~3000 команд × 50ms ≈ 2.5 мин, 7d freshness)" },
  { phase: "6. E1 OD-расширение — командные (после 01 · ingest:teams)",
    label: "24 · ingest:od-team-hero-pools", script: "ingest:od-team-hero-pools",
    description: "Hero pool команды для draft-overlap фич (~3000 команд × 50ms ≈ 2.5 мин, 7d freshness)" },

  { phase: "7. E1 OD-расширение — игровые (после 07 · ingest:drafts)",
    label: "25 · ingest:od-player-totals", script: "ingest:od-player-totals",
    description: "Долгосрочные суммы статов игрока (~3000 акк × 50ms ≈ 2.5 мин, 14d freshness)" },
  { phase: "7. E1 OD-расширение — игровые (после 07 · ingest:drafts)",
    label: "26 · ingest:od-player-counts", script: "ingest:od-player-counts",
    description: "Распределение по lane_role / game_mode (для roleClarity, ~3000 акк, 14d freshness)" },
  { phase: "7. E1 OD-расширение — игровые (после 07 · ingest:drafts)",
    label: "27 · ingest:od-player-wl-pro", script: "ingest:od-player-wl-pro",
    description: "Pro-only WL за 180д (~3000 акк × 50ms ≈ 2.5 мин, 14d freshness)" },

  { phase: "5. Снапшоты (опционально)",
    label: "14 · backfill:live-snapshots", script: "backfill:live-snapshots", description: "Восстановить live-снапшоты из OD" },

  { phase: "6. Вычисление признаков (после всех ingest)",
    label: "15 · compute:recent-form",   script: "compute:recent-form",   description: "Форма команд за 30/90 дней" },
  { phase: "6. Вычисление признаков (после всех ingest)",
    label: "16 · compute:h2h",           script: "compute:h2h",           description: "Личные встречи команд за 365 дней" },
  { phase: "6. Вычисление признаков (после всех ingest)",
    label: "17 · compute:player-glicko", script: "compute:player-glicko", description: "Рейтинги игроков по Glicko-1" },
  { phase: "6. Вычисление признаков (после всех ingest)",
    label: "18 · compute:team-extended", script: "compute:team-extended", description: "Расширенный снапшот признаков команды" },
  { phase: "6. Вычисление признаков (после всех ingest)",
    label: "19 · compute:bo3-series",    script: "compute:bo3-series",    description: "Агрегаты серий BO3/BO5" },
];

// ─── Worker Flags (F2) ───────────────────────────────────────────────────────

function WorkerFlagsPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useGetAdminWorkersConfig();
  const update = useUpdateAdminWorkersConfig();

  const toggle = (field: "liveWorkerDisabled" | "schedulerDisabled" | "autoRetrainDisabled", current: boolean) => {
    update.mutate(
      { data: { [field]: !current } },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: getGetAdminWorkersConfigQueryKey() });
          toast({ title: "Настройки сохранены", description: "Флаг воркера обновлён в БД" });
        },
        onError: (err: unknown) => {
          toast({
            variant: "destructive",
            title: "Ошибка",
            description: err instanceof Error ? err.message : "Не удалось обновить флаг",
          });
        },
      },
    );
  };

  type FlagKey = "liveWorkerDisabled" | "schedulerDisabled" | "autoRetrainDisabled";
  type EnvKey = "envDisableLiveWorker" | "envDisableScheduler" | "envDisableAutoRetrain";

  const flags: { key: FlagKey; label: string; hint: string; envKey: EnvKey }[] = [
    {
      key: "liveWorkerDisabled",
      label: "Live Worker",
      hint: "LiveWorker — опрос live-матчей каждые 20-30s, live ML predictions. Изменение вступает в силу при следующем рестарте api-server.",
      envKey: "envDisableLiveWorker",
    },
    {
      key: "schedulerDisabled",
      label: "Scheduler Worker",
      hint: "SchedulerWorker — 24h retrain pipeline + daily refresh. Изменение вступает в силу при следующем рестарте api-server.",
      envKey: "envDisableScheduler",
    },
    {
      key: "autoRetrainDisabled",
      label: "Auto-Retrain",
      hint: "Запрет автоматического переобучения внутри Scheduler. Изменение учитывается на следующем 24h-тике (без рестарта).",
      envKey: "envDisableAutoRetrain",
    },
  ];

  return (
    <Card className="rounded-none border-border bg-card">
      <CardHeader className="border-b border-border pb-4">
        <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary">
          Флаги воркеров
        </CardTitle>
        <CardDescription className="font-mono text-xs">
          Хранятся в БД (app_settings.store_settings). ENV-флаги — только для чтения.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-6 space-y-4">
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
          </div>
        ) : data ? (
          flags.map(({ key, label, hint, envKey }) => {
            const cfg = data as AdminWorkersConfig;
            const dbDisabled = cfg[key];
            const envDisabled = cfg[envKey];
            const effectivelyDisabled = dbDisabled || envDisabled;
            return (
              <div key={key} className="border border-border bg-background p-4 space-y-2">
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-0.5">
                    <p className="font-bold text-sm uppercase tracking-wider">
                      {label}
                    </p>
                    <p className="font-mono text-[10px] text-muted-foreground leading-relaxed max-w-xl">
                      {hint}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    {envDisabled && (
                      <span className="font-mono text-[10px] text-dire uppercase border border-dire/30 px-1.5 py-0.5 bg-dire/5">
                        ENV=DISABLE
                      </span>
                    )}
                    <Button
                      size="sm"
                      variant={effectivelyDisabled ? "secondary" : "default"}
                      disabled={update.isPending || envDisabled}
                      onClick={() => toggle(key, dbDisabled)}
                      className="rounded-none font-mono text-[10px] uppercase tracking-wider h-8 min-w-24"
                    >
                      {effectivelyDisabled ? "ВЫКЛЮЧЕН" : "ВКЛЮЧЁН"}
                    </Button>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${effectivelyDisabled ? "bg-dire/60" : "bg-radiant/60"}`} />
                  <span className={`font-mono text-[10px] ${effectivelyDisabled ? "text-dire" : "text-radiant"}`}>
                    {effectivelyDisabled ? "Отключён" : "Активен"}
                  </span>
                </div>
              </div>
            );
          })
        ) : (
          <p className="font-mono text-xs text-muted-foreground text-center py-4 uppercase">
            Данные недоступны
          </p>
        )}
        {data?.heartbeats ? (
          <div className="border-t border-border pt-4 space-y-2">
            <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Heartbeats (in-memory, сбрасываются при рестарте api-server)
            </p>
            <div className="grid gap-2 grid-cols-1 sm:grid-cols-2">
              {(["liveWorker", "scheduler"] as const).map((hkey) => {
                const hb = (data as AdminWorkersConfig).heartbeats[hkey];
                const ok = hb.lastStatus === "ok";
                const err = hb.lastStatus === "error";
                const ageMs = hb.lastTickAt ? Date.now() - new Date(hb.lastTickAt).getTime() : null;
                const stale = ageMs !== null && ageMs > 5 * 60_000;
                const color = err ? "bg-dire/60" : ok && !stale ? "bg-radiant/60" : stale ? "bg-primary/60" : "bg-muted-foreground/40";
                return (
                  <div key={hkey} className="border border-border bg-background p-3 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[10px] font-bold uppercase">
                        {hkey === "liveWorker" ? "Live Worker" : "Scheduler"}
                      </span>
                      <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${color}`} />
                        <span className="font-mono text-[10px] uppercase text-muted-foreground">
                          {hb.lastStatus}
                        </span>
                      </div>
                    </div>
                    <p className="font-mono text-[10px] text-muted-foreground">
                      Последний тик: {hb.lastTickAt ? formatDate(hb.lastTickAt) : "—"}
                      {ageMs !== null && (
                        <span className={stale ? "text-dire" : ""}> ({fmtMs(ageMs)} назад)</span>
                      )}
                    </p>
                    <p className="font-mono text-[10px] text-muted-foreground">
                      Тиков: {hb.totalTicks}
                      {hb.lastDurationMs !== null && ` · длительность ${fmtMs(hb.lastDurationMs)}`}
                    </p>
                    {hb.lastError && (
                      <p className="font-mono text-[10px] text-dire break-words">
                        ⚠ {hb.lastError}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
        {data?.note ? (
          <p className="font-mono text-[10px] text-muted-foreground border-t border-border pt-3 leading-relaxed">
            ℹ {(data as { note?: string }).note}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ─── Polling Intervals (Phase 10) ───────────────────────────────────────────
// Hot-reload интервалов воркеров без рестарта api-server. Каждый воркер на
// своём тике читает app_settings — изменения подхватываются на следующем тике.
// Mobile-поля отдаются через GET /api/client-config (мобилка пуллит раз в 5 мин).

type IntervalField = {
  key: keyof Pick<AdminAppSettings,
    | 'liveWorkerLiveSec' | 'liveWorkerIdleSec' | 'liveWorkerUpcomingWindowMin'
    | 'bookmakerLiveSec' | 'bookmakerUpcomingSec' | 'bookmakerIdleSec'
    | 'schedulerTickHours' | 'mobilePollLiveSec' | 'mobilePollIdleSec'>;
  label: string;
  hint: string;
  min: number;
  max: number;
  unit: string;
};

type IntervalGroup = { title: string; description: string; fields: IntervalField[] };

const INTERVAL_GROUPS: IntervalGroup[] = [
  {
    title: "LiveWorker (OpenDota /api/live)",
    description: "Адаптив: live = есть валидные live-матчи, idle = их нет. 429/5xx даёт отдельный экспоненциальный backoff поверх.",
    fields: [
      { key: 'liveWorkerLiveSec',           label: 'Live interval',  hint: 'Tick когда есть live матчи',         min: 5,  max: 3600,  unit: 'сек' },
      { key: 'liveWorkerIdleSec',           label: 'Idle interval',  hint: 'Tick когда live матчей нет',         min: 30, max: 86400, unit: 'сек' },
      { key: 'liveWorkerUpcomingWindowMin', label: 'Upcoming window', hint: 'Резерв для будущего 3-режима',     min: 0,  max: 240,   unit: 'мин' },
    ],
  },
  {
    title: "BookmakerWorker",
    description: "Три режима: live (есть live), wake_for_start (upcoming близко), idle. Loopback-сбой даёт фиксированный 3-мин fallback.",
    fields: [
      { key: 'bookmakerLiveSec',     label: 'Live interval',     hint: 'Tick когда есть live матчи',     min: 30, max: 3600,  unit: 'сек' },
      { key: 'bookmakerUpcomingSec', label: 'Wake buffer',       hint: 'Буфер после begin_at (wake_for_start)', min: 10, max: 600, unit: 'сек' },
      { key: 'bookmakerIdleSec',     label: 'Idle interval',     hint: 'Tick когда live=0 и upcoming далеко', min: 60, max: 86400, unit: 'сек' },
    ],
  },
  {
    title: "SchedulerWorker",
    description: "Период daily-check (патчи / retrain decision / lightweight ingest). Если задан ENV AUTO_RETRAIN_CRON_HOUR_UTC — он перекрывает это значение wall-clock'ом.",
    fields: [
      { key: 'schedulerTickHours', label: 'Tick interval', hint: 'Период daily-check', min: 1, max: 168, unit: 'час' },
    ],
  },
  {
    title: "Mobile polling (/api/client-config)",
    description: "Мобилка пуллит /api/client-config раз в 5 минут и подменяет setInterval. Изменения видны мобилке через 0-5 мин + 60s in-memory TTL.",
    fields: [
      { key: 'mobilePollLiveSec', label: 'Live interval', hint: 'Polling когда у пользователя есть live матчи', min: 15, max: 600,  unit: 'сек' },
      { key: 'mobilePollIdleSec', label: 'Idle interval', hint: 'Polling в idle',                                min: 30, max: 3600, unit: 'сек' },
    ],
  },
];

function IntervalsPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useGetAdminSettings();
  const update = useUpdateAdminSettings();
  const [draft, setDraft] = useState<Partial<AdminSettingsInput>>({});

  const settings = (data as { settings?: AdminAppSettings } | undefined)?.settings;

  useEffect(() => {
    setDraft({});
  }, [settings?.updatedAt]);

  function currentValue(key: IntervalField['key']): number | '' {
    const v = draft[key] ?? settings?.[key];
    return typeof v === 'number' ? v : '';
  }

  function isDirty(): boolean {
    return Object.keys(draft).length > 0;
  }

  function handleSave() {
    if (!isDirty()) return;
    update.mutate(
      { data: draft },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: getGetAdminSettingsQueryKey() });
          toast({
            title: "Сохранено",
            description: "Воркеры подхватят новые интервалы на следующем тике (без рестарта).",
          });
          setDraft({});
        },
        onError: (err: unknown) => {
          toast({
            variant: "destructive",
            title: "Ошибка",
            description: err instanceof Error ? err.message : "Не удалось сохранить",
          });
        },
      },
    );
  }

  return (
    <Card className="rounded-none border-border bg-card">
      <CardHeader className="border-b border-border pb-4">
        <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary">
          Интервалы поллинга
        </CardTitle>
        <CardDescription className="font-mono text-xs">
          Hot-reload без рестарта api-server. Каждый воркер на своём тике читает app_settings.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-6 space-y-6">
        {isLoading || !settings ? (
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
          </div>
        ) : (
          <>
            {INTERVAL_GROUPS.map((group) => (
              <div key={group.title} className="space-y-2">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-wider text-primary border-b border-primary/20 pb-1">
                    {group.title}
                  </p>
                  <p className="font-mono text-[10px] text-muted-foreground leading-relaxed mt-1">
                    {group.description}
                  </p>
                </div>
                <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                  {group.fields.map((f) => {
                    const val = currentValue(f.key);
                    const dirty = draft[f.key] !== undefined && draft[f.key] !== settings[f.key];
                    return (
                      <div key={f.key} className={`border p-3 space-y-1 ${dirty ? 'border-primary bg-primary/5' : 'border-border bg-background'}`}>
                        <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                          {f.label}
                        </Label>
                        <div className="flex items-center gap-2">
                          <Input
                            type="number"
                            min={f.min}
                            max={f.max}
                            value={val}
                            onChange={(e) => {
                              const n = e.target.value === '' ? NaN : Number(e.target.value);
                              if (Number.isFinite(n)) {
                                setDraft((d) => ({ ...d, [f.key]: Math.floor(n) }));
                              } else {
                                setDraft((d) => {
                                  const { [f.key]: _, ...rest } = d;
                                  return rest;
                                });
                              }
                            }}
                            className="rounded-none font-mono text-xs h-8 w-24"
                          />
                          <span className="font-mono text-[10px] text-muted-foreground uppercase">{f.unit}</span>
                          <span className="font-mono text-[10px] text-muted-foreground ml-auto">
                            {f.min}–{f.max}
                          </span>
                        </div>
                        <p className="font-mono text-[10px] text-muted-foreground leading-relaxed">
                          {f.hint}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            <div className="flex items-center gap-3 border-t border-border pt-4">
              <Button
                onClick={handleSave}
                disabled={!isDirty() || update.isPending}
                className="rounded-none font-mono text-xs uppercase tracking-wider h-9"
              >
                {update.isPending ? 'СОХРАНЕНИЕ...' : isDirty() ? `▶ Сохранить (${Object.keys(draft).length})` : 'Сохранить'}
              </Button>
              {isDirty() && (
                <Button
                  variant="ghost"
                  onClick={() => setDraft({})}
                  className="rounded-none font-mono text-xs uppercase tracking-wider h-9"
                >
                  Отменить
                </Button>
              )}
              <span className="font-mono text-[10px] text-muted-foreground ml-auto">
                Обновлено: {settings.updatedAt ? formatDate(settings.updatedAt) : '—'}
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Job Log Modal ──────────────────────────────────────────────────────────

function JobLogPanel({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const logRef = useRef<HTMLPreElement>(null);
  const { data, isLoading } = useGetAdminJobStatus(jobId, {
    query: {
      queryKey: getGetAdminJobStatusQueryKey(jobId),
      refetchInterval: (query) => {
        const d = query.state.data as AdminJobStatusResponse | undefined;
        return d?.status === "running" ? 1500 : false;
      },
    },
  });

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [data?.output]);

  return (
    <div className="border border-border bg-card rounded-none">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs font-bold uppercase">
            {data?.script ?? "..."}
          </span>
          {data ? (
            <span className={`font-mono text-[10px] uppercase ${statusColor(data.status)}`}>
              {data.status}
            </span>
          ) : null}
          {data?.durationMs ? (
            <span className="font-mono text-[10px] text-muted-foreground">{fmtMs(data.durationMs)}</span>
          ) : null}
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} className="rounded-none font-mono text-[10px] h-7 uppercase">
          ✕ Закрыть
        </Button>
      </div>
      <pre
        ref={logRef}
        className="font-mono text-[10px] leading-relaxed p-4 overflow-auto max-h-80 text-muted-foreground whitespace-pre-wrap break-words bg-background"
      >
        {isLoading
          ? "Загружаем логи..."
          : (data?.output ?? []).length === 0
          ? "(нет вывода)"
          : (data?.output ?? []).join("\n")}
      </pre>
    </div>
  );
}

// ─── Job List ────────────────────────────────────────────────────────────────

function JobRow({ job, isSelected, onSelect }: { job: AdminJobSummary; isSelected: boolean; onSelect: () => void }) {
  return (
    <div
      className={`border cursor-pointer transition-colors ${isSelected ? "border-primary bg-primary/5" : "border-border bg-background hover:bg-card"}`}
      onClick={onSelect}
    >
      <div className="flex items-center gap-3 px-3 py-2">
        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${job.status === "running" ? "bg-primary animate-pulse" : job.status === "done" ? "bg-radiant/70" : "bg-dire/70"}`} />
        <span className="font-mono text-xs font-bold flex-1 min-w-0 truncate">{job.script}</span>
        {job.args.length > 0 && (
          <span className="font-mono text-[10px] text-muted-foreground truncate max-w-32">{job.args.join(" ")}</span>
        )}
        <span className={`font-mono text-[10px] uppercase flex-shrink-0 ${statusColor(job.status)}`}>{job.status}</span>
        <span className="font-mono text-[10px] text-muted-foreground flex-shrink-0">{fmtMs(job.durationMs)}</span>
        <span className="font-mono text-[10px] text-muted-foreground flex-shrink-0">{formatDate(job.startedAt)}</span>
      </div>
    </div>
  );
}

// ─── Script Runner (F3) ─────────────────────────────────────────────────────

function ScriptRunnerPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: jobsData, isLoading: jobsLoading } = useGetAdminJobs({
    query: {
      queryKey: getGetAdminJobsQueryKey(),
      refetchInterval: (query) => {
        const jobs = (query.state.data as AdminJobsListResponse | undefined)?.jobs ?? [];
        return jobs.some((j) => j.status === "running") ? 2000 : 10_000;
      },
    },
  });
  const runJob = useRunAdminJob();

  const [selectedPreset, setSelectedPreset] = useState<(typeof PRESETS)[0] | null>(null);
  const [customArgs, setCustomArgs] = useState("");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const handleRun = (script: string, baseArgs: string[], label: string) => {
    const extraArgs = customArgs.trim() ? customArgs.trim().split(/\s+/) : [];
    const args = [...baseArgs, ...extraArgs];
    runJob.mutate(
      { data: { script, args } },
      {
        onSuccess: (res) => {
          const jobId = (res as { jobId?: string }).jobId;
          if (jobId) setSelectedJobId(jobId);
          void queryClient.invalidateQueries({ queryKey: getGetAdminJobsQueryKey() });
          toast({ title: `Запущен: ${label}`, description: `Job ID: ${jobId ?? "?"}` });
        },
        onError: (err: unknown) => {
          toast({
            variant: "destructive",
            title: "Ошибка",
            description: err instanceof Error ? err.message : "Не удалось запустить скрипт",
          });
        },
      },
    );
  };

  const jobs: AdminJobSummary[] = (jobsData as { jobs?: AdminJobSummary[] } | undefined)?.jobs ?? [];
  const allowedScripts: string[] = (jobsData as { allowedScripts?: string[] } | undefined)?.allowedScripts ?? [];

  return (
    <div className="space-y-6">
      {/* Пресеты */}
      <Card className="rounded-none border-border bg-card">
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary">
            Быстрый запуск
          </CardTitle>
          <CardDescription className="font-mono text-xs">
            Запускает скрипт в фоне. Результат — в «Журнале задач» ниже.
            Доп. аргументы добавляются к пресету.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-6 space-y-4">
          <div className="flex gap-2 items-end">
            <div className="flex-1 space-y-1">
              <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Доп. аргументы
              </Label>
              <Input
                value={customArgs}
                onChange={(e) => setCustomArgs(e.target.value)}
                placeholder="например: -- --limit 100 --since-days 30"
                className="rounded-none font-mono text-xs h-8"
              />
            </div>
            {selectedPreset && (
              <Button
                onClick={() => handleRun(selectedPreset.script, selectedPreset.args ?? [], selectedPreset.label)}
                disabled={runJob.isPending}
                className="rounded-none font-mono text-xs uppercase tracking-wider h-8 flex-shrink-0"
              >
                {runJob.isPending ? "ЗАПУСК..." : `▶ ${selectedPreset.label}`}
              </Button>
            )}
          </div>

          {Array.from(
            PRESETS.reduce((acc, p) => {
              const arr = acc.get(p.phase) ?? [];
              arr.push(p);
              acc.set(p.phase, arr);
              return acc;
            }, new Map<string, Preset[]>()),
          ).map(([phase, items]) => (
            <div key={phase} className="space-y-2">
              <p className="font-mono text-[10px] uppercase tracking-wider text-primary border-b border-primary/20 pb-1">
                {phase}
              </p>
              <div className="grid gap-2 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((p) => (
                  <div
                    key={p.script + (p.args ?? []).join()}
                    className={`border p-3 cursor-pointer transition-colors space-y-1 ${selectedPreset?.label === p.label ? "border-primary bg-primary/5" : "border-border bg-background hover:bg-card hover:border-border/80"}`}
                    onClick={() => setSelectedPreset(p.label === selectedPreset?.label ? null : p)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-mono text-xs font-bold truncate">{p.label}</p>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="rounded-none font-mono text-[10px] h-6 px-2 uppercase flex-shrink-0 hover:bg-primary/10 hover:text-primary"
                        disabled={runJob.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRun(p.script, p.args ?? [], p.label);
                        }}
                      >
                        ▶
                      </Button>
                    </div>
                    <p className="font-mono text-[10px] text-muted-foreground leading-relaxed">{p.description}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {allowedScripts.length > 0 && (
            <details className="font-mono text-[10px] text-muted-foreground">
              <summary className="cursor-pointer uppercase tracking-wider">Все разрешённые скрипты ({allowedScripts.length})</summary>
              <p className="mt-1 leading-relaxed">{allowedScripts.join(", ")}</p>
            </details>
          )}
        </CardContent>
      </Card>

      {/* Журнал задач */}
      <Card className="rounded-none border-border bg-card">
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary">
            Журнал задач
          </CardTitle>
          <CardDescription className="font-mono text-xs">
            Последние 20 job'ов текущей сессии (сбрасывается при рестарте api-server).
            Нажми на строку — развернётся лог.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-6 space-y-4">
          {selectedJobId ? (
            <JobLogPanel jobId={selectedJobId} onClose={() => setSelectedJobId(null)} />
          ) : null}

          {jobsLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : jobs.length === 0 ? (
            <div className="text-center py-6 font-mono text-xs text-muted-foreground uppercase">
              Нет задач — нажми ▶ у любого пресета
            </div>
          ) : (
            <div className="space-y-1">
              {jobs.map((j) => (
                <JobRow
                  key={j.id}
                  job={j}
                  isSelected={j.id === selectedJobId}
                  onSelect={() => setSelectedJobId(j.id === selectedJobId ? null : j.id)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function Workers() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold tracking-tight">Воркеры</h2>
        <p className="text-muted-foreground font-mono text-xs uppercase tracking-wider mt-1">
          Управление фоновыми воркерами и ручной запуск скриптов
        </p>
      </div>

      <WorkerFlagsPanel />
      <IntervalsPanel />
      <ScriptRunnerPanel />
    </div>
  );
}
