/**
 * Глоссарий — человеческое объяснение терминов аналитики.
 */

import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';

interface Term {
  short: string;
  full: string;
  simple: string;
  example: string;
  premium?: boolean;
}

const TERMS: Term[] = [
  {
    short: '%',
    full: 'Вероятность исхода',
    simple: 'Шанс, что событие произойдёт. По нашим расчётам на основе формы команд, истории встреч и live-данных.',
    example: 'Если у Team Liquid 67% — мы оцениваем их шансы выиграть карту в 67 из 100 случаев.',
  },
  {
    short: '2.00',
    full: 'Коэффициент букмекера',
    simple: 'Сколько вы получите на каждую вложенную единицу, если ставка зайдёт. Сам коэффициент букмекера, не наш расчёт.',
    example: 'Коэф 2.00 означает: ставка 100 → выигрыш 200 (чистая прибыль 100).',
  },
  {
    short: 'ОЦ',
    full: 'Ожидаемая ценность (Expected Value, EV)',
    simple: 'Расчётный средний результат на единицу ставки при заданных вероятности и коэффициенте. Он зависит от верности оценки вероятности и не гарантирует прибыль.',
    example: 'При ОЦ +11,7% для 100 ставок по 100 единиц ожидаемый итог равен 10 000 × 0,117 = +1170 единиц, если оценка вероятности верна. Фактический итог может отличаться.',
    premium: true,
  },
  {
    short: 'Расхождение',
    full: 'Расхождение с рынком (Edge)',
    simple: 'Разница между вероятностью модели и оценкой рынка после поправки на маржу. Измеряется в процентных пунктах.',
    example: 'Наш прогноз: 67%. Рынок: 50%. Расхождение: +17 процентных пунктов (п.п.).',
    premium: true,
  },
  {
    short: 'Уверенность',
    full: 'Уверенность прогноза',
    simple: 'Вероятность исхода и надёжность модели — разные понятия. Оценка уверенности пока недоступна: её нужно подтвердить проверками на данных, которые модель не видела при обучении.',
    example: 'Вероятность победы 67% не означает надёжность прогноза 67%. Полнота и свежесть данных сами по себе не доказывают качество модели.',
    premium: true,
  },
  {
    short: 'Brier Score',
    full: 'Средняя квадратичная ошибка вероятностей',
    simple: 'Для исхода «победа / поражение» берём разницу между вероятностью победы и результатом (1 или 0), возводим в квадрат и усредняем по матчам. На одной и той же выборке меньше — лучше.',
    example: 'Если всегда предсказывать 50%, Brier равен 0,25. Качество другой модели оценивают сравнением с базовой моделью на тех же матчах.',
    premium: true,
  },
  {
    short: 'П1 / П2',
    full: 'Победа первой / второй команды',
    simple: 'Стандартное обозначение исхода. П1 — первая команда (Radiant в Dota 2 на нашей карточке), П2 — вторая (Dire).',
    example: 'П1 67% / П2 33% — прогноз в пользу первой команды.',
  },
  {
    short: 'Фриш / Стейл',
    full: 'Свежесть данных',
    simple: 'Время с последнего получения данных от источника. Оно не показывает полную задержку относительно игры: сам источник тоже может присылать данные с опозданием.',
    example: 'Частота фоновых опросов зависит от настроек и лимитов источника. Ориентируйтесь на фактический возраст данных: обновление экрана не делает их новее.',
  },
];

export default function GlossaryScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === 'web' ? 60 : insets.top;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* Шапка */}
      <View style={[styles.header, { paddingTop: topPad + 6, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Feather name="arrow-left" size={20} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]}>Глоссарий</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 30 }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.intro, { color: colors.mutedForeground }]}>
          Простое объяснение каждого термина с примерами. Чтобы пользоваться приложением, достаточно понимать первые два — % и коэф.
        </Text>

        {TERMS.map(t => (
          <View
            key={t.short}
            style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <View style={styles.termHeader}>
              <View style={[styles.shortBox, { backgroundColor: colors.primary + '18', borderColor: colors.primary + '40' }]}>
                <Text style={[styles.shortText, { color: colors.primary }]}>{t.short}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.fullName, { color: colors.foreground }]}>{t.full}</Text>
                {t.premium && (
                  <View style={[styles.premiumPill, { backgroundColor: colors.warning + '18', borderColor: colors.warning + '40' }]}>
                    <Feather name="star" size={9} color={colors.warning} />
                    <Text style={[styles.premiumText, { color: colors.warning }]}>Подробный режим</Text>
                  </View>
                )}
              </View>
            </View>

            <Text style={[styles.simple, { color: colors.foreground }]}>{t.simple}</Text>

            <View style={[styles.exampleBox, { backgroundColor: colors.muted }]}>
              <Text style={[styles.exampleLabel, { color: colors.mutedForeground }]}>ПРИМЕР</Text>
              <Text style={[styles.exampleText, { color: colors.foreground }]}>{t.example}</Text>
            </View>
          </View>
        ))}

        <View style={[styles.disclaimerBox, { backgroundColor: colors.warning + '10', borderColor: colors.warning + '40' }]}>
          <Feather name="alert-triangle" size={14} color={colors.warning} />
          <Text style={[styles.disclaimerText, { color: colors.mutedForeground }]}>
            <Text style={{ color: colors.foreground, fontFamily: 'Inter_600SemiBold' }}>Важно. </Text>
            Никакой прогноз не гарантирует результат. Аналитика — справочный инструмент для принятия собственных решений. Играйте ответственно.
          </Text>
        </View>
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
    paddingHorizontal: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { fontFamily: 'Inter_700Bold', fontSize: 17 },
  content: { padding: 16, gap: 12 },
  intro: { fontFamily: 'Inter_400Regular', fontSize: 13, lineHeight: 19, marginBottom: 4 },
  card: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    gap: 10,
  },
  termHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  shortBox: {
    minWidth: 56,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shortText: { fontFamily: 'Inter_700Bold', fontSize: 14 },
  fullName: { fontFamily: 'Inter_600SemiBold', fontSize: 14 },
  premiumPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    borderRadius: 4,
    borderWidth: 1,
    paddingHorizontal: 5,
    paddingVertical: 1,
    marginTop: 4,
  },
  premiumText: { fontFamily: 'Inter_600SemiBold', fontSize: 9 },
  simple: { fontFamily: 'Inter_400Regular', fontSize: 13, lineHeight: 19 },
  exampleBox: {
    borderRadius: 8,
    padding: 10,
    gap: 4,
  },
  exampleLabel: { fontFamily: 'Inter_700Bold', fontSize: 9, letterSpacing: 1 },
  exampleText: { fontFamily: 'Inter_400Regular', fontSize: 12, lineHeight: 17 },
  disclaimerBox: {
    flexDirection: 'row',
    gap: 10,
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    marginTop: 8,
  },
  disclaimerText: { flex: 1, fontFamily: 'Inter_400Regular', fontSize: 12, lineHeight: 17 },
});
