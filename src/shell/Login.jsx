import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

export default function Login({ onLogin }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/platform/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        onLogin(data.token, data.user);
      } else {
        setError(data.error || 'Login failed');
      }
    } catch {
      setError('Connection error — please try again');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="center-screen">
      <div className="card" style={{ width: '100%', maxWidth: 400 }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
            <img src="/logo-dark.png" alt="Scent Australia" className="brand-logo-dark" style={{ height: 56 }} />
            <img src="/logo-light.png" alt="Scent Australia" className="brand-logo-light" style={{ height: 56 }} />
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Platform sign in</p>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Name</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
              autoComplete="username"
            />
          </div>
          <div className="form-group">
            <label>Password</label>
            <div style={{ position: 'relative' }}>
              <input
                className="input"
                type={showPwd ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                style={{ paddingRight: 40 }}
              />
              <button
                type="button"
                onClick={() => setShowPwd(!showPwd)}
                aria-label={showPwd ? 'Hide password' : 'Show password'}
                style={{
                  position: 'absolute',
                  right: 10,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  display: 'flex',
                }}
              >
                {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          {error && <div className="form-error">{error}</div>}
          <button className="btn btn-primary" style={{ width: '100%' }} disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
