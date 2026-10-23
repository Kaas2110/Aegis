import { openDotaBackgroundFetch as fetch, OdQuotaExhaustedError } from '@workspace/db/opendota';
/**
 * Загружает статистику героев в про-сцене.
 *
 * Источники:
 *   - Stratz GraphQL (если STRATZ_TOKEN задан) — professional bracket,
 *     winWeek с точными счётчиками текущего патча. РЕКОМЕНДУЕТСЯ.
 *   - OpenDota REST (fallback / всегда) — /api/heroStats, агрегат за всё время,
 *     также тянет patch из /constants/patch.
 *
 * Если STRATZ_TOKEN задан: берём winRate/pickRate из Stratz (точнее),
 * имена/primaryAttr/attackType — из OpenDota (один запрос, бесплатно).
 * Если токен не задан: полностью OpenDota (как раньше).
 */

import { db, heroStatsTable } from '@workspace/db';
import { sql } from 'drizzle-orm';
import {
  fetchHeroStatsPro,
  fetchHeroRoles,
  StratzUnavailableError,
  getStratzPoolSize,
  type StratzHeroConst,
  type StratzRoleId,
} from './lib/stratz.js';

// Веса ролей для фазового скоринга. Подобраны эмпирически:
//  - Late: керри тащит игру; durable выживает; jungler фармит
//  - Early: nuker даёт burst; initiator открывает файты; support позволяет
//    линиям доминировать; disabler контролит ранние стычки.
// max(L) = 3*1.0+3*0.5+3*0.3 = 5.4; max(E) = 3*0.7+3*0.7+3*0.5+3*0.3 = 6.6.
const LATE_WEIGHTS: Record<string, number> = { CARRY: 1.0, DURABLE: 0.5, JUNGLER: 0.3 };
const EARLY_WEIGHTS: Record<string, number> = { NUKER: 0.7, INITIATOR: 0.7, SUPPORT: 0.5, DISABLER: 0.3 };
const MAX_LATE = 5.4;
const MAX_EARLY = 6.6;

function computePhaseScores(roles: StratzHeroConst['roles']): { early: number; late: number } {
  if (!roles || roles.length === 0) return { early: 0.5, late: 0.5 };
  let lateRaw = 0, earlyRaw = 0;
  for (const r of roles) {
    const lw = LATE_WEIGHTS[r.roleId as StratzRoleId] ?? 0;
    const ew = EARLY_WEIGHTS[r.roleId as StratzRoleId] ?? 0;
    lateRaw  += lw * r.level;
    earlyRaw += ew * r.level;
  }
  return {
    early: Math.min(1, earlyRaw / MAX_EARLY),
    late:  Math.min(1, lateRaw  / MAX_LATE),
  };
}

interface OpenDotaHeroStat {
  id: number;
  name: string;
  localized_name: string;
  primary_attr: string;
  attack_type: string;
  pro_pick?: number;
  pro_ban?: number;
  pro_win?: number;
}

async function fetchOpenDotaHeroStats(): Promise<OpenDotaHeroStat[]> {
  const { withOpenDotaKey } = await import('./lib/openDotaUrl');
  const resp = await fetch(withOpenDotaKey('https://api.opendota.com/api/heroStats'), {
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`OpenDota /api/heroStats: HTTP ${resp.status}`);
  return (await resp.json()) as OpenDotaHeroStat[];
}

async function fetchCurrentPatch(): Promise<string | null> {
  try {
    const { withOpenDotaKey } = await import('./lib/openDotaUrl');
    const resp = await fetch(withOpenDotaKey('https://api.opendota.com/api/constants/patch'), {
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    const patches = (await resp.json()) as Array<{ name: string; date: string }>;
    return patches[patches.length - 1]?.name ?? null;
  } catch (error) {
    if (error instanceof OdQuotaExhaustedError) throw error;
    return null;
  }
}

async function main() {
  const useStratz = !!process.env['STRATZ_TOKEN'];
  console.log(`[ingest-hero-stats] source=${useStratz ? 'Stratz (pro bracket) + OpenDota (meta)' : 'OpenDota only'}`);

  // Всегда тянем OpenDota — там имена, атрибуты, attack_type и бан-статистика.
  console.log('[ingest-hero-stats] GET OpenDota /api/heroStats …');
  const [heroes, patch] = await Promise.all([
    fetchOpenDotaHeroStats(),
    fetchCurrentPatch(),
  ]);
  console.log(`[ingest-hero-stats] OpenDota: ${heroes.length} heroes, patch=${patch}`);

  // Индекс по id
  const odMap = new Map<number, OpenDotaHeroStat>(heroes.map(h => [h.id, h]));

  // Stratz professional winrate (более точный, по текущему патчу)
  let stratzWinMap: Map<number, { winCount: number; matchCount: number }> | null = null;
  // Stratz hero roles → фазовые скоринги (early/late). Если Stratz недоступен —
  // оставляем дефолтные 0.5/0.5 (нейтрально).
  const phaseMap = new Map<number, { early: number; late: number }>();
  if (useStratz) {
    try {
      const stratzRows = await fetchHeroStatsPro();
      stratzWinMap = new Map(stratzRows.map(r => [r.heroId, { winCount: r.winCount, matchCount: r.matchCount }]));
      console.log(`[ingest-hero-stats] Stratz: ${stratzRows.length} heroes in PROFESSIONAL bracket`);
    } catch (e) {
      if (e instanceof OdQuotaExhaustedError) throw e;
      if (e instanceof StratzUnavailableError) {
        console.warn(`[ingest-hero-stats] Stratz unavailable (${e.message}), using OpenDota only`);
      } else {
        throw e;
      }
    }
    if (getStratzPoolSize() > 0) {
      try {
        const heroConsts = await fetchHeroRoles();
        for (const h of heroConsts) phaseMap.set(h.id, computePhaseScores(h.roles));
        console.log(`[ingest-hero-stats] Stratz: roles for ${heroConsts.length} heroes → phase scores computed`);
      } catch (e) {
        if (e instanceof OdQuotaExhaustedError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[ingest-hero-stats] Stratz roles unavailable (${msg}), phase scores оставлены 0.5`);
      }
    }
  }

  // Собираем строки: берём winRate/pickRate из Stratz если есть, иначе OpenDota.
  const totalOdPicks = heroes.reduce((s, h) => s + (h.pro_pick ?? 0), 0);
  const totalOdMatches = totalOdPicks / 10;

  const rows = heroes.map(h => {
    const odPick = h.pro_pick ?? 0;
    const odBan  = h.pro_ban  ?? 0;
    const odWin  = h.pro_win  ?? 0;

    let pickCount: number;
    let winCount: number;
    let pickRate: number;
    let winRate: number;

    if (stratzWinMap) {
      const s = stratzWinMap.get(h.id);
      pickCount = s?.matchCount ?? odPick;
      winCount  = s?.winCount  ?? odWin;
      // pickRate нормализуем по Stratz тотал (сумма matchCount / 10)
      const totalStratz = [...stratzWinMap.values()].reduce((a, v) => a + v.matchCount, 0) / 10;
      pickRate = totalStratz > 0 ? pickCount / totalStratz : (totalOdMatches > 0 ? odPick / totalOdMatches : 0);
      winRate  = pickCount > 0 ? winCount / pickCount : 0.5;
    } else {
      pickCount = odPick;
      winCount  = odWin;
      pickRate  = totalOdMatches > 0 ? odPick / totalOdMatches : 0;
      winRate   = odPick > 0 ? odWin / odPick : 0.5;
    }

    const banRate = totalOdMatches > 0 ? odBan / totalOdMatches : 0;
    const phase = phaseMap.get(h.id) ?? { early: 0.5, late: 0.5 };

    return {
      heroId:         h.id,
      name:           h.localized_name,
      primaryAttr:    h.primary_attr,
      attackType:     h.attack_type,
      proPickCount:   pickCount,
      proBanCount:    odBan,
      proWinCount:    winCount,
      proPickRate:    pickRate,
      proBanRate:     banRate,
      proWinRate:     winRate,
      earlyGameScore: phase.early,
      lateGameScore:  phase.late,
      patch,
      updatedAt:      new Date(),
    };
  });

  await db
    .insert(heroStatsTable)
    .values(rows)
    .onConflictDoUpdate({
      target: heroStatsTable.heroId,
      set: {
        name:         sql`excluded.name`,
        primaryAttr:  sql`excluded.primary_attr`,
        attackType:   sql`excluded.attack_type`,
        proPickCount: sql`excluded.pro_pick_count`,
        proBanCount:  sql`excluded.pro_ban_count`,
        proWinCount:  sql`excluded.pro_win_count`,
        proPickRate:    sql`excluded.pro_pick_rate`,
        proBanRate:     sql`excluded.pro_ban_rate`,
        proWinRate:     sql`excluded.pro_win_rate`,
        earlyGameScore: sql`excluded.early_game_score`,
        lateGameScore:  sql`excluded.late_game_score`,
        patch:          sql`excluded.patch`,
        updatedAt:      sql`excluded.updated_at`,
      },
    });

  console.log(`[ingest-hero-stats] Upserted ${rows.length} heroes (Stratz=${stratzWinMap ? 'yes' : 'no'}).`);
  process.exit(0);
}

main().catch(err => {
  console.error('[ingest-hero-stats] FATAL', err);
  process.exit(1);
});
