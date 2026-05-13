import { Link, useLocation, Outlet } from "react-router-dom";
import { useAdminLogout } from "@workspace/api-client-react";
import { LogOut, Activity, Settings2, ShieldAlert, Cpu, CreditCard, Store } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Layout() {
  const location = useLocation();
  const logout = useAdminLogout();

  const navItems = [
    { href: "/", label: "Панель", icon: Activity },
    { href: "/metrics", label: "Метрики", icon: ShieldAlert },
    { href: "/operations", label: "Операции", icon: Cpu },
    { href: "/stores", label: "Магазины", icon: Store },
    { href: "/subscriptions", label: "Подписки", icon: CreditCard },
    { href: "/settings", label: "Настройки", icon: Settings2 },
  ];

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-background text-foreground selection:bg-primary/30">
      <nav className="w-full md:w-56 border-b md:border-b-0 md:border-r border-border bg-card/50 flex flex-col flex-shrink-0">
        <div className="p-4 border-b border-border flex items-center gap-3">
          <div className="w-8 h-8 rounded-sm border border-primary/50 bg-primary/10 flex items-center justify-center text-primary font-bold font-mono text-xs">AE</div>
          <div>
            <h1 className="text-sm font-bold uppercase tracking-widest text-primary">Aegis</h1>
            <p className="text-[10px] text-muted-foreground uppercase tracking-widest">Admin Console</p>
          </div>
        </div>
        
        <div className="flex-1 py-4 flex flex-col gap-1">
          {navItems.map((item) => {
            const isActive = location.pathname === item.href;
            return (
              <Link key={item.href} to={item.href}>
                <Button
                  variant={isActive ? "secondary" : "ghost"}
                  className={`w-full justify-start gap-3 rounded-none h-10 ${isActive ? 'bg-primary/10 text-primary border-l-2 border-primary' : 'text-muted-foreground hover:text-foreground border-l-2 border-transparent'}`}
                >
                  <item.icon className="w-4 h-4" />
                  <span className="font-mono text-xs uppercase tracking-wider">{item.label}</span>
                </Button>
              </Link>
            );
          })}
        </div>

        <div className="p-4 border-t border-border mt-auto">
          <Button 
            variant="ghost" 
            className="w-full justify-start gap-3 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-none h-10"
            onClick={() => {
              logout.mutate(undefined, {
                onSuccess: () => window.location.href = "/admin-web/login"
              });
            }}
            disabled={logout.isPending}
          >
            <LogOut className="w-4 h-4" />
            <span className="font-mono text-xs uppercase tracking-wider">Выйти</span>
          </Button>
        </div>
      </nav>

      <main className="flex-1 flex flex-col max-h-screen overflow-auto">
        <div className="flex-1 p-6 md:p-8">
          <div className="max-w-6xl mx-auto space-y-6">
            <Outlet />
          </div>
        </div>
      </main>
    </div>
  );
}
