import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useColors } from '@/hooks/useColors';
import type { TimelinePoint } from '@/types';

interface Props {
  data: TimelinePoint[];
  team1Name: string;
  team2Name: string;
}

export function ProbabilityTimeline({ data, team1Name, team2Name }: Props) {
  const colors = useColors();
  const WIDTH = 300;
  const HEIGHT = 120;
  const PADDING = 20;

  if (data.length < 2) return null;

  const maxTime = Math.max(...data.map(d => d.gameTimeSec));
  const minTime = Math.min(...data.map(d => d.gameTimeSec));
  const timeRange = maxTime - minTime || 1;

  function xPos(t: number): number {
    return PADDING + ((t - minTime) / timeRange) * (WIDTH - PADDING * 2);
  }
  function yPos(p: number): number {
    return PADDING + (1 - p) * (HEIGHT - PADDING * 2);
  }

  function buildPath(points: { x: number; y: number }[]): string {
    return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  }

  const modelPoints = data.map(d => ({ x: xPos(d.gameTimeSec), y: yPos(d.modelProbTeam1) }));
  const marketPoints = data.map(d => ({ x: xPos(d.gameTimeSec), y: yPos(d.marketProbTeam1) }));
  const midY = yPos(0.5);

  const eventPoints = data.filter(d => d.event);

  return (
    <View style={styles.container}>
      <View style={styles.legend}>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: colors.chart1 }]} />
          <Text style={[styles.legendText, { color: colors.mutedForeground }]}>Прогноз</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDash, { backgroundColor: colors.chart3 }]} />
          <Text style={[styles.legendText, { color: colors.mutedForeground }]}>Рынок</Text>
        </View>
      </View>

      <View style={styles.chartArea}>
        <View style={styles.yLabels}>
          <Text style={[styles.yLabel, { color: colors.mutedForeground }]}>100%</Text>
          <Text style={[styles.yLabel, { color: colors.mutedForeground }]}>50%</Text>
          <Text style={[styles.yLabel, { color: colors.mutedForeground }]}>0%</Text>
        </View>

        <View style={[styles.chart, { width: WIDTH, height: HEIGHT }]}>
          <View style={[styles.midLine, { top: midY, borderColor: colors.border }]} />

          {modelPoints.map((p, i) => {
            if (i === 0) return null;
            const prev = modelPoints[i - 1];
            const angle = Math.atan2(p.y - prev.y, p.x - prev.x) * (180 / Math.PI);
            const length = Math.sqrt((p.x - prev.x) ** 2 + (p.y - prev.y) ** 2);
            return (
              <View
                key={`m${i}`}
                style={{
                  position: 'absolute',
                  left: prev.x,
                  top: prev.y,
                  width: length,
                  height: 2,
                  backgroundColor: colors.chart1,
                  transformOrigin: 'left center',
                  transform: [{ rotate: `${angle}deg` }],
                }}
              />
            );
          })}

          {marketPoints.map((p, i) => {
            if (i === 0) return null;
            const prev = marketPoints[i - 1];
            const angle = Math.atan2(p.y - prev.y, p.x - prev.x) * (180 / Math.PI);
            const length = Math.sqrt((p.x - prev.x) ** 2 + (p.y - prev.y) ** 2);
            return (
              <View
                key={`mk${i}`}
                style={{
                  position: 'absolute',
                  left: prev.x,
                  top: prev.y,
                  width: length,
                  height: 1,
                  backgroundColor: colors.chart3,
                  opacity: 0.7,
                  transformOrigin: 'left center',
                  transform: [{ rotate: `${angle}deg` }],
                }}
              />
            );
          })}

          {eventPoints.map((d, i) => {
            const x = xPos(d.gameTimeSec);
            const y = yPos(d.modelProbTeam1);
            return (
              <View key={`ev${i}`} style={[styles.eventDot, { left: x - 4, top: y - 4, backgroundColor: colors.warning }]} />
            );
          })}
        </View>
      </View>

      <View style={styles.teamLabels}>
        <Text style={[styles.teamLabel, { color: colors.radiant }]}>{team1Name}</Text>
        <Text style={[styles.teamLabel, { color: colors.dire, textAlign: 'right' }]}>{team2Name}</Text>
      </View>

      <View style={styles.events}>
        {eventPoints.slice(-3).map((d, i) => (
          <View key={i} style={styles.eventRow}>
            <View style={[styles.eventDotSm, { backgroundColor: colors.warning }]} />
            <Text style={[styles.eventText, { color: colors.mutedForeground }]}>
              {Math.floor(d.gameTimeSec / 60)}м — {d.event}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 10 },
  legend: { flexDirection: 'row', gap: 16, justifyContent: 'center' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 10, height: 2.5, borderRadius: 1 },
  legendDash: { width: 10, height: 1.5, borderRadius: 1, opacity: 0.7 },
  legendText: { fontFamily: 'Inter_400Regular', fontSize: 11 },
  chartArea: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  yLabels: { justifyContent: 'space-between', height: 120, paddingVertical: 10 },
  yLabel: { fontFamily: 'Inter_400Regular', fontSize: 9 },
  chart: { position: 'relative', overflow: 'hidden' },
  midLine: { position: 'absolute', left: 0, right: 0, height: 1, borderWidth: 0.5, borderStyle: 'dashed', borderColor: '#333' },
  eventDot: { position: 'absolute', width: 8, height: 8, borderRadius: 4 },
  teamLabels: { flexDirection: 'row', justifyContent: 'space-between' },
  teamLabel: { fontFamily: 'Inter_600SemiBold', fontSize: 12 },
  events: { gap: 4 },
  eventRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  eventDotSm: { width: 6, height: 6, borderRadius: 3 },
  eventText: { fontFamily: 'Inter_400Regular', fontSize: 11 },
});
