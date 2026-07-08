export default function ConfirmModal({ title, message, onConfirm, onCancel, confirmLabel = 'Confirm', danger = true }) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
        {title && (
          <div className="modal-header">
            <h2>{title}</h2>
            <button className="modal-close" onClick={onCancel}>×</button>
          </div>
        )}
        <div className="modal-body">
          <p style={{ color: 'var(--text-primary)', fontSize: 14, lineHeight: 1.6, margin: 0 }}>{message}</p>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          <button className={danger ? 'btn btn-danger' : 'btn btn-primary'} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
