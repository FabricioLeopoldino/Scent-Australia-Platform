import { Package, FlaskConical, Sparkles, Users, LogOut } from 'lucide-react';

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
    key: 'SM',
    title: 'Scented Merchandise',
    subtitle: 'Production Orders · B2B Clients',
    icon: FlaskConical,
    accent: '#b1545a',
  },
  {
    key: 'MUSE',
    title: 'MUSE',
    subtitle: 'Own brand — coming soon',
    icon: Sparkles,
    accent: '#d4b574',
    comingSoon: true,
  },
];

export default function ModulePicker({ user, onPick, onLogout, onOpenUsers }) {
  const visible = MODULES.filter(
    (m) => m.comingSoon || (user.modules || []).includes(m.key)
  );
  const hasAny = visible.some((m) => !m.comingSoon);

  return (
    <div className="center-screen" style={{ flexDirection: 'column', gap: 8 }}>
      <div style={{ textAlign: 'center', marginBottom: 26 }}>
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
