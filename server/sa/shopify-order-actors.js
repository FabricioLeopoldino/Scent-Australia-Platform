// Who placed each Shopify order — the cache demand planning reads to tell a
// customer's purchase from a technician's refill.
//
// WHY THIS IS A READ AND NOT A WEBHOOK FIELD (2026-10-12). The stock is debited
// from `fulfillments/create`, and that payload carries no customer at all
// (checked on #38382, #38692, #38821). So the person can only come from asking
// the store, and that is what this does — on a timer, never per page load.
//
// Writes ONLY to `shopify_order_actor`. Whether a person is internal is NOT
// decided here: the demand query joins against `demand_internal_actors` at read
// time, so a technician added or corrected on that list reaches every past
// order at once, with nothing to re-run. `is_internal` is stored only so the
// table reads sensibly on its own.

const API = '2026-04';

// How far back technician refills are compared with the contract: the
// forecast's own horizon. One constant, shared with the demand query, so the
// cache and the window it must cover cannot drift apart.
export const TECH_REFILL_DAYS = 120;

// Orders created after `sinceISO` (YYYY-MM-DD), newest first. Refuses rather
// than truncates: a short read leaves real technician orders unclassified,
// which silently puts them back into demand.
export async function readOrderCustomers(sinceISO, maxPages = 40) {
  const shop = process.env.SA_SHOPIFY_SHOP_DOMAIN || process.env.SA_SHOPIFY_STORE_NAME;
  const token = process.env.SA_SHOPIFY_ACCESS_TOKEN;
  if (!shop || !token) throw new Error('Shopify credentials are not configured');
  const host = shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`;
  // One page, retried while Shopify says it is throttled. The read is all or
  // nothing (recordOrderActors writes in one statement), so one throttled page
  // out of ten would otherwise discard the whole run — every hour (code review).
  const page = async (q) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`https://${host}/admin/api/${API}/graphql.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q }),
        signal: AbortSignal.timeout(30000),
      });
      const throttled = res.status === 429;
      const body = throttled ? null : await res.json().catch(() => null);
      if (throttled || body?.errors?.some((e) => e.extensions?.code === 'THROTTLED')) {
        if (attempt >= 5) throw new Error('Shopify kept throttling the order read');
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      if (!res.ok || !body) throw new Error(`Shopify answered ${res.status} on the order read`);
      if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join(' | '));
      return body.data.orders;
    }
  };
  const out = [];
  let after = null;
  for (let p = 0; p < maxPages; p++) {
    const conn = await page(`{ orders(first: 250, reverse: true, sortKey: CREATED_AT,
                   query: "created_at:>${sinceISO}"${after ? `, after: "${after}"` : ''}) {
        pageInfo { hasNextPage endCursor }
        nodes { name createdAt tags customer { displayName } } } }`);
    out.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) return out;
    after = conn.pageInfo.endCursor;
  }
  throw new Error('More orders than this can page through. Raise the limit.');
}

// One statement, so a failure records nothing rather than half the orders.
// Re-runnable: an order already recorded is refreshed.
export async function recordOrderActors(pool, orders) {
  if (orders.length === 0) return 0;
  const r = await pool.query(
    `INSERT INTO shopify_order_actor (order_number, customer_name, tags, is_internal, ordered_at)
     SELECT o.n, o.c, o.t,
            EXISTS (SELECT 1 FROM demand_internal_actors a
                     WHERE lower(btrim(a.customer_name)) = lower(btrim(o.c))),
            o.at
       FROM UNNEST($1::text[], $2::text[], $3::text[], $4::timestamptz[]) AS o(n, c, t, at)
     ON CONFLICT (order_number) DO UPDATE
       SET customer_name = EXCLUDED.customer_name, tags = EXCLUDED.tags,
           is_internal = EXCLUDED.is_internal, seen_at = NOW()`,
    [orders.map((o) => o.name),
     orders.map((o) => o.customer?.displayName || null),
     orders.map((o) => (o.tags || []).join(', ') || null),
     orders.map((o) => o.createdAt)]);
  return r.rowCount;
}

// The timer's unit of work: everything since two days before the newest order
// already recorded (an order's customer can still be fixed after it is placed).
// Demand compares the contract with TECH_REFILL_DAYS of technician refills, so
// when the table does not yet reach back that far — empty, or filled when the
// window was 30 days — it reads the whole window plus five days once, and is
// incremental after.
export async function refreshOrderActors(pool) {
  const { since } = (await pool.query(
    `SELECT to_char(CASE WHEN MIN(ordered_at) IS NULL OR MIN(ordered_at) > NOW() - make_interval(days => $1)
                         THEN NOW() - make_interval(days => $1 + 5)
                         ELSE MAX(ordered_at) - INTERVAL '2 days' END, 'YYYY-MM-DD') AS since
       FROM shopify_order_actor`, [TECH_REFILL_DAYS])).rows[0];
  return recordOrderActors(pool, await readOrderCustomers(since));
}
