import { useState } from "react";
import {
  useGetAdminSubscriptions,
  useUpdateAdminSubscriptionPrice,
  getGetAdminSubscriptionsQueryKey,
  type AdminSubscriptionPackage,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";

const LOOKUP_KEY_LABEL: Record<string, string> = {
  "$rc_weekly": "Неделя",
  "$rc_monthly": "Месяц",
  "$rc_annual": "Год",
};

const LOOKUP_KEY_DURATION: Record<string, string> = {
  "$rc_weekly": "P1W",
  "$rc_monthly": "P1M",
  "$rc_annual": "P1Y",
};

function PackageRow({ pkg }: { pkg: AdminSubscriptionPackage }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updatePrice = useUpdateAdminSubscriptionPrice();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const label = LOOKUP_KEY_LABEL[pkg.lookupKey] ?? pkg.displayName;
  const currentPrice = pkg.testStoreProduct?.priceUsd;
  const priceStr = currentPrice != null ? `$${currentPrice.toFixed(2)}` : "—";

  const handleUpdate = () => {
    const val = parseFloat(draft);
    if (isNaN(val) || val <= 0 || val > 9999) {
      toast({ variant: "destructive", title: "Неверная цена", description: "Введите корректную цену в USD (например 4.99)" });
      return;
    }

    updatePrice.mutate(
      {
        data: {
          packageId: pkg.packageId,
          offeringId: pkg.offeringId,
          newPriceUsd: val,
          periodDuration: LOOKUP_KEY_DURATION[pkg.lookupKey],
        },
      },
      {
        onSuccess: (res) => {
          toast({
            title: "Цена обновлена",
            description: res.message ?? `$${res.newPriceUsd.toFixed(2)}`,
          });
          setEditing(false);
          setDraft("");
          queryClient.invalidateQueries({ queryKey: getGetAdminSubscriptionsQueryKey() });
        },
        onError: (err: unknown) => {
          toast({
            variant: "destructive",
            title: "Ошибка обновления",
            description: err instanceof Error ? err.message : "Не удалось обновить цену",
          });
        },
      },
    );
  };

  return (
    <div className="border border-border bg-background p-4 space-y-3">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-sm text-foreground">{label}</span>
            <code className="font-mono text-[10px] bg-card border border-border px-1.5 py-0.5 text-muted-foreground">
              {pkg.lookupKey}
            </code>
          </div>
          {pkg.testStoreProduct && (
            <div className="font-mono text-[11px] text-muted-foreground">
              ID: {(pkg.testStoreProduct.productId ?? '').slice(0, 14)}… ·{" "}
              <span className="text-foreground">{pkg.testStoreProduct.identifier}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="font-mono text-lg font-bold text-primary">{priceStr}</div>
            <div className="font-mono text-[10px] text-muted-foreground uppercase">Test Store</div>
          </div>
          {!editing && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => { setEditing(true); setDraft(currentPrice?.toFixed(2) ?? ""); }}
              className="rounded-none font-mono text-[10px] uppercase tracking-wider h-8"
            >
              Изменить
            </Button>
          )}
        </div>
      </div>

      {editing && (
        <div className="pt-2 border-t border-border space-y-2">
          <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            Новая цена (USD) — тест-стор
          </Label>
          <div className="flex gap-2">
            <Input
              type="number"
              step="0.01"
              min="0.01"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="4.99"
              className="rounded-none font-mono text-xs h-8 w-36"
            />
            <Button
              size="sm"
              onClick={handleUpdate}
              disabled={updatePrice.isPending || !draft}
              className="rounded-none font-mono text-[10px] uppercase tracking-wider h-8"
            >
              {updatePrice.isPending ? "..." : "Сохранить"}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => { setEditing(false); setDraft(""); }}
              className="rounded-none font-mono text-[10px] uppercase tracking-wider h-8"
            >
              Отмена
            </Button>
          </div>
          <p className="font-mono text-[10px] text-muted-foreground leading-relaxed">
            Создаёт новый продукт в тест-сторе, переключает пакет на него и удаляет старый.
            На Production обновите цену в App Store Connect / Google Play Console.
          </p>
        </div>
      )}
    </div>
  );
}

export default function Subscriptions() {
  const { data, isLoading, error } = useGetAdminSubscriptions();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold uppercase tracking-widest text-primary font-mono">
          Подписки
        </h1>
        <p className="text-muted-foreground text-sm font-mono mt-1">
          Управление тарифами RevenueCat. Цены тест-стора изменяются через API; продакшн — App Store Connect / Google Play Console.
        </p>
      </div>

      <Card className="rounded-none border-border bg-card">
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary">
            Текущий оффер — тарифные планы
          </CardTitle>
          <CardDescription className="font-mono text-xs">
            Все пакеты активного offering. Цены берутся из тест-стора RevenueCat.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-6">
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : error ? (
            <div className="font-mono text-xs text-dire p-4 border border-dire/30 bg-dire/10">
              Ошибка загрузки: {error instanceof Error ? error.message : "RevenueCat не настроен"}
            </div>
          ) : data ? (
            <div className="space-y-2">
              <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider pb-2">
                Оффер: {data.offeringDisplayName} · ID: {data.offeringId}
              </div>
              {data.packages.length === 0 ? (
                <div className="font-mono text-xs text-muted-foreground text-center py-6">
                  Пакеты не найдены
                </div>
              ) : (
                <div className="space-y-2">
                  {data.packages.map((pkg) => (
                    <PackageRow key={pkg.packageId} pkg={pkg} />
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card">
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary">
            Production-цены
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-6 space-y-3">
          <p className="font-mono text-xs text-muted-foreground leading-relaxed">
            Цены в App Store и Google Play управляются напрямую в консолях магазинов.
            RevenueCat синхронизирует их автоматически — редактировать из этой панели нельзя.
          </p>
          <div className="flex gap-3 flex-wrap">
            <a
              href="https://appstoreconnect.apple.com"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-mono text-[10px] bg-primary/10 border border-primary/30 text-primary hover:bg-primary/20 px-3 py-1.5 uppercase tracking-wider transition-colors"
            >
              App Store Connect ↗
            </a>
            <a
              href="https://play.google.com/console"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-mono text-[10px] bg-primary/10 border border-primary/30 text-primary hover:bg-primary/20 px-3 py-1.5 uppercase tracking-wider transition-colors"
            >
              Google Play Console ↗
            </a>
            <a
              href="https://app.revenuecat.com"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-mono text-[10px] bg-card border border-border text-muted-foreground hover:text-foreground px-3 py-1.5 uppercase tracking-wider transition-colors"
            >
              RevenueCat Dashboard ↗
            </a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
