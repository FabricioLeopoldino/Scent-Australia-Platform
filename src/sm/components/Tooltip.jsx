import { useState, useRef } from 'react'

export default function Tooltip({ text, children, position = 'top', maxWidth = 220 }) {
  const [visible, setVisible] = useState(false)
  const [coords, setCoords] = useState({ top: 0, left: 0 })
  const ref = useRef(null)

  function handleEnter() {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    const offset = 10
    let top, left
    if (position === 'top') {
      top = rect.top - offset
      left = rect.left + rect.width / 2
    } else if (position === 'bottom') {
      top = rect.bottom + offset
      left = rect.left + rect.width / 2
    } else if (position === 'right') {
      top = rect.top + rect.height / 2
      left = rect.right + offset
    } else {
      top = rect.top + rect.height / 2
      left = rect.left - offset
    }
    setCoords({ top, left })
    setVisible(true)
  }

  const transformMap = {
    top:    'translate(-50%, -100%)',
    bottom: 'translate(-50%, 0)',
    right:  'translate(0, -50%)',
    left:   'translate(-100%, -50%)',
  }

  return (
    <>
      <span ref={ref} onMouseEnter={handleEnter} onMouseLeave={() => setVisible(false)} style={{ display: 'inline-flex', alignItems: 'center' }}>
        {children}
      </span>
      {visible && (
        <div style={{
          position: 'fixed',
          top: coords.top,
          left: coords.left,
          transform: transformMap[position],
          background: 'rgba(10,10,20,0.97)',
          backdropFilter: 'blur(12px)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 10,
          padding: '8px 12px',
          fontSize: 12,
          color: 'rgba(232,234,242,0.85)',
          lineHeight: 1.55,
          maxWidth,
          zIndex: 99999,
          pointerEvents: 'none',
          boxShadow: '0 8px 32px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.06)',
          whiteSpace: 'pre-wrap',
        }}>
          {text}
        </div>
      )}
    </>
  )
}

export function InfoIcon({ text, size = 13, position, maxWidth }) {
  return (
    <Tooltip text={text} position={position || 'top'} maxWidth={maxWidth || 220}>
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 16, height: 16,
        background: 'rgba(96,165,250,0.12)',
        border: '1px solid rgba(96,165,250,0.25)',
        borderRadius: '50%',
        fontSize: 10, fontWeight: 700,
        color: 'rgba(96,165,250,0.7)',
        cursor: 'help', lineHeight: 1,
        userSelect: 'none', flexShrink: 0,
        transition: 'background 0.15s, border-color 0.15s',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(96,165,250,0.2)'; e.currentTarget.style.borderColor = 'rgba(96,165,250,0.5)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'rgba(96,165,250,0.12)'; e.currentTarget.style.borderColor = 'rgba(96,165,250,0.25)' }}
      >i</span>
    </Tooltip>
  )
}
