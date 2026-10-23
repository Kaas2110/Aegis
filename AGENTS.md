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
unavailable predictions say only "Прогноз недоступен"; diagnostics retain reasons.
Use synthetic test data for public fixtures. Source parity does not establish
model quality, data coverage, serving approval or a reproducible mobile build.
