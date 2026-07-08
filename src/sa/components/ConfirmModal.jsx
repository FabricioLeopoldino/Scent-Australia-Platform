export default function ConfirmModal({ message, onConfirm, onCancel }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 99998,
      background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: 'var(--card-bg, #151c2c)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: '14px',
        padding: '28px 32px',
        maxWidth: '420px', width: '90%',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        fontFamily: 'Inter, sans-serif',
      }}>
        <p style={{
          color: 'var(--text-primary, #e2e8f0)',
          fontSize: '15px', lineHeight: '1.6',
          margin: '0 0 24px 0',
        }}>{message}</p>
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{
            padding: '8px 20px', borderRadius: '8px',
            background: 'var(--surface-2)',
            border: '1px solid rgba(128,128,128,0.2)',
            color: 'var(--text-secondary, #94a3b8)',
            cursor: 'pointer', fontSize: '13px', fontWeight: '500',
          }}>Cancel</button>
          <button onClick={onConfirm} style={{
            padding: '8px 20px', borderRadius: '8px',
            background: 'rgba(239,68,68,0.15)',
            border: '1px solid rgba(239,68,68,0.35)',
            color: '#f87171',
            cursor: 'pointer', fontSize: '13px', fontWeight: '600',
          }}>Confirm</button>
        </div>
      </div>
    </div>
  );
}
