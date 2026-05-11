/**
 * AegisLogo — фирменный SVG-логотип «Aegis».
 *
 * Концепт: силуэт Aegis of Champions — НЕ просто круг: сверху корона из
 * декоративных шипов, снизу — треугольная подвеска. На лицевой стороне щита
 * две зеркальные фигуры (yin-yang) и центральный солнце-медальон.
 * Сквозь щит — тонкая восходящая линия графика как намёк на аналитику.
 *
 * Палитра приглушённая (charcoal + tarnished silver + antique gold) — чтобы
 * не конкурировать с золотыми акцентами интерфейса.
 */

import React from 'react';
import { View } from 'react-native';
import Svg, {
  Defs,
  RadialGradient,
  LinearGradient,
  Stop,
  Circle,
  Path,
  Polyline,
  G,
} from 'react-native-svg';
import { useColors } from '@/hooks/useColors';

interface Props {
  size?: number;
}

export function AegisLogo({ size = 48 }: Props) {
  const colors = useColors();
  const gEmber = 'aegisEmberV2';
  const gRim = 'aegisRimV2';
  const gMedallion = 'aegisMedallionV2';

  // Приглушённые тона: тусклое золото вместо «горячего», тёмное серебро.
  const dimGold = colors.goldLo;
  const tarnishedSilver = colors.mutedForeground;

  return (
    <View style={{ width: size, height: size }}>
      <Svg viewBox="0 0 100 100" width={size} height={size}>
        <Defs>
          {/* Слабое тёплое свечение позади — приглушённое */}
          <RadialGradient id={gEmber} cx="50%" cy="55%" r="45%">
            <Stop offset="0" stopColor={colors.primary} stopOpacity="0.22" />
            <Stop offset="1" stopColor={colors.background} stopOpacity="0" />
          </RadialGradient>
          <LinearGradient id={gRim} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={dimGold} />
            <Stop offset="0.5" stopColor={colors.goldDeep} />
            <Stop offset="1" stopColor={dimGold} />
          </LinearGradient>
          <RadialGradient id={gMedallion} cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={colors.primary} />
            <Stop offset="1" stopColor={colors.goldLo} />
          </RadialGradient>
        </Defs>

        {/* Тёплое свечение */}
        <Circle cx="50" cy="55" r="45" fill={`url(#${gEmber})`} />

        {/* ── ВЕРХНЯЯ КОРОНА — три зубца над ободом ── */}
        <Path
          d="M30 20 L34 12 L38 20 Z
             M44 18 L50 8 L56 18 Z
             M62 20 L66 12 L70 20 Z"
          fill={`url(#${gRim})`}
          stroke={dimGold}
          strokeWidth={0.5}
          strokeLinejoin="round"
        />
        {/* Дуга, соединяющая зубцы с ободом */}
        <Path
          d="M22 24 Q 50 14 78 24"
          fill="none"
          stroke={dimGold}
          strokeWidth={1.2}
        />

        {/* ── НИЖНЯЯ ПОДВЕСКА — треугольный pendant ── */}
        <Path
          d="M40 80 L50 96 L60 80 Z"
          fill={`url(#${gRim})`}
          stroke={dimGold}
          strokeWidth={0.6}
          strokeLinejoin="round"
        />
        <Circle cx="50" cy="84" r="1.6" fill={dimGold} />

        {/* ── ОСНОВНОЙ КРУГ ЩИТА ── */}
        <Circle
          cx="50" cy="50" r="32"
          fill="none"
          stroke={`url(#${gRim})`}
          strokeWidth={3}
        />
        <Circle
          cx="50" cy="50" r="29.5"
          fill={colors.background}
          stroke={colors.goldDeep}
          strokeOpacity={0.5}
          strokeWidth={0.8}
        />
        {/* Лёгкий тёплый оттенок на лицевой стороне */}
        <Circle cx="50" cy="50" r="28" fill={colors.goldDeep} fillOpacity={0.12} />

        {/* ── Yin-yang фигуры воинов (приглушённые) ── */}
        <G>
          <Path
            d="M50 22
               C 34 22, 22 34, 22 50
               C 22 66, 34 78, 50 78
               C 58 78, 58 64, 50 64
               C 42 64, 42 50, 50 50
               C 58 50, 58 36, 50 36
               C 42 36, 42 22, 50 22 Z"
            fill={tarnishedSilver}
            fillOpacity={0.42}
            stroke={dimGold}
            strokeWidth={0.5}
          />
          <Path
            d="M50 22
               C 66 22, 78 34, 78 50
               C 78 66, 66 78, 50 78
               C 42 78, 42 64, 50 64
               C 58 64, 58 50, 50 50
               C 42 50, 42 36, 50 36
               C 58 36, 58 22, 50 22 Z"
            fill={dimGold}
            fillOpacity={0.32}
            stroke={dimGold}
            strokeWidth={0.5}
          />
        </G>
        <Circle cx="40" cy="36" r="1.4" fill={colors.background} />
        <Circle cx="60" cy="64" r="1.4" fill={colors.background} />

        {/* ── ЛИНИЯ ГРАФИКА — тонкая восходящая ломаная по диагонали через щит,
            намёк на аналитику. Светло-янтарная, полупрозрачная — «вшита»
            в гравировку. ── */}
        <Polyline
          points="28,62 34,58 38,60 44,52 50,54 56,46 62,48 68,40 72,42"
          fill="none"
          stroke={colors.primary}
          strokeWidth={1.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.7}
        />
        {/* Точка-пик */}
        <Circle cx="72" cy="42" r="1.6" fill={colors.primary} opacity={0.9} />

        {/* ── Центральный медальон-солнце ── */}
        <G>
          {[0, 45, 90, 135, 180, 225, 270, 315].map((angle, i) => (
            <Path
              key={i}
              d="M50 44 L51 48 L50 50 L49 48 Z"
              fill={dimGold}
              transform={`rotate(${angle} 50 50)`}
            />
          ))}
          <Circle cx="50" cy="50" r="4.5" fill={`url(#${gMedallion})`} stroke={dimGold} strokeWidth={0.6} />
          <Circle cx="50" cy="50" r="1.6" fill={colors.background} />
          <Circle cx="50" cy="50" r="0.8" fill={dimGold} />
        </G>
      </Svg>
    </View>
  );
}
