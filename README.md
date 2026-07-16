# Scent Australia Platform

Unified platform for Scent Australia's internal systems: **Scent Stock Manager (SA)**,
**Scented Merchandise (SM)**, **MUSE**, and **Production & Operations** — one login,
one database, a module picker, and a shared **Fragrance Library** (oil pool) that
SA, SM and MUSE all draw from.

> Governing documents (workspace root): `PRD.md` (execution spec), `plano.md`
> (phase plan + cutover runbook), `SYSTEMS_KNOWLEDGE.md` (legacy systems reference).
> Do not make architectural changes that contradict them.

## Status

**LIVE in production since 2026-07-14.** SA has run without incident since cutover;
the platform now serves SA, SM (Scented Merchandise B2B), MUSE, and Production &
Operations from one login.

| Phase | Description | Status |
|---|---|---|
| 0 | Foundation (scaffold, DB schemas, staging service) | ✅ done (2026-07-07) |
| 1 | Platform core (auth, users, module picker) | ✅ done (2026-07-07) |
| 2a–2d | SA migration + monolith→router + frontend + webhook/regression | ✅ done (2026-07-08) — 25/25 green |
| 3a–3c | SM mount/auth + hardening + frontend/flow | ✅ done (2026-07-09) — 20/20 green |
| 4 | Cross-system transfers (links, 2-step, CHECK migration) | ✅ done (2026-07-09) — 17/17 green |
| 5 | Shopify wiring (two stores — D12) | ✅ done (2026-07-14) — webhook gate 7/7 |
| 6–7 | Rehearsal → cutover | ✅ done (2026-07-14) — cutover gate 9/9, went live |
| 8 | Post-cutover freeze / old-service decommission | ⏳ in freeze window |

## Post-cutover decisions (D9–D15)

Logged in full in `PRD.md` refinement log. Summary:

| # | Decision | Status |
|---|---|---|
| D9 | One design system — SM adopts SA's tokens/theme | ✅ shipped |
| D10 | SA oil → many SM fragrance aliases (link model) | ✅ shipped (retired for oils by D14) |
| D11 | "Production & Operations" tile (a 3rd view over SM) | ✅ shipped |
| D12 | TWO Shopify stores — Scent = SA · Muse = MUSE + SM | ✅ shipped |
| D13 | MUSE retail: finished-good stock leaves on shipment, returns on cancel | ✅ shipped |
| D14 | **Fragrance Library** — SM/MUSE production consumes oil directly from `sa.products` (OILS); no more transfer/link for oils; 4-bucket usage traceability | ✅ shipped |
| D15 | Fragrance Library facilitation — home tile → SA oils, oil exclusivity field, cross-company oil-usage Excel export | ✅ shipped |
| D14.9 | SM/MUSE catalog reset onto the D14 oil model (preserving live Shopify SKUs) | 🔜 planned |

**Regression suites** (run against a local server): `scripts/regression-sa.js` (25),
`regression-sm.js` (20), `regression-transfers.js` (17), `integrity-sm.cjs` (27),
`regression-fragrance-library.cjs` (13) + `-e2e.cjs` (10) + `-naming.cjs` (5),
`regression-muse-fulfillment.cjs` (9), `verify-cutover.cjs`, `verify-webhooks-d12.cjs`.

## Architecture (short version)

- **One Express server (ESM)** — `/api/platform/*` (auth, users, transfers),
  `/api/sa/*` (SA monolith as router, schema `sa`), `/api/sm/*` (SM routers —
  CommonJS isolated via local `package.json`, schema `sm`),
  `/api/webhook/shopify/:store` (HMAC + topic dispatch).
- **One Neon project, three schemas** — `platform` / `sa` / `sm`; per-module
  pools with `search_path` so legacy query text runs unchanged.
- **One React app** — shell (login → module picker) + `/sa/*` + `/sm/*` pages.

## Development

```bash
npm install
cp .env.example .env     # fill PLATFORM_DATABASE_URL at minimum
npm run dev              # server :3000 + vite :5173
```

Without `PLATFORM_DATABASE_URL` the server still boots (dev only) and
`/api/health` reports `db: false`. In production a missing URL is fatal.

## Deployment

Render web service via `render.yaml` (staging until cutover). Health check:
`/api/health`.

## Hard rules

The 10 guardrails in `PRD.md` §13 are non-negotiable — each one encodes a
production incident that was already fixed once. Read them before touching
stock, webhooks, auth, or the SPA catch-all.
