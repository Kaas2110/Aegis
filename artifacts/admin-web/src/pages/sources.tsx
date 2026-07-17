import {
  useListAdminRefCodes,
  useCreateAdminRefCode,
  usePatchAdminRefCode,
  getListAdminRefCodesQueryKey,
  useGetAdminSettings,
  useUpdateAdminSettings,
  getGetAdminSettingsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Download, Plus } from "lucide-react";

export default function Sources() {
  const { data, isLoading } = useListAdminRefCodes();
  const createCode = useCreateAdminRefCode();
  const patchCode = usePatchAdminRefCode();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [newCode, setNewCode] = useState("");
  const [newLabel, setNewLabel] = useState("");

  const { data: settingsData } = useGetAdminSettings();
  const updateSettings = useUpdateAdminSettings();
  const settings = settingsData?.settings;
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);
  const redirectValue = redirectUrl ?? settings?.refRedirectUrl ?? "";

  const saveSettings = (patch: { promoFieldEnabled?: boolean; refRedirectUrl?: string | null }) => {
    updateSettings.mutate(
      { data: patch },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetAdminSettingsQueryKey() });
          toast({ title: "Сохранено" });
        },
        onError: () => toast({ variant: "destructive", title: "Ошибка", description: "Не удалось сохранить настройки" }),
      },
    );
  };

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: getListAdminRefCodesQueryKey() });

  const handleCreate = () => {
    const code = newCode.trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,64}$/.test(code)) {
      toast({ variant: "destructive", title: "Ошибка", description: "Код: латиница/цифры/дефис/подчёркивание, до 64 символов" });
      return;
    }
    if (!newLabel.trim()) {
      toast({ variant: "destructive", title: "Ошибка", description: "Укажите метку источника" });
      return;
    }
    createCode.mutate(
      { data: { code, label: newLabel.trim() } },
      {
        onSuccess: () => {
          toast({ title: "Источник создан", description: `Ссылка: /r/${code}` });
          setNewCode("");
          setNewLabel("");
          refresh();
        },
        onError: (err: unknown) => {
          const msg = String((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? err);
          toast({
            variant: "destructive",
            title: "Ошибка",
            description: msg.includes("code_already_exists") ? "Такой код уже существует" : msg,
          });
        },
      },
    );
  };

  const toggleActive = (id: number, active: boolean) => {
    patchCode.mutate(
      { id, data: { active } },
      {
        onSuccess: refresh,
        onError: () => toast({ variant: "destructive", title: "Ошибка", description: "Не удалось обновить код" }),
      },
    );
  };

  const codes = data?.codes ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold uppercase tracking-widest text-primary">Источники</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Реферальные ссылки вида <span className="font-mono">/r/&lt;код&gt;</span> и промокоды при регистрации.
            Клики считаются по переходам, регистрации — по промокоду в анкете.
          </p>
        </div>
        <a href="/api/admin/ref-codes/export.csv" download>
          <Button variant="outline" className="gap-2 font-mono text-xs uppercase tracking-wider">
            <Download className="w-4 h-4" /> CSV
          </Button>
        </a>
      </div>

      <div className="border border-border bg-card/50 p-4 space-y-4">
        <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Настройки</h3>
        <div className="flex items-center gap-3">
          <Switch
            checked={settings?.promoFieldEnabled === true}
            onCheckedChange={(v) => saveSettings({ promoFieldEnabled: v })}
            disabled={updateSettings.isPending || !settings}
          />
          <div>
            <Label className="text-sm">Поле промокода при регистрации</Label>
            <p className="text-xs text-muted-foreground">Мобилка покажет необязательное поле «Промокод» на экране регистрации.</p>
          </div>
        </div>
        <div className="flex flex-col md:flex-row gap-3 md:items-end">
          <div className="space-y-1 flex-1">
            <Label className="text-xs">Куда редиректит /r/&lt;код&gt;</Label>
            <Input
              value={redirectValue}
              onChange={(e) => setRedirectUrl(e.target.value)}
              placeholder="https://…  (пусто = дефолтный лендинг)"
              className="font-mono"
            />
          </div>
          <Button
            variant="outline"
            onClick={() => saveSettings({ refRedirectUrl: redirectValue.trim() || null })}
            disabled={updateSettings.isPending}
          >
            Сохранить URL
          </Button>
        </div>
      </div>

      <div className="border border-border bg-card/50 p-4 space-y-3">
        <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Новый источник</h3>
        <div className="flex flex-col md:flex-row gap-3 md:items-end">
          <div className="space-y-1 flex-1">
            <Label className="text-xs">Код (для ссылки /r/…)</Label>
            <Input value={newCode} onChange={(e) => setNewCode(e.target.value)} placeholder="tg-channel" className="font-mono" />
          </div>
          <div className="space-y-1 flex-[2]">
            <Label className="text-xs">Метка</Label>
            <Input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="Telegram-канал «Дота-аналитика»" />
          </div>
          <Button onClick={handleCreate} disabled={createCode.isPending} className="gap-2">
            <Plus className="w-4 h-4" /> Создать
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : codes.length === 0 ? (
        <p className="text-sm text-muted-foreground">Источников пока нет — создайте первый.</p>
      ) : (
        <div className="border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-card/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="p-3">Код</th>
                <th className="p-3">Метка</th>
                <th className="p-3 text-right">Клики</th>
                <th className="p-3 text-right">Регистрации</th>
                <th className="p-3">Создан</th>
                <th className="p-3">Активен</th>
              </tr>
            </thead>
            <tbody>
              {codes.map((c) => (
                <tr key={c.id} className="border-b border-border/50 last:border-0">
                  <td className="p-3 font-mono">{c.code}</td>
                  <td className="p-3">{c.label}</td>
                  <td className="p-3 text-right font-mono">{c.clicks}</td>
                  <td className="p-3 text-right font-mono">{c.registrations}</td>
                  <td className="p-3 text-xs text-muted-foreground">{c.createdAt.slice(0, 10)}</td>
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <Switch checked={c.active} onCheckedChange={(v) => toggleActive(c.id, v)} disabled={patchCode.isPending} />
                      {!c.active && <Badge variant="outline" className="text-[10px]">выкл</Badge>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
