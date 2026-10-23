AEGIS PUBLIC SOURCE PARITY CHECKER — v1

Purpose
Compare public application files in the current local working tree with the exact
Git blob bytes of a locally available, immutable reference commit. The app's HEAD
may differ from that commit; current working files are what this tool compares.
It never fetches, checks out, rewrites source, changes branches, contacts providers,
starts training, or creates/merges a pull request. Only the evidence JSON is written.

Requirements
Python 3.9 or later; Git on PATH; reference commit already available in a trusted
local Git object database. No third-party Python modules. Run from the normal
repository owner account. If Git rejects a directory as unsafe, confirm the exact
repository ownership separately; this tool never disables Git's ownership checks.
Git must support the explicit --no-lazy-fetch option (validated here with Git
2.53.0). Older unsupported Git fails closed; it must not silently fetch objects.

Usage (replace placeholders; evidence must be outside both source directories)
python -B scripts/source-parity/check_source_parity.py \
  --app-root /path/to/current/app \
  --reference-repo /path/to/reference/checkout \
  --ref FULL_40_CHARACTER_COMMIT_SHA \
  --output /path/outside/repositories/source-parity.json

Tests (synthetic Git repositories in the OS temporary directory; no network)
python -B scripts/source-parity/test_source_parity.py

Exit status
0 = all included files are byte-identical and no listed safety finding exists.
1 = an included file differs/is missing, an included source changed during the
    check, or the reference violates the public source policy. Evidence is saved.
2 = audit could not be completed; a controlled error code is printed. A partial
    scan is never reported as parity. Existing evidence is not overwritten on 2.

Interpretation
byteParity is the strict gate. lfCanonicalParity also accepts CRLF versus LF only,
but does not turn a strict failure into a success. Different EOF newlines remain a
content mismatch. No whitespace, comments, formatting or code are normalized.
The report records immutable commit/tree IDs, the policy SHA256, per-file hashes,
sizes and statuses. Source contents and credential values are not printed.
Byte equality says nothing about model quality, dependency reproducibility,
whether a public release is authorized, or whether the app is running that code.

Scope and exclusions
Local candidates are Git-tracked plus nonignored working files, filtered by the
explicit versioned source-policy.json. All reference tree blobs are considered;
forbidden reference paths fail even if the local copy would be excluded.
The policy excludes environments/secrets, databases/dumps, archives, logs, cached
responses, numerical model assets, true data fixtures, generated builds and local
dependencies. It includes canonical source, public templates, schemas, configs,
tests and documentation. A tree-weight content signature catches one common
renamed model format, but is not a complete model-format detector.

Generated Android and iOS directories are excluded: Expo config, plugins and
package lockfiles are canonical public source. Native regeneration/build parity
requires a separate clean build. Keystores, local.properties and machine paths
must never be copied merely to make whole-folder bytes equal. Runtime wrappers
outside APP require their own future portable source contract.

Ignored roots are listed without reading their payloads. This boundary means a
new useful source file hidden by .gitignore needs explicit review; this checker
does not promise that every ignored path is generated or unnecessary. Maintain the
policy and Git ignore rules through reviewed source changes. Do not solve a
mismatch by broadly excluding the affected directory. Keep reference inventories
and any explicitly approved exclusions in the same logical change/PR evidence.

Safety and consistency
Reads are bounded by file count, individual size and total size. Reference blobs
use two Git batch reads after validating declared sizes. Symlink/gitlink entries,
path escapes, case collisions and unsafe path strings fail. Local included files
and the source inventory are checked again before accepting parity. This is a
bounded consistency check, not an OS snapshot that locks all writers.
Git replacement objects and lazy fetching of partial-clone objects are explicitly
disabled. Missing objects fail the audit; replace refs cannot substitute different
contents under the reported immutable commit ID.
Credential scans are heuristic. They detect selected token/private-key patterns;
zero findings do not certify that no secret ever existed, nor audit Git history.
Perform a separately reviewed staged-content scan before public publication.
Known public dummy credential examples are listed explicitly in the policy by
path, finding rule and SHA256 of the entire reviewed file. Any byte change removes
that exception until re-reviewed. Words such as "test" or "password" never grant a
broad exception. The evidence lists the exact reviewed examples it encountered.
Encoded/obfuscated secrets and arbitrary renamed numerical asset formats remain
outside reliable heuristic detection; byte parity alone is not a publish approval.

Suggested continuing PR workflow (not automated by this scaffold)
1. Record the logical change, touched source files and completed validation.
2. Prepare an isolated public source snapshot and review exclusions/secret scan.
3. Create or update its PR only when authorized; record the resulting commit.
4. Compare the local public source with that exact commit using this checker.
5. Explain every mismatch; align public source only after reviewing before/target
   hashes. Preserve private runtime files and existing local data.
6. After an authorized merge, pin the merged commit and repeat the check. Keep the
   report beside the handoff; do not mistake graph indexing for source parity.

Current delivery status
Source is provided for the reviewed PR workflow. No automatic schedule, CI
job, application installation, PR publication or merge is enabled by this file.
