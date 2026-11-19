import { useState } from 'react'
import { Construction, ChevronDown, ChevronUp } from 'lucide-react'

// Shown at the top of every MUSE screen (The Library, The Archive, The Atelier)
// while the MUSE Shopify store is still being finalised (owner, 19 Nov 2026).
// Remove it from Layout.jsx once the MUSE project is complete.
export default function DevelopmentNotice() {
  const [open, setOpen] = useState(false)
  return (
    <div role="note" style={{
      margin: '16px 28px 0', padding: '12px 16px', borderRadius: 10,
      background: 'rgba(212,181,116,0.10)', border: '1px solid rgba(212,181,116,0.35)',
      color: 'var(--text-primary)', fontSize: 13, lineHeight: 1.55,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Construction size={18} style={{ color: '#d4b574', flexShrink: 0 }} aria-hidden="true" />
        <strong style={{ letterSpacing: '0.02em' }}>MUSE — in development</strong>
        <span style={{ color: 'var(--text-secondary)', flex: '1 1 260px' }}>
          This area is being built alongside the MUSE Shopify store, which is still being finalised.
          Its design and functions will change as the store evolves.
        </span>
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open}
          style={{ background: 'none', border: 'none', color: 'var(--text-primary)', textDecoration: 'underline', textUnderlineOffset: 3, cursor: 'pointer', fontSize: 12, fontWeight: 700,
            display: 'flex', alignItems: 'center', gap: 4, padding: '4px 0', minHeight: 28 }}>
          {open ? 'Show less' : 'Read more'} {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>
      {open && (
        <div style={{ marginTop: 10, paddingLeft: 28, color: 'var(--text-secondary)', maxWidth: 760 }}>
          <p style={{ margin: '0 0 8px' }}>
            Development of the platform started before the MUSE store was finished, so it has had to follow every
            change made to the store along the way. Stock, stock movements and other functions have already been
            reworked four times as a result.
          </p>
          <p style={{ margin: '0 0 8px' }}>
            The foundations are already in use: MUSE stock is tracked, its movements and records are kept, and the
            first controls are in place. The tools are being refined together with the warehouse team, so that they
            fit the way the work is actually done.
          </p>
          <p style={{ margin: 0 }}>
            Once the MUSE store and its order structure (how orders are placed, built and fulfilled) are final,
            this area will be completed to match.
          </p>
        </div>
      )}
    </div>
  )
}
