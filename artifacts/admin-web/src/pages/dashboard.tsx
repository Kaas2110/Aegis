import { useState } from "react";
import {
  useGetAdminSchedulerState,
  useGetAdminModels,
  useGetAdminMetrics,
  useTriggerAdminRefreshAll,
  useTriggerAdminRetrain,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate, formatMetric } from "@/lib/utils";
import { AlertCircle, Clock, CheckCircle2, XCircle, Settings2, ShieldAlert, RefreshCw, Cpu } from "lucide-react";

export default function Dashboard() {
  const { data: schedulerState, isLoading: isLoadingScheduler } = useGetAdminSchedulerState();
  const { data: modelsData, isLoading: isLoadingModels } = useGetAdminModels();
  const { data: metricsData, isLoading: isLoadingMetrics } = useGetAdminMetrics();
  const refreshAll = useTriggerAdminRefreshAll();
  const retrain = useTriggerAdminRetrain();
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  const [retrainMsg, setRetrainMsg] = useState<string | null>(null);

  const handleRefresh = async () => {
    try {
      const r = await refreshAll.mutateAsync();
      const at = (r as { at?: string } | undefined)?.at;
      setRefreshMsg(`Готово: кэши очищены ${at ? `(${formatDate(at)})` : ''}. Открой мобилку и потяни pull-to-refresh.`);
    } catch (e) {
      setRefreshMsg(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
    }
    setTimeout(() => setRefreshMsg(null), 6000);
  };

  const handleRetrain = async () => {
    if (!window.confirm('Запустить полное переобучение моделей? Займёт ~10-30 мин в фоне. Активные модели будут обновлены атомарно после успеха.')) return;
    try {
      const r = await retrain.mutateAsync();
      const started = (r as { started?: boolean; reason?: string } | undefined);
      if (started?.started === false) {
        setRetrainMsg(`Уже запущено или невозможно: ${started.reason ?? '—'}`);
      } else {
        setRetrainMsg('Переобучение запущено в фоне. Проверь «Последняя тренировка» через ~15 мин.');
      }
    } catch (e) {
      setRetrainMsg(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
    }
    setTimeout(() => setRetrainMsg(null), 8000);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Операционная панель</h2>
          <p className="text-muted-foreground font-mono text-xs uppercase tracking-wider mt-1">Текущее состояние системы и ML-моделей</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-2">
            <Button
              onClick={handleRetrain}
              disabled={retrain.isPending}
              variant="outline"
              className="rounded-none border-primary/40 text-primary hover:bg-primary/10 font-mono text-xs uppercase tracking-wider"
            >
              <Cpu className={`w-4 h-4 mr-2 ${retrain.isPending ? 'animate-pulse' : ''}`} />
              Переобучить модели
            </Button>
            <Button
              onClick={handleRefresh}
              disabled={refreshAll.isPending}
              variant="outline"
              className="rounded-none border-primary/40 text-primary hover:bg-primary/10 font-mono text-xs uppercase tracking-wider"
            >
              <RefreshCw className={`w-4 h-4 mr-2 ${refreshAll.isPending ? 'animate-spin' : ''}`} />
              Обновить приложение
            </Button>
          </div>
          {retrainMsg && (
            <span className="text-[11px] font-mono text-primary max-w-xs text-right">{retrainMsg}</span>
          )}
          {refreshMsg && (
            <span className="text-[11px] font-mono text-muted-foreground max-w-xs text-right">{refreshMsg}</span>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {isLoadingScheduler ? (
          Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-none bg-card" />)
        ) : (
          <>
            {(() => {
              const notes = (schedulerState as { notes?: { failedAt?: string } } | undefined)?.notes;
              const failedAt = notes?.failedAt ? new Date(notes.failedAt).getTime() : 0;
              const errorIsRecent = failedAt > 0 && Date.now() - failedAt < 24 * 60 * 60 * 1000;
              const currentStep = schedulerState?.currentStep as string | undefined;
              const showError = errorIsRecent && !!schedulerState?.lastError;
              const statusValue = currentStep || (showError ? "ОШИБКА" : "ОК");
              const statusSubtitle = currentStep
                ? "Идёт обработка"
                : showError
                  ? "Ошибка в последнем цикле"
                  : "Работает в штатном режиме";
              return (
                <StatusCard
                  title="Статус планировщика"
                  value={statusValue}
                  status={showError ? "error" : "success"}
                  subtitle={statusSubtitle}
                  icon={showError ? XCircle : CheckCircle2}
                />
              );
            })()}
            <StatusCard 
              title="Последний ингест" 
              value={formatDate(schedulerState?.lastIngestAt as string)} 
              icon={Clock}
            />
            <StatusCard 
              title="Последняя тренировка" 
              value={formatDate(schedulerState?.lastTrainAt as string)} 
              icon={Clock}
            />
            <StatusCard 
              title="Версия патча" 
              value={schedulerState?.lastPatchSeen as string || "—"} 
              subtitle={`Детект: ${formatDate(schedulerState?.lastPatchDetectedAt as string)}`}
              icon={Settings2}
            />
          </>
        )}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="rounded-none border-border bg-card">
          <CardHeader className="pb-3 border-b border-border">
            <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary">Активные модели</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            {isLoadingModels ? (
              <div className="space-y-3">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : modelsData?.models?.length ? (
              <div className="space-y-4">
                {Object.entries(
                  modelsData.models.reduce((acc, m) => {
                    (acc[m.kind] = acc[m.kind] || []).push(m);
                    return acc;
                  }, {} as Record<string, typeof modelsData.models>)
                ).map(([kind, groupModels]) => (
                  <div key={kind} className="space-y-2">
                    <h3 className="text-xs font-mono uppercase tracking-widest text-muted-foreground">{kind}</h3>
                    <div className="space-y-1">
                      {groupModels.map(m => (
                        <div key={m.id} className="flex items-center justify-between text-sm py-1.5 px-2 bg-background border border-border/50">
                          <span className="font-mono text-xs">{m.version}</span>
                          <div className="flex gap-2 items-center">
                            <Badge variant="outline" className="rounded-none font-mono text-[10px] h-5">{m.engine}</Badge>
                            <span className="font-mono text-xs text-muted-foreground">Acc: {formatMetric(m.testAccuracy)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState message="Нет активных моделей" />
            )}
          </CardContent>
        </Card>

        <Card className="rounded-none border-border bg-card">
          <CardHeader className="pb-3 border-b border-border flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary">Сводка по метрикам</CardTitle>
            <ShieldAlert className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="pt-4">
            {isLoadingMetrics ? (
              <div className="space-y-3">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : metricsData && Object.keys(metricsData).length > 0 ? (
              <div className="space-y-2">
                {Object.entries(metricsData).slice(0, 5).map(([key, value]) => (
                  <div key={key} className="flex justify-between items-center p-2 bg-background border border-border/50">
                    <span className="font-mono text-xs text-muted-foreground">{key}</span>
                    <span className="font-mono text-xs font-bold">{typeof value === 'number' ? formatMetric(value) : String(value)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState message="Метрики не найдены" />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatusCard({ title, value, subtitle, status, icon: Icon }: { title: string, value: string | React.ReactNode, subtitle?: string, status?: 'default'|'success'|'error', icon: React.ElementType }) {
  return (
    <Card className="rounded-none border-border bg-card">
      <CardContent className="p-4 flex items-start gap-4">
        <div className={`p-2 rounded-sm ${status === 'error' ? 'bg-destructive/10 text-destructive' : status === 'success' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
          <Icon className="w-5 h-5" />
        </div>
        <div>
          <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-1">{title}</p>
          <p className="text-lg font-bold tracking-tight uppercase">{value}</p>
          {subtitle && <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>}
        </div>
      </CardContent>
    </Card>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
      <AlertCircle className="w-8 h-8 mb-2 opacity-50" />
      <span className="font-mono text-xs uppercase tracking-wider">{message}</span>
    </div>
  );
}
