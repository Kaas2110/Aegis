# Aegis source and feature architecture

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

The owner requests a pull request for each completed logical source change.
Prepare a reviewed source-only change, run relevant technical checks, create or
update its PR, and record its exact head commit. Do not publish databases, API
keys, environment files, raw observations, real training fixtures, archives,
fitted weights or generated builds. Never blindly stage the whole local runtime.

Use `scripts/source-parity/check_source_parity.py` with an immutable Git commit
to compare current public working files with GitHub source. Record byte parity
separately from line-ending equivalence. The checker does not fetch or publish;
the reference commit must first be available locally. Report every remaining
source difference. An open PR can match local source while `main` and its graph
remain on an earlier commit.

PR creation is not approval to merge, release, activate candidate models or
publish to an app store. PR #1 was separately approved and merged on 2026-10-23;
that approval does not grant automatic merge permission for later PRs.

## Graphify

Use the graphify-context skill when available and relevant. Confirm repository
identity, ready status and indexed commit before retrieval. Prefer compact,
task-specific memory and symbol queries over repeated broad reading. Current
local files and diffs remain authoritative. After one unavailable/stale/empty
lookup, continue locally. Update durable verified context after meaningful
milestones; do not upload secrets or data to make the graph current. After an
authorized merge, verify the new index commit and relevant symbols.

## Runtime boundaries

Respect existing resource limits, provider budgets, STOP files, locks and manual
pauses. Inspect active jobs before starting anything. Do not restart expired
training leases, remove manual stops or reset spend counters. User-facing
unavailable predictions say only "Прогноз недоступен"; diagnostics retain reasons.
Use synthetic test data for public fixtures. Source parity does not establish
model quality, data coverage, serving approval or a reproducible mobile build.
