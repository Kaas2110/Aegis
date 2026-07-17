/**
 * Пользователи мобилки (T004): список app_users + выдача админ-режима.
 * Админ-режим открывает в мобилке debug-экраны (Sources & Logs). Свободного
 * тогла в мобилке больше нет — только отсюда.
 */
import { useState } from "react";
import {
  useListAdminUsers,
  useSetAdminUserAdmin,
  getListAdminUsersQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { formatDate } from "@/lib/utils";
import { AlertCircle, Users as UsersIcon, ShieldCheck, Shield } from "lucide-react";

export default function Users() {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const { data, isLoading } = useListAdminUsers(
    query ? { q: query } : undefined,
    { query: { queryKey: getListAdminUsersQueryKey(query ? { q: query } : undefined) } },
  );
  const setAdmin = useSetAdminUserAdmin();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const toggleAdmin = (id: number, email: string, next: boolean) => {
    if (next && !window.confirm(`Выдать админ-режим пользователю ${email}? Откроются debug-экраны в мобилке.`)) return;
    setAdmin.mutate({ id, data: { isAdmin: next } }, {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListAdminUsersQueryKey() });
        toast({
          title: next ? "Админ-режим выдан" : "Админ-режим отозван",
          description: `${email} — изменение применится после перезапуска приложения или перелогина.`,
        });
      },
      onError: (e) => toast({ variant: "destructive", title: "Ошибка", description: e instanceof Error ? e.message : String(e) }),
    });
  };

  const users = data?.users ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold tracking-tight">Пользователи</h2>
        <p className="text-muted-foreground font-mono text-xs uppercase tracking-wider mt-1">
          Аккаунты мобилки · выдача админ-режима (debug-экраны)
        </p>
      </div>

      <Card className="rounded-none border-border bg-card">
        <CardHeader className="pb-3 border-b border-border flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary">app_users</CardTitle>
            <CardDescription className="font-mono text-[10px] mt-1">
              Показываются последние 200. Админ-режим в мобилке подхватывается при перезапуске приложения (fetchMe) или перелогине.
            </CardDescription>
          </div>
          <UsersIcon className="w-4 h-4 text-muted-foreground" />
        </CardHeader>
        <CardContent className="pt-4 space-y-4">
          <form
            className="flex gap-2"
            onSubmit={(e) => { e.preventDefault(); setQuery(search.trim()); }}
          >
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по email…"
              className="rounded-none h-9 font-mono text-xs max-w-xs"
            />
            <Button type="submit" size="sm" variant="outline"
              className="rounded-none font-mono text-[11px] uppercase tracking-wider border-primary/40 text-primary hover:bg-primary/10 h-9">
              Найти
            </Button>
            {query && (
              <Button type="button" size="sm" variant="ghost" onClick={() => { setSearch(""); setQuery(""); }}
                className="rounded-none font-mono text-[11px] uppercase tracking-wider text-muted-foreground h-9">
                Сброс
              </Button>
            )}
          </form>

          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : users.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <AlertCircle className="w-8 h-8 mb-2 opacity-50" />
              <span className="font-mono text-xs uppercase tracking-wider">
                {query ? "Никого не найдено" : "Пользователей пока нет"}
              </span>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="py-2 pr-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">ID</th>
                    <th className="py-2 pr-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Email</th>
                    <th className="py-2 pr-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Тариф</th>
                    <th className="py-2 pr-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Промокод</th>
                    <th className="py-2 pr-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Регистрация</th>
                    <th className="py-2 pr-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Последний вход</th>
                    <th className="py-2 pr-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Админ-режим</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} className="border-b border-border/50">
                      <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">{u.id}</td>
                      <td className="py-2 pr-3 font-mono text-xs">{u.email}</td>
                      <td className="py-2 pr-3">
                        <Badge variant="outline" className="rounded-none font-mono text-[10px] h-5">{u.tariff}</Badge>
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">{u.refCode ?? "—"}</td>
                      <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">{formatDate(u.createdAt)}</td>
                      <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">{u.lastLoginAt ? formatDate(u.lastLoginAt) : "—"}</td>
                      <td className="py-2 pr-3">
                        <Button
                          size="sm"
                          variant={u.isAdmin ? "default" : "outline"}
                          disabled={setAdmin.isPending}
                          onClick={() => toggleAdmin(u.id, u.email, !u.isAdmin)}
                          className={`rounded-none font-mono text-[10px] uppercase tracking-wider h-7 ${u.isAdmin ? "" : "border-border text-muted-foreground"}`}
                        >
                          {u.isAdmin ? (
                            <><ShieldCheck className="w-3 h-3 mr-1" />Выдан — отозвать</>
                          ) : (
                            <><Shield className="w-3 h-3 mr-1" />Выдать</>
                          )}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
