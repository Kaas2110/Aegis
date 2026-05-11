/**
 * Загружает статистику героев в про-сцене из OpenDota /api/heroStats.
 * Один запрос — список 138 героев со счётчиками pick/ban/win.
 *
 * Вычисляем нормализованные ставки:
 *   totalProMatches = Σ pro_pick / 10  (на матч 10 пиков)
 *   proPickRate = pro_pick / totalProMatches
 *   proBanRate  = pro_ban  / totalProMatches
 *   proWinRate  = pro_win  / pro_pick    (по умолчанию 0.5 если пиков 0)
 */

import { db, heroStatsTable } from '@workspace/db';
import { sql } from 'drizzle-orm';

interface OpenDotaHeroStat {
  id: number;
  name: string;             // npc_dota_hero_antimage
  localized_name: string;   // Anti-Mage
  primary_attr: string;     // 'str' | 'agi' | 'int' | 'all'
  attack_type: string;      // 'Melee' | 'Ranged'
  pro_pick?: number;
  pro_ban?: number;
  pro_win?: number;
}

async function main() {
  console.log('[ingest-hero-stats] GET /api/heroStats …');
  const resp = await fetch('https://api.opendota.com/api/heroStats');
  if (!resp.ok) throw new Error(`OpenDota /api/heroStats: HTTP ${resp.status}`);
  const heroes = (await resp.json()) as OpenDotaHeroStat[];
  console.log(`[ingest-hero-stats] Got ${heroes.length} heroes`);

  // OpenDota не отдаёт текущий патч в /heroStats — берём из /constants/patch
  let patch: string | null = null;
  try {
    const pResp = await fetch('https://api.opendota.com/api/constants/patch');
    if (pResp.ok) {
      const patches = (await pResp.json()) as Array<{ name: string; date: string }>;
      patch = patches[patches.length - 1]?.name ?? null;
    }
  } catch (e) {
    console.warn('[ingest-hero-stats] patch fetch failed (non-fatal):', e);
  }

  const totalPicks = heroes.reduce((s, h) => s + (h.pro_pick ?? 0), 0);
  const totalProMatches = totalPicks / 10;
  console.log(`[ingest-hero-stats] Σ pro_pick=${totalPicks} → ~${totalProMatches.toFixed(0)} matches, patch=${patch}`);

  const rows = heroes.map(h => {
    const pick = h.pro_pick ?? 0;
    const ban = h.pro_ban ?? 0;
    const win = h.pro_win ?? 0;
    return {
      heroId: h.id,
      name: h.localized_name,
      primaryAttr: h.primary_attr,
      attackType: h.attack_type,
      proPickCount: pick,
      proBanCount: ban,
      proWinCount: win,
      proPickRate: totalProMatches > 0 ? pick / totalProMatches : 0,
      proBanRate: totalProMatches > 0 ? ban / totalProMatches : 0,
      proWinRate: pick > 0 ? win / pick : 0.5,
      patch,
      updatedAt: new Date(),
    };
  });

  await db
    .insert(heroStatsTable)
    .values(rows)
    .onConflictDoUpdate({
      target: heroStatsTable.heroId,
      set: {
        name: sql`excluded.name`,
        primaryAttr: sql`excluded.primary_attr`,
        attackType: sql`excluded.attack_type`,
        proPickCount: sql`excluded.pro_pick_count`,
        proBanCount: sql`excluded.pro_ban_count`,
        proWinCount: sql`excluded.pro_win_count`,
        proPickRate: sql`excluded.pro_pick_rate`,
        proBanRate: sql`excluded.pro_ban_rate`,
        proWinRate: sql`excluded.pro_win_rate`,
        patch: sql`excluded.patch`,
        updatedAt: sql`excluded.updated_at`,
      },
    });

  console.log(`[ingest-hero-stats] Upserted ${rows.length} heroes.`);
  process.exit(0);
}

main().catch(err => {
  console.error('[ingest-hero-stats] FATAL', err);
  process.exit(1);
});
