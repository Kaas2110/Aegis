/**
 * NotificationService — push-уведомления при высоком ОЦ (EV > порога).
 *
 * На нативных платформах использует expo-notifications.
 * На вебе — локальное in-app хранилище алертов без системных push.
 */

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import type { EnrichedMatch } from '@/services/LiveDataService';
import type { Alert as UserAlertRule, MarketType } from '@/types';

/**
 * Возвращает true, если нативные push-уведомления доступны.
 * В Expo Go на Android FCM не настроен → пропускаем, иначе появляется
 * предупреждение "Android Push notifications require a Firebase project".
 */
function nativePushAvailable(): boolean {
  if (Platform.OS === 'web') return false;
  // appOwnership === 'expo' — запущено в Expo Go (не standalone-сборка)
  if (Constants.appOwnership === 'expo') return false;
  return true;
}

export interface EvAlert {
  id: string;
  matchId: string;
  team1: string;
  team2: string;
  betType: string;
  evPct: number;            // оставлено для обратной совместимости карточки
  odds: number;             // справедливый коэффициент = 1/p
  confidence: number;       // 0..1
  side: 'team1' | 'team2';
  createdAt: Date;
  seen: boolean;
  ruleId?: string;          // какое пользовательское правило сработало (если было)
  ruleLabel?: string;
}

/**
 * Правила алертов теперь приходят снаружи (из AsyncStorage в alerts.tsx).
 * Пока правил нет — используем дефолт «уверенность ≥ 70%» как baseline.
 */
const DEFAULT_MIN_CONFIDENCE = 0.70;
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;

class NotificationService {
  private sentAlerts = new Map<string, number>();
  private listeners: Array<(alerts: EvAlert[]) => void> = [];
  private alertStore: EvAlert[] = [];
  private permissionGranted = false;
  private rules: UserAlertRule[] = [];
  private favoriteTeamIds: number[] = [];

  /**
   * Передаётся из AppContext — алерты фильтруются по правилам пользователя
   * (минимальная уверенность + типы рынков + favorites). Если правил нет —
   * сработает дефолт по уверенности.
   */
  setRules(rules: UserAlertRule[]): void {
    this.rules = rules.filter(r => r.isActive);
  }
  setFavoriteTeamIds(ids: number[]): void {
    this.favoriteTeamIds = ids;
  }

  async requestPermissions(): Promise<boolean> {
    if (!nativePushAvailable()) {
      // Веб или Expo Go без FCM — in-app алерты работают, системные push нет
      this.permissionGranted = true;
      return true;
    }
    try {
      const { default: Notifications } = await import('expo-notifications');
      const { status } = await Notifications.requestPermissionsAsync();
      this.permissionGranted = status === 'granted';
      if (this.permissionGranted) {
        Notifications.setNotificationHandler({
          handleNotification: async () => ({
            shouldShowAlert: true,
            shouldPlaySound: true,
            shouldSetBadge: true,
            shouldShowBanner: true,
            shouldShowList: true,
          }),
        });
      }
      return this.permissionGranted;
    } catch {
      return false;
    }
  }

  /**
   * Главный метод. Алерт срабатывает когда:
   *   1) уверенность модели в выбранную сторону ≥ minConfidence (правило либо дефолт)
   *   2) тип рынка попадает в правило (или правило без ограничений по типу)
   *   3) если правило onlyFavoriteTeams — одна из команд в favoriteTeamIds
   * Если правил нет совсем — fallback по DEFAULT_MIN_CONFIDENCE.
   */
  async checkAndNotify(enrichedMatches: EnrichedMatch[]): Promise<EvAlert[]> {
    const newAlerts: EvAlert[] = [];
    const favs = new Set(this.favoriteTeamIds.map(Number));
    const activeRules = this.rules;

    for (const em of enrichedMatches) {
      const t1Id = Number(em.match.team1.id);
      const t2Id = Number(em.match.team2.id);
      const isFavMatch = favs.has(t1Id) || favs.has(t2Id);

      for (const mkt of em.markets) {
        const conf = mkt.prediction.confidence;
        const probTeam1 = mkt.prediction.modelProbability;
        const winnerSide: 'team1' | 'team2' = probTeam1 >= 0.5 ? 'team1' : 'team2';
        const winnerProb = winnerSide === 'team1' ? probTeam1 : 1 - probTeam1;
        const fairOdds = winnerProb > 0 ? 1 / winnerProb : 0;

        // Подбираем подходящее правило. Если ни одно не подошло — дефолт.
        type Match = { rule?: UserAlertRule; minConf: number };
        const matchedRules: Match[] = [];

        if (activeRules.length === 0) {
          matchedRules.push({ minConf: DEFAULT_MIN_CONFIDENCE });
        } else {
          for (const r of activeRules) {
            // Mode (live/prematch/any)
            // 'between_maps' семантически live (серия идёт) — алерт-режим 'live'
            // его пропускает, 'prematch' исключает. Согласовано с HomeScreen.
            const isLiveLike = em.match.status === 'live' || em.match.status === 'between_maps';
            if (r.mode === 'live' && !isLiveLike) continue;
            if (r.mode === 'prematch' && em.match.status !== 'prematch') continue;
            // Тип рынка
            if (r.marketTypes.length > 0 && !r.marketTypes.includes(mkt.type as MarketType)) continue;
            // Только избранные команды
            if (r.onlyFavoriteTeams && !isFavMatch) continue;
            matchedRules.push({ rule: r, minConf: r.minConfidence / 100 });
          }
        }

        for (const m of matchedRules) {
          if (conf < m.minConf || winnerProb < m.minConf) continue;

          const ruleSuffix = m.rule?.id ?? 'default';
          const key = `${em.match.id}::${mkt.type}::${winnerSide}::${ruleSuffix}`;
          const lastSent = this.sentAlerts.get(key) ?? 0;
          if (Date.now() - lastSent < ALERT_COOLDOWN_MS) continue;
          this.sentAlerts.set(key, Date.now());

          const alert: EvAlert = {
            id: key + '_' + Date.now(),
            matchId: em.match.id,
            team1: em.match.team1.name,
            team2: em.match.team2.name,
            betType: mkt.type,
            evPct: Math.round((winnerProb - 0.5) * 200), // условный «edge over 50%»
            odds: Math.round(fairOdds * 100) / 100,
            confidence: conf,
            side: winnerSide,
            createdAt: new Date(),
            seen: false,
            ruleId: m.rule?.id,
            ruleLabel: m.rule?.label,
          };
          newAlerts.push(alert);
          this.alertStore.unshift(alert);
          await this.sendPush(alert);
        }
      }
    }

    if (this.alertStore.length > 50) this.alertStore = this.alertStore.slice(0, 50);

    if (newAlerts.length > 0) {
      this.listeners.forEach(cb => cb(this.alertStore));
    }

    return newAlerts;
  }

  private async sendPush(alert: EvAlert): Promise<void> {
    const teamName = alert.side === 'team1' ? alert.team1 : alert.team2;
    const confPct = Math.round(alert.confidence * 100);
    const body = `${teamName} — ${betTypeRu(alert.betType)}: уверенность ${confPct}% · справедливый коэф ${alert.odds.toFixed(2)}`;
    const title = alert.ruleLabel ? `🔥 ${alert.ruleLabel}` : `🔥 Высокая уверенность модели`;

    if (!nativePushAvailable()) {
      if (typeof window !== 'undefined' && 'Notification' in window) {
        try {
          const perm = await Notification.requestPermission();
          if (perm === 'granted') {
            new Notification(title, { body, icon: '/icon.png' });
          }
        } catch { /* web notifications may be blocked */ }
      }
      return;
    }

    try {
      const { default: Notifications } = await import('expo-notifications');
      await Notifications.scheduleNotificationAsync({
        content: { title, body, sound: true },
        trigger: null,
      });
    } catch { /* ignore notification errors */ }
  }

  subscribe(cb: (alerts: EvAlert[]) => void): () => void {
    this.listeners.push(cb);
    return () => { this.listeners = this.listeners.filter(l => l !== cb); };
  }

  getAlerts(): EvAlert[] {
    return this.alertStore;
  }

  markAllSeen(): void {
    this.alertStore = this.alertStore.map(a => ({ ...a, seen: true }));
    this.listeners.forEach(cb => cb(this.alertStore));
  }

  getUnseenCount(): number {
    return this.alertStore.filter(a => !a.seen).length;
  }

  clearAll(): void {
    this.alertStore = [];
    this.listeners.forEach(cb => cb(this.alertStore));
  }
}

function betTypeRu(type: string): string {
  const map: Record<string, string> = {
    match_winner: 'победитель матча',
    map_winner: 'победитель карты',
    total_kills: 'тотал убийств',
    total_duration: 'тотал по времени',
    first_blood: 'первая кровь',
    first_tower: 'первая башня',
    map_handicap: 'фора по картам',
    comeback: 'камбэк',
    net_worth_lead: 'лидерство по NW',
    draft_advantage: 'преимущество в дрэфте',
  };
  return map[type] ?? type;
}

export const notificationService = new NotificationService();

// ────────────────────────────────────────────────────────────────────────
// Пуш про матч любимой команды
// ────────────────────────────────────────────────────────────────────────
//
// Хранит набор matchId, для которых уже отправляли уведомление,
// чтобы не спамить каждые 60 секунд (live-данные обновляются часто).
const notifiedFavMatches = new Set<string>();

function tryGetFavTeamIds(m: { team1?: { id?: string | number }; team2?: { id?: string | number } }): {
  ids: number[];
  hasFav: (favs: number[]) => boolean;
} {
  const t1 = Number(m.team1?.id);
  const t2 = Number(m.team2?.id);
  const ids = [t1, t2].filter((n) => Number.isFinite(n)) as number[];
  return {
    ids,
    hasFav: (favs) => ids.some((id) => favs.includes(id)),
  };
}

/**
 * Проверяет live-матчи и отправляет локальный пуш, когда матч любимой
 * команды только что появился в эфире. Идемпотентно: один matchId — один пуш.
 */
export async function notifyFavoriteTeamMatchStart(
  liveMatches: Array<{
    id: string;
    team1?: { id?: string | number; name?: string };
    team2?: { id?: string | number; name?: string };
    status?: string;
  }>,
  favoriteTeamIds: number[],
): Promise<void> {
  if (!favoriteTeamIds || favoriteTeamIds.length === 0) return;

  for (const m of liveMatches) {
    if (m.status && m.status !== 'live') continue;
    if (notifiedFavMatches.has(m.id)) continue;

    const { hasFav } = tryGetFavTeamIds(m);
    if (!hasFav(favoriteTeamIds)) continue;

    notifiedFavMatches.add(m.id);
    if (notifiedFavMatches.size > 200) {
      // Простая чистка — режем самые старые записи
      const arr = Array.from(notifiedFavMatches);
      notifiedFavMatches.clear();
      arr.slice(-100).forEach((id) => notifiedFavMatches.add(id));
    }

    const t1 = m.team1?.name ?? 'Team 1';
    const t2 = m.team2?.name ?? 'Team 2';
    const title = '⭐ Матч любимой команды начался';
    const body = `${t1} vs ${t2} — сейчас в эфире`;

    if (!nativePushAvailable()) {
      if (typeof window !== 'undefined' && 'Notification' in window) {
        try {
          const perm = await Notification.requestPermission();
          if (perm === 'granted') new Notification(title, { body });
        } catch { /* web notifications могут быть заблокированы */ }
      }
      continue;
    }

    try {
      const { default: Notifications } = await import('expo-notifications');
      await Notifications.scheduleNotificationAsync({
        content: { title, body, sound: true },
        trigger: null,
      });
    } catch { /* ignore */ }
  }
}
