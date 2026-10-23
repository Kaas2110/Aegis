# Aegis source snapshot — 23 October 2026

This repository contains the application source and diagnostic research integration from the local Aegis project. It is not a production release, a published Android build, or an assertion that candidate models have passed independent evaluation.

The application consists of the API server, Python ML service, mobile client, shared database/schema code, provider collectors and bounded research tooling. The API and ML source lives under `artifacts/`; this directory is application source and must not be confused with generated model artifacts.

The current integration distinguishes prematch, postdraft, live map, series and totals predictions. It preserves source identity, game time and receipt time, rejects unsupported input assumptions, and keeps candidate diagnostics separate from admission to public predictions. The public mobile fallback is `Прогноз недоступен`.

## Material intentionally kept outside Git

- Provider API credentials, private environment files, database connection secrets and OS-protected credentials.
- Database backups, raw provider captures, training datasets, real-match golden fixtures, fitted model weights and previous generated web builds.
- Local runtime binaries, virtual environments, dependency directories and private job state.

The source expects these resources only where the relevant local workflow explicitly supplies them. In particular, data-dependent tests and diagnostic candidates are not expected to run from a bare clone without their separate fixture/model bundles. Synthetic unit fixtures remain in the repository.

Backups and uploaded raw archive paths were removed from this branch tip. Their historical Git/LFS objects are not purged by this change.

## Current boundaries

Some diagnostic scripts still refer to the owner's local Windows layout. They are preserved as working source, with portability work outstanding. Documentation inherited from the original Replit deployment may describe an older operational setup; it is not proof that the same services or schedules are running now.

Steam field availability and a successful diagnostic inference are not proof of timely coverage for 95% of matches. A saved postmatch event is not automatically a feature that was known during the match. Roshan countdown research does not turn an ambiguous zero into confirmed alive state. Existing guards and provenance must remain in place when reproducing or extending experiments.

Model weights and aggregate research results should be evaluated through their pinned manifests and temporal split protocols before any promotion. The source snapshot makes no accuracy guarantee.
