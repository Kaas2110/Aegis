import { useGetAdminMetrics, useGetAdminModels } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMetric } from "@/lib/utils";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

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
      </div>
    </div>
  );
}
