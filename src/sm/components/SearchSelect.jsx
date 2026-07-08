import { useState, useEffect, useRef } from 'react'
import { Search, Check } from 'lucide-react'

/**
 * SearchSelect — themed dropdown that works inside modals (uses fixed positioning)
 *
 * Props:
 *   value        — current value (string or number)
 *   onChange     — (value) => void
 *   options      — [{ value, label, sub?, badge?, badgeColor? }]
 *   placeholder  — string
 *   clearable    — show "clear" option when something is selected (default true)
 *   searchable   — show search box (default true when options > 6)
 *   disabled     — bool
 */
export default function SearchSelect({
  value,
  onChange,
  options = [],
  placeholder = 'Select...',
  clearable = true,
  searchable,
  disabled = false,
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [panelStyle, setPanelStyle] = useState({})
  const btnRef = useRef(null)
  const panelRef = useRef(null)
  const searchRef = useRef(null)

  const showSearch = searchable !== undefined ? searchable : options.length > 6

  const selected = options.find(o => String(o.value) === String(value))

  const filtered = !search
    ? options
    : options.filter(o =>
        o.label.toLowerCase().includes(search.toLowerCase()) ||
        (o.sub || '').toLowerCase().includes(search.toLowerCase())
      )

  function openPanel() {
    if (disabled) return
    const rect = btnRef.current?.getBoundingClientRect()
    if (!rect) return
    const spaceBelow = window.innerHeight - rect.bottom
    const panelH = Math.min(280, options.length * 40 + (showSearch ? 52 : 0) + 8)
    const above = spaceBelow < panelH + 8 && rect.top > panelH + 8
    setPanelStyle({
      position: 'fixed',
      left: rect.left,
      width: rect.width,
      ...(above
        ? { bottom: window.innerHeight - rect.top + 4, top: 'auto' }
        : { top: rect.bottom + 4, bottom: 'auto' }),
      zIndex: 99999,
    })
    setOpen(true)
    setSearch('')
  }

  useEffect(() => {
    if (open && showSearch) {
      setTimeout(() => searchRef.current?.focus(), 30)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    function onDown(e) {
      if (!panelRef.current?.contains(e.target) && !btnRef.current?.contains(e.target)) {
        setOpen(false)
      }
    }
    function onScroll() { setOpen(false) }
    document.addEventListener('mousedown', onDown)
    // Listen on window (non-capture) — only fires when the page itself scrolls,
    // NOT when overflow containers like modals scroll internally.
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', onScroll)
    }
  }, [open])

  function pick(val) {
    onChange(val)
    setOpen(false)
    setSearch('')
  }

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      {/* Trigger button */}
      <button
        ref={btnRef}
        type="button"
        onClick={() => open ? setOpen(false) : openPanel()}
        disabled={disabled}
        style={{
          width: '100%',
          background: 'var(--field-bg)',
          border: `1px solid ${open ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: 8,
          padding: '8px 32px 8px 12px',
          color: selected ? 'var(--text-primary)' : 'var(--text-muted)',
          fontSize: 13,
          cursor: disabled ? 'not-allowed' : 'pointer',
          textAlign: 'left',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          opacity: disabled ? 0.5 : 1,
          outline: 'none',
          position: 'relative',
          transition: 'border-color 0.15s',
          minHeight: 38,
        }}
      >
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected ? (
            <span>
              {selected.label}
              {selected.badge && (
                <span style={{
                  marginLeft: 8, fontSize: 10, fontWeight: 600,
                  color: selected.badgeColor || 'var(--accent-text)',
                }}>
                  {selected.badge}
                </span>
              )}
            </span>
          ) : placeholder}
        </span>
        <span style={{
          position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
          color: 'var(--text-muted)', fontSize: 10, lineHeight: 1, pointerEvents: 'none',
          transition: 'transform 0.15s',
        }}>
          {open ? '▲' : '▼'}
        </span>
      </button>

      {/* Panel — fixed so it escapes modal overflow */}
      {open && (
        <div
          ref={panelRef}
          style={{
            ...panelStyle,
            background: 'var(--popover-bg)',
            border: '1px solid var(--border-h)',
            borderRadius: 10,
            boxShadow: 'var(--shadow-md)',
            display: 'flex',
            flexDirection: 'column',
            maxHeight: 300,
            overflow: 'hidden',
          }}
        >
          {/* Search */}
          {showSearch && (
            <div style={{ padding: '8px 8px 6px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <div style={{ position: 'relative' }}>
                <Search size={12} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
                <input
                  ref={searchRef}
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search..."
                  onKeyDown={e => e.key === 'Escape' && setOpen(false)}
                  style={{
                    width: '100%', background: 'var(--field-bg)',
                    border: '1px solid var(--border)', borderRadius: 7,
                    padding: '6px 10px 6px 28px', color: 'var(--text-primary)', fontSize: 12, outline: 'none',
                  }}
                />
              </div>
            </div>
          )}

          {/* Options */}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {clearable && selected && (
              <Opt label="— Clear —" sub={null} selected={false} faded onClick={() => pick('')} />
            )}
            {filtered.length === 0 ? (
              <div style={{ padding: '14px 12px', fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>No results</div>
            ) : filtered.map(opt => (
              <Opt
                key={opt.value}
                label={opt.label}
                sub={opt.sub}
                badge={opt.badge}
                badgeColor={opt.badgeColor}
                selected={String(opt.value) === String(value)}
                onClick={() => pick(opt.value)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Opt({ label, sub, badge, badgeColor, selected, faded, onClick }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: '100%', background: selected ? 'var(--accent-soft)' : hover ? 'var(--surface-2)' : 'transparent',
        border: 'none', borderBottom: '1px solid var(--border)',
        padding: '8px 12px', cursor: 'pointer', textAlign: 'left', display: 'block',
        opacity: faded ? 0.45 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {selected && <Check size={12} style={{ color: 'var(--accent-text)', flexShrink: 0 }} />}
        <span style={{ fontSize: 12, color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        {badge && (
          <span style={{ fontSize: 10, fontWeight: 600, color: badgeColor || 'var(--accent-text)', flexShrink: 0 }}>
            {badge}
          </span>
        )}
      </div>
      {sub && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, paddingLeft: selected ? 18 : 0 }}>{sub}</div>}
    </button>
  )
}
