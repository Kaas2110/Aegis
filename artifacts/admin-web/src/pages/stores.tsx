import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ExternalLink } from "lucide-react";

interface StoreConfig {
  enabled: boolean;
  url: string;
}
interface StoreSettings {
  rustore: StoreConfig;
  googlePlay: StoreConfig;
  appStore: StoreConfig;
}

const STORE_META = {
  rustore: {
    name: "RuStore",
    icon: "🇷🇺",
    description: "Российский магазин приложений от VK. Основной канал для RU/СНГ аудитории.",
    placeholder: "https://apps.rustore.ru/app/com.aegis.dota",
    color: "text-blue-400",
  },
  googlePlay: {
    name: "Google Play",
    icon: "🤖",
    description: "Глобальный магазин для Android-устройств.",
    placeholder: "https://play.google.com/store/apps/details?id=com.aegis.dota",
    color: "text-green-400",
  },
  appStore: {
    name: "App Store",
    icon: "🍎",
    description: "Магазин приложений Apple для iOS/iPadOS.",
    placeholder: "https://apps.apple.com/app/aegis-dota/id0000000000",
    color: "text-gray-300",
  },
} as const;

type StoreKey = keyof typeof STORE_META;

const BASE = "/api";

async function fetchStores(): Promise<StoreSettings> {
  const r = await fetch(`${BASE}/admin/stores`, { credentials: "include" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function saveStores(data: StoreSettings): Promise<StoreSettings> {
  const r = await fetch(`${BASE}/admin/stores`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error((e as any).error ?? `HTTP ${r.status}`);
  }
  const res = await r.json();
  return res.storeSettings;
}

function StoreCard({
  storeKey,
  config,
  onChange,
}: {
  storeKey: StoreKey;
  config: StoreConfig;
  onChange: (cfg: StoreConfig) => void;
}) {
  const meta = STORE_META[storeKey];

  return (
    <Card className="border-border bg-card/50">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="text-2xl">{meta.icon}</span>
            <div>
              <CardTitle className={`text-base ${meta.color}`}>{meta.name}</CardTitle>
              <CardDescription className="text-xs mt-0.5">{meta.description}</CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Badge variant={config.enabled ? "default" : "secondary"} className={config.enabled ? "bg-primary/20 text-primary border-primary/30" : ""}>
              {config.enabled ? "Включён" : "Выключен"}
            </Badge>
            <Switch
              checked={config.enabled}
              onCheckedChange={(v) => onChange({ ...config, enabled: v })}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground font-mono uppercase tracking-wider">
            Ссылка на страницу приложения
          </Label>
          <div className="flex gap-2">
            <Input
              value={config.url}
              onChange={(e) => onChange({ ...config, url: e.target.value })}
              placeholder={meta.placeholder}
              className="font-mono text-xs bg-background/50"
            />
            {config.url && (
              <Button
                variant="ghost"
                size="icon"
                className="flex-shrink-0"
                onClick={() => window.open(config.url, "_blank")}
                title="Открыть ссылку"
              >
                <ExternalLink className="w-4 h-4" />
              </Button>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {config.enabled
              ? "Кнопка магазина будет показана на лендинге и в мобильном приложении."
              : "Магазин выключен — кнопка скрыта на лендинге (показывается как «Скоро»)."}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function StoresPage() {
  const { toast } = useToast();
  const [stores, setStores] = useState<StoreSettings | null>(null);
  const [draft, setDraft] = useState<StoreSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    fetchStores()
      .then((s) => { setStores(s); setDraft(s); })
      .catch((e) => toast({ variant: "destructive", title: "Ошибка загрузки", description: e.message }))
      .finally(() => setLoading(false));
  }, []);

  function handleChange(key: StoreKey, cfg: StoreConfig) {
    setDraft((prev) => prev ? { ...prev, [key]: cfg } : prev);
    setDirty(true);
  }

  async function handleSave() {
    if (!draft) return;
    setSaving(true);
    try {
      const updated = await saveStores(draft);
      setStores(updated);
      setDraft(updated);
      setDirty(false);
      toast({ title: "Сохранено", description: "Настройки магазинов обновлены." });
    } catch (e: any) {
      toast({ variant: "destructive", title: "Ошибка сохранения", description: e.message });
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    if (stores) { setDraft(stores); setDirty(false); }
  }

  const enabledCount = draft ? Object.values(draft).filter((s) => s.enabled).length : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-foreground tracking-tight font-mono uppercase">Магазины</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Управление кнопками магазинов на лендинге и в мобильном приложении.
            Включите магазин когда приложение опубликовано и добавьте ссылку.
          </p>
        </div>
        <Badge variant="outline" className="font-mono text-xs">
          {enabledCount} / 3 активно
        </Badge>
      </div>

      {loading ? (
        <div className="space-y-4">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-36 w-full rounded-xl" />)}
        </div>
      ) : draft ? (
        <>
          <div className="space-y-4">
            {(Object.keys(STORE_META) as StoreKey[]).map((key) => (
              <StoreCard
                key={key}
                storeKey={key}
                config={draft[key]}
                onChange={(cfg) => handleChange(key, cfg)}
              />
            ))}
          </div>

          <div className="flex gap-3 justify-end pt-2">
            <Button variant="ghost" onClick={handleReset} disabled={!dirty || saving}>
              Сбросить
            </Button>
            <Button onClick={handleSave} disabled={!dirty || saving} className="bg-primary text-primary-foreground hover:bg-primary/90">
              {saving ? "Сохранение…" : "Сохранить"}
            </Button>
          </div>

          <Card className="border-border/50 bg-card/30">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground font-mono uppercase tracking-wider">Как работает</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground space-y-1.5 leading-relaxed">
              <p>• Переключатель <strong className="text-foreground">Включён</strong> → кнопка с реальной ссылкой на лендинге (<code>/landing</code>).</p>
              <p>• Переключатель <strong className="text-foreground">Выключен</strong> → кнопка показывается как «Скоро» (заглушка), ссылка неактивна.</p>
              <p>• Мобильное приложение читает эти настройки и показывает/скрывает кнопки магазинов в разделе «О приложении».</p>
              <p>• Изменения применяются без перезапуска — кеш лендинга сбрасывается через 30 секунд.</p>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
