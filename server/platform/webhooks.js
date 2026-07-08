import crypto from 'crypto';
import { saWebhookHandler } from '../sa/index.js';
import smModule from '../sm/index.cjs';
const { smWebhookHandler } = smModule;

// ═══════════════════════════════════════════════════════════════════════
// Platform webhook receiver — PRD §10 (FR-HOOK-2..6)
//
//   POST /api/webhook/shopify/:store
//
// Phase 1 topology (OD1): ONE physical store (the SA store) serves both
// consumers; registrations point at :store='sa' and dispatch is by topic.
// A future dedicated SM/MUSE store plugs in via its own :store key + secret.
//
// The platform mounts express.raw() on /api/webhook, so req.body arrives as
// a Buffer: HMAC is verified on the exact raw bytes, then the body is parsed
// and handed to the module handler (which also reads req.rawBody).
// ═══════════════════════════════════════════════════════════════════════

// A single physical store can sign with TWO different keys:
//   - admin-created webhooks (SA's fulfillments/*) sign with the
//     Notifications-page secret
//   - API-registered webhooks (SM's orders/*) sign with the custom app's
//     API SECRET KEY (shpss_...) — the trap the old Muse repo hit too
// The receiver therefore accepts a LIST of candidate secrets per store.
const STORE_SECRETS = {
  sa: () => [
    process.env.SA_SHOPIFY_WEBHOOK_SECRET || process.env.SCENT_SHOPIFY_WEBHOOK_SECRET, // manual/admin webhooks
    process.env.SA_SHOPIFY_API_SECRET || process.env.SHOPIFY_API_SECRET,               // API-registered webhooks
  ].filter(Boolean),
  sm: () => [
    process.env.SM_SHOPIFY_WEBHOOK_SECRET,
    process.env.SA_SHOPIFY_WEBHOOK_SECRET || process.env.SCENT_SHOPIFY_WEBHOOK_SECRET, // phase 1: same physical store
    process.env.SA_SHOPIFY_API_SECRET || process.env.SHOPIFY_API_SECRET,
  ].filter(Boolean),
};

// Topics → module. SA and SM topic sets are disjoint by design (guardrails:
// orders/fulfilled is NEVER processed; SM draft orders carry no SKUs).
const SA_TOPICS = new Set(['fulfillments/create', 'fulfillments/update', 'orders/fulfilled', 'orders/create']);
const SM_TOPICS = new Set(['orders/paid', 'orders/cancelled']);

export async function shopifyWebhookReceiver(req, res) {
  const store = String(req.params.store || '').toLowerCase();
  const topic = req.headers['x-shopify-topic'] || 'unknown';

  const secretFn = STORE_SECRETS[store];
  if (!secretFn) return res.status(404).json({ error: 'Unknown store' });

  const secrets = secretFn();
  if (secrets.length === 0) {
    if (process.env.NODE_ENV === 'production') {
      console.error(`[webhook] No webhook secret configured for store "${store}" — rejecting`);
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }
    console.warn(`[webhook] No secret for store "${store}" — dev mode, skipping HMAC`);
  }

  // ── HMAC on the raw bytes (FR-HOOK-6) — any candidate secret may match ──
  const rawBody = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));

  if (secrets.length > 0) {
    const hmacHeader = req.headers['x-shopify-hmac-sha256'];
    if (!hmacHeader) return res.status(401).json({ error: 'Missing webhook signature' });
    const received = Buffer.from(hmacHeader);
    const matched = secrets.some((secret) => {
      const digest = Buffer.from(crypto.createHmac('sha256', secret).update(rawBody).digest('base64'));
      return digest.length === received.length && crypto.timingSafeEqual(digest, received);
    });
    if (!matched) {
      console.warn(`[webhook] HMAC mismatch — store=${store} topic=${topic}`);
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
    // Module handlers may skip their internal recheck — receiver is authoritative.
    req.hmacVerified = true;
  }

  // ── Parse + hand off with SA-handler expectations intact ───────────────
  let parsed;
  try {
    parsed = JSON.parse(rawBody.toString('utf8') || '{}');
  } catch {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }
  req.body = parsed;
  req.rawBody = rawBody;

  if (SA_TOPICS.has(topic)) {
    // saWebhookHandler re-verifies HMAC under its legacy env name
    // (SHOPIFY_WEBHOOK_SECRET, aliased at boot) — harmless double check on
    // the same bytes with the same secret.
    return saWebhookHandler(req, res);
  }

  if (SM_TOPICS.has(topic)) {
    // SM handler re-verifies HMAC on req.rawBody with the same aliased
    // secret (harmless double check), then matches by 'SM Order: SM-###'.
    return smWebhookHandler(req, res);
  }

  console.log(`[webhook] Unhandled topic ${topic} — acknowledged`);
  return res.status(200).json({ received: true, skipped: 'unhandled_topic' });
}
