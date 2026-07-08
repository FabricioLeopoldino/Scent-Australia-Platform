process.env.TZ = 'Australia/Sydney';

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { isDbConfigured, platformPool } from './db.js';
import { runPlatformMigrations } from './platform/migrations.js';
import { requireAuth, requireModule } from './platform/auth.js';
import platformRouter from './platform/router.js';
import { router as saRouter, runSaStartupMigrations } from './sa/index.js';
import { shopifyWebhookReceiver } from './platform/webhooks.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// ── Env aliases for the SA module (legacy names) ─────────────────────────
// ONLY the webhook secret is aliased: the SA handler re-verifies HMAC under
// its legacy name (harmless — same bytes, same secret). Outbound Shopify
// creds (SHOPIFY_ACCESS_TOKEN / STORE_NAME / SYNC_ENABLED) are deliberately
// NOT aliased until Phase 5 so no test or staging run can write to the
// production Shopify store.
process.env.SHOPIFY_WEBHOOK_SECRET =
  process.env.SHOPIFY_WEBHOOK_SECRET ||
  process.env.SA_SHOPIFY_WEBHOOK_SECRET ||
  process.env.SCENT_SHOPIFY_WEBHOOK_SECRET ||
  '';

// Trust Render's load balancer so express-rate-limit reads the real client IP
app.set('trust proxy', 1);

// ── Global process error handlers (NFR-7) ────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[fatal] Uncaught exception — server will restart:', err);
  process.exit(1); // Render auto-restarts on exit
});
process.on('unhandledRejection', (reason) => {
  // Never exit here — Neon idle-connection drops surface as transient
  // rejections that the pool recovers from automatically.
  console.error('[warn] Unhandled promise rejection (non-fatal):', reason);
});

// ── CORS ──────────────────────────────────────────────────────────────────
const corsOptions = {
  origin: IS_PRODUCTION
    ? (process.env.ALLOWED_ORIGIN
        ? process.env.ALLOWED_ORIGIN.split(',').map((o) => o.trim())
        : false)
    : ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  maxAge: 600,
};
app.use(cors(corsOptions));

// ── Body parsing ──────────────────────────────────────────────────────────
// Webhook paths must keep the raw body for HMAC verification (FR-HOOK-6):
// raw parser is scoped to /api/webhook BEFORE the global JSON parser.
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(
  express.json({
    limit: '50mb',
    verify: (req, _res, buf) => {
      if (req.path.startsWith('/api/webhook')) req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ── Health check ──────────────────────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  if (!isDbConfigured()) {
    return res.json({
      status: 'ok',
      message: 'Service active (database not configured yet)',
      db: false,
      ts: new Date().toISOString(),
    });
  }
  try {
    const r = await platformPool.query('SELECT NOW() AS now, current_database() AS db');
    res.json({ status: 'ok', db: r.rows[0].db, ts: r.rows[0].now });
  } catch (e) {
    console.error('[health] DB check failed:', e.message);
    res.status(503).json({ status: 'error', error: 'Database unreachable' });
  }
});

// ── Auth gate (FR-AUTH-5): all /api/* except login, webhooks, health ─────
const PUBLIC_API_PATHS = ['/platform/auth/login', '/health'];
app.use('/api', (req, res, next) => {
  if (PUBLIC_API_PATHS.includes(req.path) || req.path.startsWith('/webhook/')) return next();
  requireAuth(req, res, next);
});

// ── Module routers ────────────────────────────────────────────────────────
app.use('/api/platform', platformRouter);

// SA module — the production monolith mounted as a router (Phase 2b,
// Appendix A conversion; SQL/business logic untouched, schema sa).
app.use('/api/sa', requireModule('SA'), saRouter);

// SA legacy uploads (multer, disk) served at platform level
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// SM stub — replaced by the real routers in Phase 3a.
app.use('/api/sm', requireModule('SM'), (_req, res) =>
  res.status(501).json({ error: 'SM module not yet mounted (Phase 3)' })
);

// Webhook receiver (PRD §10) — public, HMAC-authed; raw body preserved by
// the express.raw mount above. Registered in Shopify only at cutover.
app.post('/api/webhook/shopify/:store', shopifyWebhookReceiver);

// ── Static frontend + SPA catch-all ──────────────────────────────────────
if (IS_PRODUCTION) {
  app.use(express.static(path.join(__dirname, '../dist')));
  // GUARDRAIL #6: the catch-all MUST pass API/upload paths through, otherwise
  // any route registered after it silently hangs (fixed SA incident).
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
    res.sendFile(path.join(__dirname, '../dist/index.html'));
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────
async function start() {
  if (isDbConfigured()) {
    await runPlatformMigrations();
    // SA inline migrations (idempotent, no-ops on migrated data) — run on the
    // sa pool so unqualified DDL resolves to schema sa.
    await runSaStartupMigrations();
  } else if (IS_PRODUCTION) {
    console.error('[fatal] PLATFORM_DATABASE_URL is required in production.');
    process.exit(1);
  } else {
    console.warn('[boot] PLATFORM_DATABASE_URL not set — skipping migrations (dev only).');
  }

  app.listen(PORT, () => {
    console.log(`[platform] Scent Australia Platform server running on port ${PORT}`);
  });
}

start().catch((e) => {
  console.error('[fatal] Boot failed:', e);
  process.exit(1);
});
