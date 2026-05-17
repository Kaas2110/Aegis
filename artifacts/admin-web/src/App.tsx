import { QueryClient, QueryClientProvider, QueryCache } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAdminWhoami, getAdminWhoamiQueryKey, ApiError } from "@workspace/api-client-react";

import Layout from "@/components/layout";
import Dashboard from "@/pages/dashboard";
import Login from "@/pages/login";
import Settings from "@/pages/settings";
import Metrics from "@/pages/metrics";
import Operations from "@/pages/operations";
import Coverage from "@/pages/coverage";
import Workers from "@/pages/workers";
import Models from "@/pages/models";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) {
        window.location.href = "/admin-web/login";
      }
    },
  }),
});

function AuthGate() {
  const { data, isLoading } = useAdminWhoami({
    query: {
      retry: false,
      queryKey: getAdminWhoamiQueryKey(),
    }
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background text-primary">
        <div className="text-sm font-mono tracking-widest uppercase animate-pulse">АВТОРИЗАЦИЯ...</div>
      </div>
    );
  }

  if (!data?.authenticated) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <BrowserRouter basename="/admin-web">
          <Routes>
            <Route path="/login" element={<Login />} />
            
            <Route element={<AuthGate />}>
              <Route element={<Layout />}>
                <Route path="/" element={<Dashboard />} />
                <Route path="/coverage" element={<Coverage />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/metrics" element={<Metrics />} />
                <Route path="/models" element={<Models />} />
                <Route path="/operations" element={<Operations />} />
                <Route path="/workers" element={<Workers />} />
              </Route>
            </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
