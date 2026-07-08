// Standardized editorial button used across the whole app.
// variant: 'primary' (default) | 'secondary' | 'danger' | 'ghost'
// size:    'md' (default) | 'sm' | 'lg'
// Styling lives in index.css (.btn / .btn-*). Works in light + dark via tokens.
export default function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  type = 'button',
  children,
  ...props
}) {
  const classes = [
    'btn',
    `btn-${variant}`,
    size === 'sm' ? 'btn-sm' : size === 'lg' ? 'btn-lg' : '',
    className,
  ].filter(Boolean).join(' ')

  return (
    <button type={type} className={classes} {...props}>
      {children}
    </button>
  )
}
