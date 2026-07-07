import { useEffect, useState } from 'react';

// Phase 0 placeholder shell. Phase 1 replaces this with:
// Login → forced password change → Module Picker → module routes.
export default function App() {
  const [health, setHealth] = useState(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ status: 'error' }));
  }, []);

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
      }}
    >
      <h1 style={{ fontSize: 28, letterSpacing: '0.02em' }}>Scent Australia Platform</h1>
      <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
        Foundation scaffold — Phase 0
      </p>
      <div
        style={{
          padding: '10px 18px',
          borderRadius: 10,
          border: '1px solid var(--border)',
          background: 'var(--surface)',
          fontSize: 13,
          color:
            health?.status === 'ok' ? '#4ade80' : health ? '#f87171' : 'var(--text-muted)',
        }}
      >
        API: {health ? health.status : 'checking...'}
        {health?.db === false && ' (database not configured yet)'}
      </div>
    </div>
  );
}
