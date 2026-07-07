import { useState } from 'react';

// Forced password change (FR-AUTH-4) — blocks the whole app until resolved.
export default function ChangePassword({ user, onChanged, onLogout }) {
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (newPwd !== confirmPwd) return setError('Passwords do not match');
    if (newPwd.length < 6) return setError('Password must be at least 6 characters');
    if (newPwd.toLowerCase() === '#scent2026') return setError('Please choose a different password');

    setLoading(true);
    try {
      const res = await fetch('/api/platform/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPwd }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        onChanged(data.token, data.user);
      } else {
        setError(data.error || 'Failed to update password');
      }
    } catch {
      setError('Connection error — please try again');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="center-screen">
      <div className="card" style={{ width: '100%', maxWidth: 420, border: '1px solid rgba(251,191,36,0.35)' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 30, marginBottom: 8 }}>🔐</div>
          <h2 style={{ fontSize: 19, marginBottom: 8 }}>Password Change Required</h2>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            Hi <strong>{user.name}</strong>, you must set a new password before continuing.
          </p>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>New Password</label>
            <input
              className="input"
              type="password"
              value={newPwd}
              onChange={(e) => setNewPwd(e.target.value)}
              required
              minLength={6}
              placeholder="Min. 6 characters"
              autoFocus
            />
          </div>
          <div className="form-group">
            <label>Confirm Password</label>
            <input
              className="input"
              type="password"
              value={confirmPwd}
              onChange={(e) => setConfirmPwd(e.target.value)}
              required
              placeholder="Repeat new password"
            />
          </div>
          {error && <div className="form-error">{error}</div>}
          <button className="btn btn-primary" style={{ width: '100%' }} disabled={loading}>
            {loading ? 'Saving...' : 'Set New Password'}
          </button>
        </form>
        <div style={{ marginTop: 14, textAlign: 'center' }}>
          <button className="link-muted" onClick={onLogout}>Logout</button>
        </div>
      </div>
    </div>
  );
}
