import { useState } from 'react'
import { useLocation } from 'wouter'
import { useAuth } from '../SMModule.jsx'
import {
  LayoutDashboard, ShoppingBag, Factory, Package, Archive,
  BookOpen, Users, ScanBarcode, Truck, RotateCcw,
  History, ScrollText, UserCog, LogOut, ChevronLeft, ChevronRight,
  Beaker, ClipboardList, Building2, Star, Briefcase, Tag, Box, FlaskConical,
  Sun, Moon, Send,
} from 'lucide-react'

function getInitialTheme() {
  if (typeof document === 'undefined') return 'dark'
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

// Sections with headers. Each section has items; headers render as small uppercase labels.
// Organized by mental model: SHARED workflows + SHARED inventory pool + MUSE world + SCENTED MERCHANDISE (B2B) + history/system.
const NAV_SECTIONS = [
  { items: [
    { path: '/', label: 'Dashboard', icon: LayoutDashboard, roles: ['root','admin','user'] },
  ]},
  { header: 'PRODUCTION', items: [
    { path: '/production-orders', label: 'Production Orders', icon: ShoppingBag, roles: ['root','admin','user'] },
    { path: '/manufacturing-queue', label: 'Manufacturing Queue', icon: Factory, roles: ['root','admin','user'] },
    { path: '/packing-records', label: 'Packing Records', icon: ClipboardList, roles: ['root','admin','user'] },
  ]},
  { header: 'OPERATIONS', items: [
    { path: '/barcode', label: 'Barcode Scanner', icon: ScanBarcode, roles: ['root','admin','user'] },
    { path: '/transfers-in', label: 'Incoming Transfers', icon: Send, roles: ['root','admin','user'] },
    { path: '/incoming-orders', label: 'Incoming Orders', icon: Truck, roles: ['root','admin','user'] },
    { path: '/external-processing', label: 'External Processing', icon: Send, roles: ['root','admin','user'] },
    { path: '/suppliers', label: 'Suppliers', icon: Building2, roles: ['root','admin','user'] },
    { path: '/returns', label: 'Returns', icon: RotateCcw, roles: ['root','admin','user'] },
  ]},
  { header: 'SHARED INVENTORY', items: [
    { path: '/stock', label: 'Stock Management', icon: Archive, roles: ['root','admin','user'] },
  ]},
  { header: 'SCENTED MERCHANDISE', items: [
    { path: '/customers', label: 'Clients', icon: Users, roles: ['root','admin','user'] },
    { path: '/standard/catalog', label: 'Standard Catalog', icon: Tag, roles: ['root','admin','user'] },
    { path: '/major-clients', label: 'Major Clients', icon: Briefcase, roles: ['root','admin','user'] },
    { path: '/bom-sm', label: 'Bill of Materials', icon: BookOpen, roles: ['root','admin','user'] },
    { path: '/sm-stock', label: 'Stock', icon: Package, roles: ['root','admin','user'] },
  ]},
  // view:'muse' — shown ONLY when the MUSE tile was picked (D7 amendment:
  // MUSE is a navigation view over this module; SM view hides these).
  { header: 'MUSE', view: 'muse', items: [
    { path: '/muse', label: 'Dashboard', icon: Star, roles: ['root','admin','user'] },
    { path: '/muse/products', label: 'Catalog', icon: Star, roles: ['root','admin','user'] },
    { path: '/bom-muse', label: 'Bill of Materials', icon: BookOpen, roles: ['root','admin','user'] },
    { path: '/muse-stock', label: 'Stock', icon: Package, roles: ['root','admin','user'] },
  ]},
  { header: 'HISTORY', view: 'both', items: [
    { path: '/transactions', label: 'Transaction History', icon: History, roles: ['root','admin','user'] },
    { path: '/activity-log', label: 'Activity Log', icon: ScrollText, roles: ['root','admin'] },
  ]},
  // SYSTEM section removed on the platform: user management is platform-level
  // (root reaches it from the Module Picker).
]

export default function Layout({ children }) {
  const [collapsed, setCollapsed] = useState(false)
  const [theme, setTheme] = useState(getInitialTheme)
  const [location, navigate] = useLocation()
  const { user, logout } = useAuth()

  // D7 amendment: the active tile decides the view (and the sidebar brand) —
  //   MUSE tile → MU:SE mark + only view:'muse'/'both' sections
  //   SM tile   → Scented Merchandise brand + everything except view:'muse'
  const activeView = (typeof localStorage !== 'undefined' && localStorage.getItem('platform_active_module')) === 'MUSE' ? 'muse' : 'sm'

  const sidebarWidth = collapsed ? 64 : 220

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    if (next === 'dark') document.documentElement.classList.add('dark')
    else document.documentElement.classList.remove('dark')
    try { localStorage.setItem('sm_theme', next) } catch {}
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg)' }}>
      {/* Sidebar */}
      <div style={{
        width: sidebarWidth, minHeight: '100vh',
        background: 'var(--card-bg)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
        transition: 'width 0.2s ease, background 0.2s ease',
        position: 'fixed', top: 0, left: 0, bottom: 0, zIndex: 100,
        overflowX: 'hidden'
      }}>
        {/* Logo */}
        <div style={{
          padding: collapsed ? '20px 0' : '20px 16px',
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: collapsed ? 'center' : 'space-between',
          minHeight: 64
        }}>
          {!collapsed && activeView === 'muse' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* MUSE view — the MU:SE editorial mark is the brand */}
              <img src="/logos/muse-logo-parchment.svg" alt="MU:SE" className="theme-dark-only" style={{ height: 22, display: 'block' }} />
              <img src="/logos/muse-logo-wine.svg" alt="MU:SE" className="theme-light-only" style={{ height: 22, display: 'block' }} />
              <div style={{ fontSize: 8.5, fontWeight: 600, letterSpacing: '0.22em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                Own Brand
              </div>
            </div>
          )}
          {!collapsed && activeView === 'sm' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* SM view — Scented Merchandise wordmark (D7: MUSE mark lives on its own tile) */}
              <div>
                <div className="serif" style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '0.02em', lineHeight: 1.1 }}>
                  Scented Merchandise
                </div>
                <div style={{ fontSize: 8.5, fontWeight: 600, letterSpacing: '0.22em', textTransform: 'uppercase', color: 'var(--text-muted)', marginTop: 3 }}>
                  Production &amp; Inventory
                </div>
              </div>
            </div>
          )}
          {collapsed && activeView === 'muse' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <img src="/logos/muse-colon-parchment.svg" alt="MU:SE" className="theme-dark-only" style={{ height: 22 }} />
              <img src="/logos/muse-colon-wine.svg" alt="MU:SE" className="theme-light-only" style={{ height: 22 }} />
            </div>
          )}
          {collapsed && activeView === 'sm' && (
            <div className="serif" style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '0.06em' }}>
              SM
            </div>
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            style={{
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              borderRadius: 6, padding: '4px 6px', cursor: 'pointer', color: 'var(--text-primary)',
              display: 'flex', alignItems: 'center'
            }}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: '8px 0', overflowY: 'auto' }}>
          {NAV_SECTIONS.map((section, sIdx) => {
            const sectionView = section.view || 'sm'
            if (activeView === 'muse' && sectionView === 'sm') return null
            if (activeView === 'sm' && sectionView === 'muse') return null
            // Filter items by role first to know if section has any visible items
            const visibleItems = section.items.filter(it => it.roles.includes(user?.role))
            if (visibleItems.length === 0) return null

            return (
              <div key={sIdx} style={{ marginBottom: 4 }}>
                {section.header && !collapsed && (
                  <div style={{
                    fontSize: 9, fontWeight: 800, color: 'var(--text-muted)',
                    letterSpacing: '0.12em', textTransform: 'uppercase',
                    padding: '12px 14px 4px',
                  }}>
                    {section.header}
                  </div>
                )}
                {section.header && collapsed && sIdx > 0 && (
                  <div style={{ height: 1, background: 'var(--border)', margin: '6px 8px' }} />
                )}
                {visibleItems.map(item => {
                  const isActive = location === item.path || (item.path !== '/' && location.startsWith(item.path))
                  const Icon = item.icon

                  return (
                    <button
                      key={item.path}
                      onClick={() => navigate(item.path)}
                      title={collapsed ? item.label : undefined}
                      className={isActive ? 'nav-active-glow' : undefined}
                      style={{
                        width: '100%',
                        background: isActive
                          ? (theme === 'light' ? 'rgba(97,36,40,0.05)' : 'var(--accent-soft)')
                          : 'transparent',
                        border: 'none',
                        borderLeft: isActive ? '3px solid var(--accent)' : '3px solid transparent',
                        color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                        padding: collapsed ? '10px 0' : '8px 14px',
                        display: 'flex', alignItems: 'center', gap: 10,
                        cursor: 'pointer', fontSize: 13, fontWeight: isActive ? 700 : 400,
                        justifyContent: collapsed ? 'center' : 'flex-start',
                        transition: 'all 0.15s ease',
                        whiteSpace: 'nowrap',
                        boxShadow: theme === 'dark' && isActive ? 'var(--shadow-glow)' : 'none',
                      }}
                      onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'var(--surface-2)' }}
                      onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent' }}
                    >
                      <Icon size={16} style={{ flexShrink: 0, color: isActive ? 'var(--accent)' : undefined }} />
                      {!collapsed && item.label}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </nav>

        {/* User / Logout */}
        <div style={{
          borderTop: '1px solid var(--border)',
          padding: collapsed ? '12px 0' : '12px 16px'
        }}>
          {!collapsed && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
              <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{user?.name}</div>
              <div style={{ textTransform: 'uppercase', fontSize: 10, color: 'var(--accent)', fontWeight: 700, letterSpacing: 1 }}>{user?.role}</div>
            </div>
          )}
          <button
            onClick={toggleTheme}
            title={collapsed ? (theme === 'dark' ? 'Light mode' : 'Dark mode') : undefined}
            style={{
              width: '100%', background: 'var(--surface-2)', border: '1px solid var(--border)',
              borderRadius: 6, color: 'var(--text-secondary)', padding: collapsed ? '8px 0' : '8px 12px',
              cursor: 'pointer', fontSize: 12, fontWeight: 600,
              display: 'flex', alignItems: 'center', gap: 8, justifyContent: collapsed ? 'center' : 'flex-start',
              marginBottom: 8,
            }}
          >
            {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            {!collapsed && (theme === 'dark' ? 'Light mode' : 'Dark mode')}
          </button>
          <button
            onClick={() => { localStorage.removeItem('platform_active_module'); window.location.href = '/' }}
            title={collapsed ? 'Switch System' : undefined}
            style={{
              width: '100%', background: 'rgba(37,99,235,0.1)', border: '1px solid rgba(37,99,235,0.25)',
              borderRadius: 6, color: '#60a5fa', padding: collapsed ? '8px 0' : '8px 12px',
              cursor: 'pointer', fontSize: 12, fontWeight: 600,
              display: 'flex', alignItems: 'center', gap: 8, justifyContent: collapsed ? 'center' : 'flex-start',
              marginBottom: 8,
            }}
          >
            <ChevronLeft size={14} />
            {!collapsed && 'Switch System'}
          </button>
          <button
            onClick={logout}
            title={collapsed ? 'Logout' : undefined}
            style={{
              width: '100%', background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.2)',
              borderRadius: 6, color: '#f87171', padding: collapsed ? '8px 0' : '8px 12px',
              cursor: 'pointer', fontSize: 12, fontWeight: 600,
              display: 'flex', alignItems: 'center', gap: 8, justifyContent: collapsed ? 'center' : 'flex-start'
            }}
          >
            <LogOut size={14} />
            {!collapsed && 'Logout'}
          </button>
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, marginLeft: sidebarWidth, transition: 'margin-left 0.2s ease', minHeight: '100vh' }}>
        {children}
      </div>
    </div>
  )
}
