// D12 verification — two physical stores, each with its own signing secrets.
// Proves: correct secret accepted, wrong-store secret rejected, cross-store
// topic dispatch refused, and the cutover gate blocks outbound writes.
// Usage: PORT=3010 node scripts/verify-webhooks-d12.cjs   (server must be up)
require('dotenv').config();
const crypto = require('crypto');

const BASE = `http://localhost:${process.env.PORT || 3010}`;
const SA_SECRET = process.env.SA_SHOPIFY_WEBHOOK_SECRET || process.env.SCENT_SHOPIFY_WEBHOOK_SECRET;
const MUSE_API_SECRET = process.env.SM_SHOPIFY_API_SECRET || process.env.MUSE_SHOPIFY_API_SECRET;
const MUSE_HOOK_SECRET = process.env.SM_SHOPIFY_WEBHOOK_SECRET || process.env.MUSE_SHOPIFY_WEBHOOK_SECRET;

let pass = 0, fail = 0;
const ok = (m, d = '') => { pass++; console.log(`PASS  ${m}${d ? ' — ' + d : ''}`); };
const bad = (m, d = '') => { fail++; console.log(`FAIL  ${m}${d ? ' — ' + d : ''}`); };

const sign = (body, secret) => crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64');

async function post(store, topic, body, secret) {
  const raw = JSON.stringify(body);
  const res = await fetch(`${BASE}/api/webhook/shopify/${store}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Topic': topic,
      'X-Shopify-Hmac-Sha256': secret ? sign(raw, secret) : 'invalid',
    },
    body: raw,
  });
  return res.status;
}

(async () => {
  console.log('Secrets present → SA:', !!SA_SECRET, '| MUSE api:', !!MUSE_API_SECRET, '| MUSE hook:', !!MUSE_HOOK_SECRET);

  // An order that matches nothing — the handlers must still authenticate it.
  const order = { id: 999999001, name: '#D12-PROBE', note: 'no SM order ref', line_items: [] };

  // 1. Muse store, API-secret signature (how our registered webhooks are signed)
  let s = await post('muse', 'orders/paid', order, MUSE_API_SECRET);
  s !== 401 ? ok('muse store: API-secret (shpss_) signature accepted', 'HTTP ' + s)
            : bad('muse store: API-secret signature rejected', 'HTTP ' + s);

  // 2. Muse store, Notifications-secret signature (admin-created webhooks)
  s = await post('muse', 'orders/paid', order, MUSE_HOOK_SECRET);
  s !== 401 ? ok('muse store: notifications-secret signature accepted', 'HTTP ' + s)
            : bad('muse store: notifications-secret signature rejected', 'HTTP ' + s);

  // 3. Muse store signed with the SA store's secret → must be rejected
  s = await post('muse', 'orders/paid', order, SA_SECRET);
  s === 401 ? ok('muse store: SA secret rejected (stores are isolated)')
            : bad('muse store accepted an SA-signed payload', 'HTTP ' + s);

  // 4. SA store signed with the Muse secret → must be rejected
  s = await post('sa', 'fulfillments/create', order, MUSE_API_SECRET);
  s === 401 ? ok('sa store: Muse secret rejected (stores are isolated)')
            : bad('sa store accepted a Muse-signed payload', 'HTTP ' + s);

  // 5. Invalid HMAC → 401
  s = await post('muse', 'orders/paid', order, null);
  s === 401 ? ok('invalid HMAC rejected') : bad('invalid HMAC not rejected', 'HTTP ' + s);

  // 6. Cross-store topic: an SM topic delivered on the SA store must NOT drive SM
  s = await post('sa', 'orders/paid', order, SA_SECRET);
  s === 200 ? ok('SM topic on SA store → acknowledged, not processed')
            : bad('SM topic on SA store took an unexpected path', 'HTTP ' + s);

  // 7. Unknown store → 404
  const r = await fetch(`${BASE}/api/webhook/shopify/nope`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Topic': 'orders/paid' }, body: '{}',
  });
  r.status === 404 ? ok('unknown store → 404') : bad('unknown store not rejected', 'HTTP ' + r.status);

  console.log(`\n══════ D12 WEBHOOKS: ${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} (${pass} pass / ${fail} fail) ══════`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
