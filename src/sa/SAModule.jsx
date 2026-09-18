import { Router, Route, Switch, Link, useLocation } from 'wouter';
import { ToastProvider } from './components/Toast';
import Dashboard from './pages/Dashboard';
import StockManagement from './pages/StockManagement';
import SkuMapping from './pages/SkuMapping';
import TransactionHistory from './pages/TransactionHistory';
import ProductManagement from './pages/ProductManagement';
import MachineInventory from './pages/MachineInventory';
import ProductReturns from './pages/ProductReturns';
import ColdRoomMap from './pages/ColdRoomMap';
import BOMViewer from './pages/BOMViewer';
import DiffuserMachineBOM from './pages/DiffuserMachineBOM';
import ReplenishmentDashboard from './pages/ReplenishmentDashboard';
import RawMaterials from './pages/RawMaterials';
import Formulas from './pages/Formulas';
import ActivityLog from './pages/ActivityLog';
import ScentedProducts from './pages/ScentedProducts';
// TechStock retired 31/08/2026 — page kept at ./pages/TechStock for restoring.
import ThemeToggle from './components/ThemeToggle';

// SA Scent Stock Manager module shell — nav/routes/role-gating identical to
// the production SA App.jsx. Differences (platform integration only):
//   - login/forced-password-change removed (platform shell owns auth)
//   - routes live under /sa/* (wouter Router base)
//   - "Switch System" returns to the Module Picker
//   - user CRUD moved to the platform User Management (root reaches it
//     from the picker); the in-module Users page was platform-superseded
export default function SAModule({ user, onSwitchModule, onLogout }) {
  return (
    <ToastProvider>
      <Router base="/sa">
        <SAContent user={user} onSwitchModule={onSwitchModule} onLogout={onLogout} />
      </Router>
    </ToastProvider>
  );
}

function SAContent({ user, onSwitchModule, onLogout }) {
  const [location] = useLocation();

  // Technicians used to land on Tech Stock. That screen was retired on
  // 31/08/2026 — see the route below — so they land on the Dashboard like
  // everybody else. Leaving the redirect would drop them on a dead page.

  const isActive = (path) => (path === '/' ? location === '/' : location.startsWith(path));

  return (
    // .sa-scope — SA's theme-repaint CSS in index.css is scoped here so it
    // never bleeds into the SM module (which owns .sm-scope). Both modules'
    // [style*=…] inline-style overrides are wrapper-scoped (2026-07-10 fix).
    <div className="sa-scope" style={{ position: 'relative', zIndex: 1 }}>
      <nav className="nav">
        <div className="nav-container">
          {/* Brand */}
          <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
            <img src="/logo-dark.png" alt="Scent Australia" className="brand-logo-dark" />
            <img src="/logo-light.png" alt="Scent Australia" className="brand-logo-light" />
          </div>

          {/* Nav Links — identical to production SA App.jsx (minus Users,
              which is platform-level now via the Module Picker) */}
          <ul className="nav-links" style={{ flex: 1, justifyContent: 'center' }}>
            <li><Link href="/" className={isActive('/') ? 'nav-active' : ''}>Dashboard</Link></li>
            <li><Link href="/products" className={isActive('/products') ? 'nav-active' : ''}>Products</Link></li>
            <li><Link href="/fragrance-library" className={isActive('/fragrance-library') ? 'nav-active' : ''}>Fragrance Library</Link></li>
            <li><Link href="/machines" className={isActive('/machines') ? 'nav-active' : ''}>Diffusers</Link></li>
            <li><Link href="/returns" className={isActive('/returns') ? 'nav-active' : ''}>Returns</Link></li>
            {user.role !== 'technician' && (
              <li><Link href="/stock" className={isActive('/stock') ? 'nav-active' : ''}>Stock</Link></li>
            )}
            {user.role !== 'technician' && (<>
              <li><Link href="/cold-room-map" className={isActive('/cold-room-map') ? 'nav-active' : ''}>Fragrance Map</Link></li>
              {user.role !== 'user' && (
                <li><Link href="/replenishment" className={isActive('/replenishment') ? 'nav-active' : ''}>Demand Planning</Link></li>
              )}
              <li><Link href="/formulas" className={isActive('/formulas') ? 'nav-active' : ''}>Formulas</Link></li>
              {/* Scented nav hidden by owner 2026-07-24 ("not usable for now"). Route + page kept below; re-add this line to restore. */}
              {['admin', 'root'].includes(user.role) && (
                <li><Link href="/sku-mapping" className={isActive('/sku-mapping') ? 'nav-active' : ''}>SKU Mapping</Link></li>
              )}
            </>)}
            <li><Link href="/history" className={isActive('/history') ? 'nav-active' : ''}>History</Link></li>
            {['admin', 'root'].includes(user.role) && (
              <li><Link href="/activity" className={isActive('/activity') ? 'nav-active' : ''}>Activity</Link></li>
            )}
          </ul>

          {/* Right side: ThemeToggle + Switch System + Logout */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
            <ThemeToggle />
            <button
              onClick={onSwitchModule}
              style={{
                background: 'rgba(37, 99, 235, 0.08)',
                border: '1px solid rgba(37, 99, 235, 0.25)',
                borderRadius: '8px',
                cursor: 'pointer',
                color: '#60a5fa',
                fontWeight: '600',
                fontSize: '12px',
                padding: '6px 14px',
                fontFamily: 'Inter, sans-serif',
                whiteSpace: 'nowrap',
              }}
            >
              Switch System
            </button>
            <button
              onClick={onLogout}
              style={{
                background: 'rgba(248, 113, 113, 0.08)',
                border: '1px solid rgba(248, 113, 113, 0.2)',
                borderRadius: '8px',
                cursor: 'pointer',
                color: '#f87171',
                fontWeight: '600',
                fontSize: '12px',
                padding: '6px 14px',
                fontFamily: 'Inter, sans-serif',
                whiteSpace: 'nowrap',
              }}
            >
              Logout
            </button>
          </div>
        </div>
      </nav>

      <div style={{ padding: '24px 2rem', position: 'relative', zIndex: 1 }}>
        <Switch>
          <Route path="/"><Dashboard user={user} /></Route>
          {/* The keys are load-bearing. Both routes render the SAME component,
              so without them React reconciles one into the other and KEEPS ALL
              ITS STATE across the switch — the filtered list, the search box,
              the category chips, an open modal. Walking from Products to the
              Fragrance Library left the previous page's rows on screen, spare
              parts and all, until a hard refresh forced a remount. The owner hit
              this often enough to report it as "sempre tenho que dar Hard
              Refresh". A key makes them two pages again. */}
          <Route path="/products"><ProductManagement key="products" user={user} /></Route>
          <Route path="/fragrance-library"><ProductManagement key="fragrance-library" user={user} libraryMode /></Route>
          <Route path="/machines"><MachineInventory user={user} /></Route>
          <Route path="/returns"><ProductReturns user={user} /></Route>
          <Route path="/cold-room-map"><ColdRoomMap user={user} /></Route>
          <Route path="/stock"><StockManagement user={user} /></Route>
          <Route path="/replenishment">{!['user', 'technician'].includes(user?.role) ? <ReplenishmentDashboard user={user} /> : null}</Route>
          <Route path="/formulas"><Formulas user={user} /></Route>
          <Route path="/scented-products"><ScentedProducts user={user} /></Route>
          {/* Tech Stock retired by the owner, 31/08/2026. Not a fault in the
              screen: keeping a second stock ledger did not survive contact with
              the operation. The 28/08 count found the biggest gaps on exactly
              the oils the technicians move most — an order not entered, a
              withdrawal not taken off, a return not put back — so it goes back
              to one number per oil. The 255 L they were holding was folded into
              that count and their balances cleared.
              The page and its route are kept so an old bookmark explains itself
              instead of showing nothing; restore by putting <TechStock /> back. */}
          <Route path="/tech-stock">
            <div style={{ padding: 40, maxWidth: 620 }}>
              <h1 className="ed-title" style={{ marginBottom: 12 }}>Tech Stock has been retired</h1>
              <p style={{ color: 'var(--text-muted)', lineHeight: 1.7 }}>
                Fragrance is now held as one number per oil, as it was before. What the
                technicians were holding was included in the stock take of 28 August.
                Use <Link href="/returns" style={{ color: '#60a5fa' }}>Returns</Link> to put
                fragrance back, and <Link href="/history" style={{ color: '#60a5fa' }}>History</Link> to
                see what moved.
              </p>
            </div>
          </Route>
          <Route path="/bom"><BOMViewer user={user} /></Route>
          <Route path="/diffuser-bom"><DiffuserMachineBOM user={user} /></Route>
          <Route path="/sku-mapping">{['admin', 'root'].includes(user?.role) ? <SkuMapping user={user} /> : null}</Route>
          <Route path="/history"><TransactionHistory user={user} /></Route>
          <Route path="/activity">{['admin', 'root'].includes(user?.role) ? <ActivityLog user={user} /> : null}</Route>
          <Route path="/raw-materials"><RawMaterials user={user} /></Route>
        </Switch>
      </div>
    </div>
  );
}
