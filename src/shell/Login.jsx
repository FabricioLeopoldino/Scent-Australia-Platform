import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { GlowingEffect } from '../sa/components/GlowingEffect';

export default function Login({ onLogin }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e?.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/platform/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) onLogin(data.token, data.user);
      else setError(data.error || 'Login failed');
    } catch {
      setError('Connection error — please try again');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20, position: 'relative', overflow: 'hidden', background: 'var(--background)' }}>
      {/* Ambient brand glows — static (no WebGL), respects reduced motion by being animation-free */}
      <div aria-hidden style={{ position: 'absolute', top: '-15%', left: '-10%', width: 520, height: 520, borderRadius: '50%', background: 'radial-gradient(circle, rgba(34,197,94,0.18), transparent 65%)', filter: 'blur(40px)', pointerEvents: 'none' }} />
      <div aria-hidden style={{ position: 'absolute', bottom: '-20%', right: '-12%', width: 560, height: 560, borderRadius: '50%', background: 'radial-gradient(circle, rgba(99,179,237,0.15), transparent 65%)', filter: 'blur(50px)', pointerEvents: 'none' }} />

      <div style={{ position: 'relative', width: '100%', maxWidth: 408, background: 'var(--surface)', border: '1px solid var(--border-hover)', borderRadius: 22, padding: '38px 34px', boxShadow: 'var(--shadow-lg)' }}>
        <GlowingEffect spread={44} glow={false} disabled={false} proximity={100} inactiveZone={0.1} borderWidth={1.5} />

        <div style={{ textAlign: 'center', marginBottom: 30 }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
            <img src="/logo-dark.png" alt="Scent Australia" className="brand-logo-dark" style={{ height: 60 }} />
            <img src="/logo-light.png" alt="Scent Australia" className="brand-logo-light" style={{ height: 60 }} />
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 600 }}>Platform sign in</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="login-name">Name</label>
            <input id="login-name" className="input" value={name} onChange={(e) => setName(e.target.value)} required autoFocus autoComplete="username" />
          </div>
          <div className="form-group">
            <label htmlFor="login-pwd">Password</label>
            <div style={{ position: 'relative' }}>
              <input id="login-pwd" className="input" type={showPwd ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" style={{ paddingRight: 40 }} />
              <button type="button" onClick={() => setShowPwd(!showPwd)} aria-label={showPwd ? 'Hide password' : 'Show password'}
                style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex' }}>
                {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          {error && <div className="form-error">{error}</div>}
          <button type="submit" className="login-cta" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
