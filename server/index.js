process.env.TZ = 'Australia/Sydney';

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { isDbConfigured, platformPool } from './db.js';
import { runPlatformMigrations } from './platform/migrations.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

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

// ── Module routers (mounted as phases land) ──────────────────────────────
// Phase 1: app.use('/api/platform', platformRouter)
// Phase 2: app.use('/api/sa', requireAuth, requireModule('SA'), saRouter)
// Phase 3: app.use('/api/sm', requireAuth, requireModule('SM'), smRouter)
// Phase 5: app.post('/api/webhook/shopify/:store', webhookReceiver)

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
