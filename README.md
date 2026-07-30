# Scent Australia Platform

Unified platform for Scent Australia's internal systems: **Scent Stock Manager (SA)**,
**Scented Merchandise (SM)**, **MUSE**, and **Production & Operations** — one login,
one database, a module picker, and a shared **Fragrance Library** (oil pool) that
SA, SM and MUSE all draw from.

> **Governing document: `MASTER_PLAN.md` at the workspace root — the single source of
> truth.** Read it first: it carries current state, the roadmap, open decisions and the
> verified findings behind them. The older planning docs (`PRD.md`, `plano.md`,
> `planejamentoQA.md`, `D14_*`, `D15_*`, `D14.9_*`) were consolidated into it on
> 2026-07-28 and now live in `_archive/` — useful history, not current instructions.
> `SYSTEMS_KNOWLEDGE.md` (legacy systems reference) stays at the root.

## Two facts that shape everything

1. **Only SA is production.** It runs the real business — real Shopify sales arrive by
   webhook daily against real stock. **MUSE and Scented Merchandise are still in
   development**; data registered there is test/construction data. Every script treats
   `sa` as sacred: read-only where possible, and never modified as a side effect.
2. **Timestamps are stored UTC** in `timestamp without time zone` columns, with the DB
   session in GMT. The app handles this (`server/db.js` sets
   `types.setTypeParser(1114, v => new Date(v + 'Z'))`), so screens and exports show
   correct Sydney time — but **any throwaway script must replicate that parser**, or raw
   UTC prints as if it were local and times look ~10 h off.

## Status

**LIVE in production since 2026-07-14.** SA has run without incident since cutover; the
platform serves SA, SM (B2B), MUSE and Production & Operations from one login.

The 8-phase unification (foundation → auth/picker → SA port → SM port → transfers →
Shopify → rehearsal → cutover) is complete. See `MASTER_PLAN.md` for the detailed history.

## Decisions after cutover (D9–D16)

| # | Decision | Status |
|---|---|---|
| D9 | One design system — SM adopts SA's tokens/theme | ✅ shipped |
| D10 | SA oil → many SM fragrance aliases (link model) | ⛔ superseded by D14 |
| D11 | "Production & Operations" tile (a 3rd view over SM) | ✅ shipped |
| D12 | TWO Shopify stores — Scent = SA · Muse = MUSE + SM | ✅ shipped |
| D13 | MUSE retail: finished-good stock leaves on shipment, returns on cancel | ✅ shipped |
| D14 | **Fragrance Library** — SM/MUSE production consumes oil directly from `sa.products` (OILS); 4-bucket usage traceability | ✅ shipped |
| D15 | Fragrance Library facilitation — home tile, oil exclusivity, cross-company oil-usage Excel export | ✅ shipped |
| D16 | MUSE make-to-order + hybrid finished-goods stock | ✅ shipped |
| D14.9 | SM/MUSE catalog re-key onto the oil model | ✅ **executed on production 2026-07-28** |
| — | **Phase B** — every MUSE/SM screen reads the oil (one universal SA code); legacy `FRAG_*` catalog archived | ✅ done 2026-07-29 |
| — | Centralised **History & Activity** (cross-system report + CSV export) | ✅ shipped |
| — | Dedicated **Fragrance Library page** — the only place oil is created/edited | ✅ shipped 2026-07-30 |

## Architecture (short version)

- **One Express server (ESM)** — `/api/platform/*` (auth, users, cross-system
  History & Activity reports), `/api/sa/*` (SA monolith mounted as a router, schema
  `sa`), `/api/sm/*` (SM routers — CommonJS, isolated via a local `package.json`,
  schema `sm`), `/api/webhook/shopify/:store` (HMAC + topic dispatch).
- **One Neon project, three schemas** — `platform` / `sa` / `sm`; one pool per module
  with its own `search_path`, so legacy query text runs unchanged.
- **One React app** — shell (login → module picker) + `/sa/*` + `/sm/*` pages. MUSE,
  Scented Merchandise and Production & Operations are three *views* over the same SM
  module, selected by the active tile.
- **Oil is the only shared resource.** `sa.products` category `OILS` is the single
  source of truth; SM/MUSE production debits it directly under a row lock, writing an
  audited `sa.transactions` row tagged with the consuming business. Everything else
  (components, packaging, labels) is per-business.

## Verification scripts (`scripts/`)

Run against a live DB; most need `PLATFORM_DATABASE_URL`. Counts intentionally not
listed here — they drift; run the script for the current number.

| Script | Purpose |
|---|---|
| `regression-sa.js` | SA module regression |
| `regression-sm.js` | SM module regression |
| `integrity-sm.cjs` | Cross-table invariants (the broadest safety net — run it after ANY data change) |
| `regression-fragrance-library*.cjs` | D14 oil model: core, e2e, naming, ready-formula |
| `regression-muse-fulfillment.cjs` | D13 retail fulfilment |
| `regression-d16-makeorder.cjs` | D16 make-to-order + hybrid stock |
| `regression-status-machine.cjs` · `regression-order-status-axes.cjs` | Production-order status transitions |
| `regression-d14-9-reset.cjs` | Asserts the D14.9 catalog re-key held |
| `regression-lightmode-safetynet.cjs` | Guards the light-mode CSS source-order invariant |
| `verify-cutover.cjs` · `verify-webhooks-d12.cjs` | Cutover + Shopify webhook checks |

**Data-changing scripts** (all refuse to run without an explicit env var, default to a
dry run, and require `--commit` to apply): `reset-d14-9.cjs`,
`archive-legacy-fragrances.cjs`, `cleanup-sm-test-data.cjs`.

## Development

```bash
npm install
cp .env.example .env     # fill PLATFORM_DATABASE_URL at minimum
npm run dev              # server :3000 + vite :5173
```

Without `PLATFORM_DATABASE_URL` the server still boots (dev only) and `/api/health`
reports `db: false`. In production a missing URL is fatal.

## Deployment

Render web service via `render.yaml`. Health check: `/api/health`.

## Hard rules

The guardrails in `_archive/PRD.md` §13 are non-negotiable — each one encodes a
production incident that was already fixed once. Read them before touching stock,
webhooks, auth, or the SPA catch-all. Two habits this project runs on, both of which
repeatedly paid off:

- **Investigate before building.** More than once the planned work turned out to be
  unnecessary (the feature already existed) or actively wrong (it would have shifted
  live behaviour). Measure first.
- **Prove it, don't assume it.** Filename/heuristic scans are a starting point, never
  proof: a never-mounted destructive DB-reset endpoint was missed by an automated dead-code
  scan and only found by auditing routes by hand. Verify every candidate individually.
