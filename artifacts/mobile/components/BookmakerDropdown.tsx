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
  value: FilterBookmaker;
}

const BOOKMAKER_OPTIONS: Option[] = [
  { label: 'Без БК', value: 'none' },
  { label: 'Bovada', value: 'bovada' },
];

/**
 * Компактный выпадающий пикер букмекера для строки заголовка ЛАЙВ.
 * Открывается как Modal-оверлей: список рисуется поверх всего экрана,
 * под кнопкой-триггером, и не сдвигает вниз остальной контент.
 *
 * Координаты якорения берём через measureInWindow триггера в момент
 * открытия — это даёт корректное позиционирование и на iOS, и на web.
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

  // Фиксированная ширина дропдауна, чтобы помещались длинные названия типа "Лига Ставок".
  const PANEL_WIDTH = 160;

  // Если триггер ближе к правому краю — выравниваем панель по правому краю триггера,
  // чтобы не вылезала за границу экрана.
  const panelLeft = anchor
    ? Math.max(8, anchor.x + anchor.w - PANEL_WIDTH)
    : 0;
  const panelTop = anchor ? anchor.y + anchor.h + 4 : 0;

  return (
    <>
      <TouchableOpacity
        ref={triggerRef}
        onPress={handleOpen}
        style={[styles.trigger, {
          backgroundColor: colors.card,
          borderColor: colors.borderGold,
        }]}
        accessibilityRole="button"
        accessibilityLabel={`Букмекер: ${current.label}`}
      >
        <Feather name="bar-chart-2" size={11} color={colors.primary} />
        <Text style={[styles.triggerLabel, { color: colors.primary }]} numberOfLines={1}>
          {current.label}
        </Text>
        <Feather name={open ? 'chevron-up' : 'chevron-down'} size={12} color={colors.primary} />
      </TouchableOpacity>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        {/* Прозрачный backdrop — клик закрывает */}
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
              // Останавливаем всплытие, чтобы клик по самому списку не закрывал его.
              onStartShouldSetResponder={() => true}
            >
              {BOOKMAKER_OPTIONS.map((opt, idx) => {
                const active = opt.value === filters.bookmaker;
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
                    <Text style={[styles.itemLabel, {
                      color: active ? colors.primary : colors.foreground,
                      fontFamily: active ? 'Inter_700Bold' : 'Inter_500Medium',
                    }]}>
                      {opt.label}
                    </Text>
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
    paddingVertical: 4,
    marginLeft: 6,
  },
  triggerLabel: {
    fontFamily: 'Cinzel_700Bold',
    fontSize: 10,
    letterSpacing: 1,
    maxWidth: 80,
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
    // iOS shadow
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    // Android shadow
    elevation: 12,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  itemLabel: {
    fontSize: 12,
    letterSpacing: 0.4,
  },
});
