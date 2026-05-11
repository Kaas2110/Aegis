# Threat Model

## Project Overview

Dota Edge Analyzer is a production mobile betting-analytics app for Dota 2. The deployed production surface is an Express API in `artifacts/api-server/src` plus an Expo mobile client in `artifacts/mobile` that consumes that API. The server stores model state and analytics data in PostgreSQL and calls multiple third-party data providers (OpenDota, Stratz, PandaScore, The Odds API, plus bookmaker scraping endpoints).

Production assumptions for future scans:
- Only production-reachable code should be reported.
- `artifacts/mockup-sandbox` is dev-only and out of scope unless production reachability is demonstrated.
- TLS is handled by the platform.
- The mobile client and browser-based admin UI are untrusted clients; all enforcement must happen server-side.

## Assets

- **Admin capabilities and admin token** — the single `ADMIN_TOKEN` authorizes retraining, settings changes, metrics access, and snapshot pruning. Compromise gives operational control over the backend.
- **Application secrets** — `DATABASE_URL`, `ADMIN_TOKEN`, `ODDS_API_KEY`, `STRATZ_TOKEN`, `PANDASCORE_API_KEY`, `PINNACLE_GUEST_API_KEY`, and optional `PROXY_URL`. Leakage can expose data, incur third-party costs, or enable service abuse.
- **Model registry and analytics data** — active model weights, training metadata, prediction history, odds snapshots, live snapshots, and prematch outcomes. Integrity matters because the product's recommendations depend on them.
- **Third-party API quota and availability** — public endpoints proxy external services and can consume rate-limited or paid upstream quota.
- **Operational availability** — the API also runs background workers (live polling, scheduler, outcome tracker). Resource exhaustion can affect both user traffic and internal data freshness.

## Trust Boundaries

- **Mobile / browser to API** — all request data is attacker-controlled. Query params, JSON bodies, and headers must be validated and authorized server-side.
- **API to PostgreSQL** — the API has broad database access. Injection or unsafe bulk operations here would expose or corrupt core analytics data.
- **API to external providers** — OpenDota, Stratz, PandaScore, The Odds API, Pinnacle/bookmaker endpoints, and optional outbound proxy are outside the trust boundary. Their latency, availability, and returned data are not trustworthy.
- **Public to admin boundary** — most API routes are public, while `/api/admin/*` and `/api/analytics/retrain` rely on `X-Admin-Token`. This boundary must resist brute force, cross-origin abuse, and client-side token theft.
- **Inline admin UI to backend admin API** — `/api/admin-ui/` is public HTML/JS that stores the admin token in browser localStorage and then calls `/api/admin/*`. Any same-origin script execution issue can become admin-token compromise.
- **Internal worker to production boundary** — in-process background jobs share the same server resources and secrets as request handlers. Public request amplification that starves CPU, DB, or outbound network impacts internal jobs too.

## Scan Anchors

- **Production entry points:** `artifacts/api-server/src/app.ts`, `artifacts/api-server/src/index.ts`, `artifacts/api-server/src/routes/*.ts`
- **Highest-risk areas:** admin/auth boundary in `routes/admin.ts`, `routes/analytics.ts`, inline admin page in `routes/adminUi.ts`, upstream proxy routes in `routes/matches.ts`, `routes/odds.ts`, `routes/bookmakers.ts`, and background workers in `services/LiveWorker.ts`, `services/SchedulerWorker.ts`, `services/OutcomeTracker.ts`
- **Public surfaces:** `/api/healthz`, `/api/matches/*`, `/api/odds/*`, `/api/bookmakers/*`, `/api/analytics/*` except retrain, `/api/teams/*`, `/api/admin-ui/`
- **Admin surfaces:** `/api/admin/*`, `POST /api/analytics/retrain`
- **Usually ignore as dev-only:** `artifacts/mockup-sandbox/**`, local build scripts, and dev artifact tooling unless production reachability is shown

## Threat Categories

### Spoofing

Admin access is protected only by a static bearer-style secret in `X-Admin-Token`. The system must ensure this token is high-entropy, never exposed to untrusted clients except deliberate admin entry, and enforced on every admin-capable route. Public routes must never trust client-side role flags or mobile state.

### Tampering

The mobile client can send arbitrary request bodies to analytics endpoints. The server must validate request structure, numeric ranges, and enum-like fields before computing predictions or mutating settings. Background retraining and settings changes must remain admin-only and auditable.

### Information Disclosure

The application handles secrets, model metadata, and operational state. Responses and logs must not leak environment secrets, stack traces, or unnecessary internals. Because the admin UI stores the admin token in browser localStorage, any same-origin script injection would directly expose that token.

### Denial of Service

Several public endpoints trigger outbound fetches or database/model work. The system must rate-limit or cache expensive public routes, enforce request timeouts, and bound request sizes and work factors so attackers cannot exhaust upstream quotas, burn paid API credits, or starve the single-process server and its background jobs.

### Elevation of Privilege

Admin-only actions include retraining, pruning, and settings changes. These must be protected server-side independent of client UI. All database access must remain parameterized, and no user-controlled input should reach shell execution, filesystem access, or outbound destination selection without strict validation.