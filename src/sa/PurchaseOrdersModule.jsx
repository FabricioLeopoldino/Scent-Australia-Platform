import { Router, Route, Switch } from 'wouter';
import { ToastProvider } from './components/Toast';
import PurchaseOrders from './pages/PurchaseOrders';
import { ShellActions } from './SAModule';

// Purchase Orders — its own area since H4 (PRD_H4_PURCHASE_ORDERS.md §2.1): every
// order, raised in Shopify, seen and handled in one place. Over the SA API (the
// PURCHASING tile resolves to /api/sa, shell/api.js). The frame is the Fragrance
// Library's: same theme scope, same menu, and the same no-z-index content box
// that keeps windows above the menu (Stage 0).
export default function PurchaseOrdersModule({ user, onSwitchModule, onLogout }) {
  return (
    <ToastProvider>
      <Router base="/purchase-orders">
        <div className="sa-scope" style={{ position: 'relative', zIndex: 1 }}>
          <nav className="nav">
            <div className="nav-container">
              <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12 }}>
                <img src="/logo-dark.png" alt="Scent Australia" className="brand-logo-dark" />
                <img src="/logo-light.png" alt="Scent Australia" className="brand-logo-light" />
                <span style={{ fontWeight: 800, fontSize: 14, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>Purchase Orders</span>
              </div>
              <div style={{ flex: 1 }} />
              <ShellActions onSwitchModule={onSwitchModule} onLogout={onLogout} />
            </div>
          </nav>
          <div style={{ padding: '24px 2rem', position: 'relative' }}>
            <Switch>
              <Route path="/"><PurchaseOrders user={user} /></Route>
            </Switch>
          </div>
        </div>
      </Router>
    </ToastProvider>
  );
}
