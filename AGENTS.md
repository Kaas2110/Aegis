# Aegis source and feature architecture

## Documentation language

Write all new or substantively updated project documentation in English,
including plans, architecture notes, reports, handoffs, durable Graphify notes
and PR titles/descriptions. Communicate with the owner in Russian in chat.
Translate a document into Russian only on explicit request. Translate existing
prose when substantively updating its document; do not bulk-translate historical
evidence as a separate work block. Preserve identifiers, quoted evidence and
product localization. Owner preference recorded on 2026-10-23.

## Current implementation order

Read `docs/feature-architecture-20261023.txt` and
`docs/sol-feature-first-plan-20261023.txt` before substantive ML work.
First finish the source contracts, complete feature inventory, common feature
producer and historical/live alignment. New training, HPO, ablations and model
quality evaluations are paused until this work is reviewed. Technical correctness
tests and bounded inspection of existing data remain appropriate.

Historical player/team/hero information is useful in both prematch and live.
Join only the version available at the declared history cutoff to a coherent
current-game observation. Preserve event time, receipt/availability time and
decision time. Current-map final results are separate labels, not early inputs.
Use the same versioned formulas for offline and online vectors. Do not claim
that the proposed unified pipeline is already fully integrated.

## Public source synchronization

The owner requests one pull request per completed block of work, not per edit.
Within an unfinished block, local working source and saved checkpoints are
authoritative. Save intermediate checkpoints for meaningful progress; do not
automatically update GitHub or Graphify after each edit. State explicitly when
main or its graph trails the current block.

When the block is complete, review its source inventory and exclusions, run
relevant technical checks, then create one PR or update the existing PR for that
same block. Record its exact head commit. Do not publish databases, API keys,
environment files, raw observations, real training fixtures, archives, fitted
weights or generated builds. Never blindly stage the whole local runtime.

The owner clarified on 2026-10-23: after each completed, reviewed block, create
or update its PR and merge it into main without asking again. Graphify refreshes
automatically after merge. Relevant correctness and changed-file checks remain
required. A full byte-by-byte source scan is not a routine block gate; reuse prior
immutable evidence and run the parity checker only for a concrete divergence or
synchronization concern. Its report distinguishes source bytes from line endings
and excludes private/runtime data. An unfinished local block may lead main/graph.
This standing source/documentation merge permission supersedes older per-PR
approval wording. App release, public candidate promotion, purchases and app-store
publication remain separate decisions.

## Astra review record

Astra is the architect and reviewer of Sol implementation. At each meaningful
checkpoint and completed block, record the original problem, decisions and why,
alternatives, exact changed paths, checks/results, actual versus synthetic evidence,
limitations/risks, open architecture questions and next action. Preserve negative
reproductions and their fixes. Passing technical tests does not by itself establish
architectural acceptance, data coverage or model quality. Keep the full review pack
in the local continuation workspace and a source-safe summary with the block PR.

## Graphify

Use the graphify-context skill when available and relevant. Confirm repository
identity, ready status and indexed commit before retrieval. Prefer compact,
task-specific memory and symbol queries over repeated broad reading. Current
local files, diffs and checkpoints remain authoritative. After one unavailable,
stale or empty lookup, continue locally. Save meaningful intermediate progress
locally; synchronize durable verified cloud context at block completion, not
after every edit. Do not upload secrets or data to make the graph current.
After a completed-block merge, confirm the automatic indexing result with a
lightweight ready/commit check. Avoid a second manual rebuild or repeated full scan.

## Runtime boundaries

Respect existing resource limits, provider budgets, STOP files, locks and manual
pauses. Inspect active jobs before starting anything. Do not restart expired
training leases, remove manual stops or reset spend counters. User-facing
unavailable predictions say only "РџСЂРѕРіРЅРѕР· РЅРµРґРѕСЃС‚СѓРїРµРЅ"; diagnostics retain reasons.
Use synthetic test data for public fixtures. Source parity does not establish
model quality, data coverage, serving approval or a reproducible mobile build.

## Sol r2 diagnostic feature expansion

The next reviewed source block adds the actual rich historical/dynamic/series
formula modules, unifiedFeatureProducer, immutable history source exports and
feature-only diagnostic journaling. Read docs/unified-feature-runtime-20261023.txt
and docs/sol-feature-expansion-review-20261023.txt before continuing. The broad
vector remains diagnostic, with inferenceVector=null and no serving/training
admission. All79 families remain in scope; partial implemented subsets do not
close the full feature-first gate. Runtime/task activation is separate from
source installation. Do not rerun prior manifests against changed local source.

## Astra review and next Sol plan вЂ” 2026-10-24

Read `docs/astra-sol-review-20261024.txt` and
`docs/sol-feature-first-plan-20261024.txt` first. The latter supersedes the old
October 23 implementation sequence; prior reports remain historical evidence.
The reviewed source corrections preserve history/live causality and diagnostic
routing. Full feature-first acceptance and active host/model integration remain
incomplete. The actual retained GLG corpus omits phase; a distinct private-proof
progressing admission profile is specified for Sol, not implemented or activated.
Mutable historical rows remain reconstruction-only until source versioning.
No new fits, HPO, calibration, quality evaluations, migrations, provider probes,
schedule changes or candidate activation are implied. Preserve all manual stops.
Record every implementation decision and actual check for Astra. Continue from
the current installation/publication receipt, never re-run old install manifests.


## Sol r3 implementation checkpoint — 2026-10-24

Read docs/sol-feature-integration-review-20261024-r3.txt and the generated family
integration ledger before continuing. This block implements portable registry,
retained field versions, progressing Steam proof, broad current/history/draft
features, independent series history, bounded schema/value production and an
opt-in diagnostic host/reader/12-target adapter. Astra acceptance remains pending.
No fits, provider probes, migrations, runtime/task activation or promotion.
Replay source horizons never backdate actual calculation timestamps. Preserve
all source/store/STOP/lock boundaries and distinguish generated family subsets
from source availability and full semantic migration.

## Sol r4 current source contracts — 2026-10-24

Read docs/sol-feature-first-plan-20261024-r4.txt and
 docs/sol-r4-integration-review-20261024.txt first. The owner restricts Astra to
architecture, difficult logical/mathematical choices and review. Sol implements,
integrates, tests and publishes reviewed completed source blocks.

Current eligible-state age is300seconds. Receipt time, source-state confirmation
and game-clock advance are separate. Unknown stationary responses do not renew
qualification; a saved feature trace does not prove an issued current forecast.
No qualified live-pause field was established in the retained GLG profile; do not
invent pause confirmation. No runtime activation or serving promotion is implied.

Keep the all79-family feature catalogue and rich variants. Historical facts use
as-of availability and actual game end for sporting recency. Only one coherent
current source profile feeds dynamic fields. Preserve manual STOP/lock state.
Training/HPO/calibration/model-quality evaluation remain paused pending full
feature-first acceptance and Astra review. New technical tests are synthetic;
archive-scale source/proof integration and prospective source coverage remain
explicit gates. Follow the current exact install/publication receipts and use
local source when Graphify indexing lags. No routine whole-source byte audit.

## Sol R5 core source checkpoint — 2026-10-24
Read docs/sol-r5-core-review-20261024.txt and the R5 feature-first plan.
Early allocation admission, serial diagnostic generation/commit, source clock
anchor/final read fence, Roshan event ledger, historical clock-block v2 and compact
verified history handles are source-integrated. The full byte-owned compact runtime,
transactional reference corpus, complete series host integration and sustained
acceptance remain separate later work. Training/provider probes/runtime activation
and model promotion stay paused. Existing 300-second state retention and separate
180-second progression admission are preserved; active legacy serving is separate.
Use exact new install/publication receipts; do not rerun old guards or full parity.
