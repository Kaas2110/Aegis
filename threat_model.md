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
- **Public to admin boundary** — most API routes are public, while `/api/admin/*` and `/api/analytics/retrain` are gated by an HttpOnly session cookie (`aegis_admin_session`) issued by `POST /api/admin/login` after a constant-time comparison against `ADMIN_TOKEN`. The legacy `X-Admin-Token` header is no longer accepted. This boundary must resist brute force (per-IP throttle on the login endpoint), cross-origin abuse (CORS allows credentialed requests only from same/explicit origins), and session-cookie theft (cookie is HttpOnly, sameSite=lax, `secure` in production).
- **Admin web client to backend admin API** — `artifacts/admin-web` is a separate React+Vite SPA served from `/admin-web/` that talks to `/api/admin/*` via the typed React Query hooks generated from `lib/api-spec/openapi.yaml`. The admin token is held only inside the HttpOnly session cookie, never in localStorage and never reachable from page JavaScript, so a same-origin script injection cannot exfiltrate the token directly. The previous inline `/api/admin-ui/` page (which stored the token in localStorage) has been removed.
- **Internal worker to production boundary** — in-process background jobs share the same server resources and secrets as request handlers. Public request amplification that starves CPU, DB, or outbound network impacts internal jobs too.

## Scan Anchors

- **Production entry points:** `artifacts/api-server/src/app.ts`, `artifacts/api-server/src/index.ts`, `artifacts/api-server/src/routes/*.ts`
- **Highest-risk areas:** admin/auth boundary in `routes/admin.ts`, `routes/adminAuth.ts`, `routes/analytics.ts`, upstream proxy routes in `routes/matches.ts`, `routes/odds.ts`, `routes/bookmakers.ts`, and background workers in `services/LiveWorker.ts`, `services/SchedulerWorker.ts`, `services/OutcomeTracker.ts`
- **Public surfaces:** `/api/healthz`, `/api/matches/*`, `/api/odds/*`, `/api/bookmakers/*`, `/api/analytics/*` except retrain, `/api/teams/*`, `POST /api/admin/login`, `POST /api/admin/logout`, `GET /api/admin/whoami`
- **Admin surfaces:** `/api/admin/*` except the auth endpoints above, `POST /api/analytics/retrain`. The admin web client lives at `/admin-web/` (artifact `admin-web`) and is otherwise just static SPA assets — it carries no privileged behavior on its own.
- **Usually ignore as dev-only:** `artifacts/mockup-sandbox/**`, local build scripts, and dev artifact tooling unless production reachability is shown

## Threat Categories

### Spoofing

Admin access is protected only by a static bearer-style secret in `X-Admin-Token`. The system must ensure this token is high-entropy, never exposed to untrusted clients except deliberate admin entry, and enforced on every admin-capable route. Public routes must never trust client-side role flags or mobile state.

### Tampering

The mobile client can send arbitrary request bodies to analytics endpoints. The server must validate request structure, numeric ranges, and enum-like fields before computing predictions or mutating settings. Background retraining and settings changes must remain admin-only and auditable.

### Information Disclosure

The application handles secrets, model metadata, and operational state. Responses and logs must not leak environment secrets, stack traces, or unnecessary internals. The admin token lives only inside the HttpOnly session cookie (never in localStorage), so same-origin script injection cannot read it directly, but XSS could still ride the cookie to perform admin actions — the admin SPA must remain free of injection sinks.

### Denial of Service

Several public endpoints trigger outbound fetches or database/model work. The system must rate-limit or cache expensive public routes, enforce request timeouts, and bound request sizes and work factors so attackers cannot exhaust upstream quotas, burn paid API credits, or starve the single-process server and its background jobs.

### Elevation of Privilege

Admin-only actions include retraining, pruning, and settings changes. These must be protected server-side independent of client UI. All database access must remain parameterized, and no user-controlled input should reach shell execution, filesystem access, or outbound destination selection without strict validation.