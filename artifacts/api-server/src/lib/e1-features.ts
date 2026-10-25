/** Legacy E1 DB loader compatibility port.
 * Pure names/types/builders are shared; local loader SQL and iteration order
 * remain unchanged. These loaders read the current DB and do not mint causal
 * history authority. Source/as-of selection remains the caller's responsibility.
 */
import { inArray } from 'drizzle-orm';
import {
  db,
  teamRostersTable,
  teamHeroPoolTable,
  heroBenchmarksTable,
  heroItemPopularityTable,
  playerTotalsTable,
  playerCountsTable,
  playerWlProTable,
} from '@workspace/db';
import type { TeamRostersMap, TeamHeroPoolMap, HeroBenchmarkAgg, HeroBenchmarksMap, HeroItemPopularityMap, PlayerTotalsMap, PlayerCountsMap, PlayerWlProMap } from '../../../../shared/feature-math/e1-features.mjs';
export * from '../../../../shared/feature-math/e1-features.mjs';

export async function loadTeamRostersMap(): Promise<TeamRostersMap> {
  const rows = await db.select().from(teamRostersTable);
  const map: TeamRostersMap = new Map();
  for (const r of rows) {
    let arr = map.get(r.teamId);
    if (!arr) { arr = []; map.set(r.teamId, arr); }
    arr.push({
      accountId: r.accountId,
      gamesPlayed: r.gamesPlayed,
      wins: r.wins,
      isCurrent: r.isCurrent,
    });
  }
  return map;
}

export async function loadTeamHeroPoolMap(): Promise<TeamHeroPoolMap> {
  const rows = await db.select().from(teamHeroPoolTable);
  const map: TeamHeroPoolMap = new Map();
  for (const r of rows) {
    let inner = map.get(r.teamId);
    if (!inner) { inner = new Map(); map.set(r.teamId, inner); }
    inner.set(r.heroId, { games: r.gamesPlayed, wins: r.wins });
  }
  return map;
}

/**
 * Загружает hero_benchmarks и сворачивает массив перцентилей в {median, std}.
 * Если перцентилей мало или они невалидны — пара пропускается (defaults на пользователе).
 */
export async function loadHeroBenchmarksMap(): Promise<HeroBenchmarksMap> {
  const rows = await db.select().from(heroBenchmarksTable);
  const map: HeroBenchmarksMap = new Map();
  for (const r of rows) {
    const inner = new Map<string, HeroBenchmarkAgg>();
    for (const [metric, pcts] of Object.entries(r.data)) {
      if (!Array.isArray(pcts) || pcts.length < 2) continue;
      // Ищем ближайшую точку к target (а не первое попадание в окно) —
      // защищает от мисклика, когда OD прислал и p40 и p50 в одном массиве.
      const findClosest = (target: number) => {
        let best: { percentile: number; value: number } | null = null;
        let bestDist = Infinity;
        for (const p of pcts) {
          if (typeof p.percentile !== 'number' || typeof p.value !== 'number') continue;
          const d = Math.abs(p.percentile - target);
          if (d < bestDist && d < 0.05) { best = p; bestDist = d; }
        }
        return best;
      };
      const p50 = findClosest(0.5);
      const p25 = findClosest(0.25);
      const p75 = findClosest(0.75);
      if (!p50 || typeof p50.value !== 'number') continue;
      let std = 0;
      if (p25 && p75 && typeof p25.value === 'number' && typeof p75.value === 'number') {
        std = Math.max(0, (p75.value - p25.value) / 1.35);
      }
      inner.set(metric, { median: p50.value, std });
    }
    if (inner.size > 0) map.set(r.heroId, inner);
  }
  return map;
}

/**
 * Свернёт start/early/mid/late dicts в {lateShare, earlyAggression}.
 * Если суммарных покупок нет (новый герой) — герой пропускается, defaults у вызова.
 */
export async function loadHeroItemPopularityMap(): Promise<HeroItemPopularityMap> {
  const rows = await db.select().from(heroItemPopularityTable);
  const map: HeroItemPopularityMap = new Map();
  const sumDict = (d: Record<string, number> | null | undefined) =>
    d ? Object.values(d).reduce((acc, v) => acc + (Number(v) || 0), 0) : 0;
  for (const r of rows) {
    const s = sumDict(r.startGameItems);
    const e = sumDict(r.earlyGameItems);
    const m = sumDict(r.midGameItems);
    const l = sumDict(r.lateGameItems);
    const total = s + e + m + l;
    if (total <= 0) continue;
    map.set(r.heroId, {
      lateShare: l / total,
      earlyAggression: (s + e) / total,
    });
  }
  return map;
}

/**
 * Тянет долгосрочные суммы (например gold_per_min / kills_per_min) для всех
 * pro-аккаунтов. Узкий загрузчик через `fields?` ограничивает выборку, чтобы
 * не таскать 100+ метрик на каждого игрока.
 */
export async function loadPlayerTotalsMap(opts?: { fields?: string[] }): Promise<PlayerTotalsMap> {
  const rows = opts?.fields && opts.fields.length > 0
    ? await db.select().from(playerTotalsTable).where(inArray(playerTotalsTable.field, opts.fields))
    : await db.select().from(playerTotalsTable);
  const map: PlayerTotalsMap = new Map();
  for (const r of rows) {
    let inner = map.get(r.accountId);
    if (!inner) { inner = new Map(); map.set(r.accountId, inner); }
    inner.set(r.field, { n: r.n, sum: r.sum, avg: r.avg });
  }
  return map;
}

/**
 * Сворачивает player_counts.data.lane_role в `laneRoleClarity = max/sum`.
 * Игроки без lane_role либо с 0 играми — пропускаются.
 */
export async function loadPlayerCountsMap(): Promise<PlayerCountsMap> {
  const rows = await db.select().from(playerCountsTable);
  const map: PlayerCountsMap = new Map();
  for (const r of rows) {
    const lr = r.data?.lane_role;
    if (!lr || typeof lr !== 'object') continue;
    let total = 0;
    let max = 0;
    for (const v of Object.values(lr)) {
      const games = typeof v?.games === 'number' ? v.games : 0;
      total += games;
      if (games > max) max = games;
    }
    if (total <= 0) continue;
    map.set(r.accountId, { laneRoleClarity: max / total });
  }
  return map;
}

export async function loadPlayerWlProMap(): Promise<PlayerWlProMap> {
  const rows = await db.select().from(playerWlProTable);
  const map: PlayerWlProMap = new Map();
  for (const r of rows) {
    const total = r.win + r.lose;
    map.set(r.accountId, {
      win: r.win,
      lose: r.lose,
      winrate: total > 0 ? r.win / total : 0.5,
    });
  }
  return map;
}
