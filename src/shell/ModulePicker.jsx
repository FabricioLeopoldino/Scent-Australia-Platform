import { Package, FlaskConical, Sparkles, Factory, Users, LogOut } from 'lucide-react';

// Module Picker — behavioral spec in PRD Appendix B.
// Tiles: SA / SM enabled by user.modules; MUSE always "Coming soon" (B6).
// No-access tiles are hidden (Appendix B default). B2: never auto-skip.
const MODULES = [
  {
    key: 'SA',
    title: 'Scent Stock Manager',
    subtitle: 'Oils · Machines · Demand Planning',
    icon: Package,
    accent: '#2563eb',
  },
  {
    // D11: Production & Operations — a VIEW over the SM module (like MUSE/D7):
    // factory floor + warehouse + shared inventory, split out of the SM tile.
    key: 'OPS',
    title: 'Production & Operations',
    subtitle: 'Production orders · queue · warehouse',
    icon: Factory,
    accent: '#f59e0b',
    viewOf: 'SM',
  },
  {
    key: 'SM',
    title: 'Scented Merchandise',
    subtitle: 'B2B clients · catalogs',
    icon: FlaskConical,
    accent: '#b1545a',
  },
  {
    // MUSE is a VIEW over the SM module (same backend/segments) — the tile
    // opens the MUSE-only navigation. Entry requires SM (or explicit MUSE)
    // access. PRD D7 amended 2026-07-09 at owner request.
    key: 'MUSE',
    title: 'MUSE',
    subtitle: 'Own brand — dashboard · catalog · stock',
    icon: Sparkles,
    accent: '#d4b574',
    viewOf: 'SM',
  },
];

export default function ModulePicker({ user, onPick, onLogout, onOpenUsers }) {
  const canEnter = (m) => {
    const mods = user.modules || [];
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
                <div
                  className="module-tile-icon"
                  style={{ background: `${m.accent}22`, color: m.accent }}
                >
                  <Icon size={30} />
                </div>
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
