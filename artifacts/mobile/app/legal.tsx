import React, { useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';

type Section = 'privacy' | 'terms';

const PRIVACY_POLICY = `ПОЛИТИКА КОНФИДЕНЦИАЛЬНОСТИ
Дата вступления в силу: 1 мая 2026 г.

1. ОБЩИЕ ПОЛОЖЕНИЯ

Aegis («Приложение», «мы») уважает вашу конфиденциальность. Настоящая Политика описывает, какие данные собираются при использовании приложения и как они используются.

2. СОБИРАЕМЫЕ ДАННЫЕ

2.1. Данные, которые вы предоставляете добровольно:
— Подтверждение совершеннолетия (18+) — хранится локально на устройстве.
— Настройки фильтров и предпочтения — хранятся локально.
— Список избранных команд — хранится локально.

2.2. Данные, собираемые автоматически:
— Анонимный идентификатор устройства (генерируется случайно, не связан с личностью).
— События использования (какие экраны открывались, какие фичи использовались) — только при наличии вашего согласия в настройках «Аналитика и логирование».
— Технические журналы ошибок — анонимно.

2.3. Данные платёжной системы:
— Информация о подписке обрабатывается через RevenueCat и App Store / Google Play. Мы не получаем и не храним данные банковских карт.

3. ИСПОЛЬЗОВАНИЕ ДАННЫХ

Собранные данные используются для:
— Улучшения качества прогнозов и работы приложения.
— Формирования агрегированной статистики (без привязки к личности).
— Технической поддержки при сбоях.

Мы не продаём и не передаём персональные данные третьим лицам в коммерческих целях.

4. ХРАНЕНИЕ ДАННЫХ

Все пользовательские настройки хранятся локально на вашем устройстве. Анонимные аналитические события могут передаваться на наш сервер в зашифрованном виде (только при включённом согласии).

5. ВАШИ ПРАВА

Вы можете в любой момент:
— Отозвать согласие на аналитику (Настройки → Аналитика и логирование).
— Удалить все локальные данные (Настройки → Удалить аккаунт).
— Запросить экспорт данных (Настройки → Экспорт данных).

6. ФАЙЛЫ COOKIE И ТРЕКИНГ

Приложение не использует файлы cookie. Аналитика реализована через анонимный идентификатор сессии без привязки к личности.

7. КОНТАКТ

По вопросам конфиденциальности: support@aegis-dota.app`;

const TERMS_OF_SERVICE = `УСЛОВИЯ ИСПОЛЬЗОВАНИЯ
Дата вступления в силу: 1 мая 2026 г.

1. ПРИНЯТИЕ УСЛОВИЙ

Используя приложение Aegis, вы соглашаетесь с настоящими Условиями использования. Если вы не согласны — пожалуйста, не используйте приложение.

2. ОПИСАНИЕ СЕРВИСА

Aegis — информационно-аналитическое приложение для Dota 2, которое предоставляет статистические прогнозы на основе публичных данных и моделей машинного обучения.

3. ОГРАНИЧЕНИЯ

3.1. Приложение предназначено только для лиц старше 18 лет.
3.2. Приложение НЕ является букмекером, не принимает ставки и не гарантирует результат.
3.3. Вся аналитика носит исключительно информационный характер.
3.4. Пользователь самостоятельно несёт ответственность за принимаемые решения о ставках.

4. ОТКАЗ ОТ ГАРАНТИЙ

Прогнозы предоставляются «как есть». Мы не гарантируем точность и актуальность данных. Прошлые результаты модели не гарантируют будущих результатов.

5. ОГРАНИЧЕНИЕ ОТВЕТСТВЕННОСТИ

Компания не несёт ответственности за финансовые потери, понесённые в результате использования прогнозов приложения.

6. ПОДПИСКА

6.1. Premium-подписка оплачивается через App Store / Google Play.
6.2. Бесплатный пробный период (если предлагается) активируется автоматически.
6.3. Отмена подписки осуществляется в настройках магазина приложений.
6.4. Частичный возврат средств за неиспользованный период не предусмотрен.

7. ИНТЕЛЛЕКТУАЛЬНАЯ СОБСТВЕННОСТЬ

Весь контент приложения, включая модели и алгоритмы, является собственностью разработчика. Данные о командах и матчах получены из публичных источников (OpenDota API).

8. ИЗМЕНЕНИЕ УСЛОВИЙ

Мы оставляем за собой право обновлять настоящие Условия. Продолжение использования приложения после изменений означает принятие новых условий.

9. ОТВЕТСТВЕННАЯ ИГРА

Ставки могут вызвать зависимость. Если у вас есть проблемы с азартными играми, обратитесь за помощью: https://gamblersanonymous.ru

10. КОНТАКТ

По всем вопросам: support@aegis-dota.app`;

export default function LegalScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ type?: string }>();
  const [section, setSection] = useState<Section>(
    params.type === 'terms' ? 'terms' : 'privacy'
  );

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: Platform.OS === 'web' ? 16 : insets.top + 8, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={8}>
          <Feather name="arrow-left" size={20} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Правовая информация</Text>
        <View style={{ width: 36 }} />
      </View>

      <View style={[styles.tabs, { borderBottomColor: colors.border }]}>
        {(['privacy', 'terms'] as Section[]).map(s => (
          <TouchableOpacity
            key={s}
            onPress={() => setSection(s)}
            style={[
              styles.tab,
              { borderBottomColor: section === s ? colors.primary : 'transparent' },
            ]}
          >
            <Text style={[
              styles.tabText,
              { color: section === s ? colors.primary : colors.mutedForeground },
            ]}>
              {s === 'privacy' ? 'Конфиденциальность' : 'Условия использования'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.body, { color: colors.mutedForeground }]}>
          {section === 'privacy' ? PRIVACY_POLICY : TERMS_OF_SERVICE}
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: { width: 36, alignItems: 'flex-start' },
  headerTitle: { fontFamily: 'Inter_700Bold', fontSize: 16 },
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 2,
  },
  tabText: { fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  content: { padding: 20 },
  body: { fontFamily: 'Inter_400Regular', fontSize: 13, lineHeight: 21 },
});
