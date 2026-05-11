import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useContext, useEffect, useState } from 'react';
import type { UserSettings, Filters } from '@/types';
import { initLogger, logProductEvent } from '@/services/logging/EventLogger';

const DEFAULT_SETTINGS: UserSettings = {
  language: 'ru',
  minOdds: 1.5,
  minEdge: 0.03,
  minConfidence: 60,
  favoriteTeamIds: [],
  selectedBookmakerIds: ['fonbet', 'liga_stavok', 'betfair', 'betboom', 'pari'],
  showOnlyPositiveEV: false,
  hideStaleData: false,
  hideMockMarkets: false,
  analyticsConsent: false,
  pushConsent: false,
  role: 'user',
  viewMode: 'detailed',
  isPremium: false,
};

const DEFAULT_FILTERS: Filters = {
  bookmaker: 'all',
  minOdds: 1.5,
  minEdge: 0.03,
  minConfidence: 60,
  eventType: 'all',
  mode: 'all',
  onlyPositiveEV: false,
  hideStaleData: false,
  hideMockMarkets: false,
};

interface AppContextValue {
  isOnboarded: boolean;
  isAgeConfirmed: boolean;
  settings: UserSettings;
  filters: Filters;
  setOnboarded: (v: boolean) => void;
  setAgeConfirmed: (v: boolean) => void;
  updateSettings: (patch: Partial<UserSettings>) => void;
  updateFilters: (patch: Partial<Filters>) => void;
  isAdmin: boolean;
}

const AppContext = createContext<AppContextValue | null>(null);

const ONBOARDED_KEY = '@dea_onboarded';
const AGE_KEY = '@dea_age_confirmed';
const SETTINGS_KEY = '@dea_settings';
const FILTERS_KEY = '@dea_filters';

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [isOnboarded, setIsOnboarded] = useState(false);
  const [isAgeConfirmed, setIsAgeConfirmed] = useState(false);
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    async function load() {
      await initLogger();
      try {
        const [ob, age, sRaw, fRaw] = await Promise.all([
          AsyncStorage.getItem(ONBOARDED_KEY),
          AsyncStorage.getItem(AGE_KEY),
          AsyncStorage.getItem(SETTINGS_KEY),
          AsyncStorage.getItem(FILTERS_KEY),
        ]);
        if (ob === 'true') setIsOnboarded(true);
        if (age === 'true') setIsAgeConfirmed(true);
        if (sRaw) {
          const parsed = JSON.parse(sRaw);
          // Миграция: раньше favoriteTeamIds хранились строковыми slug'ами
          // (например 'liquid'). Сейчас — числовые OpenDota team_id.
          // На загрузке отбрасываем нечисловые значения.
          if (Array.isArray(parsed.favoriteTeamIds)) {
            parsed.favoriteTeamIds = parsed.favoriteTeamIds
              .map((v: unknown) => (typeof v === 'number' ? v : Number(v)))
              .filter((n: number) => Number.isFinite(n));
          }
          setSettings({ ...DEFAULT_SETTINGS, ...parsed });
        }
        if (fRaw) setFilters({ ...DEFAULT_FILTERS, ...JSON.parse(fRaw) });
      } catch {
        // use defaults
      }
      setLoaded(true);
      await logProductEvent('app_opened', 'root');
    }
    load();
  }, []);

  const setOnboarded = async (v: boolean) => {
    setIsOnboarded(v);
    await AsyncStorage.setItem(ONBOARDED_KEY, v ? 'true' : 'false');
  };

  const setAgeConfirmed = async (v: boolean) => {
    setIsAgeConfirmed(v);
    await AsyncStorage.setItem(AGE_KEY, v ? 'true' : 'false');
    if (v) await logProductEvent('age_gate_confirmed', 'onboarding');
  };

  const updateSettings = async (patch: Partial<UserSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    await logProductEvent('settings_changed', 'settings', patch as Record<string, unknown>);
  };

  const updateFilters = async (patch: Partial<Filters>) => {
    const next = { ...filters, ...patch };
    setFilters(next);
    await AsyncStorage.setItem(FILTERS_KEY, JSON.stringify(next));
    if (patch.minOdds !== undefined) await logProductEvent('min_odds_changed', 'home', { minOdds: patch.minOdds });
    if (patch.minEdge !== undefined) await logProductEvent('min_edge_changed', 'home', { minEdge: patch.minEdge });
    if (patch.minConfidence !== undefined) await logProductEvent('min_confidence_changed', 'home', { minConfidence: patch.minConfidence });
    if (patch.bookmaker !== undefined) await logProductEvent('bookmaker_filter_changed', 'home', { bookmaker: patch.bookmaker });
  };

  if (!loaded) return null;

  return (
    <AppContext.Provider value={{
      isOnboarded,
      isAgeConfirmed,
      settings,
      filters,
      setOnboarded,
      setAgeConfirmed,
      updateSettings,
      updateFilters,
      isAdmin: settings.role === 'admin',
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
