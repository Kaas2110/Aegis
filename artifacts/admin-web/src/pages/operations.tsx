import { useState } from "react";
import {
  useTriggerAdminRetrain,
  useTriggerAdminPrune,
  useGetAdminOddsStatus,
  useGetAdminIntegrations,
  useUpdateAdminIntegration,
  useProbeAdminBookmakers,
  getGetAdminIntegrationsQueryKey,
  getGetAdminOddsStatusQueryKey,
  getGetAdminSettingsQueryKey,
  type AdminIntegrationStatus,
  type AdminBookmakerProbeResult,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/utils";

const CATEGORY_LABEL: Record<string, string> = {
  "data-source": "Источник данных",
  "odds-feed": "Букмекерские котировки",
  network: "Сетевая инфраструктура",
};

const SOURCE_LABEL: Record<string, string> = {
  override: "OVERRIDE",
  env: "ENV",
  none: "НЕ ЗАДАН",
};

const SOURCE_COLOR: Record<string, string> = {
  override: "text-radiant",
  env: "text-primary",
  none: "text-muted-foreground",
};

// Публичные источники без ключей — показываем для прозрачности.
const PUBLIC_SOURCES: { name: string; description: string; url: string }[] = [
  {
    name: "OpenDota",
    description: "Live & pro-матчи, тимы, лиги, hero stats. Rate-limit ~60/мин. Без ключа.",
    url: "https://docs.opendota.com",
  },
  {
    name: "Fonbet",
    description: "Букмекер (RU). Публичный mobile API. Гео-блок не-РФ → нужен PROXY_URL.",
    url: "https://www.fon.bet",
  },
  {
    name: "Лига Ставок",
    description: "Букмекер (RU). Публичный web JSON API. Гео-блок не-РФ → нужен PROXY_URL.",
    url: "https://www.ligastavok.ru",
  },
  {
    name: "PARI",
    description: "Букмекер (RU). Публичный web JSON API. Гео-блок не-РФ → нужен PROXY_URL.",
    url: "https://pari.ru",
  },
  {
    name: "BetBoom",
    description: "Букмекер (RU). Публичный web JSON API. Гео-блок не-РФ → нужен PROXY_URL.",
    url: "https://betboom.ru",
  },
  {
    name: "1xStavka",
    description: "Букмекер (RU). Публичный mobile API. Гео-блок не-РФ → нужен PROXY_URL.",
    url: "https://1xstavka.ru",
  },
  {
    name: "Olimp.bet",
    description: "Букмекер (RU). Публичный web JSON API. Гео-блок не-РФ → нужен PROXY_URL.",
    url: "https://www.olimp.bet",
  },
];

function BookmakerProbePanel() {
  const { toast } = useToast();
  const probe = useProbeAdminBookmakers();
  const [results, setResults] = useState<AdminBookmakerProbeResult[] | null>(null);
  const [probedAt, setProbedAt] = useState<string | null>(null);
  const [proxyConfigured, setProxyConfigured] = useState<boolean>(false);

  const handleProbe = () => {
    probe.mutate(
      { data: {} },
      {
        onSuccess: (data) => {
          setResults(data.results);
          setProbedAt(data.probedAt);
          setProxyConfigured(data.proxyConfigured);
          const okCount = data.results.filter((r) => r.ok && (r.contentType ?? "").includes("json")).length;
          toast({
            title: "Probe завершён",
            description: `Живых JSON-источников: ${okCount} / ${data.results.length}`,
          });
        },
        onError: (err: unknown) => {
          toast({
            variant: "destructive",
            title: "Ошибка probe",
            description: err instanceof Error ? err.message : "—",
          });
        },
      },
    );
  };

  const verdict = (r: AdminBookmakerProbeResult): { label: string; color: string } => {
    if (r.rateLimited) return { label: "RATE-LIMIT", color: "text-muted-foreground" };
    if (r.error && r.httpStatus === null) return { label: "DNS / CONN", color: "text-dire" };
    if (r.httpStatus && r.httpStatus >= 500) return { label: `HTTP ${r.httpStatus}`, color: "text-dire" };
    if (r.httpStatus === 403) return { label: "BLOCKED 403", color: "text-dire" };
    if (r.httpStatus === 404) return { label: "404 (URL устарел)", color: "text-dire" };
    if (r.ok && r.contentType && !r.contentType.includes("json"))
      return { label: "HTML (челлендж)", color: "text-primary" };
    if (r.ok && r.contentType?.includes("json")) return { label: "OK JSON", color: "text-radiant" };
    return { label: r.error ?? "?", color: "text-muted-foreground" };
  };

  return (
    <Card className="rounded-none border-border bg-card">
      <CardHeader className="border-b border-border pb-4">
        <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary">
          Букмекеры — диагностика источников
        </CardTitle>
        <CardDescription className="font-mono text-xs">
          1 запрос на источник, минимум 30 сек между probe одного источника. На не-РФ IP
          без PROXY_URL все 6 источников будут заблокированы (DNS / Cloudflare / гео).
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-6 space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <Button
            onClick={handleProbe}
            disabled={probe.isPending}
            className="rounded-none font-mono text-xs uppercase tracking-wider"
          >
            {probe.isPending ? "PROBING..." : "ЗАПУСТИТЬ PROBE (6 ИСТОЧНИКОВ)"}
          </Button>
          {probedAt ? (
            <span className="font-mono text-[10px] text-muted-foreground uppercase">
              Запущен: {formatDate(probedAt)} · proxy: {proxyConfigured ? "ON" : "OFF"}
            </span>
          ) : null}
        </div>

        {results ? (
          <div className="border border-border bg-background overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead className="bg-card border-b border-border">
                <tr className="text-left text-muted-foreground uppercase text-[10px]">
                  <th className="px-3 py-2">Источник</th>
                  <th className="px-3 py-2">Статус</th>
                  <th className="px-3 py-2">HTTP</th>
                  <th className="px-3 py-2">Тип</th>
                  <th className="px-3 py-2">Размер</th>
                  <th className="px-3 py-2">Latency</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => {
                  const v = verdict(r);
                  return (
                    <tr key={r.source} className="border-t border-border">
                      <td className="px-3 py-2 font-bold text-foreground">{r.name}</td>
                      <td className={`px-3 py-2 font-bold ${v.color}`}>{v.label}</td>
                      <td className="px-3 py-2">{r.httpStatus ?? "—"}</td>
                      <td className="px-3 py-2 text-muted-foreground truncate max-w-[160px]">
                        {r.contentType ?? "—"}
                      </td>
                      <td className="px-3 py-2">{r.bodySize ?? "—"}b</td>
                      <td className="px-3 py-2">{r.latencyMs}ms</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="font-mono text-xs text-muted-foreground">
            Нажмите «Запустить probe» — увидите живой статус каждого источника. На Replit без
            PROXY_URL ожидается «DNS / CONN», «BLOCKED 403» или «HTML (челлендж)» вместо JSON.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function IntegrationCard({ integration }: { integration: AdminIntegrationStatus }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const update = useUpdateAdminIntegration();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);

  const handleSave = (value: string | null) => {
    update.mutate(
      { data: { envName: integration.envName, value } },
      {
        onSuccess: () => {
          toast({
            title: value ? "Override установлен" : "Override очищен",
            description: integration.label,
          });
          setEditing(false);
          setDraft("");
          // Реагируем на смену ключа в админ-вьюхах: список интеграций,
          // odds-status (зависит от ODDS_API_KEY), settings (oddsApiKeyConfigured).
          queryClient.invalidateQueries({ queryKey: getGetAdminIntegrationsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetAdminOddsStatusQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetAdminSettingsQueryKey() });
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
  };

  return (
    <div className="border border-border bg-background p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-sm text-foreground">{integration.label}</span>
            <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
              {CATEGORY_LABEL[integration.category] ?? integration.category}
            </span>
          </div>
          <p className="font-mono text-[11px] text-muted-foreground leading-relaxed">
            {integration.description}
          </p>
          <div className="flex items-center gap-3 pt-1 flex-wrap">
            <code className="font-mono text-[10px] bg-card border border-border px-1.5 py-0.5 text-muted-foreground">
              {integration.envName}
            </code>
            <a
              href={integration.docUrl}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[10px] text-primary hover:underline uppercase tracking-wider"
            >
              docs ↗
            </a>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div
            className={`font-mono text-[10px] font-bold uppercase tracking-wider ${
              SOURCE_COLOR[integration.source] ?? "text-muted-foreground"
            }`}
          >
            {SOURCE_LABEL[integration.source] ?? "?"}
          </div>
          {integration.preview ? (
            <code className="font-mono text-[10px] text-foreground block mt-1">
              {integration.preview}
            </code>
          ) : null}
        </div>
      </div>

      {editing ? (
        <div className="flex gap-2 pt-2 border-t border-border">
          <Input
            type={integration.sensitive ? "password" : "text"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Новое значение для ${integration.envName}`}
            className="rounded-none font-mono text-xs h-8"
            autoComplete="new-password"
          />
          <Button
            size="sm"
            onClick={() => handleSave(draft)}
            disabled={update.isPending || draft.length === 0}
            className="rounded-none font-mono text-[10px] uppercase tracking-wider h-8"
          >
            {update.isPending ? "..." : "Сохранить"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setEditing(false);
              setDraft("");
            }}
            className="rounded-none font-mono text-[10px] uppercase tracking-wider h-8"
          >
            Отмена
          </Button>
        </div>
      ) : (
        <div className="flex gap-2 pt-2 border-t border-border">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setEditing(true)}
            className="rounded-none font-mono text-[10px] uppercase tracking-wider h-8"
          >
            {integration.source === "override" ? "Изменить override" : "Задать override"}
          </Button>
          {integration.source === "override" ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => handleSave(null)}
              disabled={update.isPending}
              className="rounded-none font-mono text-[10px] uppercase tracking-wider h-8 text-dire"
            >
              Сбросить к ENV
            </Button>
          ) : null}
        </div>
      )}
      {integration.overrideUpdatedAt ? (
        <p className="font-mono text-[10px] text-muted-foreground">
          Override обновлён: {formatDate(integration.overrideUpdatedAt)}
        </p>
      ) : null}
    </div>
  );
}

export default function Operations() {
  const { data: oddsStatus, isLoading: isOddsLoading } = useGetAdminOddsStatus();
  const { data: integrationsData, isLoading: isIntegrationsLoading } = useGetAdminIntegrations();
  const retrain = useTriggerAdminRetrain();
  const prune = useTriggerAdminPrune();
  const { toast } = useToast();

  const [pruneDays, setPruneDays] = useState("7");

  const handleRetrain = () => {
    retrain.mutate(undefined, {
      onSuccess: (res) => {
        toast({
          title: "Переобучение запущено",
          description: res.message ?? "Процесс добавлен в очередь",
        });
      },
      onError: (err: unknown) => {
        toast({
          variant: "destructive",
          title: "Ошибка",
          description: err instanceof Error ? err.message : "Не удалось запустить переобучение",
        });
      },
    });
  };

  const handlePrune = () => {
    const days = parseInt(pruneDays, 10);
    if (Number.isNaN(days) || days < 1) return;

    prune.mutate(
      { data: { days } },
      {
        onSuccess: (res) => {
          toast({
            title: "Снапшоты очищены",
            description: `Удалено записей: ${res.deleted}`,
          });
        },
        onError: (err: unknown) => {
          toast({
            variant: "destructive",
            title: "Ошибка",
            description: err instanceof Error ? err.message : "Не удалось очистить снапшоты",
          });
        },
      },
    );
  };

  const integrations = integrationsData?.integrations ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold tracking-tight">Операции</h2>
        <p className="text-muted-foreground font-mono text-xs uppercase tracking-wider mt-1">
          Ручное управление пайплайнами и интеграциями
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="rounded-none border-border bg-card">
          <CardHeader className="border-b border-border pb-4">
            <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary">
              ML Пайплайн
            </CardTitle>
            <CardDescription className="font-mono text-xs">
              Управление обучением моделей
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-6 space-y-6">
            <div className="space-y-3">
              <div className="space-y-1">
                <Label className="text-sm font-bold uppercase tracking-wider">Переобучение</Label>
                <p className="text-xs text-muted-foreground font-mono">
                  Запускает полный цикл сбора фичей и переобучения всех активных рынков.
                </p>
              </div>
              <Button
                onClick={handleRetrain}
                disabled={retrain.isPending}
                className="w-full rounded-none font-mono text-xs uppercase tracking-wider"
              >
                {retrain.isPending ? "ЗАПУСК..." : "ЗАПУСТИТЬ ПЕРЕОБУЧЕНИЕ"}
              </Button>
            </div>

            <div className="h-px bg-border w-full" />

            <div className="space-y-3">
              <div className="space-y-1">
                <Label className="text-sm font-bold uppercase tracking-wider">
                  Очистка снапшотов
                </Label>
                <p className="text-xs text-muted-foreground font-mono">
                  Удаление старых предсказаний live-моделей.
                </p>
              </div>
              <div className="flex gap-2">
                <Input
                  type="number"
                  value={pruneDays}
                  onChange={(e) => setPruneDays(e.target.value)}
                  className="w-24 rounded-none font-mono"
                  min={1}
                />
                <Button
                  variant="secondary"
                  onClick={handlePrune}
                  disabled={prune.isPending}
                  className="flex-1 rounded-none font-mono text-xs uppercase tracking-wider"
                >
                  {prune.isPending ? "ОЧИСТКА..." : `ОЧИСТИТЬ СТАРШЕ ${pruneDays} ДНЕЙ`}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-none border-border bg-card">
          <CardHeader className="border-b border-border pb-4">
            <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary">
              Статус The Odds API
            </CardTitle>
            <CardDescription className="font-mono text-xs">
              Последняя попытка получения котировок
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-6">
            {isOddsLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : oddsStatus ? (
              <div className="space-y-4">
                <div className="flex justify-between items-center p-3 bg-background border border-border/50">
                  <span className="font-mono text-xs text-muted-foreground uppercase">
                    Доступность
                  </span>
                  <span className="font-mono text-xs font-bold text-primary">
                    {(oddsStatus as { available?: boolean }).available ? "ДА" : "НЕТ"}
                  </span>
                </div>
                {(oddsStatus as { reason?: string }).reason ? (
                  <div className="p-3 bg-background border border-border/50">
                    <p className="font-mono text-[10px] text-muted-foreground uppercase mb-1">
                      Причина
                    </p>
                    <p className="font-mono text-xs">
                      {String((oddsStatus as { reason?: string }).reason)}
                    </p>
                  </div>
                ) : null}
                {(oddsStatus as { fetchedAt?: string }).fetchedAt ? (
                  <div className="flex justify-between items-center p-3 bg-background border border-border/50">
                    <span className="font-mono text-xs text-muted-foreground uppercase">
                      Последний запрос
                    </span>
                    <span className="font-mono text-xs">
                      {formatDate(String((oddsStatus as { fetchedAt?: string }).fetchedAt))}
                    </span>
                  </div>
                ) : null}
                {(oddsStatus as { remainingRequests?: number }).remainingRequests !== undefined ? (
                  <div className="flex justify-between items-center p-3 bg-background border border-border/50">
                    <span className="font-mono text-xs text-muted-foreground uppercase">
                      Остаток квоты
                    </span>
                    <span className="font-mono text-xs font-bold">
                      {String((oddsStatus as { remainingRequests?: number }).remainingRequests)}
                    </span>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="text-center py-4 font-mono text-xs text-muted-foreground uppercase">
                СТАТУС НЕИЗВЕСТЕН
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-none border-border bg-card">
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary">
            Внешние API с ключами
          </CardTitle>
          <CardDescription className="font-mono text-xs">
            Override значений ENV хранится в БД и переживает рестарт. Пустое значение возвращает к ENV.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-6">
          {isIntegrationsLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : integrations.length === 0 ? (
            <div className="text-center py-4 font-mono text-xs text-muted-foreground uppercase">
              ИНТЕГРАЦИИ НЕ ЗАГРУЖЕНЫ
            </div>
          ) : (
            <div className="space-y-3">
              {integrations.map((integration) => (
                <IntegrationCard key={integration.envName} integration={integration} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <BookmakerProbePanel />

      <Card className="rounded-none border-border bg-card">
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary">
            Публичные источники (без ключей)
          </CardTitle>
          <CardDescription className="font-mono text-xs">
            Read-only — статус мониторится по факту запросов.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-6">
          <div className="grid gap-2 md:grid-cols-2">
            {PUBLIC_SOURCES.map((source) => (
              <div key={source.name} className="border border-border bg-background p-3 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-sm text-foreground">{source.name}</span>
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-[10px] text-primary hover:underline uppercase tracking-wider"
                  >
                    site ↗
                  </a>
                </div>
                <p className="font-mono text-[11px] text-muted-foreground leading-relaxed">
                  {source.description}
                </p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
