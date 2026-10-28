// Proves the Claude connector (server/platform/mcp.js) is read-only, logs in
// only real platform users with SA access, and answers with the screens'
// numbers. PRD_MCP_CONNECTOR.md.
//
// Walks the whole path a person's Claude takes: discovery → registration →
// the platform login page → code → token → every tool — and then every way it
// must NOT work: a tampered login, a replayed code, a wrong PKCE verifier, no
// token, a forged token, a revoked token, a deactivated user, a user without SA.
//
// FIXTURE: two temporary platform users (created and deleted here, with every
// row they produce: audit entries, codes, tokens, the registered client).
// Nothing in schema sa is written. Booting the server runs the startup
// migrations against the live database — the connector's tables are additive
// (CREATE TABLE IF NOT EXISTS, platform schema).
//
// Run: node scripts/regression-mcp-connector.js
import 'dotenv/config';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pkg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getStockStatus, lowStockAlertItems } from '../src/sa/utils/stockStatus.js';
import { getJwtSecret } from '../server/platform/auth.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3984;
const BASE = `http://localhost:${PORT}`;
const MCP_URL = `${BASE}/mcp`;
const REDIRECT = 'http://localhost:9/callback';
const PASSWORD = crypto.randomBytes(12).toString('base64url');
const STAMP = `mcp-regression-${Date.now()}`;

const pool = new pkg.Pool({ connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: true } });
let failed = 0, server, admin, noSa, plainUser;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};
const b64url = (buf) => buf.toString('base64url');

async function makeUser(name, role, modules) {
  const id = (await pool.query(`INSERT INTO platform.users (name, password_hash, role, must_change_password, active)
                                VALUES ($1, $2, $3, false, true) RETURNING id`, [name, bcrypt.hashSync(PASSWORD, 10), role])).rows[0].id;
  for (const m of modules) await pool.query(`INSERT INTO platform.user_modules (user_id, module) VALUES ($1, $2)`, [id, m]);
  return { id, name };
}

// The OAuth dance, as Claude does it. Returns the token response.
async function connect(user, { password = PASSWORD, resource = MCP_URL } = {}) {
  const reg = await (await fetch(`${BASE}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: STAMP, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) })).json();
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const auth = new URL(`${BASE}/authorize`);
  Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge,
    code_challenge_method: 'S256', state: 'st-1', resource, scope: 'read' }).forEach(([k, v]) => auth.searchParams.set(k, v));
  const page = await (await fetch(auth)).text();
  const ticket = page.match(/name="ticket" value="([^"]+)"/)?.[1];
  const login = await fetch(`${BASE}/mcp/login`, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ticket, name: user.name, password }) });
  const location = login.headers.get('location');
  const code = location ? new URL(location).searchParams.get('code') : null;
  const tokenFor = (c, v = verifier) => fetch(`${BASE}/token`, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: c, code_verifier: v, client_id: reg.client_id,
      redirect_uri: REDIRECT, resource }) });
  return { reg, page, ticket, login, location, code, tokenFor, verifier };
}

const mcpClient = async (accessToken) => {
  const c = new Client({ name: STAMP, version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  return c;
};
const parse = (r) => { try { return JSON.parse(r.content[0].text); } catch { return null; } };

try {
  admin = await makeUser(`${STAMP}-admin`, 'admin', ['SA']);
  noSa = await makeUser(`${STAMP}-nosa`, 'admin', []);
  plainUser = await makeUser(`${STAMP}-user`, 'user', ['SA']);

  server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test', SM_SHOPIFY_SYNC_ENABLED: 'false', PUBLIC_BASE_URL: BASE } });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  let up = false;
  for (let i = 0; i < 360 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { /* booting */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error(`server did not boot\n${log.slice(-1500)}`);

  console.log('\n1. Discovery');
  const asMeta = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  check(asMeta.authorization_endpoint === `${BASE}/authorize` && asMeta.token_endpoint === `${BASE}/token`
    && asMeta.registration_endpoint === `${BASE}/register`, 'the server advertises its login, token and registration endpoints');
  const rsMeta = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
  check(rsMeta.resource === MCP_URL, 'and names /mcp as the protected resource', JSON.stringify(rsMeta));
  const noToken = await fetch(MCP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check(noToken.status === 401 && /resource_metadata=/.test(noToken.headers.get('www-authenticate') || ''),
    '/mcp without a token is refused, pointing Claude at the login', String(noToken.status));

  console.log('\n2. Login is the platform user, and only that');
  const bad = await connect(admin, { password: 'wrong-password' });
  check(bad.page.includes('read-only') && !!bad.ticket, 'the login page says read-only and carries a signed ticket');
  check(bad.login.status === 401 && !bad.location, 'a wrong password gets no code');
  const forged = await fetch(`${BASE}/mcp/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ticket: jwt.sign({ aud: 'mcp-authorize', client_id: bad.reg.client_id, redirect_uri: 'https://evil.example/cb',
      code_challenge: 'x', scopes: [] }, 'not-the-secret'), name: admin.name, password: PASSWORD }) });
  check(forged.status === 400 && !forged.headers.get('location'), 'a ticket not signed by the platform is refused (no code sent elsewhere)');
  // 401 = the signature itself is refused. Signed with the session key, the
  // gate would have let it through and only the module check answered (403).
  const asSession = await fetch(`${BASE}/api/sa/products`, { headers: { Authorization: `Bearer ${bad.ticket}` } });
  check(asSession.status === 401, 'the ticket on the login page is useless as a platform session', String(asSession.status));
  const loginCsp = bad.login.headers.get('content-security-policy') || '';
  check(loginCsp.includes(`form-action 'self' ${new URL(REDIRECT).origin}`) && loginCsp.includes("frame-ancestors 'none'"),
    'the page lets the browser hand the code back to Claude, and cannot be framed', loginCsp);
  const wrongTarget = new URL(`${BASE}/authorize`);
  Object.entries({ response_type: 'code', client_id: bad.reg.client_id, redirect_uri: REDIRECT, code_challenge: 'x'.repeat(43),
    code_challenge_method: 'S256', state: 's', resource: `${BASE}/not-this-server` }).forEach(([k, v]) => wrongTarget.searchParams.set(k, v));
  const wt = await fetch(wrongTarget, { redirect: 'manual' });
  check(wt.status === 302 && new URL(wt.headers.get('location')).searchParams.get('error') === 'invalid_target',
    'a token for another server is refused before the login, not after it');
  const slash = new URL(wrongTarget); slash.searchParams.set('resource', `${MCP_URL}/`);
  check((await fetch(slash, { redirect: 'manual' })).status === 200, '"/mcp/" with a trailing slash is the same server');
  const sl = await connect(admin, { resource: `${MCP_URL}/` });
  const slTok = await (await sl.tokenFor(sl.code)).json();
  check(!!slTok.access_token && (await mcpClient(slTok.access_token).then((c) => c.listTools()).then((r) => r.tools.length)) === 6,
    'and the whole connection works through it: login, token, tools');
  const sa = await connect(admin);
  check(sa.login.status === 302 && sa.code && new URL(sa.location).searchParams.get('state') === 'st-1'
    && sa.location.startsWith(REDIRECT), 'the right password returns a code to the registered address, with its state');
  check((await sa.tokenFor(sa.code, b64url(crypto.randomBytes(32)))).status === 400, 'a wrong PKCE verifier gets no token');
  const noRedirect = await fetch(`${BASE}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: sa.code, code_verifier: sa.verifier, client_id: sa.reg.client_id, resource: MCP_URL }) });
  check(noRedirect.status === 400, 'leaving out the redirect_uri at the token step gets no token');
  const tok = await (await sa.tokenFor(sa.code)).json();
  check(!!tok.access_token && !!tok.refresh_token && tok.expires_in === 3600, 'the code buys a 1-hour access token and a refresh token');
  check((await sa.tokenFor(sa.code)).status === 400, 'a code works once only');
  const nosa = await connect(noSa);
  check(nosa.login.status === 401 && !nosa.location && /Only admin and root users with SA access/.test(await nosa.login.text()),
    'an admin without SA access is refused at login');
  const pu = await connect(plainUser);
  check(pu.login.status === 401 && !pu.location, 'a "user"-role account with SA is refused too — admin and root only (owner, 15 Oct)');

  console.log('\n2b. Only Claude can register');
  const reg = (uris) => fetch(`${BASE}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: STAMP, redirect_uris: uris, token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  check((await reg(['https://evil.example/cb'])).status === 400, 'a client returning anywhere but Claude is refused (no look-alike "Claude")');
  check((await reg(['https://claude.ai/api/mcp/auth_callback', 'https://evil.example/cb'])).status === 400, 'one foreign address among Claude\'s is enough to refuse');
  check((await reg(['https://claude.ai/api/mcp/auth_callback'])).status === 201 && (await reg(['https://claude.com/api/mcp/auth_callback'])).status === 201,
    'Claude\'s own callbacks (claude.ai, and claude.com) are accepted');
  check((await reg(['http://localhost/callback'])).status === 201, 'and Claude Code\'s loopback callback');
  check(/sent back to <strong>localhost:9<\/strong>/.test(sa.page) && /Claude Code/.test(sa.page),
    'the login page shows where the access goes, and warns when it is this computer');

  console.log('\n3. The tools: read only, and the screens\' numbers');
  const client = await mcpClient(tok.access_token);
  const tools = (await client.listTools()).tools;
  const names = tools.map((t) => t.name).sort();
  check(JSON.stringify(names) === JSON.stringify(['get_demand_plan', 'get_movements', 'get_stock', 'list_purchase_orders', 'list_stock_alerts', 'search_products']),
    'exactly the six tools of the PRD', names.join(', '));
  check(tools.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false),
    'every tool declares itself read-only and non-destructive');

  // The same user's view of the screens, through the platform's own routes.
  const userJwt = jwt.sign({ id: admin.id, name: admin.name, role: 'admin', modules: ['SA'], must_change_password: false },
    getJwtSecret(), { expiresIn: '10m' });
  const screen = async (path) => (await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${userJwt}` } })).json();
  const products = await screen('/api/sa/products');
  const santal = products.find((p) => p.productCode === 'FRAG_0137');

  const st = parse(await client.callTool({ name: 'get_stock', arguments: { product: 'FRAG_0137' } }));
  const wordOf = { HEALTHY: 'Healthy', LOW: 'Low Stock', CRITICAL: 'Critical', OUT: 'Out of Stock', NEGATIVE: 'Negative Stock' };
  // An oil's stock is SA's balance, its total beside it (PRD_STAGE_1_FRAGRANCE_LIBRARY.md §2.6).
  check(st?.code === 'FRAG_0137' && Math.abs(st.stock.value - santal.saStock / 1000) < 0.01 && st.stock.unit === 'L'
    && Math.abs(st.total?.value - santal.currentStock / 1000) < 0.01
    && st.status === wordOf[getStockStatus(santal).key], 'get_stock: Santal 33 SA stock, total and status equal the Fragrance Library',
    JSON.stringify(st?.stock) + ' ' + JSON.stringify(st?.total) + ' ' + st?.status);
  // The companies the oil belongs to (its active registrations).
  const wantIn = Object.entries(santal.registrations || {}).filter(([, r]) => r.active).map(([c]) => c);
  check(Array.isArray(st?.registeredIn) && st.registeredIn.includes('SA') && st.registeredIn.join() === wantIn.join(),
    'get_stock: Santal 33 says which companies it belongs to', JSON.stringify(st?.registeredIn));
  const amb = await client.callTool({ name: 'get_stock', arguments: { product: 'Santal' } });
  check(amb.isError && /More than one product matches/.test(amb.content[0].text), 'an ambiguous name asks which one, never guesses');

  const sr = parse(await client.callTool({ name: 'search_products', arguments: { query: 'Santal' } }));
  check(sr?.matches === products.filter((p) => /santal/i.test(`${p.name} ${p.productCode} ${p.tag}`)).length && sr.products.length <= 25,
    'search_products: the same matches as the screen\'s search, at most 25 shown', `${sr?.matches}`);

  const al = parse(await client.callTool({ name: 'list_stock_alerts', arguments: {} }));
  const dash = lowStockAlertItems(products);
  check(al?.count === dash.length && al.alerts.map((a) => a.code).join() === dash.map((x) => x.p.productCode).join(),
    'list_stock_alerts: the Dashboard card\'s list, in its order', `${al?.count} vs ${dash.length}`);

  const rep = await screen('/api/sa/dashboard/replenishment');
  const dp = parse(await client.callTool({ name: 'get_demand_plan', arguments: { product: 'FRAG_0137' } }));
  const repS = rep.products.find((p) => p.productCode === 'FRAG_0137');
  check(dp?.status === repS.safetyStatus && dp.recommendation.quantity === repS.recommendation.litres
    && dp.perDay.total === repS.recommendation.dailyRate
    && JSON.stringify(dp.orderToCoverFromToday.map((c) => c.withCustomerSales)) === JSON.stringify(repS.coverage.map((c) => c.all)),
    'get_demand_plan: status, rate, recommendation and the 30/60/90/120 table equal Demand Planning',
    `${dp?.status}/${repS.safetyStatus} ${dp?.recommendation?.quantity}/${repS.recommendation.litres}`);

  const po = parse(await client.callTool({ name: 'list_purchase_orders', arguments: {} }));
  // Orders with something still to arrive — a received-but-unclosed one has nothing left.
  const poCount = products.reduce((s, p) => s + (p.incomingOrders || [])
    .filter((o) => (parseFloat(o.quantity) || 0) - (parseFloat(o.quantityReceived) || 0) > 0).length, 0);
  check(po?.count === poCount && po.orders.every((o) => /^(no delivery date|today|in \d+ days|overdue by \d+ days)$/.test(o.due)),
    'list_purchase_orders: every open order, each with its due date or a flag', `${po?.count} vs ${poCount}`);

  const mv = parse(await client.callTool({ name: 'get_movements', arguments: { product: 'FRAG_0137', days: 7 } }));
  check(mv?.code === 'FRAG_0137' && Array.isArray(mv.rows) && mv.rows.length === mv.movements, 'get_movements: a week of Santal 33 movements');
  const tooFar = await client.callTool({ name: 'get_movements', arguments: { product: 'FRAG_0137', days: 365 } }).catch((e) => ({ isError: true, content: [{ text: e.message }] }));
  check(tooFar.isError, 'more than 90 days back is refused');

  console.log('\n4. Every question is recorded');
  const audit = (await pool.query(`SELECT action, details->>'tool' AS tool FROM platform.audit_log WHERE user_id = $1`, [admin.id])).rows;
  check(audit.some((a) => a.action === 'mcp_connected'), 'the connection itself is logged');
  check(['get_stock', 'search_products', 'list_stock_alerts', 'get_demand_plan', 'list_purchase_orders', 'get_movements']
    .every((t) => audit.some((a) => a.action === 'mcp_query' && a.tool === t)), 'each tool call is logged with its name');

  console.log('\n5. Access ends when it should');
  // Each "refused" below follows a call that worked with the same token, so a
  // 401 means the thing being tested ended it — not that it never worked.
  const refresh = (rt, clientId = sa.reg.client_id) => fetch(`${BASE}/token`, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: clientId }) });
  const call = (t) => fetch(MCP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${t}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  const tok2 = await (await refresh(tok.refresh_token)).json();
  check(!!tok2.access_token && tok2.refresh_token !== tok.refresh_token, 'a refresh gives new tokens');
  check((await refresh(tok.refresh_token)).status === 400, 'and the old refresh token is spent');
  check((await call('not-a-token')).status === 401, 'a made-up token is refused');
  check((await call(tok.access_token)).status === 401, 'a refresh ends the access token issued before it');
  check((await call(tok2.access_token)).status === 200, 'the new access token works…');
  await fetch(`${BASE}/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: tok2.refresh_token, client_id: sa.reg.client_id }) });
  check((await call(tok2.access_token)).status === 401,
    '…until the connection is revoked (disconnecting): its access token ends with the refresh token handed back');
  check((await refresh(tok2.refresh_token)).status === 400, 'and its refresh token is dead');
  // Deactivation, on the other, still live connection (made through "/mcp/").
  check((await call(slTok.access_token)).status === 200, 'another live connection works…');
  await pool.query(`UPDATE platform.users SET active = false WHERE id = $1`, [admin.id]);
  check((await call(slTok.access_token)).status === 401, '…until the user is deactivated: a still-valid token is cut at once');
  check((await refresh(slTok.refresh_token, sl.reg.client_id)).status === 400, 'and its refresh token too');

  console.log('\n6. Nothing in the connector can write to the business data');
  const src = readFileSync(join(ROOT, 'server/platform/mcp.js'), 'utf8');
  const fetches = [...src.matchAll(/fetch\(([^)]*)\)/g)].map((m) => m[1]);
  check(fetches.length === 1 && !/method/.test(fetches[0]) && !/method\s*:/.test(src.slice(src.indexOf('function makeGetAsUser'), src.indexOf('class ToolError'))),
    'the only call into the platform is one GET helper — no method can be passed', fetches.join(' | '));
  const code = src.replace(/\/\/.*$/gm, ''); // comments describe SQL; only code counts
  const writes = [...code.matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+([\w.]+)/g)].map((m) => m[2]);
  check(writes.length > 0 && writes.every((t) => /^platform\.mcp_/.test(t)), 'its only SQL writes are its own OAuth tables (platform.mcp_*)', writes.join(', '));
  check(!/\bsa\./.test(src.replace(/\/\/.*$/gm, '')) && !/saPool/.test(src), 'it never touches schema sa directly');

  await client.close().catch(() => {});
  console.log(failed === 0 ? '\n✅ mcp-connector: all checks passed' : `\n❌ ${failed} failed`);
  if (failed) console.log(log.split('\n').filter((l) => /mcp|rror/i.test(l)).slice(-15).join('\n'));
} catch (e) {
  console.error('\nFATAL', e.stack || e.message);
  failed++;
} finally {
  if (server) { try { server.kill('SIGKILL'); } catch { /* gone */ } }
  // Clean up everything the fixture produced.
  try {
    const ids = [admin?.id, noSa?.id, plainUser?.id].filter(Boolean);
    const a = await pool.query(`DELETE FROM platform.audit_log WHERE user_id = ANY($1::int[])`, [ids]);
    const c = await pool.query(`DELETE FROM platform.mcp_clients WHERE info->>'client_name' = $1`, [STAMP]);
    await pool.query(`DELETE FROM platform.user_modules WHERE user_id = ANY($1::int[])`, [ids]);
    // The boot copies platform users into sm.users (syncPlatformUsersToSm) —
    // remove that mirror too, by name, so a run leaves nothing behind.
    const m = await pool.query(`DELETE FROM sm.users WHERE name LIKE $1`, [`${STAMP}-%`]);
    const u = await pool.query(`DELETE FROM platform.users WHERE id = ANY($1::int[])`, [ids]); // codes and tokens cascade
    const left = (await pool.query(`SELECT
        (SELECT COUNT(*) FROM platform.users WHERE name LIKE $1)::int AS users,
        (SELECT COUNT(*) FROM sm.users WHERE name LIKE $1)::int AS sm_users,
        (SELECT COUNT(*) FROM platform.mcp_tokens WHERE user_id = ANY($2::int[]))::int AS tokens,
        (SELECT COUNT(*) FROM platform.mcp_auth_codes WHERE user_id = ANY($2::int[]))::int AS codes,
        (SELECT COUNT(*) FROM platform.mcp_clients WHERE info->>'client_name' = $3)::int AS clients`, [`${STAMP}%`, ids, STAMP])).rows[0];
    const clean = Object.values(left).every((n) => n === 0);
    console.log(`  ${clean ? 'ok  ' : 'FAIL'}  cleaned up: ${u.rowCount} users (+${m.rowCount} sm mirror), ${a.rowCount} audit rows, ${c.rowCount} clients (codes and tokens cascaded) — left ${JSON.stringify(left)}`);
    if (!clean) failed++;
  } catch (e) { console.error('cleanup failed:', e.message); failed++; }
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}
