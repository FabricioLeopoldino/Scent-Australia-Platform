// Ghost/quiet row-action icon button — standardized across all tables.
// Transparent until hover (soft wine wash + wine icon). variant="danger" → red on hover.
// Styling lives in index.css (.icon-btn / .icon-btn.danger).
export default function IconButton({ variant = 'default', className = '', title, children, ...props }) {
  const cls = ['icon-btn', variant === 'danger' ? 'danger' : '', className].filter(Boolean).join(' ')
  return (
    <button type="button" title={title} className={cls} {...props}>
      {children}
    </button>
  )
}
