import React, { useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, Pressable, Platform,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useApp } from '@/context/AppContext';
import type { FilterBookmaker } from '@/types';

interface Option {
  label: string;
  shortLabel: string;
  value: FilterBookmaker;
}

/**
 * Первая опция — «без ставок» (показываем только вероятности модели).
 * Остальные — конкретные букмекеры; при выборе плитки рынков начинают
 * показывать пары «вероятность + коэффициент этого бука».
 */
const BOOKMAKER_OPTIONS: Option[] = [
  { label: 'Без ставок (только вероятности)', shortLabel: 'Без ставок', value: 'none' },
  { label: 'Fonbet', shortLabel: 'Fonbet', value: 'fonbet' },
  { label: 'Лига Ставок', shortLabel: 'Лига С.', value: 'liga_stavok' },
  { label: 'PARI', shortLabel: 'PARI', value: 'pari' },
  { label: 'BetBoom', shortLabel: 'BetBoom', value: 'betboom' },
  { label: '1xStavka', shortLabel: '1xStavka', value: 'x1stavka' },
  { label: 'Olimp.bet', shortLabel: 'Olimp', value: 'olimp' },
];

/**
 * Компактный пикер букмекера в шапке. Открывается как Modal-оверлей
 * под кнопкой-триггером без сдвига контента.
 */
export function BookmakerDropdown() {
  const colors = useColors();
  const { filters, updateFilters } = useApp();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const triggerRef = useRef<View>(null);

  const current = BOOKMAKER_OPTIONS.find(o => o.value === filters.bookmaker) ?? BOOKMAKER_OPTIONS[0];

  const handleOpen = () => {
    triggerRef.current?.measureInWindow((x, y, w, h) => {
      setAnchor({ x, y, w, h });
      setOpen(true);
    });
  };

  const handleSelect = (value: FilterBookmaker) => {
    updateFilters({ bookmaker: value });
    setOpen(false);
  };

  // Шире чем раньше — длинная подпись «Без ставок (только вероятности)» влезает.
  const PANEL_WIDTH = 240;

  // Если триггер ближе к правому краю — выравниваем панель по правому краю триггера.
  const panelLeft = anchor
    ? Math.max(8, anchor.x + anchor.w - PANEL_WIDTH)
    : 0;
  const panelTop = anchor ? anchor.y + anchor.h + 4 : 0;

  const isNone = current.value === 'none';

  return (
    <>
      <TouchableOpacity
        ref={triggerRef}
        onPress={handleOpen}
        style={[styles.trigger, {
          backgroundColor: colors.card,
          borderColor: isNone ? colors.borderGold + '88' : colors.primary,
        }]}
        accessibilityRole="button"
        accessibilityLabel={`Букмекер: ${current.label}`}
      >
        <Feather
          name={isNone ? 'eye-off' : 'bar-chart-2'}
          size={11}
          color={isNone ? colors.mutedForeground : colors.primary}
        />
        <Text
          style={[styles.triggerLabel, { color: isNone ? colors.mutedForeground : colors.primary }]}
          numberOfLines={1}
        >
          {current.shortLabel}
        </Text>
        <Feather
          name={open ? 'chevron-up' : 'chevron-down'}
          size={12}
          color={isNone ? colors.mutedForeground : colors.primary}
        />
      </TouchableOpacity>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          {anchor && (
            <View
              style={[styles.panel, {
                top: panelTop,
                left: panelLeft,
                width: PANEL_WIDTH,
                backgroundColor: colors.card,
                borderColor: colors.borderGold,
              }]}
              onStartShouldSetResponder={() => true}
            >
              {BOOKMAKER_OPTIONS.map((opt, idx) => {
                const active = opt.value === filters.bookmaker;
                const isFirst = idx === 0;
                return (
                  <TouchableOpacity
                    key={opt.value}
                    onPress={() => handleSelect(opt.value)}
                    style={[
                      styles.item,
                      idx > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
                      active && { backgroundColor: colors.primary + '1A' },
                    ]}
                  >
                    <View style={{ flexShrink: 1 }}>
                      <Text style={[styles.itemLabel, {
                        color: active ? colors.primary : colors.foreground,
                        fontFamily: active ? 'Inter_700Bold' : 'Inter_500Medium',
                      }]}>
                        {opt.label}
                      </Text>
                      {isFirst && (
                        <Text style={[styles.itemHint, { color: colors.mutedForeground }]}>
                          Чистый ML-режим
                        </Text>
                      )}
                    </View>
                    {active && <Feather name="check" size={13} color={colors.primary} />}
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  triggerLabel: {
    fontFamily: 'Cinzel_700Bold',
    fontSize: 10,
    letterSpacing: 1,
    maxWidth: 90,
  },
  backdrop: {
    flex: 1,
    backgroundColor: Platform.OS === 'web' ? 'rgba(0,0,0,0.25)' : 'transparent',
  },
  panel: {
    position: 'absolute',
    borderWidth: 1,
    borderRadius: 6,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 12,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  itemLabel: {
    fontSize: 12,
    letterSpacing: 0.4,
  },
  itemHint: {
    fontFamily: 'Inter_400Regular',
    fontSize: 10,
    marginTop: 2,
    letterSpacing: 0.3,
  },
});
