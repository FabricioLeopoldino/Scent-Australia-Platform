import { useEffect } from 'react';
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
import Attachments from './pages/Attachments';
import ReplenishmentDashboard from './pages/ReplenishmentDashboard';
import RawMaterials from './pages/RawMaterials';
import Formulas from './pages/Formulas';
import ActivityLog from './pages/ActivityLog';
import ScentedProducts from './pages/ScentedProducts';
import TechStock from './pages/TechStock';
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
  const [location, setLocation] = useLocation();

  // SA behavior preserved: technicians land on Tech Stock
  useEffect(() => {
    if (user.role === 'technician' && (location === '/' || location === '')) {
      setLocation('/tech-stock');
    }
  }, [user.role, location]);

  const isActive = (path) => (path === '/' ? location === '/' : location.startsWith(path));

  return (
    <div style={{ position: 'relative', zIndex: 1 }}>
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
              <li><Link href="/scented-products" className={isActive('/scented-products') ? 'nav-active' : ''}>Scented</Link></li>
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
          <Route path="/"><Dashboard /></Route>
          <Route path="/products"><ProductManagement user={user} /></Route>
          <Route path="/machines"><MachineInventory user={user} /></Route>
          <Route path="/returns"><ProductReturns user={user} /></Route>
          <Route path="/cold-room-map"><ColdRoomMap user={user} /></Route>
          <Route path="/stock"><StockManagement user={user} /></Route>
          <Route path="/replenishment">{user?.role !== 'user' ? <ReplenishmentDashboard user={user} /> : null}</Route>
          <Route path="/formulas"><Formulas user={user} /></Route>
          <Route path="/scented-products"><ScentedProducts user={user} /></Route>
          <Route path="/tech-stock"><TechStock user={user} /></Route>
          <Route path="/bom"><BOMViewer user={user} /></Route>
          <Route path="/diffuser-bom"><DiffuserMachineBOM user={user} /></Route>
          <Route path="/sku-mapping">{['admin', 'root'].includes(user?.role) ? <SkuMapping user={user} /> : null}</Route>
          <Route path="/attachments"><Attachments user={user} /></Route>
          <Route path="/history"><TransactionHistory user={user} /></Route>
          <Route path="/activity">{['admin', 'root'].includes(user?.role) ? <ActivityLog user={user} /> : null}</Route>
          <Route path="/raw-materials"><RawMaterials user={user} /></Route>
        </Switch>
      </div>
    </div>
  );
}
