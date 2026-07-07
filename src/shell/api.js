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
  if (m === 'SA') return '/api/sa';
  if (m === 'SM') return '/api/sm';
  return '/api/platform';
}

// Global fetch patch — call once from main.jsx before the app renders.
export function installFetchInterceptor() {
  const _fetch = window.fetch.bind(window);
  window.fetch = (url, options = {}) => {
    if (typeof url === 'string' && url.startsWith('/api/')) {
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
