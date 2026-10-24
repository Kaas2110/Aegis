/** Shared plausibility invariant. The anchor time belongs to its native clock,
 * not the newest HTTP receipt carrying an unchanged clock. Receipt chronology,
 * qualification leases and continuity barriers remain the caller's concerns. */
export function isPlausibleSteamClockAdvance({anchorClockSeconds,anchorReceivedNs,clockSeconds,receivedNs,slackSeconds}){
 return Number.isFinite(anchorClockSeconds)&&Number.isFinite(clockSeconds)&&clockSeconds>=anchorClockSeconds&&typeof anchorReceivedNs==='bigint'&&typeof receivedNs==='bigint'&&receivedNs>=anchorReceivedNs&&Number.isFinite(slackSeconds)&&slackSeconds>=0&&clockSeconds-anchorClockSeconds<=Number(receivedNs-anchorReceivedNs)/1e9+slackSeconds;
}
