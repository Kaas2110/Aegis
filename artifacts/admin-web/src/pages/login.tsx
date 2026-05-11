import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useAdminLogin, useAdminWhoami, getAdminWhoamiQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

export default function Login() {
  const [token, setToken] = useState("");
  const { data: whoami, isLoading, refetch } = useAdminWhoami({ query: { retry: false, queryKey: getAdminWhoamiQueryKey() } });
  const login = useAdminLogin();
  const { toast } = useToast();

  if (isLoading) return null;
  if (whoami?.authenticated) {
    return <Navigate to="/" replace />;
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;

    login.mutate({ data: { token } }, {
      onSuccess: (res) => {
        if (res.ok) {
          refetch(); // will trigger navigation to /
        } else {
          toast({
            variant: "destructive",
            title: "Ошибка",
            description: "Неверный токен",
          });
        }
      },
      onError: () => {
        toast({
          variant: "destructive",
          title: "Ошибка",
          description: "Ошибка авторизации",
        });
      }
    });
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm border border-border bg-card p-8 shadow-xl">
        <div className="mb-8 text-center">
          <div className="w-12 h-12 rounded-sm border border-primary/50 bg-primary/10 flex items-center justify-center text-primary font-bold font-mono mx-auto mb-4">AE</div>
          <h1 className="text-xl font-bold uppercase tracking-widest text-primary">Aegis Admin</h1>
          <p className="text-xs font-mono text-muted-foreground mt-2 uppercase tracking-widest">
            {whoami?.tokenConfigured ? 'СИСТЕМА АКТИВНА' : 'ВНИМАНИЕ: ТОКЕН НЕ НАСТРОЕН'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="token" className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Токен доступа</Label>
            <Input
              id="token"
              type="password"
              className="bg-background border-border font-mono rounded-none focus-visible:ring-primary focus-visible:border-primary"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="••••••••"
              disabled={login.isPending}
            />
          </div>
          <Button 
            type="submit" 
            className="w-full rounded-none font-mono text-xs uppercase tracking-wider h-10" 
            disabled={login.isPending || !token}
          >
            {login.isPending ? "АВТОРИЗАЦИЯ..." : "ВОЙТИ"}
          </Button>
        </form>
      </div>
    </div>
  );
}
