/**
 * Временный скрипт проверки Stratz-токена. Запустить:
 *   pnpm --filter @workspace/scripts run test:stratz
 */
import { checkStratzConnectivity, fetchHeroStatsPro, fetchMatchDetail } from './lib/stratz.js';

async function main() {
  console.log('[test-stratz] Checking connectivity …');
  const conn = await checkStratzConnectivity();
  console.log('[test-stratz] connectivity:', JSON.stringify(conn));

  if (!conn.ok) {
    console.error('[test-stratz] FAIL:', conn.error);
    process.exit(1);
  }

  console.log('[test-stratz] Fetching PRO hero stats …');
  const rows = await fetchHeroStatsPro();
  const top3 = [...rows].sort((a, b) => b.matchCount - a.matchCount).slice(0, 3);
  console.log(`[test-stratz] ${rows.length} heroes. Top3 by matchCount:`, JSON.stringify(top3));

  console.log('[test-stratz] Fetching match detail (7975481055) …');
  const match = await fetchMatchDetail(7975481055);
  console.log(`[test-stratz] match id=${match.id} didRadiantWin=${match.didRadiantWin} picks=${match.pickBans?.filter(p=>p.isPick).length ?? 0}`);

  console.log('[test-stratz] ALL OK');
  process.exit(0);
}

main().catch(e => { console.error('[test-stratz] FATAL', e); process.exit(1); });
