import { Package, FlaskConical, Sparkles, Factory, Users, LogOut, Droplets, History, ClipboardList } from 'lucide-react';
import { SYSTEM_NAMES, SA_DISPLAY_NAME } from '../../shared/business-names.js';

// Module Picker — behavioral spec in PRD Appendix B.
// Tiles: SA / SM enabled by user.modules; a tile marked comingSoon shows but cannot open (The Archive, until it has products).
// No-access tiles are hidden (Appendix B default). B2: never auto-skip.
const MODULES = [
  {
    key: 'SA',
    title: SA_DISPLAY_NAME,
    subtitle: 'Oils · Machines · Demand Planning',
    icon: Package,
    logo: '/logo-light.png',       // Scent Australia wordmark (SA & SM share it, owner 2026-07-24)
    accent: '#2563eb',
  },
  {
    // D11: Production & Operations — a VIEW over the SM module (like MUSE/D7):
    // factory floor + warehouse + shared inventory, split out of the SM tile.
    // HIDDEN, not deleted (owner, 21 Oct 2026): unused — no packing, external
    // processing or purchase-order records, and MUSE orders close themselves
    // on shipment. Remove `hidden` to bring the tile back; routes stay live.
    hidden: true,
    key: 'OPS',
    title: 'Production & Operations',
    subtitle: 'Production orders · queue · warehouse',
    icon: Factory,
    logo: '/logo-light.png',       // part of Scent Australia — same mark
    accent: '#f59e0b',
    viewOf: 'SM',
  },
  // Six tiles, in the owner's order (PRD_LIBRARY_SECTORS.md §7, 23 Oct 2026):
  // SA Warehouse · Fragrance Library · The Atelier · The Archive · The Library
  // · History & Activity. The keys are what user.modules stores — never rename them.
  {
    // Its own area since Stage 1 (PRD_STAGE_1_FRAGRANCE_LIBRARY.md §2.1): every
    // oil across the main store, SA and MUSE — /library, over the SA API, so
    // still one engine and one numbering sequence. Shown to whoever has SA;
    // every SM and MUSE user has SA as well today (orchestrator, 26 Oct).
    key: 'FRAGLIB',
    title: 'Fragrance Library',
    subtitle: 'Main store · SA · MUSE',
    icon: Droplets,
    logo: '/fragrance-library.png', // the dropper-bottle mark the owner supplied
    accent: '#0ea5e9',
    viewOf: 'SA',
  },
  {
    // Every purchase order in one place (H4, PRD_H4_PURCHASE_ORDERS.md §2.1, O4):
    // raised in Shopify, accepted, received, corrected and cancelled here. Over the
    // SA API like the Fragrance Library. Not for technicians: suppliers and costs
    // are on it (R6), and the server refuses them too.
    key: 'PURCHASING',
    title: 'Purchase Orders',
    subtitle: 'Shopify orders · SA · MUSE',
    icon: ClipboardList,
    accent: '#14b8a6',
    viewOf: 'SA',
    roles: ['root', 'admin', 'user'],
  },
  {
    // The old Scented Merchandise B2B screens (clients, catalogs, major
    // clients). It is MUSE's Atelier, and absorbs "SA Custom Orders (Collab)"
    // (owner, 23 Oct).
    key: 'SM',
    title: SYSTEM_NAMES.SM,
    subtitle: 'MUSE · White Label · Custom',
    icon: FlaskConical,
    logo: '/logo-light.png',       // same mark as SA (owner decision)
    accent: '#b1545a',
  },
  {
    // MUSE's core collection. No product is registered to it yet (all 506 MUSE
    // finished goods are Library on 23 Oct), so the tile waits: its screens are
    // built on real data once the ten Archive fragrances are registered.
    key: 'ARCHIVE',
    title: 'The Archive',
    subtitle: 'MUSE · Core collection',
    icon: Sparkles,
    logo: '/logos/muse-logo-wine.svg',
    accent: '#d4b574',
    viewOf: 'SM',
    comingSoon: true,
  },
  {
    // MUSE is a VIEW over the SM module (same backend/segments) — the tile
    // opens the MUSE-only navigation. Entry requires SM (or explicit MUSE)
    // access. PRD D7 amended 2026-07-09 at owner request. Every MUSE product
    // today is a Library one, so this is The Library (owner, 23 Oct).
    key: 'MUSE',
    title: 'The Library',
    subtitle: 'MUSE · dashboard · catalog · stock',
    icon: Sparkles,
    logo: '/logos/muse-logo-wine.svg', // MUSE's own wordmark (wine, reads on the light plate)
    accent: '#d4b574',
    viewOf: 'SM',
  },
  {
    // Centralized cross-system History & Activity (owner 2026-07-28) — its own
    // top-level tile because it spans SA + Scented + MUSE, not any single module.
    // Admin/root only; opens the SM shell in a focused "Reports" view at /history.
    key: 'REPORTS',
    title: 'History & Activity',
    subtitle: 'Cross-system — SA · Atelier · MUSE',
    icon: History,
    accent: '#8b5cf6',
    viewOf: 'SM',
    roles: ['root', 'admin'],
  },
];

export default function ModulePicker({ user, onPick, onLogout, onOpenUsers }) {
  const canEnter = (m) => {
    if (m.hidden) return false;
    const mods = user.modules || [];
    if (m.roles && !m.roles.includes(user.role)) return false; // role-gated tiles (e.g. cross-system reports)
    if (mods.includes(m.key)) return true;
    if (m.viewOf && mods.includes(m.viewOf)) return true;
    return false;
  };
  const visible = MODULES.filter(canEnter);
  const hasAny = visible.length > 0;

  return (
    <div className="center-screen" style={{ flexDirection: 'column', gap: 8 }}>
      <div style={{ textAlign: 'center', marginBottom: 26 }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
          <img src="/logo-dark.png" alt="Scent Australia" className="brand-logo-dark" style={{ height: 48 }} />
          <img src="/logo-light.png" alt="Scent Australia" className="brand-logo-light" style={{ height: 48 }} />
        </div>
        <h1 style={{ fontSize: 24, marginBottom: 8 }}>Scent Australia Platform</h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
          Welcome, <strong>{user.name}</strong> — choose a system
        </p>
      </div>

      {!hasAny ? (
        // B7 — empty state
        <div className="card" style={{ maxWidth: 420, textAlign: 'center' }}>
          <p style={{ fontSize: 14, marginBottom: 6 }}>No systems enabled for your account.</p>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            Please contact an administrator to request access.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', justifyContent: 'center' }}>
          {visible.map((m) => {
            const Icon = m.icon;
            const disabled = m.comingSoon;
            return (
              <button
                key={m.key}
                onClick={() => !disabled && onPick(m.key)}
                disabled={disabled}
                className="module-tile"
                style={{
                  '--tile-accent': m.accent,
                  opacity: disabled ? 0.45 : 1,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                }}
              >
                {m.logo ? (
                  <div className="module-tile-logo">
                    <img src={m.logo} alt={m.title} />
                  </div>
                ) : (
                  <div className="module-tile-icon" style={{ background: `${m.accent}22`, color: m.accent }}>
                    <Icon size={30} />
                  </div>
                )}
                <div style={{ fontSize: 16, fontWeight: 800 }}>{m.title}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{m.subtitle}</div>
                {disabled && <span className="badge-soon">Coming soon</span>}
              </button>
            );
          })}
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, marginTop: 34, alignItems: 'center' }}>
        {user.role === 'root' && (
          <button className="btn btn-ghost" onClick={onOpenUsers}>
            <Users size={14} style={{ marginRight: 6, verticalAlign: -2 }} />
            User Management
          </button>
        )}
        <button className="btn btn-ghost btn-danger-ghost" onClick={onLogout}>
          <LogOut size={14} style={{ marginRight: 6, verticalAlign: -2 }} />
          Logout
        </button>
      </div>
    </div>
  );
}
