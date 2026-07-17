import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import {
  loadStoredAuth, login as svcLogin, register as svcRegister,
  logout as svcLogout, fetchMe, type AuthUser,
} from '@/services/AuthService';
import { logProductEvent } from '@/services/logging/EventLogger';

interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isHydrating: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, promoCode?: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isHydrating, setIsHydrating] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await loadStoredAuth();
      if (cancelled) return;
      if (stored) {
        setUser(stored.user);
        // Проверяем токен в фоне. Только при `invalid` (401) разлогиниваем —
        // network/5xx оставляем cached юзера чтобы оффлайн-режим работал.
        fetchMe().then(result => {
          if (cancelled) return;
          if (result.kind === 'ok') setUser(result.user);
          else if (result.kind === 'invalid') setUser(null);
          // network / no_token — ничего не делаем, оставляем cached
        }).catch(() => {});
      }
      setIsHydrating(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const u = await svcLogin(email, password);
    setUser(u);
    await logProductEvent('user_login', 'auth', { userId: u.id });
  }, []);

  const register = useCallback(async (email: string, password: string, promoCode?: string) => {
    const u = await svcRegister(email, password, promoCode);
    setUser(u);
    await logProductEvent('user_registered', 'auth', { userId: u.id });
  }, []);

  const logout = useCallback(async () => {
    const id = user?.id;
    await svcLogout();
    setUser(null);
    if (id) await logProductEvent('user_logout', 'auth', { userId: id });
  }, [user?.id]);

  return (
    <AuthContext.Provider value={{
      user,
      isAuthenticated: !!user,
      isHydrating,
      login,
      register,
      logout,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
