import {
  useGetAdminCoverage,
  useGetAdminParseQueueStats,
  useGetAdminOdUsage,
  useGetAdminSchedulerState,
  getGetAdminCoverageQueryKey,
  getGetAdminParseQueueStatsQueryKey,
  getGetAdminOdUsageQueryKey,
  getGetAdminSchedulerStateQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/utils";

function pctClass(pct: number, good = 90, ok = 60): string {
  if (pct >= good) return "text-radiant";
  if (pct >= ok) return "text-primary";
  return "text-dire";
}

function MetricRow({
  label,
  value,
  hint,
  valueClass,
}: {
  label: string;
  value: string | number;
  hint?: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 border-b border-border/40 last:border-0">
      <span className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider">{label}</span>
      <div className="text-right">
        <span className={`font-mono text-sm font-bold ${valueClass ?? "text-foreground"}`}>{value}</span>
        {hint ? <div className="font-mono text-[10px] text-muted-foreground">{hint}</div> : null}
      </div>
    </div>
  );
}

function Bar({ pct, threshold }: { pct: number; threshold?: number }) {
  const clamped = Math.min(100, Math.max(0, pct));
  const colorCls = pct >= 90 ? "bg-radiant" : pct >= 60 ? "bg-primary" : "bg-dire";
  return (
    <div className="w-full h-1.5 bg-border/40 relative overflow-hidden">
      <div className={`h-full ${colorCls}`} style={{ width: `${clamped}%` }} />
      {threshold !== undefined ? (
        <div className="absolute top-0 bottom-0 w-px bg-foreground/50" style={{ left: `${threshold}%` }} />
      ) : null}
    </div>
  );
}

function DraftsCard() {
  const { data, isLoading } = useGetAdminCoverage({ query: { refetchInterval: 30_000, queryKey: getGetAdminCoverageQueryKey() } });
  if (isLoading || !data) return <Skeleton className="h-48 w-full" />;
  const d = data.drafts;
  return (
    <Card className="rounded-none border-border bg-card">
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary">Драфты</CardTitle>
        <CardDescription className="font-mono text-xs">Покрытие picks/bans по матчам</CardDescription>
      </CardHeader>
      <CardContent className="pt-4 space-y-3">
        {[
          { label: "30 дней", pct: d.pct30d, cov: d.covered30d, tot: d.total30d },
          { label: "90 дней", pct: d.pct90d, cov: d.covered90d, tot: d.total90d },
          { label: "365 дней", pct: d.pct365d, cov: d.covered365d, tot: d.total365d },
        ].map((row) => (
          <div key={row.label} className="space-y-1">
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider">{row.label}</span>
              <span className={`font-mono text-sm font-bold ${pctClass(row.pct)}`}>
                {row.pct.toFixed(1)}%
                <span className="text-muted-foreground font-normal ml-2 text-[10px]">
                  {row.cov.toLocaleString("ru")} / {row.tot.toLocaleString("ru")}
                </span>
              </span>
            </div>
            <Bar pct={row.pct} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ParsedCard() {
  const { data: cov, isLoading: covLoading } = useGetAdminCoverage({ query: { refetchInterval: 30_000, queryKey: getGetAdminCoverageQueryKey() } });
  const { data: queue, isLoading: qLoading } = useGetAdminParseQueueStats({ query: { refetchInterval: 30_000, queryKey: getGetAdminParseQueueStatsQueryKey() } });
  if (covLoading || qLoading || !cov) return <Skeleton className="h-72 w-full" />;
  const p = cov.parsed;
  const q = (queue ?? {}) as {
    queue?: Array<{ status: string; count: number }>;
    parsed?: { latestParsedAt?: string | null };
    oldestQueued?: Array<{ matchId: number; requestedAt: string; attempts: number }>;
  };
  const queueByStatus = (q.queue ?? []).reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = r.count;
    return acc;
  }, {});
  return (
    <Card className="rounded-none border-border bg-card">
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary">Replay Parse</CardTitle>
        <CardDescription className="font-mono text-xs">
          Post-mortem data из OpenDota replay-parser{" "}
          {p.cruiseReady60d ? (
            <span className="text-radiant">· готов к крейсерскому режиму ({p.cruiseReadyThreshold}%+)</span>
          ) : (
            <span className="text-primary">· накапливаем до {p.cruiseReadyThreshold}%</span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-4 space-y-3">
        {[
          { label: "60 дней", pct: p.pct60d, cov: p.parsed60d, tot: p.total60d, thresh: p.cruiseReadyThreshold },
          { label: "180 дней", pct: p.pct180d, cov: p.parsed180d, tot: p.total180d },
        ].map((row) => (
          <div key={row.label} className="space-y-1">
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider">{row.label}</span>
              <span className={`font-mono text-sm font-bold ${pctClass(row.pct)}`}>
                {row.pct.toFixed(1)}%
                <span className="text-muted-foreground font-normal ml-2 text-[10px]">
                  {row.cov.toLocaleString("ru")} / {row.tot.toLocaleString("ru")}
                </span>
              </span>
            </div>
            <Bar pct={row.pct} threshold={row.thresh} />
          </div>
        ))}
        <div className="pt-3 border-t border-border/40 space-y-1">
          <MetricRow label="Всего распаршено" value={p.parsedTotal.toLocaleString("ru")} />
          <MetricRow
            label="Очередь (queued)"
            value={(queueByStatus.queued ?? 0).toLocaleString("ru")}
            valueClass={queueByStatus.queued ? "text-primary" : "text-foreground"}
          />
          <MetricRow
            label="Failed"
            value={(queueByStatus.failed ?? 0).toLocaleString("ru")}
            valueClass={queueByStatus.failed ? "text-dire" : "text-foreground"}
          />
          <MetricRow
            label="Timeout"
            value={(queueByStatus.timeout ?? 0).toLocaleString("ru")}
            valueClass={queueByStatus.timeout ? "text-primary" : "text-foreground"}
          />
          {q.parsed?.latestParsedAt ? (
            <MetricRow label="Последний parse" value={formatDate(q.parsed.latestParsedAt)} />
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function PlayersTeamsCard() {
  const { data, isLoading } = useGetAdminCoverage({ query: { refetchInterval: 30_000, queryKey: getGetAdminCoverageQueryKey() } });
  if (isLoading || !data) return <Skeleton className="h-72 w-full" />;
  const ps = data.playerStats;
  const tf = data.teamFeatures;
  return (
    <Card className="rounded-none border-border bg-card">
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary">Игроки и команды</CardTitle>
        <CardDescription className="font-mono text-xs">Признаки, считаемые фоновыми job-ами</CardDescription>
      </CardHeader>
      <CardContent className="pt-4 space-y-1">
        <MetricRow label="player_hero_stats" value={ps.playerHeroRows.toLocaleString("ru")} hint="строк" />
        <MetricRow label="player_ratings (Glicko)" value={ps.playerRatingRows.toLocaleString("ru")} hint="игроков" />
        <div className="pt-3 mt-1 border-t border-border/40" />
        <MetricRow
          label="team_recent_form"
          value={tf.recentFormRows.toLocaleString("ru")}
          hint={tf.recentFormLastAt ? `последний пересчёт ${formatDate(tf.recentFormLastAt)}` : undefined}
        />
        <MetricRow
          label="team_extended_features"
          value={tf.extendedRows.toLocaleString("ru")}
          hint={tf.extendedLastAt ? `последний пересчёт ${formatDate(tf.extendedLastAt)}` : undefined}
        />
        <MetricRow label="team_h2h" value={tf.h2hRows.toLocaleString("ru")} hint="пар команд" />
      </CardContent>
    </Card>
  );
}

function LiveOutcomesCard() {
  const { data, isLoading } = useGetAdminCoverage({ query: { refetchInterval: 30_000, queryKey: getGetAdminCoverageQueryKey() } });
  if (isLoading || !data) return <Skeleton className="h-72 w-full" />;
  const ls = data.liveSnapshots;
  const po = data.prematchOutcomes;
  return (
    <Card className="rounded-none border-border bg-card">
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary">Live & Outcomes</CardTitle>
        <CardDescription className="font-mono text-xs">
          Live polling + накопление prematch outcomes для тренировки live-моделей
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-4 space-y-1">
        <MetricRow label="Live snapshots / 24ч" value={ls.last24h.toLocaleString("ru")} />
        <MetricRow
          label="Из них с Stratz"
          value={`${ls.withStratzEnrichment} (${ls.stratzPct.toFixed(1)}%)`}
          valueClass={ls.stratzPct > 0 ? "text-radiant" : "text-muted-foreground"}
          hint={ls.stratzPct === 0 ? "Stratz live upstream пуст (dormant)" : undefined}
        />
        {ls.lastCapturedAt ? (
          <MetricRow label="Последний snapshot" value={formatDate(ls.lastCapturedAt)} />
        ) : null}
        <div className="pt-3 mt-1 border-t border-border/40" />
        <MetricRow
          label="prematch_outcomes (всего)"
          value={po.total.toLocaleString("ru")}
          valueClass={po.liveTrainReady ? "text-radiant" : "text-foreground"}
        />
        <MetricRow label="За 30 дней" value={po.last30d.toLocaleString("ru")} />
        <div className="pt-2">
          <div className="flex items-baseline justify-between mb-1">
            <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
              К live-train (порог {po.liveTrainReadyThreshold})
            </span>
            <span
              className={`font-mono text-[11px] font-bold ${
                po.liveTrainReady ? "text-radiant" : "text-primary"
              }`}
            >
              {po.liveTrainReady ? "ГОТОВ" : `${Math.round((100 * po.total) / po.liveTrainReadyThreshold)}%`}
            </span>
          </div>
          <Bar pct={Math.min(100, (100 * po.total) / po.liveTrainReadyThreshold)} threshold={100} />
        </div>
      </CardContent>
    </Card>
  );
}

function OdUsageCard() {
  const { data, isLoading } = useGetAdminOdUsage({ query: { refetchInterval: 60_000, queryKey: getGetAdminOdUsageQueryKey() } });
  if (isLoading || !data) return <Skeleton className="h-56 w-full" />;
  return (
    <Card className="rounded-none border-border bg-card">
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary">OpenDota usage</CardTitle>
        <CardDescription className="font-mono text-xs">
          {data.hasKey ? (
            <span className="text-radiant">Премиум-ключ активен · 3000 req/min · $0.0001/req · 404/429/500 free</span>
          ) : (
            <span className="text-dire">Без ключа · 60 req/min, 3000/день</span>
          )}
          {" · "}счётчик in-memory (сбрасывается при рестарте)
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-4 space-y-1">
        <MetricRow
          label="Сегодня"
          value={data.today.toLocaleString("ru")}
          hint={`≈ $${data.estimatedCostUsdToday.toFixed(4)}`}
        />
        <MetricRow label="За 7 дней" value={data.last7d.toLocaleString("ru")} />
        <MetricRow
          label="За 30 дней"
          value={data.last30d.toLocaleString("ru")}
          hint={`≈ $${data.estimatedCostUsdLast30d.toFixed(4)}`}
        />
      </CardContent>
    </Card>
  );
}

function SchedulerCard() {
  const { data, isLoading } = useGetAdminSchedulerState({ query: { refetchInterval: 60_000, queryKey: getGetAdminSchedulerStateQueryKey() } });
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  const state = (data ?? {}) as Record<string, unknown>;
  const entries = Object.entries(state).filter(([k]) => !["status", "ok"].includes(k));
  return (
    <Card className="rounded-none border-border bg-card">
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary">Scheduler</CardTitle>
        <CardDescription className="font-mono text-xs">Состояние SchedulerWorker'а (авто-ретрейн)</CardDescription>
      </CardHeader>
      <CardContent className="pt-4 space-y-1">
        {entries.length === 0 ? (
          <div className="font-mono text-[11px] text-muted-foreground py-2">Состояние пустое</div>
        ) : (
          entries.map(([k, v]) => {
            const display =
              v === null || v === undefined
                ? "—"
                : typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)
                  ? formatDate(v)
                  : typeof v === "object"
                    ? JSON.stringify(v)
                    : String(v);
            return <MetricRow key={k} label={k} value={display} />;
          })
        )}
      </CardContent>
    </Card>
  );
}

export default function Coverage() {
  const { data: cov } = useGetAdminCoverage({ query: { queryKey: getGetAdminCoverageQueryKey() } });
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-primary uppercase tracking-wider">Coverage / Health</h1>
        <p className="font-mono text-xs text-muted-foreground mt-1">
          Покрытие БД, очередь парсинга, использование OpenDota-квоты, scheduler. Обновление каждые 30 сек.
          {cov?.generatedAt ? ` · последний снимок ${formatDate(cov.generatedAt)}` : ""}
        </p>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <DraftsCard />
        <ParsedCard />
        <PlayersTeamsCard />
        <LiveOutcomesCard />
        <OdUsageCard />
        <SchedulerCard />
      </div>
    </div>
  );
}
