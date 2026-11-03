// Read-only Claude connector for the SA platform (MCP). PRD_MCP_CONNECTOR.md.
//
// WHY (2026-10-15). The manager's stock questions — "how much Wonderwood do we
// need according to Salesforce?" — came to the owner, who answered them from
// the same screens she could open. The owner's call: a connector anyone with a
// platform user can add to their corporate Claude, READ ONLY ("somente leitura
// sem dúvida"), security first.
//
// How it is safe:
//   · Only admin and root users can connect (owner, 2026-10-15: "apenas irei
//     liberar para admins e root").
//   · Only Claude can be the client: registration accepts nothing but
//     Claude's own return addresses (CLAUDE_REDIRECTS), so a look-alike
//     "Claude" registered by anyone else cannot collect a code (security
//     review — consent phishing through open registration).
//   · Login is the person's own platform user, through OAuth: Claude never
//     sees the password; it holds a token that expires and is revoked the
//     moment the user is deactivated.
//   · Every tool answers by calling the platform's OWN GET routes as that
//     user (getAsUser below — it cannot send anything but GET). So the numbers
//     are the screens' numbers, and each person sees exactly what their role
//     sees on the screens: nothing opens that is closed today.
//   · Every call is logged in platform.audit_log, visible in History & Activity.
//   · The only rows this file writes are its own OAuth state (platform.mcp_*)
//     and the audit log. Nothing in schema sa.
import crypto from 'node:crypto';
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidGrantError, InvalidTokenError, InvalidTargetError, InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { platformPool, withTransaction } from '../db.js';
import rateLimit from 'express-rate-limit';
import { getJwtSecret, getUserModules, auditLog } from './auth.js';
import { getStockStatus, effectiveMin, lowStockAlertItems, isSaProduct } from '../../src/sa/utils/stockStatus.js';
import { sectorLabel, HELD_SECTORS } from '../../shared/sectors.js';

const ACCESS_TTL_S = 60 * 60;            // 1 hour
const REFRESH_TTL_S = 30 * 24 * 60 * 60; // 30 days, rotated on every use
const CODE_TTL_S = 5 * 60;
const TICKET_TTL = '10m';                // the login page has 10 minutes
const CALLS_PER_MINUTE = 60;
const MOVEMENT_DAYS_MAX = 90;
// Who may connect, on top of an active account with the SA module.
const CONNECT_ROLES = ['root', 'admin'];
// Where Claude sends a person back after login (claude.com/docs/connectors/
// building/authentication, checked 2026-10-15): the hosted apps use exactly
// claude.ai's callback (Anthropic warns it may move to claude.com, so both);
// Claude Code uses a loopback address on a port that changes per session —
// the code then goes to the signed-in person's own computer.
const CLAUDE_REDIRECTS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];
const LOOPBACK_CALLBACKS = ['http://localhost/callback', 'http://127.0.0.1/callback'];
const isClaudeRedirect = (uri) => CLAUDE_REDIRECTS.includes(uri) || LOOPBACK_CALLBACKS.some((l) => redirectUriMatches(uri, l));

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
let dummyHash; // made on the first sign-in, not at boot
const DUMMY_HASH = () => (dummyHash ||= bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10));
// The login-page ticket is signed with its OWN key, derived from the platform
// secret. Signed with the session key itself, the ticket — which any visitor
// can read off the page — would pass the /api auth gate as a session token
// (code review). A different key makes that impossible.
const ticketKey = () => crypto.createHmac('sha256', getJwtSecret()).update('mcp-authorize-ticket').digest();
// "https://host/mcp/" and "https://host/mcp" are the same server.
const sameResource = (a, b) => String(a).replace(/\/+$/, '') === String(b).replace(/\/+$/, '');
const newSecret = () => crypto.randomBytes(32).toString('base64url');
const q = (text, params) => platformPool.query(text, params);

// ── Who the user is, freshly, on every call ───────────────────────────────
// Deactivating a user, or removing their SA module, cuts the connector at
// once — the token alone is never enough.
async function loadUser(userId) {
  const r = await q(`SELECT id, name, role, active, must_change_password FROM platform.users WHERE id = $1`, [userId]);
  const user = r.rows[0];
  if (!user || !user.active || user.must_change_password || !CONNECT_ROLES.includes(user.role)) return null;
  const modules = await getUserModules(user.id);
  if (!modules.includes('SA')) return null;
  return { ...user, modules };
}

// ── OAuth provider (the SDK runs the protocol; this stores and decides) ───
function makeProvider(mcpUrl) {
  const clientsStore = {
    async getClient(clientId) {
      const r = await q(`SELECT info FROM platform.mcp_clients WHERE client_id = $1`, [clientId]);
      return r.rows[0]?.info;
    },
    async registerClient(client) {
      if (!client.redirect_uris?.length || !client.redirect_uris.every(isClaudeRedirect)) {
        throw new InvalidClientMetadataError('This server accepts Claude only');
      }
      await q(`INSERT INTO platform.mcp_clients (client_id, info) VALUES ($1, $2)`, [client.client_id, JSON.stringify(client)]);
      return client;
    },
  };

  async function issueTokens(clientId, userId, scopes, resource, run = q) {
    // Housekeeping on the way: codes and tokens a day past expiry are useless.
    // Registrations are kept: Claude caches its client_id, so deleting an idle
    // one would break that connector for good (code review). Only Claude can
    // register (CLAUDE_REDIRECTS), so they do not pile up from strangers.
    await run(`DELETE FROM platform.mcp_auth_codes WHERE expires_at < NOW() - INTERVAL '1 day'`);
    await run(`DELETE FROM platform.mcp_tokens WHERE expires_at < NOW() - INTERVAL '1 day'`);
    const access = newSecret(), refresh = newSecret();
    await run(`INSERT INTO platform.mcp_tokens (token_hash, kind, client_id, user_id, scopes, resource, expires_at)
             VALUES ($1, 'access',  $3, $4, $5, $6, NOW() + make_interval(secs => $7)),
                    ($2, 'refresh', $3, $4, $5, $6, NOW() + make_interval(secs => $8))`,
      [sha256(access), sha256(refresh), clientId, userId, scopes, resource, ACCESS_TTL_S, REFRESH_TTL_S]);
    return { access_token: access, token_type: 'bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scopes.join(' ') };
  }

  return {
    clientsStore,

    // The SDK has validated the client and its redirect_uri. Show the
    // platform's own login; the request travels in a signed, expiring
    // ticket, so the form cannot be edited to send the code elsewhere.
    async authorize(client, params, res) {
      // A token for some other server would be refused on every call after a
      // successful login — say so now instead (code review).
      if (params.resource && !sameResource(params.resource.href, mcpUrl.href)) {
        throw new InvalidTargetError(`This server is ${mcpUrl.href}`);
      }
      const ticket = jwt.sign({
        aud: 'mcp-authorize', client_id: client.client_id, redirect_uri: params.redirectUri,
        code_challenge: params.codeChallenge, state: params.state ?? null,
        scopes: params.scopes || [], resource: params.resource ? mcpUrl.href : null,
      }, ticketKey(), { expiresIn: TICKET_TTL });
      sendLoginPage(res, { ticket, clientName: client.client_name, redirectUri: params.redirectUri });
    },

    async challengeForAuthorizationCode(client, code) {
      const r = await q(`SELECT code_challenge FROM platform.mcp_auth_codes
                         WHERE code_hash = $1 AND client_id = $2 AND used_at IS NULL AND expires_at > NOW()`,
        [sha256(code), client.client_id]);
      if (!r.rows[0]) throw new InvalidGrantError('Invalid or expired authorization code');
      return r.rows[0].code_challenge;
    },

    async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
      // One use only: the UPDATE claims the code, so a replay finds nothing.
      // The redirect_uri is required and must be the one the code was issued
      // for (RFC 6749 §4.1.3); it is part of the claim, so a request without
      // it is refused without spending the code.
      const r = await q(`UPDATE platform.mcp_auth_codes SET used_at = NOW()
                         WHERE code_hash = $1 AND client_id = $2 AND redirect_uri = $3
                           AND used_at IS NULL AND expires_at > NOW()
                         RETURNING user_id, redirect_uri, scopes, resource`,
        [sha256(code), client.client_id, redirectUri ?? null]);
      const row = r.rows[0];
      if (!row) throw new InvalidGrantError('Invalid or expired authorization code, or a different redirect_uri');
      if (resource && row.resource && !sameResource(resource.href, row.resource)) throw new InvalidGrantError('resource does not match');
      if (!(await loadUser(row.user_id))) throw new InvalidGrantError('User is not allowed');
      return issueTokens(client.client_id, row.user_id, row.scopes, row.resource);
    },

    async exchangeRefreshToken(client, refreshToken) {
      // Rotated: the old refresh token is spent the moment it is used — in the
      // same transaction as issuing the new pair, so a dropped connection in
      // between cannot leave the person with neither (code review).
      return withTransaction(platformPool, async (tx) => {
        const run = (text, params) => tx.query(text, params);
        const r = await run(`UPDATE platform.mcp_tokens SET revoked_at = NOW()
                             WHERE token_hash = $1 AND kind = 'refresh' AND client_id = $2
                               AND revoked_at IS NULL AND expires_at > NOW()
                             RETURNING user_id, scopes, resource`,
          [sha256(refreshToken), client.client_id]);
        const row = r.rows[0];
        if (!row) throw new InvalidGrantError('Invalid or expired refresh token');
        if (!(await loadUser(row.user_id))) throw new InvalidGrantError('User is not allowed');
        // The connection keeps one live access token: the ones issued before
        // this refresh end with it (code review).
        await run(`UPDATE platform.mcp_tokens SET revoked_at = NOW()
                   WHERE client_id = $1 AND user_id = $2 AND kind = 'access' AND revoked_at IS NULL`,
          [client.client_id, row.user_id]);
        return issueTokens(client.client_id, row.user_id, row.scopes, row.resource, run);
      });
    },

    async verifyAccessToken(token) {
      // Ours are 43 base64url characters. Anything else is refused without
      // waking the database — /mcp is public (code review).
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new InvalidTokenError('Invalid or expired token');
      const r = await q(`SELECT client_id, user_id, scopes, resource, EXTRACT(EPOCH FROM expires_at)::bigint AS exp
                         FROM platform.mcp_tokens
                         WHERE token_hash = $1 AND kind = 'access' AND revoked_at IS NULL AND expires_at > NOW()`,
        [sha256(token)]);
      const row = r.rows[0];
      if (!row) throw new InvalidTokenError('Invalid or expired token');
      if (row.resource && !sameResource(row.resource, mcpUrl.href)) throw new InvalidTokenError('Token was not issued for this server');
      const user = await loadUser(row.user_id);
      if (!user) throw new InvalidTokenError('User is not allowed');
      // The user travels with the request, so /mcp does not look them up twice.
      return { token, clientId: row.client_id, scopes: row.scopes, expiresAt: Number(row.exp), extra: { user } };
    },

    // Disconnecting revokes one token; it ends the whole connection — every
    // live token this client holds for that person, so an access token cannot
    // outlive the refresh token Claude handed back (code review).
    async revokeToken(client, { token }) {
      await q(`UPDATE platform.mcp_tokens SET revoked_at = NOW()
               WHERE client_id = $2 AND revoked_at IS NULL
                 AND user_id = (SELECT user_id FROM platform.mcp_tokens WHERE token_hash = $1 AND client_id = $2)`,
        [sha256(token), client.client_id]);
    },
  };
}

// ── The login page ────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function sendLoginPage(res, { ticket, clientName, redirectUri, error }) {
  // Chrome applies form-action to the redirect after the post as well, so the
  // registered return address (Claude's) must be allowed, or the browser
  // blocks the code on its way back and the connector can never be added
  // (code review — fetch-based tests cannot see it).
  let back = '', destination = 'Claude', local = false;
  try {
    const u = new URL(redirectUri);
    back = ' ' + u.origin;
    destination = u.host;
    local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch { /* no redirect known: self only */ }
  res.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${back}; frame-ancestors 'none'`,
  });
  res.status(error ? 401 : 200).send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Claude — Scent Australia</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0e0e1a;color:#e8eaf2;font-family:system-ui,sans-serif}
.card{width:100%;max-width:380px;margin:16px;padding:28px;border:1px solid rgba(255,255,255,.1);border-radius:14px;background:rgba(255,255,255,.04)}
h1{font-size:18px;margin:0 0 6px}p{font-size:13px;line-height:1.5;color:rgba(232,234,242,.7);margin:0 0 18px}
label{display:block;font-size:12px;margin:12px 0 4px;color:rgba(232,234,242,.7)}input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,.15);background:#151525;color:#e8eaf2;font-size:14px}
button{margin-top:18px;width:100%;padding:11px;border:0;border-radius:8px;background:#3b82f6;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
.err{color:#f87171;font-size:13px;margin-top:10px}</style></head><body><main class="card">
<h1>Connect Claude to Scent Australia</h1>
<p>${esc(clientName || 'Claude')} is asking for <strong>read-only</strong> access to SA stock, demand planning and purchase orders, as you. It cannot change anything. Every question is recorded in History &amp; Activity.</p>
<p>After you sign in you will be sent back to <strong>${esc(destination)}</strong>.${local ? ' That is a program on this computer (Claude Code) — continue only if you started it.' : ''}</p>
<form method="post" action="/mcp/login">
<input type="hidden" name="ticket" value="${esc(ticket)}">
<label for="name">Platform user</label><input id="name" name="name" autocomplete="username" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Allow read-only access</button>
${error ? `<div class="err" role="alert">${esc(error)}</div>` : ''}
</form></main></body></html>`);
}

// ── Asking the platform, as the user, GET only ────────────────────────────
// The single door every tool goes through. There is no method parameter: it
// can only read. A short-lived platform token for this user makes every
// route apply its own role and module checks, exactly as on the screens.
function makeGetAsUser(user) {
  const token = jwt.sign({ id: user.id, name: user.name, role: user.role, modules: user.modules, must_change_password: false },
    getJwtSecret(), { expiresIn: '5m' });
  const base = `http://127.0.0.1:${process.env.PORT || 3000}`;
  return async function getAsUser(path) {
    const r = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(25000) });
    if (r.status === 403) throw new ToolError('Your platform role does not have access to this.');
    if (!r.ok) throw new ToolError(`The platform answered ${r.status}.`);
    return r.json();
  };
}

class ToolError extends Error {}

// The Demand Planning build takes about a second and covers every product; a
// conversation asking about ten oils should not run it ten times (code
// review). Two minutes old at most, the same for everyone — the route has no
// per-role view — and read through the asking user's own session.
let repCache = { at: 0, pending: null, data: null };
function replenishment(getAsUser) {
  if (repCache.data && Date.now() - repCache.at < 2 * 60 * 1000) return Promise.resolve(repCache.data);
  repCache.pending ||= getAsUser('/api/sa/dashboard/replenishment')
    .then((data) => { repCache = { at: Date.now(), pending: null, data }; return data; })
    .finally(() => { repCache.pending = null; });
  return repCache.pending;
}

// ── Presenting the platform's numbers ─────────────────────────────────────
// Oils are stored in mL and shown in L on every screen; the same here.
const toDisplay = (v, unit) => unit === 'mL' ? { value: Math.round(v) / 1000, unit: 'L' } : { value: v, unit: unit || 'units' };
const STATUS_WORD = { HEALTHY: 'Healthy', LOW: 'Low Stock', CRITICAL: 'Critical', OUT: 'Out of Stock', NEGATIVE: 'Negative Stock' };

const dueText = (days) => days == null ? 'no delivery date' : days < 0 ? `overdue by ${-days} days` : days === 0 ? 'today' : `in ${days} days`;

function openOrders(p) {
  return (p.incomingOrders || []).flatMap((o) => {
    const left = (parseFloat(o.quantity) || 0) - (parseFloat(o.quantityReceived) || 0);
    if (left <= 0) return []; // fully (or over-) received but not closed: nothing left to arrive
    return [{
      order: o.orderNumber, supplier: o.supplier || null,
      stillToArrive: toDisplay(left, p.unit),
      due: dueText(o.etaDays),
    }];
  });
}

function stockView(p) {
  const auto = p.minStockAuto != null;
  return {
    code: p.productCode, name: p.name, category: p.category, active: (p.status || 'active') === 'active',
    stock: toDisplay(p.currentStock, p.unit),
    // An oil: SA's own balance — what the SA screens show, and what the status
    // and minimum are about — and where the rest of the oil sits
    // (PRD_STAGE_1_FRAGRANCE_LIBRARY.md §2.6). Equal to the total until oil
    // moves into the main store or MUSE.
    ...(p.sectors && {
      stock: toDisplay(p.saStock, p.unit),
      stockIs: 'SA',
      total: toDisplay(p.currentStock, p.unit),
      elsewhere: Object.fromEntries(HELD_SECTORS.map((k) => [sectorLabel(k), toDisplay(p.sectors[k] || 0, p.unit)])),
      // The companies the oil belongs to (an active registration), e.g. ['SA', 'MUSE'].
      registeredIn: Object.entries(p.registrations || {}).filter(([, r]) => r.active).map(([c]) => c),
    }),
    minimum: { ...toDisplay(effectiveMin(p), p.unit), source: auto ? 'automatic (Demand Planning safety stock)' : 'typed' },
    status: STATUS_WORD[getStockStatus(p).key],
    binLocation: p.bin_location || null,
    openOrders: openOrders(p),
  };
}

// One product from what a person would type: a code, a tag, or a name.
function pickProduct(list, query) {
  const t = query.trim().toLowerCase();
  const exact = list.filter((p) => [p.productCode, p.tag, p.name].some((v) => (v || '').trim().toLowerCase() === t));
  if (exact.length === 1) return { product: exact[0] };
  const found = exact.length ? exact : list;
  if (found.length === 1) return { product: found[0] };
  return { candidates: found.slice(0, 15).map((p) => ({ code: p.productCode, name: p.name, category: p.category })) };
}

// ── The tools ─────────────────────────────────────────────────────────────
function buildServer(user) {
  const server = new McpServer({ name: 'scent-australia-sa', version: '1.0.0' });
  const getAsUser = makeGetAsUser(user);
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const products = (search, category) => {
    const qs = new URLSearchParams({ ...(search ? { search } : {}), ...(category ? { category } : {}) }).toString();
    return getAsUser(`/api/sa/products${qs ? `?${qs}` : ''}`);
  };

  const tool = (name, description, inputSchema, run) => server.registerTool(name, { description, inputSchema, annotations: readOnly },
    async (args) => {
      try {
        allowCall(user.id);
        await auditLog(user.id, 'mcp_query', 'mcp', null, { name: `Claude: ${name}`, tool: name, args });
        return { content: [{ type: 'text', text: JSON.stringify(await run(args), null, 1) }] };
      } catch (e) {
        if (e instanceof ToolError) return { content: [{ type: 'text', text: e.message }], isError: true };
        console.error(`[mcp/${name}]`, e.message);
        return { content: [{ type: 'text', text: 'Something went wrong reading the platform. Try again in a moment.' }], isError: true };
      }
    });

  const resolve = async (raw, category, list) => {
    const query = raw.trim();
    const r = pickProduct(list || await products(query, category), query);
    if (r.candidates) {
      throw new ToolError(r.candidates.length
        ? `More than one product matches "${query}". Ask again with one of these codes: ${JSON.stringify(r.candidates)}`
        : `No product matches "${query}".`);
    }
    return r.product;
  };

  tool('search_products',
    'Find SA products (fragrance oils, diffuser machines, spare parts, raw materials, scented products) by name, product code or tag. Returns stock and stock status for each.',
    { query: z.string().min(1).describe('Name, product code (e.g. FRAG_0137) or part of a name') },
    async ({ query }) => {
      const list = await products(query.trim());
      return { matches: list.length, showing: Math.min(list.length, 25), products: list.slice(0, 25).map(stockView) };
    });

  tool('get_stock',
    'Stock of one product: quantity, minimum (automatic for oils with demand, otherwise typed), status (Healthy / Low Stock / Critical / Out of Stock) and open purchase orders with their due dates. Same rule as the Fragrance Library. For a fragrance oil the quantity is SA\'s own balance; the oil\'s total and what the main store and the MUSE stocks hold are beside it.',
    { product: z.string().min(1).describe('Product code, tag or exact name') },
    async ({ product }) => stockView(await resolve(product)));

  tool('list_stock_alerts',
    'The Dashboard\'s Low Stock Alerts, most urgent first: Critical (even an order placed today lands after it runs out) before Low Stock (order now). Oils appear only when they have real demand (an automatic minimum).',
    { category: z.enum(['OILS', 'SCENT_MACHINES', 'MACHINES_SPARES', 'RAW_MATERIALS', 'SA_SCENTED_PRODUCTS']).optional().describe('Only this category') },
    async ({ category }) => {
      // SA's alerts only, as on SA's Dashboard: an oil that is not SA's (no
      // active SA registration) is never "SA out of stock" (fix round 3, F4).
      const items = lowStockAlertItems((await products()).filter(isSaProduct))
        .filter((x) => !category || x.p.category === category);
      return { count: items.length, alerts: items.map((x) => stockView(x.p)) };
    });

  tool('get_demand_plan',
    'Demand Planning for one fragrance oil: daily rate (Salesforce contract, technician refills, customer sales), recommendation, how much to order to cover 30/60/90/120 days, safety stock, lead time, and whether the shelf runs out before the next purchase order lands.',
    { product: z.string().min(1).describe('Oil product code (e.g. FRAG_0137) or exact name') },
    async ({ product }) => {
      // Oils only — Demand Planning is about oil — and both reads at once.
      const [oils, rep] = await Promise.all([products(product.trim(), 'OILS'), replenishment(getAsUser)]);
      const p = await resolve(product, 'OILS', oils);
      const d = rep.products.find((x) => x.id === p.id);
      if (!d) throw new ToolError(`${p.name} is not in Demand Planning — it is inactive.`);
      const rate = d.recommendation.dailyRate || 0; // every product row carries one (regression-replenishment-recommendation §1)
      const orders = d.openOrders || [];
      return {
        code: d.productCode, name: d.name, status: d.safetyStatus, supplier: d.supplier || null,
        leadTimeDays: d.leadTime, leadTimeIsDefault: d.leadTimeSource === 'fallback',
        // onShelf is SA's balance. The main store and MUSE are information
        // only — in no figure here (R6) — and the warning says when oil
        // received into the main store waits for its split (D1).
        stock: { onShelf: d.realStock, onOrder: d.incomingStock, unit: d.unit,
                 mainStore: d.mainStore, muse: d.museTotal, warning: d.mainStoreWarning },
        perDay: { total: rate, customerSales: d.retailDailyAvg, b2b: d.b2bDaily, b2bFrom: d.b2bSource === 'technicians' ? 'technician refills' : 'Salesforce contract', technicianRefills: d.technicianDaily },
        salesforce: d.hasForecast ? { next120Days: d.forecast120Days, perDay: d.forecastDaily, importedDaysAgo: d.forecastAgeDays } : null,
        safetyStock: d.safetyStockLevel,
        recommendation: {
          action: d.recommendation.action, quantity: d.recommendation.litres, unit: d.unit,
          covers: d.recommendation.bridge ? `until the order due in ${d.recommendation.bridge.dueInDays} days lands` : `${d.recommendation.coversDays} days (lead time plus buffer)`,
          note: d.recommendation.note,
        },
        orderToCoverFromToday: d.coverage.map((c) => ({ days: c.days, salesforceOnly: c.salesforce, withCustomerSales: c.all, unit: d.unit })),
        // The server's own figures (worked out in mL, unrounded) — never a
        // re-derivation from the rounded litres, which could disagree with
        // the status beside it (code review).
        shelf: d.recommendation.action !== 'count_first' ? {
          shelfAloneLastsDays: d.daysOfStockActual >= 9999 ? null : Math.max(0, d.daysOfStockActual),
          withOrdersLandingInTimeLastsDays: d.recommendation.coverDaysInTime,
          runsOutBeforeAnOrderPlacedTodayCouldLand: d.safetyStatus === 'Critical',
          openOrders: orders.map((o) => ({ stillToArrive: Math.round(o.qty * 1000) / 1000, unit: d.unit, due: dueText(o.days) })),
        } : null,
      };
    });

  tool('list_purchase_orders',
    'Open purchase orders (pending or partly received): product, supplier, quantity still to arrive and when it is due — flagged when overdue or with no delivery date.',
    { supplier: z.string().optional().describe('Only this supplier (e.g. FIA, Luxaroma)') },
    async ({ supplier }) => {
      const s = supplier?.trim().toLowerCase();
      const rows = (await products()).flatMap((p) => openOrders(p).map((o) => ({ code: p.productCode, name: p.name, ...o })))
        .filter((o) => !s || (o.supplier || '').toLowerCase().includes(s));
      return { count: rows.length, orders: rows };
    });

  tool('get_movements',
    `Stock movements of one product (sales, removals, receipts, adjustments) for up to the last ${MOVEMENT_DAYS_MAX} days, newest first — for questions like "why did it drop?".`,
    { product: z.string().min(1).describe('Product code, tag or exact name'),
      days: z.number().int().min(1).max(MOVEMENT_DAYS_MAX).optional().describe(`How many days back (default 30, max ${MOVEMENT_DAYS_MAX})`) },
    async ({ product, days = 30 }) => {
      const p = await resolve(product);
      // Sydney's calendar, as every screen counts days.
      const from = new Date(Date.now() - (days - 1) * 86400000).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
      const cap = 1000;
      const rows = await getAsUser(`/api/sa/transactions?productId=${encodeURIComponent(p.id)}&dateFrom=${from}&limit=${cap}`);
      return {
        code: p.productCode, name: p.name, days, movements: rows.length,
        ...(rows.length >= cap ? { truncated: `Only the newest ${cap} are listed — ask for fewer days for the full picture.` } : {}),
        rows: rows.map((t) => ({
          when: new Date(t.created_at).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }),
          type: t.type, quantity: toDisplay(parseFloat(t.quantity) || 0, t.unit).value,
          balanceAfter: t.balance_after == null ? null : toDisplay(parseFloat(t.balance_after), t.unit).value,
          unit: t.unit === 'mL' ? 'L' : t.unit, reason: t.reason || null, notes: t.notes || null,
        })),
      };
    });

  return server;
}

// ── A small per-user cap, so a long conversation cannot hammer the database ─
const recentCalls = new Map();
function allowCall(userId) {
  const now = Date.now();
  const calls = (recentCalls.get(userId) || []).filter((t) => now - t < 60000);
  if (calls.length >= CALLS_PER_MINUTE) throw new ToolError('Too many questions in a minute — wait a moment and ask again.');
  calls.push(now);
  recentCalls.set(userId, calls);
}

// ── Mounting ──────────────────────────────────────────────────────────────
// At the application root, before the /api auth gate and the SPA catch-all.
export function mountMcp(app) {
  const port = process.env.PORT || 3000;
  const publicUrl = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL;
  // In production the connector must announce its real https address — a
  // login flow advertising localhost would hand Claude a dead end. Off, loudly,
  // rather than wrong.
  if (process.env.NODE_ENV === 'production' && !/^https:\/\//.test(publicUrl || '')) {
    console.error('[mcp] Claude connector NOT mounted: set PUBLIC_BASE_URL (or RENDER_EXTERNAL_URL) to the https address');
    return;
  }
  const base = new URL(publicUrl || `http://localhost:${port}`);
  const mcpUrl = new URL('/mcp', base);
  const provider = makeProvider(mcpUrl);

  app.use(mcpAuthRouter({
    provider, issuerUrl: base, resourceServerUrl: mcpUrl, resourceName: 'Scent Australia — SA stock (read only)',
    scopesSupported: ['read'],
    // A registered Claude keeps working: access is cut by tokens and by the
    // user's own account, not by its client secret expiring.
    clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
  }));

  // The login form posts here.
  // Its own limiter: sharing the platform login's counter let connecting
  // Claude use up everyone's sign-ins behind one office address, and answered
  // an HTML form with raw JSON (code review).
  const connectLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
    message: 'Too many sign-in attempts — wait 15 minutes and start the connection again from Claude.' });
  app.post('/mcp/login', connectLimiter, express.urlencoded({ extended: false }), async (req, res) => {
   try {
    let t;
    try {
      t = jwt.verify(String(req.body.ticket || ''), ticketKey(), { audience: 'mcp-authorize' });
    } catch {
      return res.status(400).send('This sign-in link has expired. Start the connection again from Claude.');
    }
    const client = await provider.clientsStore.getClient(t.client_id);
    if (!client || !client.redirect_uris.some((r) => redirectUriMatches(t.redirect_uri, r))) return res.status(400).send('Unknown client.');
    const again = (error) => sendLoginPage(res, { ticket: req.body.ticket, clientName: client.client_name, redirectUri: t.redirect_uri, error });

    const r = await q(`SELECT id, password_hash FROM platform.users WHERE name = $1 AND active = true`, [String(req.body.name || '')]);
    const row = r.rows[0];
    // Async, so the hash does not stall the whole platform; and against a
    // dummy when the user does not exist, so timing does not tell which names
    // are real (code review).
    const ok = await bcrypt.compare(String(req.body.password || ''), row?.password_hash || DUMMY_HASH());
    if (!row || !ok) return again('Invalid user or password.');
    if (!(await loadUser(row.id))) return again('Only admin and root users with SA access can connect Claude (and a pending password change must be done in the platform first).');

    const code = newSecret();
    await q(`INSERT INTO platform.mcp_auth_codes (code_hash, client_id, user_id, code_challenge, redirect_uri, scopes, resource, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + make_interval(secs => $8))`,
      [sha256(code), t.client_id, row.id, t.code_challenge, t.redirect_uri, t.scopes, t.resource, CODE_TTL_S]);
    await auditLog(row.id, 'mcp_connected', 'mcp', null, { name: `Claude connected (${client.client_name || 'client'})` });

    const back = new URL(t.redirect_uri);
    back.searchParams.set('code', code);
    if (t.state) back.searchParams.set('state', t.state);
    res.redirect(302, back.href);
   } catch (e) {
    // Express 4 does not catch a rejected handler: answer, never hang.
    console.error('[mcp/login]', e.message);
    if (!res.headersSent) res.status(503).send('The platform could not complete the sign-in. Try again in a moment.');
   }
  });

  // The connector itself: stateless, one server per request, as this user.
  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });
  const mcpLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
  app.post('/mcp', mcpLimiter, bearer, async (req, res) => {
    try {
      const server = buildServer(req.auth.extra.user);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('[mcp]', e.message);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });
  // Stateless: no server-initiated stream, no session to end.
  app.get('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').end());
  app.delete('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').end());

  console.log(`[mcp] Claude connector at ${mcpUrl.href} (read only)`);
}
