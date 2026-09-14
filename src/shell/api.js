// Module-aware fetch interceptor (FR-AUTH-7).
// - Injects Authorization: Bearer <token> into every /api/ call.
// - On 401 (except auth endpoints) clears the session and returns to login.
// - setActiveModule/getActiveModule persist the picked module (Appendix B, B3);
//   module pages call their APIs via apiBase() so SA pages hit /api/sa/* etc.

const TOKEN_KEY = 'platform_token';
const USER_KEY = 'platform_user';
const MODULE_KEY = 'platform_active_module';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser() {
  try {
    const s = localStorage.getItem(USER_KEY);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

export function storeSession(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(MODULE_KEY);
}

export function setActiveModule(module) {
  if (module) localStorage.setItem(MODULE_KEY, module);
  else localStorage.removeItem(MODULE_KEY);
}

export function getActiveModule() {
  return localStorage.getItem(MODULE_KEY);
}

// API base for the active module ('SA' → '/api/sa'); platform APIs use '/api/platform'.
export function apiBase(module) {
  const m = module || getActiveModule();
  // FRAGLIB is a VIEW over SA, not a module of its own — the Fragrance Library
  // tile opens /sa/fragrance-library, which is ProductManagement in oils-locked
  // mode and calls bare fetch('/api/products').
  //
  // WHY THIS LINE EXISTS (2026-09-15). It was missing, so 'FRAGLIB' fell through
  // to the platform base and every call on that page became
  // /api/platform/products — a route that does not exist. Opening the Fragrance
  // Library from its own tile 404'd the whole page, and it stayed broken for as
  // long as FRAGLIB was the stored active module, because the fault lives in
  // localStorage rather than in the page.
  if (m === 'SA' || m === 'FRAGLIB') return '/api/sa';
  if (m === 'SM' || m === 'MUSE' || m === 'OPS') return '/api/sm'; // MUSE (D7) and OPS (D11) are views over SM
  // REPORTS lands here deliberately: that tile opens the cross-system report,
  // which calls /api/platform/* — already exempt from rewriting.
  return '/api/platform';
}

// Paths that must never be module-prefixed
const NON_MODULE_PREFIXES = ['/api/platform', '/api/sa', '/api/sm', '/api/webhook', '/api/health'];

// Global fetch patch — call once from main.jsx before the app renders.
// FR-AUTH-7 + PRD §7.4: legacy module pages keep calling fetch('/api/...');
// the interceptor rewrites those to the active module's base (/api/sa|/api/sm)
// so page code stays byte-identical to the original systems.
export function installFetchInterceptor() {
  const _fetch = window.fetch.bind(window);
  window.fetch = (url, options = {}) => {
    if (typeof url === 'string' && url.startsWith('/api/')) {
      const active = getActiveModule();
      if (active && !NON_MODULE_PREFIXES.some((p) => url === p || url.startsWith(p + '/'))) {
        url = apiBase(active) + url.slice('/api'.length);
      }
      const token = getToken();
      if (token) {
        options = { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } };
      }
    }
    return _fetch(url, options).then((res) => {
      const isApi = typeof url === 'string' && url.startsWith('/api/');
      const isAuthCall = typeof url === 'string' && url.includes('/auth/');
      if (res.status === 401 && isApi && !isAuthCall) {
        clearSession();
        window.location.href = '/';
      }
      return res;
    });
  };
}
