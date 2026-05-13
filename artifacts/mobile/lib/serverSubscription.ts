/**
 * Серверная подписка (RuStore / YooKassa).
 *
 * - Анонимный deviceId генерируется при первом запуске и хранится в AsyncStorage.
 * - Статус опрашивается с /api/payments/status каждые 5 минут.
 * - Активируется автоматически, когда YooKassa-webhook подтверждает платёж.
 */

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getApiUrl } from './api/baseUrl';

const DEVICE_ID_KEY = 'aegis.device_id';

export async function getOrCreateDeviceId(): Promise<string> {
  const stored = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (stored) return stored;
  const id = crypto.randomUUID();
  await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  return id;
}

export interface ServerSubscriptionStatus {
  isSubscribed: boolean;
  expiresAt: string | null;
  plan: string | null;
}

async function fetchServerSubscription(deviceId: string): Promise<ServerSubscriptionStatus> {
  const url = getApiUrl(`/api/payments/status?deviceId=${encodeURIComponent(deviceId)}`);
  const r = await fetch(url);
  if (!r.ok) return { isSubscribed: false, expiresAt: null, plan: null };
  return (await r.json()) as ServerSubscriptionStatus;
}

export function useDeviceId() {
  const { data: deviceId } = useQuery({
    queryKey: ['device-id'],
    queryFn: getOrCreateDeviceId,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return deviceId ?? null;
}

export function useServerSubscription() {
  const deviceId = useDeviceId();

  const query = useQuery({
    queryKey: ['server-subscription', deviceId],
    queryFn: () => fetchServerSubscription(deviceId!),
    enabled: !!deviceId,
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    retry: 1,
  });

  const qc = useQueryClient();
  const refetch = useCallback(() => {
    if (deviceId) qc.invalidateQueries({ queryKey: ['server-subscription', deviceId] });
  }, [qc, deviceId]);

  return {
    isSubscribed: query.data?.isSubscribed ?? false,
    expiresAt: query.data?.expiresAt ?? null,
    plan: query.data?.plan ?? null,
    isLoading: query.isLoading,
    deviceId,
    refetch,
  };
}
