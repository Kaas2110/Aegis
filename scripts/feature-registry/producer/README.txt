AEGIS S7 — PURE COMMON FEATURE COMPOSITION FOUNDATION
23 October 2026

Status

Staged diagnostic foundation. This implements a reusable composition/projection contract and technical checks. It does not complete S7, the common feature inventory, the feature-first gate, training admission, serving admission or application integration. No training, prediction-quality evaluation, provider requests or new model math was performed.

Original problem

The catalogue contains alternative schemas and many implemented, partial and planned families. A runtime vector must preserve exact feature order, formulas, source meanings and causal availability. Equal feature names do not establish equal semantics: a shared formula can change while a wrapper and a 38,468-name list remain unchanged. Missing families must not silently become a smaller model input.

Implemented entry point

createFeatureComposer({index, familyDocument, targetDocument}) compiles the existing canonical 14-schema/79-family/12-target registry once. Its composeFeatureProjection(request) method is pure and synchronous. It performs no file/network/database access, formula evaluation, dynamically selected import or arbitrary callback execution. It copies inputs and returns a deeply frozen result.

Portable source/test files:
- feature-composer.mjs
- feature-composer.fixtures.mjs
- feature-composer.test.mjs

These import ../registry-contract.mjs and, for tests only, ../registry-contract.fixtures.mjs. Preserve that relative placement when installing. The separate actual-component-integration.test.mjs and its receipt read private local catalogue/evidence paths and are not part of the portable public test set.

Request contract

1. targetId and stateMode use the canonical registry. mapId is required for map targets and current-map POST/LIVE/SERIES_LIVE. SERIES_PRE may explicitly use null when no current map exists. SERIES_BETWEEN requires mapId=null and cannot carry a stale current-map identity. Series targets require seriesId. A map ID is never substituted for a series ID.
2. decisionAt, historyCutoffAt and readMode are explicit. Nanosecond comparisons preserve sub-millisecond differences. readMode is recorded or reconstructed; it is not inferred from an old timestamp.
3. definitions is the exact ordered executable-definition list validated by the registry helper. Each definition states formula/version, units, dtype, source profile, missing/time policy, producer source identity, scopes and target eligibility. Learned-state definitions retain their TRAIN/fold/cohort pins. This component does not calculate or validate learned-state contents.
4. componentSpecs bind contract, version, sourceSha256, sourceInventory (including shared dependencies), normalizationContract, sourceProfile, accepted source/history profiles, exact featureIds and familyIds. Every declared feature has exactly one component owner. Every block binds the complete semantic component-spec hash, producer metadata and exact column order.
5. componentBlocks contain the supplied values and explicit boolean missing masks. Missing means value=null and mask=true; known zero remains zero with mask=false. NaN, infinity, integer overflow and float32 overflow are rejected. No value is imputed or silently dropped. Every block binds its map/series, availableAt, history cutoff and exact input-reference IDs.
6. sourceRefs and historyRefs are immutable-address metadata (content SHA256, byte count, evidence contract/ref, source profile, target identity, availability/materialization times). History refs additionally retain original historyCutoffAt, validFrom, maximum fact availability and actual source-map IDs. Current-map history and facts beyond the original cutoff are rejected. Completed previous-series maps have their own scope and sourceSeriesId.
7. Current-live components share a single anchor state/profile/clock/receipt. Older trajectory prefixes reference that anchor and cannot be later by receipt or clock. Every component using current_live must include the anchor. Mixing unrelated current states is rejected.
8. familyImplementations explicitly declare implemented, partial, planned or unimplemented status and the exact declared definition IDs. All 79 family records remain in the output ledger, including catalogue status, eligibility, required status, missing blocks and missing values.

Required-family policy and results

The default profile is canonical-maximal.v1: every target-eligible predictive family is required. Planned/unimplemented families remain visible and incomplete. Label-only and presentation families remain visible but are never predictors. There is no inferred compact fallback.

A narrower technical profile must use an explicit aegis.diagnostic-feature-profile.v1 ID, exact family list and matching profile hash. Its excluded eligible families are marked out_of_profile and its completeness scope is explicit_diagnostic_profile. This mechanism supports bounded technical checks; it is not permission to prune features, run ablations or expose a reduced production model.

Invalid identity/time/profile/column/mask/phase contracts throw an error. A structurally valid projection with a missing or unfinished required family returns status=incomplete and vector=null. It does not return a compact vector. Complete supplied blocks may contain explicitly missing feature values; the ledger distinguishes complete_with_missing_values. status=diagnostic_complete means only that the declared technical profile is structurally complete.

Trust and admission boundary

componentSpecs, sourceRefs and familyImplementations are code-host structural declarations, not authentication or proof that the producer implemented an entire family. The pure layer cannot discover omitted columns, verify referenced bytes, establish that values were calculated from those bytes, or prove the completeness of a declared dependency inventory. Upstream adapters must bind verified raw/context bytes, canonical reviewed definitions, exact full-family inventories and source/normalizer parity. Production callers must not expose these declarations as client-controlled request fields.

For example, declaring H02 implemented with one team-form column cannot establish that all H02 features are implemented. The actual integration test deliberately declares that family partial. Outputs always state implementationCompletenessAttested=false, sourceVerification=upstream_adapter_responsibility, eligibleForTraining=false, eligibleForServing=false and recordedPrediction=false.

semanticSchemaHash covers the registry, target/mode, profile, ordered full definitions, component semantic contracts/source dependency inventory and declared family implementation inventory. It does not hash names alone. Runtime values and receipts affect contentHash without changing semanticSchemaHash. Changing a formula version, normalization contract or shared-helper pin changes the semantic hash even when the ordered names do not change.

Technical verification and actual-versus-synthetic evidence

36 portable synthetic tests pass. They exercise PRE/POST/LIVE and SERIES_LIVE postdraft routing; previous-series identity; label isolation; map/profile/source/order and stable identity-revision mismatches; one-nanosecond futures; late identity with fixed cutoff; recorded versus reconstructed materialization; missing families/masks; type bounds; immutable outputs; coherent prefixes; and semantic changes with unchanged names/wrapper.

One additional local integration test calls the actual staged observed-draft-v3 producer with synthetic pinned raw/fact inputs and loads the actual existing canonical catalogue. It extracts the real producer's team-form output 0.6, builds an immutable context reference, binds the transitive source inventory (including historyCalculationCore.mjs), and validates composition. H02 stays partial, all 79 records remain, and vector=null because the maximal profile is not implemented. This is actual source-code integration on synthetic data, not a real-match or predictive-quality result. ACTUAL-COMPONENT-INTEGRATION.json records that distinction.

Open architecture/integration items

A. Canonical state-mode eligibility is incomplete. SERIES_LIVE has observed_postdraft and observed_live modes, but the current canonical matrix gives only target-level eligible families. The maximal profile therefore retains dynamic families in observed_postdraft while the projection guard correctly forbids current_live features. Returning incomplete is intentional until the canonical registry is extended; this module does not invent exclusions.

Proposed rule for architectural review: provide an explicit canonical (targetId,stateMode) projection with vetted definition IDs and per-family scope status. In observed_postdraft, allow causally available prior_maps, current_draft, series_context and previous_series_maps; exclude current_live dependencies from that mode while preserving their inventory as unavailable_in_phase. In observed_live, additionally admit coherent current_live dependencies. PRE excludes current_draft/current_live; POST excludes current_live. candidate_axis remains specific to totals with explicit final/remaining coordinates and kills/seconds. current_map_label and presentation remain excluded everywhere. Mixed families must be resolved at executable-definition scope, not guessed from a family ID prefix. This is causal phase routing, not feature ablation. Astra must approve the canonical mapping before it replaces the current incomplete default.

B. Legitimate empty historical cohorts need a reviewed contract. Current history refs require actual nonempty sourceMapIds, and a regression rejects an empty list. The existing v3 producer also blocks an entirely absent history. A future adapter must distinguish a verified complete as-of query returning zero rows from a failed, partial or missing query, binding actual export/query receipts and selection scope. It must never invent a source-map ID or zero performance value to pass this gate. Until that contract exists, known-empty cohorts remain an explicit blocker rather than false complete history.

C. Runtime adapters and full-family definition inventories are still required. The present local integration covers one actual formula, not all H02, all C1/C2 alternatives, all 79 families or the 38,468-column Steam bundle. No aliases or new formulas were invented. Integrate verified components progressively while retaining incomplete status and the old inventories.

Next action

Install/review the portable core and tests through the parent-owned completed-block workflow. Add vetted family definitions and adapters binding actual source/context bytes. Resolve canonical state-mode eligibility and empty-cohort semantics explicitly. Only after architecture, full feature scope and technical integration are complete may the owner-approved later plan consider training or model-quality tests. No feature-first completion is claimed here.


Independent-review correction: stable identity revision

A separate reviewer reproduced a same-map gap in the initial stage: an old history roster and a new draft/live roster could both be individually valid yet share only mapId/seriesId at composition. That initial stage is superseded. The corrected request requires targetIdentity and every reference/block must bind its exact targetIdentityHash.

For POST, LIVE and both SERIES_LIVE modes, targetIdentity.mode=observed_map. The currentMapRevision contains sourceProfile, original historyCutoffAt, firstCompleteObservationId, revision number, validFromObservationId/validFrom and draftHash/rosterHash/sideIdentityHash. observedDraftTargetIdentity derives this stable envelope from a self-consistent observedDraft state. The full per-packet stateHash, last observation, receipt and clock are deliberately excluded, so unchanged packets do not invalidate a frozen history snapshot. The revision's validFrom must be no later than decisionAt and its cutoff must equal the request cutoff; history refs must also have the matching validFrom. An old context cannot be relabeled with a new hash while retaining its old validity time.

PRE and SERIES_PRE use mode=undrafted_context with a code-host contextRevisionHash and contextRevisionKnownAt, and currentMapRevision=null. This binds the vetted scheduled-team/known-roster context without inventing an observed draft. SERIES_BETWEEN uses mode=between_maps with its own context revision and requires mapId/currentMapRevision=null. Adapters must derive the context revision from reviewed team/roster/series state; an arbitrary client-supplied hash does not authenticate that state.

Runtime identity changes affect output contentHash and targetIdentityHash, not semanticSchemaHash or model weights. Source/reference availability must include any identity knowledge needed to use the feature; upstream adapters retain original raw receipt times separately rather than rewriting observations. Raw-source authentication and production admission remain upstream responsibilities, not properties created by this hash check.

Seven added technical regressions cover stale draft/roster/side hashes; a stale component with otherwise matching refs; a matching late identity; stale history validity despite copying a new hash; cutoff/future validity; PRE/between null policies; and stability across ordinary packet changes. The local actual-v3 integration derives its binding from the real producer's synthetic draft state. The independent reviewer subsequently passed seven scoped synthetic closure checks against source c1bc341268c77c2ffb4b3c19a26b7419a8d98f2e5825687a4952060964915df6. Evidence is retained privately as registry/COMPOSER-IDENTITY-CLOSURE.json and registry/INDEPENDENT-COMPOSER-REVIEW.txt. Missing targetIdentity still fails closed via TypeError; the reviewer classified the error wording as nonblocking.

