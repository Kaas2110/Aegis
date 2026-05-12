import { useGetAdminSettings, useUpdateAdminSettings, getGetAdminSettingsQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/utils";

export default function Settings() {
  const { data, isLoading } = useGetAdminSettings();
  const updateSettings = useUpdateAdminSettings();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [useBookmakerOdds, setUseBookmakerOdds] = useState(false);
  const [pruneDays, setPruneDays] = useState("30");
  const [trainWindowDays, setTrainWindowDays] = useState("365");
  const [trainMaxPatches, setTrainMaxPatches] = useState("4");
  const [trainMinSamples, setTrainMinSamples] = useState("1000");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (data?.settings) {
      setUseBookmakerOdds(data.settings.useBookmakerOdds);
      setPruneDays(data.settings.liveSnapshotPruneDays.toString());
      setTrainWindowDays(data.settings.trainWindowDays.toString());
      setTrainMaxPatches(data.settings.trainMaxPatches.toString());
      setTrainMinSamples(data.settings.trainMinSamples.toString());
      setNotes(data.settings.notes || "");
    }
  }, [data?.settings]);

  const handleSave = () => {
    const days = parseInt(pruneDays, 10);
    if (isNaN(days) || days < 1 || days > 365) {
      toast({ variant: "destructive", title: "Ошибка", description: "Дней хранения снапшотов: 1–365" });
      return;
    }
    const window = parseInt(trainWindowDays, 10);
    if (isNaN(window) || window < 30 || window > 730) {
      toast({ variant: "destructive", title: "Ошибка", description: "Окно обучения: 30–730 дней" });
      return;
    }
    const patches = parseInt(trainMaxPatches, 10);
    if (isNaN(patches) || patches < 1 || patches > 20) {
      toast({ variant: "destructive", title: "Ошибка", description: "Патчей: 1–20" });
      return;
    }
    const minSamples = parseInt(trainMinSamples, 10);
    if (isNaN(minSamples) || minSamples < 50 || minSamples > 100000) {
      toast({ variant: "destructive", title: "Ошибка", description: "Минимум сэмплов: 50–100000" });
      return;
    }

    updateSettings.mutate({
      data: {
        useBookmakerOdds,
        liveSnapshotPruneDays: days,
        trainWindowDays: window,
        trainMaxPatches: patches,
        trainMinSamples: minSamples,
        notes: notes || null
      }
    }, {
      onSuccess: (res) => {
        queryClient.setQueryData(getGetAdminSettingsQueryKey(), (old: any) => {
          if (!old) return old;
          return { ...old, settings: res.settings };
        });
        toast({ title: "Успех", description: "Настройки обновлены" });
      },
      onError: (err: any) => {
        toast({ variant: "destructive", title: "Ошибка сохранения", description: err.message || "Неизвестная ошибка" });
      }
    });
  };

  if (isLoading) {
    return <div className="space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-[400px] w-full" /></div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold tracking-tight">Настройки системы</h2>
        <p className="text-muted-foreground font-mono text-xs uppercase tracking-wider mt-1">Глобальные параметры работы Aegis</p>
      </div>

      <div className="grid gap-6 border border-border bg-card p-6">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-bold uppercase tracking-wider">The Odds API</Label>
            <p className="text-xs text-muted-foreground mt-1 font-mono">Статус конфигурации API ключа</p>
          </div>
          <Badge variant={data?.oddsApiKeyConfigured ? "default" : "destructive"} className="rounded-none font-mono">
            {data?.oddsApiKeyConfigured ? 'НАСТРОЕН' : 'НЕ НАСТРОЕН'}
          </Badge>
        </div>

        <div className="h-px bg-border w-full" />

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label className="text-sm font-bold uppercase tracking-wider">Использовать коэффициенты БК</Label>
            <p className="text-xs text-muted-foreground font-mono">Включить парсинг и использование коэффициентов букмекеров</p>
          </div>
          <Switch checked={useBookmakerOdds} onCheckedChange={setUseBookmakerOdds} />
        </div>

        <div className="h-px bg-border w-full" />

        <div className="space-y-3">
          <Label className="text-sm font-bold uppercase tracking-wider">Хранение снапшотов (Дней)</Label>
          <p className="text-xs text-muted-foreground font-mono mb-2">Сколько дней хранить снимки live-моделей</p>
          <Input
            type="number" min={1} max={365}
            className="font-mono rounded-none max-w-[200px]"
            value={pruneDays} onChange={e => setPruneDays(e.target.value)}
          />
        </div>

        <div className="h-px bg-border w-full" />

        <div className="space-y-1">
          <Label className="text-sm font-bold uppercase tracking-wider">Тренировочный датасет</Label>
          <p className="text-xs text-muted-foreground font-mono">
            Граница данных = max(окно дней, N последних патчей). Более строгое из двух ограничений.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label className="text-xs font-bold uppercase tracking-wider font-mono">Окно (дней)</Label>
            <p className="text-xs text-muted-foreground font-mono">Макс. глубина истории матчей. 30–730.</p>
            <Input
              type="number" min={30} max={730}
              className="font-mono rounded-none"
              value={trainWindowDays} onChange={e => setTrainWindowDays(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label className="text-xs font-bold uppercase tracking-wider font-mono">Патчей</Label>
            <p className="text-xs text-muted-foreground font-mono">Макс. число последних патчей. 1–20.</p>
            <Input
              type="number" min={1} max={20}
              className="font-mono rounded-none"
              value={trainMaxPatches} onChange={e => setTrainMaxPatches(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label className="text-xs font-bold uppercase tracking-wider font-mono">Мин. сэмплов</Label>
            <p className="text-xs text-muted-foreground font-mono">Порог запуска обучения. 50–100 000.</p>
            <Input
              type="number" min={50} max={100000}
              className="font-mono rounded-none"
              value={trainMinSamples} onChange={e => setTrainMinSamples(e.target.value)}
            />
          </div>
        </div>

        <div className="h-px bg-border w-full" />

        <div className="space-y-3">
          <Label className="text-sm font-bold uppercase tracking-wider">Заметки оператора</Label>
          <Textarea
            className="font-mono text-sm rounded-none min-h-[120px]"
            placeholder="Внутренние заметки по конфигурации..."
            value={notes} onChange={e => setNotes(e.target.value)}
          />
        </div>

        <div className="pt-4 flex items-center justify-between">
          <div className="text-xs font-mono text-muted-foreground">
            {data?.settings?.updatedAt ? `Обновлено: ${formatDate(data.settings.updatedAt)}` : ''}
          </div>
          <Button
            onClick={handleSave}
            disabled={updateSettings.isPending}
            className="rounded-none font-mono text-xs uppercase tracking-wider min-w-[140px]"
          >
            {updateSettings.isPending ? "СОХРАНЕНИЕ..." : "СОХРАНИТЬ"}
          </Button>
        </div>
      </div>
    </div>
  );
}
