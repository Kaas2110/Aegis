import { useState, useEffect } from "react";
import {
  useGetAdminFeatureFlags,
  useUpdateAdminFeatureFlags,
  getGetAdminFeatureFlagsQueryKey,
  type FeatureFlagsConfig,
  type TierAccess,
  type MonetizationMode,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

type FeatureTier = "free" | "basic" | "premium";

const TIER_LABEL: Record<FeatureTier, string> = { free: "Free", basic: "Basic", premium: "Premium" };
const TIER_COLOR: Record<FeatureTier, string> = {
  free:    "bg-emerald-500 text-black border-emerald-500",
  basic:   "bg-amber-500   text-black border-amber-500",
  premium: "bg-primary     text-black border-primary",
};

type DraftFlags = Record<string, TierAccess>;

function emptyAccess(): TierAccess { return { free: false, basic: false, premium: false }; }

export function FeatureFlagsCard() {
  const { data, isLoading, error } = useGetAdminFeatureFlags();
  const update = useUpdateAdminFeatureFlags();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [draftMode, setDraftMode]   = useState<MonetizationMode | null>(null);
  const [draftFlags, setDraftFlags] = useState<DraftFlags | null>(null);

  useEffect(() => {
    if (data && draftMode === null) {
      setDraftMode(data.mode);
      setDraftFlags(Object.fromEntries(
        Object.entries(data.flags as Record<string, TierAccess>).map(([k, v]) => [k, { ...v }]),
      ));
    }
  }, [data, draftMode]);

  const mode: MonetizationMode = draftMode ?? data?.mode ?? "freemium";
  const flags: DraftFlags = draftFlags ?? (data?.flags as Record<string, TierAccess> | undefined) ?? {};
  const features = data?.features ?? [];

  const tierColumns: FeatureTier[] = mode === "freemium" ? ["free", "premium"] : ["free", "basic", "premium"];

  const dirty = (() => {
    if (!data || !draftFlags) return false;
    if (draftMode !== null && draftMode !== data.mode) return true;
    for (const k of Object.keys(draftFlags)) {
      const orig = (data.flags as Record<string, TierAccess>)[k];
      const draft = draftFlags[k];
      if (!orig || !draft) return true;
      if (orig.free !== draft.free || orig.basic !== draft.basic || orig.premium !== draft.premium) return true;
    }
    return false;
  })();

  function toggle(featureKey: string, tier: FeatureTier) {
    setDraftFlags(prev => {
      const entry = { ...(prev?.[featureKey] ?? emptyAccess()) };
      entry[tier] = !entry[tier];
      return { ...(prev ?? {}), [featureKey]: entry };
    });
  }

  function reset() {
    if (data) {
      setDraftMode(data.mode);
      setDraftFlags(Object.fromEntries(
        Object.entries(data.flags as Record<string, TierAccess>).map(([k, v]) => [k, { ...v }]),
      ));
    }
  }

  function save() {
    if (!data || !draftFlags) return;
    update.mutate(
      { data: { mode, flags: draftFlags } },
      {
        onSuccess: (res: FeatureFlagsConfig) => {
          toast({ title: "Доступ обновлён", description: `Режим: ${res.mode}` });
          const resFlags = res.flags as Record<string, TierAccess>;
          setDraftMode(res.mode);
          setDraftFlags(Object.fromEntries(Object.entries(resFlags).map(([k, v]) => [k, { ...v }])));
          queryClient.invalidateQueries({ queryKey: getGetAdminFeatureFlagsQueryKey() });
        },
        onError: (err: unknown) => {
          toast({ variant: "destructive", title: "Ошибка", description: err instanceof Error ? err.message : "Не удалось сохранить" });
        },
      },
    );
  }

  return (
    <Card className="rounded-none border-border bg-card">
      <CardHeader className="border-b border-border pb-4">
        <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary">
          Доступ к функциям
        </CardTitle>
        <CardDescription className="font-mono text-xs">
          Настройка доступа к функциям по тарифам. Каждый тир — независимая галочка. Меняется без релиза.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-6 space-y-5">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : error ? (
          <div className="font-mono text-xs text-dire p-4 border border-dire/30 bg-dire/10">
            Ошибка загрузки: {error instanceof Error ? error.message : "не удалось получить флаги"}
          </div>
        ) : (
          <>
            {/* Режим монетизации */}
            <div className="space-y-3">
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Режим монетизации
              </div>
              <div className="flex gap-2">
                {(["freemium", "tiered"] as MonetizationMode[]).map((m) => {
                  const active = mode === m;
                  return (
                    <button
                      key={m}
                      onClick={() => setDraftMode(m)}
                      className={`px-4 py-2 font-mono text-[11px] uppercase tracking-wider border transition-colors ${
                        active
                          ? "bg-primary/20 border-primary text-primary"
                          : "bg-background border-border text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {m === "freemium" ? "Freemium · Free + Premium" : "Tiered · Free + Basic + Premium"}
                    </button>
                  );
                })}
              </div>

              {/* Объяснение режимов */}
              <div className="grid grid-cols-2 gap-3">
                <div className={`p-3 border font-mono text-[10px] leading-relaxed transition-colors ${
                  mode === "freemium" ? "border-primary/40 bg-primary/5 text-foreground" : "border-border text-muted-foreground"
                }`}>
                  <div className="font-bold mb-1 text-[11px]">Freemium — Free + Premium</div>
                  <div>Два тира. Бесплатный с минимальным набором функций и один платный Premium. Basic не существует — купить можно только Premium.</div>
                </div>
                <div className={`p-3 border font-mono text-[10px] leading-relaxed transition-colors ${
                  mode === "tiered" ? "border-primary/40 bg-primary/5 text-foreground" : "border-border text-muted-foreground"
                }`}>
                  <div className="font-bold mb-1 text-[11px]">Tiered — Free + Basic + Premium</div>
                  <div>Три тира. Free — минимум, Basic — средний уровень по меньшей цене, Premium — полный доступ. Позволяет строить ценовую лестницу.</div>
                </div>
              </div>
            </div>

            {/* Таблица фичей */}
            <div className="border border-border overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="border-b border-border bg-background">
                    <th className="text-left p-3 font-bold uppercase tracking-wider text-[10px] text-muted-foreground">
                      Функция
                    </th>
                    {tierColumns.map((tier) => (
                      <th key={tier} className="p-3 font-bold uppercase tracking-wider text-[10px] text-muted-foreground text-center min-w-[80px]">
                        {TIER_LABEL[tier]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {features.map((f) => {
                    const access: TierAccess = (flags[f.key] as TierAccess | undefined) ?? emptyAccess();
                    return (
                      <tr key={f.key} className="border-b border-border last:border-b-0 hover:bg-background/50">
                        <td className="p-3 align-top">
                          <div className="font-bold text-foreground">{f.label}</div>
                          {f.description && (
                            <div className="text-[10px] text-muted-foreground mt-0.5 max-w-md leading-snug">
                              {f.description}
                            </div>
                          )}
                          <code className="text-[9px] text-muted-foreground mt-1 block">{f.key}</code>
                        </td>
                        {tierColumns.map((tier) => {
                          const checked = access[tier] === true;
                          return (
                            <td key={tier} className="p-3 text-center align-middle">
                              <button
                                onClick={() => toggle(f.key, tier)}
                                title={checked ? `Убрать доступ для ${TIER_LABEL[tier]}` : `Дать доступ для ${TIER_LABEL[tier]}`}
                                className={`inline-flex items-center justify-center w-9 h-9 border-2 transition-all font-bold text-sm ${
                                  checked
                                    ? TIER_COLOR[tier]
                                    : "border-border/50 bg-background/30 text-muted-foreground/40 hover:border-border hover:text-muted-foreground"
                                }`}
                              >
                                {checked ? "✓" : "·"}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <p className="font-mono text-[10px] text-muted-foreground leading-relaxed">
              Каждая галочка — независима. Можно дать функцию только Free, только Basic, только Premium, или любой комбинации.
              В режиме Freemium колонка Basic скрыта.
            </p>

            <div className="flex gap-2 pt-2 border-t border-border">
              <Button
                onClick={save}
                disabled={!dirty || update.isPending}
                className="rounded-none font-mono text-[10px] uppercase tracking-wider h-9"
              >
                {update.isPending ? "Сохранение..." : "Сохранить"}
              </Button>
              <Button
                variant="secondary"
                onClick={reset}
                disabled={!dirty || update.isPending}
                className="rounded-none font-mono text-[10px] uppercase tracking-wider h-9"
              >
                Сбросить
              </Button>
              {dirty && (
                <span className="self-center font-mono text-[10px] text-warning uppercase tracking-wider">
                  Несохранённые изменения
                </span>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
