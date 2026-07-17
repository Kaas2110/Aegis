import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/context/AuthContext';

type Mode = 'login' | 'register';

const ERROR_RU: Record<string, string> = {
  invalid_credentials:    'Неверный email или пароль',
  email_already_registered: 'Этот email уже зарегистрирован — войдите вместо регистрации',
  invalid_input:          'Email должен быть корректным, пароль — минимум 6 символов',
  too_many_attempts:      'Слишком много попыток. Подождите 15 минут',
  internal_error:         'Ошибка сервера. Попробуйте позже',
  network:                'Нет связи с сервером',
};

function explainError(code: string): string {
  return ERROR_RU[code] ?? `Ошибка: ${code}`;
}

export default function AuthScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { login, register } = useAuth();

  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [promoCode, setPromoCode] = useState('');
  const [promoEnabled, setPromoEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Поле промокода включается динамически через /api/client-config
  // (админ может включить/выключить без релиза приложения).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const base = (globalThis as { process?: { env?: Record<string, string> } })
          .process?.env?.['EXPO_PUBLIC_API_URL']?.replace(/\/$/, '') ?? '';
        const res = await fetch(`${base}/api/client-config`);
        if (!res.ok) return;
        const cfg = (await res.json()) as { promoFieldEnabled?: boolean };
        if (!cancelled) setPromoEnabled(cfg.promoFieldEnabled === true);
      } catch {
        // нет связи — просто не показываем поле
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const bottomPad = Platform.OS === 'web' ? 34 : insets.bottom;

  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && password.length >= 6;

  async function handleSubmit() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      if (mode === 'login') await login(email.trim().toLowerCase(), password);
      else await register(email.trim().toLowerCase(), password, promoCode.trim() || undefined);
      router.replace('/(tabs)');
    } catch (err) {
      const code = err instanceof Error ? err.message : 'network';
      setError(explainError(code));
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setBusy(false);
    }
  }

  function switchMode() {
    setMode(mode === 'login' ? 'register' : 'login');
    setError(null);
  }

  const fg = colors.foreground;
  const p = colors.primary;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.root, { backgroundColor: colors.background, paddingTop: topPad, paddingBottom: bottomPad }]}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={[styles.iconWrap, { borderColor: p + '30' }]}>
          <View style={[styles.iconOuter, { backgroundColor: p + '18' }]}>
            <View style={[styles.iconInner, { backgroundColor: p + '30' }]}>
              <Text style={[styles.iconText, { color: p }]}>AE</Text>
            </View>
          </View>
        </View>

        <Text style={[styles.title, { color: fg }]}>
          {mode === 'login' ? 'Вход в Aegis' : 'Регистрация в Aegis'}
        </Text>
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
          {mode === 'login'
            ? 'Введите email и пароль чтобы продолжить'
            : 'Создайте аккаунт по email — пароль минимум 6 символов'}
        </Text>

        <View style={styles.form}>
          <Text style={[styles.label, { color: colors.mutedForeground }]}>Email</Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            placeholderTextColor={colors.mutedForeground}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            editable={!busy}
            style={[styles.input, { backgroundColor: colors.card, color: fg, borderColor: colors.border }]}
          />

          <Text style={[styles.label, { color: colors.mutedForeground, marginTop: 12 }]}>Пароль</Text>
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="минимум 6 символов"
            placeholderTextColor={colors.mutedForeground}
            secureTextEntry
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            editable={!busy}
            style={[styles.input, { backgroundColor: colors.card, color: fg, borderColor: colors.border }]}
          />

          {mode === 'register' && promoEnabled && (
            <>
              <Text style={[styles.label, { color: colors.mutedForeground, marginTop: 12 }]}>
                Промокод <Text style={{ color: colors.mutedForeground }}>(необязательно)</Text>
              </Text>
              <TextInput
                value={promoCode}
                onChangeText={setPromoCode}
                placeholder="если есть — введите код"
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
                style={[styles.input, { backgroundColor: colors.card, color: fg, borderColor: colors.border }]}
              />
            </>
          )}

          {error && (
            <View style={[styles.errorBox, { backgroundColor: colors.destructive + '18', borderColor: colors.destructive + '55' }]}>
              <Feather name="alert-circle" size={14} color={colors.destructive} />
              <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
            </View>
          )}

          <TouchableOpacity
            onPress={handleSubmit}
            disabled={!valid || busy}
            activeOpacity={0.85}
            style={[styles.primaryBtn, { backgroundColor: !valid || busy ? colors.muted : p }]}
          >
            {busy ? (
              <ActivityIndicator color={!valid ? colors.mutedForeground : colors.primaryForeground} />
            ) : (
              <>
                <Text style={[styles.primaryBtnText, { color: !valid ? colors.mutedForeground : colors.primaryForeground }]}>
                  {mode === 'login' ? 'Войти' : 'Зарегистрироваться'}
                </Text>
                <Feather name="arrow-right" size={18} color={!valid ? colors.mutedForeground : colors.primaryForeground} />
              </>
            )}
          </TouchableOpacity>

          <TouchableOpacity onPress={switchMode} disabled={busy} style={styles.switchBtn}>
            <Text style={[styles.switchText, { color: colors.mutedForeground }]}>
              {mode === 'login'
                ? 'Нет аккаунта? '
                : 'Уже есть аккаунт? '}
              <Text style={{ color: p, fontFamily: 'Inter_600SemiBold' }}>
                {mode === 'login' ? 'Зарегистрироваться' : 'Войти'}
              </Text>
            </Text>
          </TouchableOpacity>
        </View>

        <View style={[styles.hintBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="info" size={13} color={colors.mutedForeground} />
          <Text style={[styles.hintText, { color: colors.mutedForeground }]}>
            Apple/Google авторизация будет добавлена позже. Пока используйте email — устройство запомнит вас до выхода из аккаунта.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { flexGrow: 1, padding: 22, gap: 16 },
  iconWrap: {
    alignSelf: 'center', width: 90, height: 90, borderRadius: 24, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center', marginTop: 12,
  },
  iconOuter: { width: 76, height: 76, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  iconInner: { width: 54, height: 54, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  iconText: { fontFamily: 'Inter_700Bold', fontSize: 17, letterSpacing: 1 },
  title: { fontFamily: 'Inter_700Bold', fontSize: 22, textAlign: 'center', marginTop: 4 },
  subtitle: { fontFamily: 'Inter_400Regular', fontSize: 13, textAlign: 'center', lineHeight: 19 },
  form: { gap: 4, marginTop: 8 },
  label: { fontFamily: 'Inter_400Regular', fontSize: 12 },
  input: {
    borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12,
    fontFamily: 'Inter_400Regular', fontSize: 15,
  },
  errorBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    borderRadius: 10, borderWidth: 1, padding: 10, marginTop: 12,
  },
  errorText: { flex: 1, fontFamily: 'Inter_500Medium', fontSize: 12, lineHeight: 17 },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderRadius: 14, height: 52, marginTop: 16,
  },
  primaryBtnText: { fontFamily: 'Inter_700Bold', fontSize: 15 },
  switchBtn: { alignItems: 'center', paddingVertical: 14 },
  switchText: { fontFamily: 'Inter_400Regular', fontSize: 13 },
  hintBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    borderRadius: 12, borderWidth: 1, padding: 12, marginTop: 6,
  },
  hintText: { flex: 1, fontFamily: 'Inter_400Regular', fontSize: 12, lineHeight: 18 },
});
