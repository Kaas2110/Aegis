/**
 * HexBadge — гексагональная плашка для команды (как иконки героев в Dota 2 HUD).
 * Рисуется через react-native-svg, текст с инициалами поверх. Снизу/сверху
 * можно положить «фракционный» цвет (Radiant/Dire) — заливка hex и обводка
 * берут tint.
 */

import React, { useId } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Polygon, Defs, LinearGradient, Stop } from 'react-native-svg';

interface Props {
  label: string;        // 2-3 буквы
  color: string;        // основной цвет (фракция)
  size?: number;
  textColor?: string;
}

export function HexBadge({ label, color, size = 44, textColor }: Props) {
  // Регулярный шестиугольник вписан в квадрат size×size, плоские стороны слева/справа
  // (pointy-top вариант). Координаты для viewBox 100x100:
  const points = '50,4 92,28 92,72 50,96 8,72 8,28';
  // useId() гарантирует уникальный ID на каждый инстанс — иначе на web все
  // hex-бэйджи одного цвета делят один <linearGradient> и SVG-движок может
  // их перепутать (особенно при размонтировании в FlatList).
  const uid = useId().replace(/[^a-z0-9]/gi, '');
  const gradId = `hexg-${color.replace('#', '')}-${uid}`;
  const fg = textColor ?? color;

  return (
    <View style={[styles.box, { width: size, height: size }]}>
      <Svg viewBox="0 0 100 100" width={size} height={size}>
        <Defs>
          <LinearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={color} stopOpacity="0.35" />
            <Stop offset="1" stopColor={color} stopOpacity="0.08" />
          </LinearGradient>
        </Defs>
        <Polygon points={points} fill={`url(#${gradId})`} stroke={color} strokeWidth={2} />
      </Svg>
      <View style={StyleSheet.absoluteFillObject}>
        <View style={styles.center}>
          <Text style={[styles.label, { color: fg, fontSize: size * 0.32 }]} numberOfLines={1}>
            {label.substring(0, 3).toUpperCase()}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', justifyContent: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  label: { fontFamily: 'Cinzel_700Bold', letterSpacing: 0.3 },
});
