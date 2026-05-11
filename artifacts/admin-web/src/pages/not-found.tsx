import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center space-y-4">
      <div className="w-16 h-16 rounded-sm border border-destructive bg-destructive/10 flex items-center justify-center text-destructive font-bold font-mono text-xl mb-4">404</div>
      <h1 className="text-2xl font-bold uppercase tracking-widest text-primary">Страница не найдена</h1>
      <p className="text-muted-foreground font-mono text-sm uppercase">Запрашиваемый ресурс недоступен</p>
      <div className="mt-8 pt-8">
        <Link to="/">
          <Button variant="outline" className="rounded-none font-mono text-xs uppercase tracking-wider h-10 border-primary/50 text-primary hover:bg-primary hover:text-primary-foreground">
            ВЕРНУТЬСЯ НА ПАНЕЛЬ
          </Button>
        </Link>
      </div>
    </div>
  );
}
