import { Router, Route, Switch, Link, Redirect, useLocation } from 'wouter';
import { ToastProvider } from './components/Toast';
import ProductManagement from './pages/ProductManagement';
import LibraryTransfers from './pages/LibraryTransfers';
import { ShellActions } from './SAModule';

// The Fragrance Library — its own area since Stage 1 (PRD_STAGE_1_FRAGRANCE_LIBRARY.md
// §2.2–2.4): every oil's stock across the main store, SA and MUSE, the fragrance
// purchase orders, and the transfers between stocks. Same SA API underneath
// (the FRAGLIB tile resolves to /api/sa, shell/api.js), same pages as SA's with
// one prop each, so there is still one engine and one product-code sequence.
// The frame is SAModule's, on purpose: same theme scope, same menu, and the
// same no-z-index content box that keeps windows above the menu (Stage 0).
export default function LibraryModule({ user, onSwitchModule, onLogout }) {
  return (
    <ToastProvider>
      <Router base="/library">
        <LibraryContent user={user} onSwitchModule={onSwitchModule} onLogout={onLogout} />
      </Router>
    </ToastProvider>
  );
}

function LibraryContent({ user, onSwitchModule, onLogout }) {
  const [location] = useLocation();
  const isActive = (path) => (path === '/' ? location === '/' : location.startsWith(path));

  return (
    <div className="sa-scope" style={{ position: 'relative', zIndex: 1 }}>
      <nav className="nav">
        <div className="nav-container">
          <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12 }}>
            <img src="/logo-dark.png" alt="Scent Australia" className="brand-logo-dark" />
            <img src="/logo-light.png" alt="Scent Australia" className="brand-logo-light" />
            <span style={{ fontWeight: 800, fontSize: 14, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>Fragrance Library</span>
          </div>

          <ul className="nav-links" style={{ flex: 1, justifyContent: 'center' }}>
            <li><Link href="/" className={isActive('/') ? 'nav-active' : ''}>All stock</Link></li>
            {/* Purchase orders are their own tile since H4. */}
            <li><Link href="/transfers" className={isActive('/transfers') ? 'nav-active' : ''}>Transfers</Link></li>
          </ul>

          <ShellActions onSwitchModule={onSwitchModule} onLogout={onLogout} />
        </div>
      </nav>

      {/* No z-index here — see SAModule.jsx: with one, every window slid under the menu. */}
      <div style={{ padding: '24px 2rem', position: 'relative' }}>
        <Switch>
          <Route path="/"><ProductManagement key="library" user={user} libraryMode /></Route>
          {/* The old address: "~" leaves this menu's /library base. */}
          <Route path="/purchase-orders"><Redirect to="~/purchase-orders" /></Route>
          <Route path="/transfers"><LibraryTransfers user={user} /></Route>
        </Switch>
      </div>
    </div>
  );
}
