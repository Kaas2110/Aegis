import { db, proMatchesTable } from '@workspace/db';
import { desc } from 'drizzle-orm';
import { openDotaLedger, openDotaBackgroundFetch } from '@workspace/db/opendota';
async function main() {
  const command = process.argv[2];
  if (command === 'enable') {
    if (!process.env.OPENDOTA_API_KEY) throw new Error('OpenDota key is missing; policy unchanged');
    await openDotaLedger.configurePaid!({
      enabled: true,
      minute: 100,
      monthlyLimitUnits: 200_000,
      archiveLimitUnits: 200_000
    });
  } else if (command === 'disable') {
    const { state } = await openDotaLedger.snapshot();
    if (state.paid) await openDotaLedger.configurePaid!({ ...state.paid, enabled: false });
  } else if (command !== 'status' && command !== 'probe')
    throw new Error('Choose enable, disable, status or probe');
  if (command === 'probe') {
    const [row] = await db
      .select({ id: proMatchesTable.matchId })
      .from(proMatchesTable)
      .orderBy(desc(proMatchesTable.startTime))
      .limit(1);
    if (!row) throw new Error('No local match for paid read-only probe');
    const res = await openDotaBackgroundFetch(`https://api.opendota.com/api/matches/${row.id}`);
    if (!res.ok) throw new Error(`OpenDota probe HTTP ${res.status}`);
    const data = (await res.json()) as { match_id?: number; players?: unknown[]; version?: number };
    if (data.match_id !== row.id) throw new Error('OpenDota probe returned a different match');
    console.log(
      JSON.stringify({
        probe: 'matched',
        matchId: row.id,
        players: Array.isArray(data.players) ? data.players.length : 0,
        parsedVersion: data.version ?? null,
        remainingMinute: res.headers.get('x-rate-limit-remaining-minute'),
        hasDailyFreeHeader: res.headers.has('x-rate-limit-remaining-day')
      })
    );
  }
  const { state, now } = await openDotaLedger.snapshot();
  console.log(
    JSON.stringify({
      at: new Date(now).toISOString(),
      freeDays: state.days,
      paid: state.paid ?? null,
      blockedUntil: state.blockedUntil,
      blockedReason: state.blockedReason
    })
  );
}
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[opendota-policy]', error instanceof Error ? error.message : 'failed');
    process.exit(1);
  });
