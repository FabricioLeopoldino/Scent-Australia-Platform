import { useState, useEffect, useCallback, createContext, useContext, useRef } from 'react';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timerRefs = useRef({});

  const showToast = useCallback((message, type = 'info', duration = 3500) => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type }]);
    timerRefs.current[id] = setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
      delete timerRefs.current[id];
    }, duration);
    return id;
  }, []);

  const removeToast = useCallback((id) => {
    clearTimeout(timerRefs.current[id]);
    delete timerRefs.current[id];
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  useEffect(() => {
    return () => Object.values(timerRefs.current).forEach(clearTimeout);
  }, []);

  const icons = {
    success: '✓',
    error: '✕',
    info: 'ℹ',
    warning: '⚠',
  };

  const colors = {
    success: { bg: 'rgba(34,197,94,0.12)', border: 'rgba(34,197,94,0.35)', text: '#4ade80', icon: '#22c55e' },
    error:   { bg: 'rgba(239,68,68,0.12)',  border: 'rgba(239,68,68,0.35)',  text: '#f87171', icon: '#ef4444' },
    info:    { bg: 'rgba(99,179,237,0.12)', border: 'rgba(99,179,237,0.35)', text: '#93c5fd', icon: '#60a5fa' },
    warning: { bg: 'rgba(251,191,36,0.12)', border: 'rgba(251,191,36,0.35)', text: '#fcd34d', icon: '#f59e0b' },
  };

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div style={{
        position: 'fixed', bottom: '24px', right: '24px',
        zIndex: 99999, display: 'flex', flexDirection: 'column', gap: '10px',
        pointerEvents: 'none',
      }}>
        {toasts.map(toast => {
          const c = colors[toast.type] || colors.info;
          return (
            <div key={toast.id} style={{
              display: 'flex', alignItems: 'flex-start', gap: '10px',
              background: c.bg,
              border: `1px solid ${c.border}`,
              borderRadius: '10px',
              padding: '12px 16px',
              minWidth: '260px', maxWidth: '380px',
              backdropFilter: 'blur(12px)',
              boxShadow: `0 4px 20px rgba(0,0,0,0.3), 0 0 0 1px ${c.border}`,
              pointerEvents: 'all',
              animation: 'toastIn 0.25s ease',
              fontFamily: 'Inter, sans-serif',
            }}>
              <span style={{
                width: '20px', height: '20px', borderRadius: '50%',
                background: c.icon, color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '11px', fontWeight: '700', flexShrink: 0, marginTop: '1px',
              }}>{icons[toast.type]}</span>
              <span style={{ color: c.text, fontSize: '13.5px', lineHeight: '1.45', flex: 1 }}>
                {toast.message}
              </span>
              <button onClick={() => removeToast(toast.id)} style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: c.text, opacity: 0.6, fontSize: '14px', padding: '0 0 0 4px',
                lineHeight: 1, flexShrink: 0,
              }}>✕</button>
            </div>
          );
        })}
      </div>
      <style>{`@keyframes toastIn { from { opacity:0; transform:translateX(20px);} to { opacity:1; transform:translateX(0);} }`}</style>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx.showToast;
}
