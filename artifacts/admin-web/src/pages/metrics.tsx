import { Fragment, useState, useMemo } from "react";
import { useGetAdminMetrics, useGetAdminModels } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMetric } from "@/lib/utils";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import registry from "@/data/feature-registry.json";

interface FeatureEntry {
  id: string;
  group: string;
  label_ru: string;
  shortHint_ru: string;
  longDescription_ru: string;
  computedBy: string;
  sourceTables: string[];
  engines: string[];
  usedInBuckets: string[];
  valueType: string;
  rangeMin: number;
  rangeMax: number;
  nullable: boolean;
  unit: string;
}

const GROUP_LABELS: Record<string, string> = {
  prematch_team: "Командные (prematch)",
  prematch_hero: "Драфт / Герои (prematch v2+)",
  prematch_extra: "Игроки / Glicko / H2H (prematch v3)",
  live_winner: "Live-winner модель",
  live_totals: "Live-totals (kills / duration)",
};

function FeatureExplorer() {
  const [filter, setFilter] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const features = (registry.features as FeatureEntry[]);
  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? features.filter(f =>
          f.id.toLowerCase().includes(q) ||
          f.label_ru.toLowerCase().includes(q) ||
          f.shortHint_ru.toLowerCase().includes(q) ||
          f.sourceTables.some(t => t.toLowerCase().includes(q)))
      : features;
    const map = new Map<string, FeatureEntry[]>();
    for (const f of filtered) {
      const arr = map.get(f.group) ?? [];
      arr.push(f);
      map.set(f.group, arr);
    }
    return map;
  }, [filter, features]);

  return (
    <Card className="rounded-none border-border bg-card">
      <CardHeader className="border-b border-border pb-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary">
              Реестр фичей моделей
            </CardTitle>
            <p className="text-[10px] font-mono text-muted-foreground mt-1">
              {features.length} фичей · клик по строке — раскрыть описание · источник: docs/feature-registry.json
            </p>
          </div>
          <Input
            placeholder="Фильтр: id / название / таблица…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="rounded-none w-72 font-mono text-xs"
          />
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {Array.from(grouped.entries()).map(([groupId, items]) => (
          <div key={groupId} className="border-b border-border/40 last:border-b-0">
            <div className="px-4 py-2 bg-muted/30 font-mono text-[10px] uppercase tracking-wider text-muted-foreground flex justify-between">
              <span>{GROUP_LABELS[groupId] ?? groupId}</span>
              <span>{items.length} фичей</span>
            </div>
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="font-mono text-[10px] uppercase w-[28%]">ID / Название</TableHead>
                  <TableHead className="font-mono text-[10px] uppercase">Краткий смысл</TableHead>
                  <TableHead className="font-mono text-[10px] uppercase text-right w-[15%]">Бакеты</TableHead>
                  <TableHead className="font-mono text-[10px] uppercase text-right w-[10%]">Тип</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map(f => (
                  <Fragment key={f.id}>
                    <TableRow
                      className="border-border/30 hover:bg-muted/40 cursor-pointer"
                      onClick={() => setOpenId(openId === f.id ? null : f.id)}
                    >
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-mono text-xs font-bold text-foreground">{f.id}</span>
                          <span className="font-mono text-[10px] text-muted-foreground">{f.label_ru}</span>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-[11px] text-muted-foreground">
                        {f.shortHint_ru}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex gap-1 justify-end flex-wrap">
                          {f.usedInBuckets.map(b => (
                            <Badge key={b} variant="outline" className="rounded-none font-mono text-[9px]">
                              {b}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-[10px] text-muted-foreground">
                        {f.valueType}{f.nullable ? "?" : ""}
                      </TableCell>
                    </TableRow>
                    {openId === f.id && (
                      <TableRow className="border-border/30 bg-background/50 hover:bg-background/50">
                        <TableCell colSpan={4} className="p-4">
                          <div className="grid gap-3 text-xs">
                            <div>
                              <div className="font-mono text-[10px] uppercase text-muted-foreground mb-1">Подробно</div>
                              <p className="text-foreground leading-relaxed">{f.longDescription_ru}</p>
                            </div>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 font-mono text-[10px]">
                              <div>
                                <div className="uppercase text-muted-foreground">Считает</div>
                                <div className="text-foreground">{f.computedBy || "—"}</div>
                              </div>
                              <div>
                                <div className="uppercase text-muted-foreground">Таблицы</div>
                                <div className="text-foreground">{f.sourceTables.length ? f.sourceTables.join(", ") : "—"}</div>
                              </div>
                              <div>
                                <div className="uppercase text-muted-foreground">Движки</div>
                                <div className="text-foreground">{f.engines.join(", ")}</div>
                              </div>
                              <div>
                                <div className="uppercase text-muted-foreground">Диапазон</div>
                                <div className="text-foreground">
                                  [{f.rangeMin}, {f.rangeMax}]{f.unit ? ` ${f.unit}` : ""}
                                </div>
                              </div>
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
        ))}
        {grouped.size === 0 && (
          <div className="text-center py-8 font-mono text-xs text-muted-foreground uppercase">
            НИЧЕГО НЕ НАЙДЕНО
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function Metrics() {
  const { data: metricsData, isLoading: isMetricsLoading } = useGetAdminMetrics();
  const { data: modelsData, isLoading: isModelsLoading } = useGetAdminModels();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold tracking-tight">ML Метрики</h2>
        <p className="text-muted-foreground font-mono text-xs uppercase tracking-wider mt-1">Детальная статистика производительности моделей</p>
      </div>

      <div className="grid gap-6">
        <Card className="rounded-none border-border bg-card">
          <CardHeader className="border-b border-border pb-3">
            <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary">Сводные данные</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            {isMetricsLoading ? (
              <div className="space-y-2"><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-full" /></div>
            ) : metricsData ? (
              <div className="grid gap-2 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
                {Object.entries(metricsData).map(([key, val]) => (
                  <div key={key} className="flex justify-between items-center p-3 bg-background border border-border/50">
                    <span className="font-mono text-xs text-muted-foreground truncate mr-2" title={key}>{key}</span>
                    <span className="font-mono text-xs font-bold text-foreground">
                      {typeof val === 'number' ? formatMetric(val) : String(val)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-4 font-mono text-xs text-muted-foreground uppercase">ДАННЫЕ ОТСУТСТВУЮТ</div>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-none border-border bg-card">
          <CardHeader className="border-b border-border pb-3">
            <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary">Таблица моделей</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isModelsLoading ? (
              <div className="p-4 space-y-2"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>
            ) : modelsData?.models?.length ? (
              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="font-mono text-xs uppercase tracking-wider">Тип / Версия</TableHead>
                    <TableHead className="font-mono text-xs uppercase tracking-wider">Движок</TableHead>
                    <TableHead className="font-mono text-xs uppercase tracking-wider text-right">Acc (Train / Test)</TableHead>
                    <TableHead className="font-mono text-xs uppercase tracking-wider text-right">Brier</TableHead>
                    <TableHead className="font-mono text-xs uppercase tracking-wider text-right">Sample (N)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {modelsData.models.map((model) => (
                    <TableRow key={model.id} className="border-border/50 hover:bg-muted/50">
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-mono text-xs font-bold text-primary">{model.kind}</span>
                          <span className="font-mono text-[10px] text-muted-foreground">v{model.version} (ft: {model.featuresVersion})</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="rounded-none font-mono text-[10px]">{model.engine}</Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {formatMetric(model.trainAccuracy)} / <span className="font-bold">{formatMetric(model.testAccuracy)}</span>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {formatMetric(model.brierScore)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">
                        {model.testSampleSize || '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="text-center py-8 font-mono text-xs text-muted-foreground uppercase">МОДЕЛИ НЕ НАЙДЕНЫ</div>
            )}
          </CardContent>
        </Card>

        <FeatureExplorer />
      </div>
    </div>
  );
}
