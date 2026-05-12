import { useState, useEffect } from "react";
import {
  useGetAdminFeatureFlags,
  useUpdateAdminFeatureFlags,
  getGetAdminFeatureFlagsQueryKey,
  type FeatureFlagsConfig,
  type FeatureTier,
  type MonetizationMode,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

const TIER_RANK: Record<FeatureTier, number> = { free: 0, basic: 1, premium: 2 };
const TIER_LABEL: Record<FeatureTier, string> = { free: "Free", basic: "Basic", premium: "Premium" };
const TIER_COLOR: Record<FeatureTier, string> = {
  free: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  basic: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  premium: "bg-primary/15 text-primary border-primary/30",
};

export function FeatureFlagsCard() {
  const { data, isLoading, error } = useGetAdminFeatureFlags();
  const update = useUpdateAdminFeatureFlags();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [draftMode, setDraftMode] = useState<MonetizationMode | null>(null);
  const [draftFlags, setDraftFlags] = useState<Record<string, FeatureTier> | null>(null);

  useEffect(() => {
    if (data && draftMode === null) {
      setDraftMode(data.mode);
      setDraftFlags({ ...data.flags } as Record<string, FeatureTier>);
    }
  }, [data, draftMode]);

  const mode: MonetizationMode = draftMode ?? data?.mode ?? "freemium";
  const flags = (draftFlags ?? (data?.flags as Record<string, FeatureTier> | undefined) ?? {}) as Record<string, FeatureTier>;
  const features = data?.features ?? [];

  const tierColumns: FeatureTier[] = mode === "freemium" ? ["free", "premium"] : ["free", "basic", "premium"];

  const dirty = (() => {
    if (!data) return false;
    if (draftMode !== null && draftMode !== data.mode) return true;
    if (draftFlags) {
      for (const k of Object.keys(draftFlags)) {
        if ((data.flags as Record<string, FeatureTier>)[k] !== draftFlags[k]) return true;
      }
    }
    return false;
  })();

  function setFlag(key: string, tier: FeatureTier) {
    setDraftFlags((prev) => ({ ...(prev ?? {}), [key]: tier }));
  }

  function reset() {
    if (data) {
      setDraftMode(data.mode);
      setDraftFlags({ ...data.flags } as Record<string, FeatureTier>);
    }
  }

  function save() {
    if (!data || !draftFlags) return;
    update.mutate(
      { data: { mode, flags: draftFlags } },
      {
        onSuccess: (res: FeatureFlagsConfig) => {
          toast({ title: "Доступ обновлён", description: `Режим: ${res.mode}` });
          setDraftMode(res.mode);
          setDraftFlags({ ...res.flags } as Record<string, FeatureTier>);
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
          Настройка матрицы фичей по тарифам. Минимальный тир, начиная с которого функция доступна. Меняется без релиза.
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
            <div className="space-y-2">
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
              <p className="font-mono text-[10px] text-muted-foreground">
                {mode === "freemium"
                  ? "Активны только Free и Premium. Колонка Basic скрыта; если фича была закреплена за Basic — приравнивается к Premium."
                  : "Активны три тира. Если фича включена для Free — автоматически доступна и в Basic/Premium (каскад вверх)."}
              </p>
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
                      <th key={tier} className="p-3 font-bold uppercase tracking-wider text-[10px] text-muted-foreground text-center">
                        {TIER_LABEL[tier]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {features.map((f) => {
                    let activeTier = (flags[f.key] ?? "premium") as FeatureTier;
                    if (mode === "freemium" && activeTier === "basic") activeTier = "premium";
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
                          const enabled = TIER_RANK[tier] >= TIER_RANK[activeTier];
                          const isMinTier = tier === activeTier;
                          return (
                            <td key={tier} className="p-3 text-center align-middle">
                              <button
                                onClick={() => setFlag(f.key, tier)}
                                className={`inline-flex items-center justify-center w-9 h-9 border transition-colors ${
                                  isMinTier
                                    ? `${TIER_COLOR[tier]} border-2`
                                    : enabled
                                      ? "border-border bg-background text-muted-foreground hover:border-primary/50"
                                      : "border-border/50 bg-background/30 text-muted-foreground/40 hover:border-primary/50"
                                }`}
                                title={isMinTier
                                  ? `Минимальный тир: ${TIER_LABEL[tier]}`
                                  : `Сделать минимальным тиром: ${TIER_LABEL[tier]}`}
                              >
                                {enabled ? "✓" : "·"}
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
              ✓ — функция доступна на этом тире. Цветной квадрат — минимальный тир. Клик по квадрату назначает его минимальным;
              функция автоматически становится доступна и на всех более высоких тирах.
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
