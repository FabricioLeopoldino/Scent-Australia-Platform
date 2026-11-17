// Brand header used at the top of every /muse-* page. Swaps logo variant by theme:
// dark → Parchment (light logo on dark bg), light → Wine Stain (logo in brand wine).
import { COLLECTION_NAMES, activeCollection } from '../collection.js'

export default function MuseHeader({ subtitle }) {
  // Every MUSE page says whose products it is listing (the open tile).
  const collection = COLLECTION_NAMES[activeCollection()]
  if (collection) subtitle = subtitle ? `${collection} · ${subtitle}` : collection
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '8px 0 18px',
      borderBottom: '1px solid var(--border)',
      marginBottom: 20,
    }}>
      <img src="/logos/muse-logo-parchment.svg" alt="MUSE" className="theme-dark-only" style={{ height: 28 }} />
      <img src="/logos/muse-logo-wine.svg" alt="MUSE" className="theme-light-only" style={{ height: 28 }} />
      {subtitle && (
        <span style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1.5, paddingTop: 2 }}>
          {subtitle}
        </span>
      )}
    </div>
  )
}
