/** Legacy E1 pure arithmetic shared by offline and API import wrappers.
 * Exact PR11 feature order, defaults, support thresholds and addition order.
 * Callers own source selection; this module performs no DB/provider/as-of IO.
 */
export const E1_PREMATCH_FEATURE_NAMES = [
  'roster_known_radiant', 'roster_known_dire',
  'roster_continuity_radiant', 'roster_continuity_dire',
  'team_pool_overlap_radiant', 'team_pool_overlap_dire',
  'team_pool_winrate_radiant', 'team_pool_winrate_dire',
  'roster_avg_gpm_radiant', 'roster_avg_gpm_dire',
  'roster_avg_xpm_radiant', 'roster_avg_xpm_dire',
  'roster_avg_kda_radiant', 'roster_avg_kda_dire',
  'roster_avg_wlpro180_radiant', 'roster_avg_wlpro180_dire',
  'roster_role_clarity_radiant', 'roster_role_clarity_dire',
];
export const E1_PREMATCH_FEATURE_DIM = E1_PREMATCH_FEATURE_NAMES.length;

function rosterKnown(accountIds, roster) {
  if (!accountIds || accountIds.length === 0 || !roster) return 0;
  const set = new Set(roster.map(r => r.accountId));
  let n = 0;
  for (const a of accountIds) if (a && a > 0 && set.has(a)) n++;
  return n / Math.max(1, accountIds.length);
}

function rosterContinuity(accountIds, roster) {
  if (!accountIds || accountIds.length === 0 || !roster) return 0;
  const currentSet = new Set(roster.filter(r => r.isCurrent).map(r => r.accountId));
  let n = 0;
  for (const a of accountIds) if (a && a > 0 && currentSet.has(a)) n++;
  return n / Math.max(1, accountIds.length);
}

function teamPoolStats(picks, pool) {
  if (!pool || pool.size === 0) return { overlap: 0, wr: 0.5 };
  let overlap = 0;
  let weightedWinSum = 0;
  let weightSum = 0;
  for (const h of picks) {
    const e = pool.get(h);
    if (!e || e.games <= 0) continue;
    overlap += Math.log(e.games + 1);
    const w = Math.log(e.games + 1);
    weightedWinSum += (e.wins / e.games) * w;
    weightSum += w;
  }
  return { overlap, wr: weightSum > 0 ? weightedWinSum / weightSum : 0.5 };
}

function teamAvgTotal(accountIds, totals, field) {
  if (!accountIds || accountIds.length === 0) return 0;
  let sum = 0;
  let n = 0;
  for (const a of accountIds) {
    if (!a || a <= 0) continue;
    const entry = totals.get(a)?.get(field);
    if (entry && entry.n > 0) { sum += entry.avg; n++; }
  }
  return n > 0 ? sum / n : 0;
}

function teamAvgKda(accountIds, totals) {
  if (!accountIds || accountIds.length === 0) return 0;
  let sum = 0;
  let n = 0;
  for (const a of accountIds) {
    if (!a || a <= 0) continue;
    const inner = totals.get(a);
    if (!inner) continue;
    const k = inner.get('kills')?.avg ?? 0;
    const ast = inner.get('assists')?.avg ?? 0;
    const d = inner.get('deaths')?.avg ?? 0;
    const kda = (k + ast) / Math.max(1, d);
    sum += kda; n++;
  }
  return n > 0 ? sum / n : 0;
}

function teamAvgWlPro(accountIds, wlPro) {
  if (!accountIds || accountIds.length === 0) return 0.5;
  let sum = 0;
  let n = 0;
  for (const a of accountIds) {
    if (!a || a <= 0) continue;
    const e = wlPro.get(a);
    if (e && (e.win + e.lose) >= 5) { sum += e.winrate; n++; }
  }
  return n > 0 ? sum / n : 0.5;
}

function teamAvgRoleClarity(accountIds, counts) {
  if (!accountIds || accountIds.length === 0) return 0;
  let sum = 0;
  let n = 0;
  for (const a of accountIds) {
    if (!a || a <= 0) continue;
    const e = counts.get(a);
    if (e) { sum += e.laneRoleClarity; n++; }
  }
  return n > 0 ? sum / n : 0;
}

export function buildE1PrematchFeatures(args) {
  const rosterR = args.rosters.get(args.radiantTeamId);
  const rosterD = args.rosters.get(args.direTeamId);
  const poolR = teamPoolStats(args.radiantPicks, args.pool.get(args.radiantTeamId));
  const poolD = teamPoolStats(args.direPicks, args.pool.get(args.direTeamId));
  return [
    rosterKnown(args.radiantAccountIds, rosterR),
    rosterKnown(args.direAccountIds, rosterD),
    rosterContinuity(args.radiantAccountIds, rosterR),
    rosterContinuity(args.direAccountIds, rosterD),
    poolR.overlap,
    poolD.overlap,
    poolR.wr,
    poolD.wr,
    teamAvgTotal(args.radiantAccountIds, args.totals, 'gold_per_min'),
    teamAvgTotal(args.direAccountIds, args.totals, 'gold_per_min'),
    teamAvgTotal(args.radiantAccountIds, args.totals, 'xp_per_min'),
    teamAvgTotal(args.direAccountIds, args.totals, 'xp_per_min'),
    teamAvgKda(args.radiantAccountIds, args.totals),
    teamAvgKda(args.direAccountIds, args.totals),
    teamAvgWlPro(args.radiantAccountIds, args.wlPro),
    teamAvgWlPro(args.direAccountIds, args.wlPro),
    teamAvgRoleClarity(args.radiantAccountIds, args.counts),
    teamAvgRoleClarity(args.direAccountIds, args.counts),
  ];
}

export const E1_MARKET_KILLS_FEATURE_NAMES = [
  'hero_benchmark_kills_pm_sum_draft', 'hero_dmg_pm_sum_draft',
];
export const E1_MARKET_KILLS_FEATURE_DIM = E1_MARKET_KILLS_FEATURE_NAMES.length;

function draftBenchmarkSum(picks, benchmarks, metric) {
  let sum = 0;
  for (const h of picks) {
    const b = benchmarks.get(h)?.get(metric);
    if (b) sum += b.median;
  }
  return sum;
}

export function buildE1KillsFeatures(args) {
  const allPicks = [...args.radiantPicks, ...args.direPicks];
  return [
    draftBenchmarkSum(allPicks, args.benchmarks, 'kills_per_min'),
    draftBenchmarkSum(allPicks, args.benchmarks, 'hero_damage_per_min'),
  ];
}

export const E1_MARKET_DURATION_FEATURE_NAMES = [
  'hero_late_item_pop_share_radiant', 'hero_late_item_pop_share_dire',
  'hero_early_item_aggression_radiant', 'hero_early_item_aggression_dire',
];
export const E1_MARKET_DURATION_FEATURE_DIM = E1_MARKET_DURATION_FEATURE_NAMES.length;

function teamItemShare(picks, itemPop, field) {
  let sum = 0;
  for (const h of picks) {
    const e = itemPop.get(h);
    if (e) sum += e[field];
  }
  return sum;
}

export function buildE1DurationFeatures(args) {
  return [
    teamItemShare(args.radiantPicks, args.itemPop, 'lateShare'),
    teamItemShare(args.direPicks, args.itemPop, 'lateShare'),
    teamItemShare(args.radiantPicks, args.itemPop, 'earlyAggression'),
    teamItemShare(args.direPicks, args.itemPop, 'earlyAggression'),
  ];
}

export const E1_MARKET_FB_FEATURE_NAMES = ['hero_fb_proxy_radiant', 'hero_fb_proxy_dire'];
export const E1_MARKET_FB_FEATURE_DIM = E1_MARKET_FB_FEATURE_NAMES.length;

function teamFbProxy(picks, benchmarks, itemPop) {
  let sum = 0;
  for (const h of picks) {
    const killsPm = benchmarks.get(h)?.get('kills_per_min')?.median ?? 0;
    const earlyAgg = itemPop.get(h)?.earlyAggression ?? 0;
    sum += killsPm * earlyAgg;
  }
  return sum;
}

export function buildE1FbFeatures(args) {
  return [
    teamFbProxy(args.radiantPicks, args.benchmarks, args.itemPop),
    teamFbProxy(args.direPicks, args.benchmarks, args.itemPop),
  ];
}

export const E1_LIVE_TOTALS_FEATURE_NAMES = [
  'hero_kills_pm_benchmark_sum', 'hero_late_item_pop_share_total',
];
export const E1_LIVE_TOTALS_FEATURE_DIM = E1_LIVE_TOTALS_FEATURE_NAMES.length;

export function buildE1LiveTotalsFeatures(args) {
  const allPicks = [...args.radiantPicks, ...args.direPicks];
  return [
    draftBenchmarkSum(allPicks, args.benchmarks, 'kills_per_min'),
    teamItemShare(allPicks, args.itemPop, 'lateShare'),
  ];
}
