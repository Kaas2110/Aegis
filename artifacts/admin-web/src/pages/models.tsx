import { useState, Fragment } from "react";
import {
  useGetAdminModelsHistory,
  useActivateAdminModel,
  useGetAdminModelCalibration,
  getGetAdminModelsHistoryQueryKey,
  getGetAdminModelsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/hooks/use-toast";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, RotateCw } from "lucide-react";

type ModelRow = {
  id: number;
  kind: string;
  version: string;
  engine: string;
  featuresVersion: number;
  testAccuracy: number | null;
  brierScore: number | null;
  testSampleSize: number | null;
  createdAt: string;
  isActive?: boolean;
};

function fmt(n: number | null | undefined, digits = 3): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function fmtDate(s: string): string {
  try {
    const d = new Date(s);
    return d.toISOString().slice(0, 16).replace("T", " ");
  } catch {
    return s;
  }
}

/**
 * Parse "version family" from version string.
 * Examples:
 *   "lgbm-2026-05-19-07-24-34-v4-prematch_winner_t1" → 4
 *   "lr-v2026-05-17-20-49-37-v2-prematch_winner"     → 2
 *   "vlgbm-..."                                       → null (no -vN- group)
 * Returns null if not parseable — those bubble to the bottom of active group.
 */
function parseVersionFamily(version: string): number | null {
  const m = version.match(/-v(\d+)-/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function CalibrationPanel({ modelId }: { modelId: number }) {
  const { data, isLoading } = useGetAdminModelCalibration(modelId);

  if (isLoading) {
    return <Skeleton className="h-48 w-full" />;
  }
  if (!data) {
    return (
      <div className="font-mono text-xs text-muted-foreground uppercase py-4">
        Не удалось загрузить калибровку
      </div>
    );
  }

  const bins = data.calibration.bins ?? [];
  const chartData = bins.map((b) => ({
    rawMid: (b.minProb + b.maxProb) / 2,
    calibrated: b.calibratedProb,
  }));

  const fv = data.featureView;
  const drifts = data.drifts ?? [];
  const severeDrifts = drifts.filter((d) => Math.abs(d.rel) > 0.20);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2 text-xs font-mono">
        <div className="border border-border/50 bg-background p-2">
          <span className="text-muted-foreground uppercase tracking-wider">Тип</span>
          <div className="font-bold mt-1">
            {data.calibration.identity ? "identity (без калибровки)" : "isotonic"}
          </div>
        </div>
        <div className="border border-border/50 bg-background p-2">
          <span className="text-muted-foreground uppercase tracking-wider">Bins / Sample</span>
          <div className="font-bold mt-1">
            {bins.length} bins · n={data.calibration.sampleSize ?? "—"}
          </div>
        </div>
        <div
          className={`border p-2 ${fv.stale ? "border-amber-500/60 bg-amber-500/10" : "border-border/50 bg-background"}`}
          title="D1 — feature view версия модели vs текущая константа в коде"
        >
          <span className="text-muted-foreground uppercase tracking-wider">Feature View</span>
          <div className="font-bold mt-1 flex items-center gap-1">
            {fv.stale && <AlertTriangle className="w-3 h-3 text-amber-400" />}
            fv={fv.modelFv}
            {fv.currentFv != null && fv.currentFv !== fv.modelFv && (
              <span className="text-muted-foreground"> / cur={fv.currentFv}</span>
            )}
          </div>
        </div>
      </div>

      {drifts.length > 0 && (
        <div>
          <div className="text-xs font-mono uppercase text-muted-foreground tracking-wider mb-2 flex items-center gap-2">
            {severeDrifts.length > 0 && <AlertTriangle className="w-3 h-3 text-amber-400" />}
            Data drift · top {drifts.length} (|train−test mean| &gt; 10%)
          </div>
          <div className="bg-background border border-border/50">
            {drifts.map((d) => {
              const severe = Math.abs(d.rel) > 0.20;
              const pct = Math.min(100, Math.abs(d.rel) * 100);
              return (
                <div
                  key={d.name}
                  className="flex items-center gap-2 px-2 py-1 border-b border-border/30 last:border-b-0"
                >
                  <div className="font-mono text-[11px] w-44 truncate" title={d.name}>
                    {d.name}
                  </div>
                  <div className="flex-1 h-2 bg-muted/30 relative">
                    <div
                      className={`absolute top-0 left-0 h-2 ${severe ? "bg-amber-400/80" : "bg-primary/50"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="font-mono text-[11px] w-28 text-right text-muted-foreground">
                    {fmt(d.trainMean, 2)} → {fmt(d.testMean, 2)}
                  </div>
                  <div
                    className={`font-mono text-[11px] w-12 text-right font-bold ${severe ? "text-amber-400" : ""}`}
                  >
                    {(d.rel * 100).toFixed(0)}%
                  </div>
                </div>
              );
            })}
          </div>
          {severeDrifts.length > 0 && (
            <div className="text-[10px] font-mono text-amber-400/80 mt-2 leading-relaxed">
              ⚠ {severeDrifts.length} фич(ей) с |drift| &gt; 20% между train и test — стоит проверить
              распределения и, возможно, пересобрать окно тренировки.
            </div>
          )}
        </div>
      )}

      {bins.length >= 2 ? (
        <div>
          <div className="text-xs font-mono uppercase text-muted-foreground tracking-wider mb-2">
            Reliability диаграмма (сырая модельная p → калиброванная p)
          </div>
          <div className="bg-background border border-border/50 p-3">
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
                <XAxis
                  dataKey="rawMid"
                  type="number"
                  domain={[0, 1]}
                  tickFormatter={(v) => v.toFixed(1)}
                  stroke="hsl(var(--muted-foreground))"
                  tick={{ fontSize: 10, fontFamily: "monospace" }}
                />
                <YAxis
                  type="number"
                  domain={[0, 1]}
                  tickFormatter={(v) => v.toFixed(1)}
                  stroke="hsl(var(--muted-foreground))"
                  tick={{ fontSize: 10, fontFamily: "monospace" }}
                />
                <RechartsTooltip
                  contentStyle={{
                    background: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    fontFamily: "monospace",
                    fontSize: 11,
                  }}
                  formatter={(v: number) => v.toFixed(3)}
                  labelFormatter={(v: number) => `Raw ${v.toFixed(3)}`}
                />
                <ReferenceLine
                  segment={[
                    { x: 0, y: 0 },
                    { x: 1, y: 1 },
                  ]}
                  stroke="hsl(var(--muted-foreground))"
                  strokeDasharray="4 4"
                  label={{ value: "y=x", position: "insideTopRight", fontSize: 10 }}
                />
                <Line
                  type="monotone"
                  dataKey="calibrated"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="text-[10px] font-mono text-muted-foreground mt-2 leading-relaxed">
            Чем ближе кривая к диагонали — тем лучше калибровка. Прогиб вниз = модель
            переоценивает уверенность, прогиб вверх = недооценивает.
          </div>
        </div>
      ) : (
        <div className="font-mono text-xs text-muted-foreground py-2">
          {data.calibration.identity
            ? "Калибровка не применена (identity). Это норма для свежих экспериментальных моделей."
            : "Недостаточно бинов для отрисовки диаграммы (нужно ≥2)."}
        </div>
      )}

      {data.featureImportance.length > 0 && (
        <div>
          <div className="text-xs font-mono uppercase text-muted-foreground tracking-wider mb-2">
            Feature importance · top {data.featureImportance.length}
          </div>
          <div className="bg-background border border-border/50">
            {data.featureImportance.map((f) => {
              const max = Math.max(...data.featureImportance.map((x) => Math.abs(x.weight)));
              const pct = max > 0 ? (Math.abs(f.weight) / max) * 100 : 0;
              return (
                <div
                  key={f.name}
                  className="flex items-center gap-2 px-2 py-1 border-b border-border/30 last:border-b-0"
                >
                  <div className="font-mono text-[11px] w-44 truncate" title={f.name}>
                    {f.name}
                  </div>
                  <div className="flex-1 h-2 bg-muted/30 relative">
                    <div
                      className="absolute top-0 left-0 h-2 bg-primary/70"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="font-mono text-[11px] w-16 text-right">
                    {fmt(f.weight, 4)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ModelTableRows({
  models,
  expandedId,
  setExpandedId,
  onActivate,
  activatePending,
}: {
  models: ModelRow[];
  expandedId: number | null;
  setExpandedId: (id: number | null) => void;
  onActivate: (id: number, kind: string, version: string) => void;
  activatePending: boolean;
}) {
  return (
    <>
      {models.map((m) => {
        const isExpanded = expandedId === m.id;
        const isActive = m.isActive === true;
        const vf = parseVersionFamily(m.version);
        return (
          <Fragment key={m.id}>
            <TableRow className="border-border/50 hover:bg-muted/50">
              <TableCell className="p-1">
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 rounded-none"
                  onClick={() => setExpandedId(isExpanded ? null : m.id)}
                  title={isExpanded ? "Свернуть" : "Развернуть калибровку"}
                >
                  {isExpanded ? (
                    <ChevronDown className="w-3 h-3" />
                  ) : (
                    <ChevronRight className="w-3 h-3" />
                  )}
                </Button>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  {vf != null && (
                    <Badge
                      variant="outline"
                      className={`rounded-none font-mono text-[10px] px-1.5 ${
                        vf >= 4
                          ? "border-emerald-500/60 text-emerald-400"
                          : vf === 3
                            ? "border-primary/60 text-primary"
                            : "border-border text-muted-foreground"
                      }`}
                    >
                      v{vf}
                    </Badge>
                  )}
                  <div className="flex flex-col">
                    <span className="font-mono text-xs font-bold text-primary">
                      {m.kind}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {m.version} (ft: {m.featuresVersion})
                    </span>
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <Badge variant="outline" className="rounded-none font-mono text-[10px]">
                  {m.engine}
                </Badge>
              </TableCell>
              <TableCell className="text-right font-mono text-xs font-bold">
                {fmt(m.testAccuracy)}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {fmt(m.brierScore)}
              </TableCell>
              <TableCell className="text-right font-mono text-xs text-muted-foreground">
                {m.testSampleSize ?? "—"}
              </TableCell>
              <TableCell className="font-mono text-[10px] text-muted-foreground">
                {fmtDate(m.createdAt)}
              </TableCell>
              <TableCell className="text-center">
                {isActive ? (
                  <Badge className="rounded-none font-mono text-[10px] bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20">
                    <CheckCircle2 className="w-3 h-3 mr-1" />
                    ACTIVE
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="rounded-none font-mono text-[10px] text-muted-foreground"
                  >
                    shadow
                  </Badge>
                )}
              </TableCell>
              <TableCell className="text-right">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isActive || activatePending}
                  className="rounded-none font-mono text-[10px] h-7 px-2"
                  onClick={() => onActivate(m.id, m.kind, m.version)}
                  title={
                    isActive
                      ? "Уже активна"
                      : "Сделать активной (атомарно деактивирует конкурента того же kind+version-family)"
                  }
                >
                  <RotateCw className="w-3 h-3 mr-1" />
                  Активировать
                </Button>
              </TableCell>
            </TableRow>
            {isExpanded && (
              <TableRow className="border-border/50">
                <TableCell colSpan={9} className="bg-muted/20 p-4">
                  <CalibrationPanel modelId={m.id} />
                </TableCell>
              </TableRow>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

function ModelTableHeader() {
  return (
    <TableHeader>
      <TableRow className="border-border hover:bg-transparent">
        <TableHead className="w-8" />
        <TableHead className="font-mono text-xs uppercase tracking-wider">
          Тип / Версия
        </TableHead>
        <TableHead className="font-mono text-xs uppercase tracking-wider">
          Движок
        </TableHead>
        <TableHead className="font-mono text-xs uppercase tracking-wider text-right">
          Acc test
        </TableHead>
        <TableHead className="font-mono text-xs uppercase tracking-wider text-right">
          Brier
        </TableHead>
        <TableHead className="font-mono text-xs uppercase tracking-wider text-right">
          N test
        </TableHead>
        <TableHead className="font-mono text-xs uppercase tracking-wider">
          Создана
        </TableHead>
        <TableHead className="font-mono text-xs uppercase tracking-wider text-center">
          Статус
        </TableHead>
        <TableHead />
      </TableRow>
    </TableHeader>
  );
}

export default function Models() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useGetAdminModelsHistory();
  const activate = useActivateAdminModel();
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [showArchive, setShowArchive] = useState(false);

  const allModels: ModelRow[] = (data?.models ?? []) as ModelRow[];

  // Split active vs archived.
  const activeModels = allModels.filter((m) => m.isActive === true);
  const archivedModels = allModels.filter((m) => m.isActive !== true);

  // Sort active: version family DESC (v4 → v3 → v2 → v1 → unknown),
  // then kind ASC (group same family together: prematch_winner, prematch_winner_t1, prematch_winner_t2, ...),
  // then createdAt DESC.
  activeModels.sort((a, b) => {
    const va = parseVersionFamily(a.version);
    const vb = parseVersionFamily(b.version);
    const vaSort = va ?? -1;
    const vbSort = vb ?? -1;
    if (vaSort !== vbSort) return vbSort - vaSort;
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  // Sort archive: newest first.
  archivedModels.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  function onActivate(id: number, kind: string, version: string) {
    if (!window.confirm(`Сделать ${kind} v${version} активной? Текущая будет деактивирована.`)) {
      return;
    }
    activate.mutate(
      { id },
      {
        onSuccess: (r) => {
          toast({
            title: r.alreadyActive ? "Уже активна" : "Активирована",
            description: `${r.kind} v${r.version} (${r.engine})`,
          });
          queryClient.invalidateQueries({ queryKey: getGetAdminModelsHistoryQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetAdminModelsQueryKey() });
        },
        onError: (e) => {
          toast({
            title: "Ошибка активации",
            description: String(e),
            variant: "destructive",
          });
        },
      },
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold tracking-tight">Управление моделями</h2>
        <p className="text-muted-foreground font-mono text-xs uppercase tracking-wider mt-1">
          Активные сверху по версии фич (v4 → v1) · нажми ▶ чтобы развернуть калибровку
        </p>
      </div>

      <Card className="rounded-none border-border bg-card">
        <CardHeader className="border-b border-border pb-3">
          <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary flex items-center justify-between">
            <span>Активные модели ({activeModels.length})</span>
            <span className="text-[10px] text-muted-foreground font-normal normal-case">
              v4 — полные фичи (E1 + OD), v3 — base + draft, v2 — base, v1 — team-only fallback
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : activeModels.length === 0 ? (
            <div className="text-center py-8 font-mono text-xs text-muted-foreground uppercase">
              Активных моделей нет
            </div>
          ) : (
            <Table>
              <ModelTableHeader />
              <TableBody>
                <ModelTableRows
                  models={activeModels}
                  expandedId={expandedId}
                  setExpandedId={setExpandedId}
                  onActivate={onActivate}
                  activatePending={activate.isPending}
                />
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {archivedModels.length > 0 && (
        <Collapsible open={showArchive} onOpenChange={setShowArchive}>
          <Card className="rounded-none border-border bg-card">
            <CollapsibleTrigger asChild>
              <CardHeader className="border-b border-border pb-3 cursor-pointer hover:bg-muted/30 transition-colors">
                <CardTitle className="text-sm font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                  {showArchive ? (
                    <ChevronDown className="w-4 h-4" />
                  ) : (
                    <ChevronRight className="w-4 h-4" />
                  )}
                  Старые модели ({archivedModels.length})
                  <span className="text-[10px] font-normal normal-case ml-2">
                    Прошлые retrain'ы — можно вернуть из истории
                  </span>
                </CardTitle>
              </CardHeader>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent className="p-0">
                <Table>
                  <ModelTableHeader />
                  <TableBody>
                    <ModelTableRows
                      models={archivedModels}
                      expandedId={expandedId}
                      setExpandedId={setExpandedId}
                      onActivate={onActivate}
                      activatePending={activate.isPending}
                    />
                  </TableBody>
                </Table>
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>
      )}
    </div>
  );
}
