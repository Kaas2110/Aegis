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
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (data?.settings) {
      setUseBookmakerOdds(data.settings.useBookmakerOdds);
      setPruneDays(data.settings.liveSnapshotPruneDays.toString());
      setNotes(data.settings.notes || "");
    }
  }, [data?.settings]);

  const handleSave = () => {
    const days = parseInt(pruneDays, 10);
    if (isNaN(days) || days < 1 || days > 365) {
      toast({
        variant: "destructive",
        title: "Ошибка",
        description: "Дней должно быть от 1 до 365",
      });
      return;
    }

    updateSettings.mutate({
      data: {
        useBookmakerOdds,
        liveSnapshotPruneDays: days,
        notes: notes || null
      }
    }, {
      onSuccess: (res) => {
        queryClient.setQueryData(getGetAdminSettingsQueryKey(), (old: any) => {
          if (!old) return old;
          return {
            ...old,
            settings: res.settings
          };
        });
        toast({
          title: "Успех",
          description: "Настройки обновлены",
        });
      },
      onError: (err: any) => {
        toast({
          variant: "destructive",
          title: "Ошибка сохранения",
          description: err.message || "Неизвестная ошибка",
        });
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
            <p className="text-xs text-muted-foreground mt-1 font-mono">
              Статус конфигурации API ключа
            </p>
          </div>
          <Badge variant={data?.oddsApiKeyConfigured ? "default" : "destructive"} className="rounded-none font-mono">
            {data?.oddsApiKeyConfigured ? 'НАСТРОЕН' : 'НЕ НАСТРОЕН'}
          </Badge>
        </div>

        <div className="h-px bg-border w-full" />

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label className="text-sm font-bold uppercase tracking-wider">Использовать коэффициенты БК</Label>
            <p className="text-xs text-muted-foreground font-mono">
              Включить парсинг и использование коэффициентов букмекеров
            </p>
          </div>
          <Switch 
            checked={useBookmakerOdds}
            onCheckedChange={setUseBookmakerOdds}
          />
        </div>

        <div className="h-px bg-border w-full" />

        <div className="space-y-3">
          <Label className="text-sm font-bold uppercase tracking-wider">Хранение снапшотов (Дней)</Label>
          <p className="text-xs text-muted-foreground font-mono mb-2">
            Сколько дней хранить снимки live-моделей
          </p>
          <Input 
            type="number"
            min={1}
            max={365}
            className="font-mono rounded-none max-w-[200px]"
            value={pruneDays}
            onChange={e => setPruneDays(e.target.value)}
          />
        </div>

        <div className="h-px bg-border w-full" />

        <div className="space-y-3">
          <Label className="text-sm font-bold uppercase tracking-wider">Заметки оператора</Label>
          <Textarea 
            className="font-mono text-sm rounded-none min-h-[120px]"
            placeholder="Внутренние заметки по конфигурации..."
            value={notes}
            onChange={e => setNotes(e.target.value)}
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
