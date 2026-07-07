# Scent Australia Platform

Unified platform for Scent Australia's internal systems: **Scent Stock Manager (SA)**,
**Scented Merchandise (SM)**, and **MUSE** (coming soon) — one login, one database,
a module picker, and cross-system fragrance transfers.

> Governing documents (workspace root): `PRD.md` (execution spec), `plano.md`
> (phase plan + cutover runbook), `SYSTEMS_KNOWLEDGE.md` (legacy systems reference).
> Do not make architectural changes that contradict them.

## Status

| Phase | Description | Status |
|---|---|---|
| 0 | Foundation (scaffold, DB schemas, staging service) | ✅ done (2026-07-07) — Render deploy pending env vars |
| 1 | Platform core (auth, users, module picker) | ✅ done (2026-07-07) — verified against Neon |
| 2a | SA migration script + reconciliation | ✅ done (2026-07-08) — ALL PASS in 81s, corrupt-test FAILs correctly |
| 2b–2d | SA module port (router, frontend, regression) | — |
| 3a–3c | SM module port + hardening | — |
| 4 | Cross-system transfers | — |
| 5 | Shopify wiring | — |
| 6–8 | Rehearsal → cutover → post-cutover | — |

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
