import { useState, useEffect } from 'react'

// Returns true when the app is in dark mode. The theme is a `dark` class on
// <html> toggled outside React (in Layout), so we watch it with a
// MutationObserver and re-render when it flips.
export function useIsDark() {
  const [dark, setDark] = useState(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  )
  useEffect(() => {
    const el = document.documentElement
    const update = () => setDark(el.classList.contains('dark'))
    const obs = new MutationObserver(update)
    obs.observe(el, { attributes: true, attributeFilter: ['class'] })
    update()
    return () => obs.disconnect()
  }, [])
  return dark
}

// Foreground "ink" for canvas/SVG that CSS can't remap (barcodes, etc.).
// Near-white in dark; Deep Shadow in light — so it never vanishes on parchment.
export function useInkColor() {
  return useIsDark() ? '#e8eaf2' : '#1b0905'
}
