/**
 * OrnateFrame — оверлей с четырьмя золотыми L-образными «уголками» в стиле
 * рамок предметов из инвентаря Dota 2. Накладывается поверх любого View
 * с position: 'relative', не влияет на содержимое.
 *
 * Используется для обозначения «эпичных» карточек: матчей с +EV,
 * заголовков турниров, карточек профиля.
 *
 *   ┌─        ─┐
 *   │          │
 *   │          │
 *   └─        ─┘
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';

interface Props {
  color: string;
  size?: number;     // длина «крыла» уголка
  thickness?: number; // толщина линии
  inset?: number;    // отступ от края контейнера
  opacity?: number;
}

export function OrnateCorners({
  color,
  size = 14,
  thickness = 2,
  inset = 0,
  opacity = 0.9,
}: Props) {
  // Целочисленные значения toolbar-уголков — иначе на web 1x DPR
  // ширина 1.5px AA-блюрится в «грязный» серый пиксель.
  const armStyle = { backgroundColor: color, opacity };
  const horizontal = { width: size, height: thickness };
  const vertical = { width: thickness, height: size };

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {/* TL */}
      <View style={[styles.corner, { top: inset, left: inset }, horizontal, armStyle]} />
      <View style={[styles.corner, { top: inset, left: inset }, vertical, armStyle]} />
      {/* TR */}
      <View style={[styles.corner, { top: inset, right: inset }, horizontal, armStyle]} />
      <View style={[styles.corner, { top: inset, right: inset }, vertical, armStyle]} />
      {/* BL */}
      <View style={[styles.corner, { bottom: inset, left: inset }, horizontal, armStyle]} />
      <View style={[styles.corner, { bottom: inset, left: inset }, vertical, armStyle]} />
      {/* BR */}
      <View style={[styles.corner, { bottom: inset, right: inset }, horizontal, armStyle]} />
      <View style={[styles.corner, { bottom: inset, right: inset }, vertical, armStyle]} />
    </View>
  );
}

const styles = StyleSheet.create({
  corner: { position: 'absolute' },
});
