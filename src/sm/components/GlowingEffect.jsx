import { memo, useCallback, useEffect, useRef } from 'react'

const GlowingEffect = memo(({
  inactiveZone = 0.1,
  proximity = 80,
  spread = 30,
  disabled = false,
  borderWidth = 1.5,
}) => {
  const containerRef  = useRef(null)
  const borderRef     = useRef(null)
  const lastPos       = useRef({ x: 0, y: 0 })
  const currentAngle  = useRef(0)
  const targetAngle   = useRef(0)
  const rafId         = useRef(0)
  const isAnimating   = useRef(false)

  const tick = useCallback(() => {
    const border = borderRef.current
    if (!border) return
    const diff = ((targetAngle.current - currentAngle.current + 180) % 360) - 180
    currentAngle.current += diff * 0.08
    border.style.setProperty('--start', String(currentAngle.current))
    if (Math.abs(diff) > 0.15) {
      rafId.current = requestAnimationFrame(tick)
    } else {
      isAnimating.current = false
    }
  }, [])

  const handleMove = useCallback((e) => {
    const container = containerRef.current
    const border    = borderRef.current
    if (!container || !border) return

    const { left, top, width, height } = container.getBoundingClientRect()
    const mx = e?.clientX ?? lastPos.current.x
    const my = e?.clientY ?? lastPos.current.y
    if (e) lastPos.current = { x: mx, y: my }

    const cx = left + width  * 0.5
    const cy = top  + height * 0.5
    const dist = Math.hypot(mx - cx, my - cy)

    if (dist < 0.5 * Math.min(width, height) * inactiveZone) {
      border.style.opacity = '0'
      return
    }

    const active =
      mx > left - proximity && mx < left + width  + proximity &&
      my > top  - proximity && my < top  + height + proximity

    border.style.opacity = active ? '1' : '0'
    if (!active) return

    targetAngle.current = (180 * Math.atan2(my - cy, mx - cx)) / Math.PI + 90
    if (!isAnimating.current) {
      isAnimating.current = true
      rafId.current = requestAnimationFrame(tick)
    }
  }, [inactiveZone, proximity, tick])

  useEffect(() => {
    if (disabled) return
    const onMove   = (e) => handleMove(e)
    const onScroll = ()  => handleMove()
    document.body.addEventListener('pointermove', onMove,   { passive: true })
    window.addEventListener       ('scroll',      onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(rafId.current)
      document.body.removeEventListener('pointermove', onMove)
      window.removeEventListener       ('scroll',      onScroll)
    }
  }, [handleMove, disabled])

  if (disabled) return null

  const spread2 = spread * 2
  const gradient = `
    radial-gradient(circle, #3b82f6 10%, transparent 20%),
    radial-gradient(circle at 40% 40%, #1d4ed8 5%, transparent 15%),
    radial-gradient(circle at 60% 60%, #60a5fa 10%, transparent 20%),
    radial-gradient(circle at 40% 60%, #1e40af 10%, transparent 20%),
    repeating-conic-gradient(
      from 236.84deg at 50% 50%,
      #3b82f6   0%,
      #1d4ed8   calc(25%  / 5),
      #60a5fa   calc(50%  / 5),
      #1e40af   calc(75%  / 5),
      #3b82f6   calc(100% / 5)
    )
  `

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute', inset: 0,
        borderRadius: 'inherit',
        pointerEvents: 'none',
        overflow: 'visible',
      }}
    >
      <div
        ref={borderRef}
        style={{
          '--start':  '0',
          '--spread': spread,
          position: 'absolute',
          inset: `${-borderWidth}px`,
          borderRadius: 'inherit',
          border: `${borderWidth}px solid transparent`,
          background: gradient,
          backgroundAttachment: 'fixed',
          opacity: 0,
          transition: 'opacity 0.3s ease',
          WebkitMaskImage:     `linear-gradient(#0000,#0000), conic-gradient(from calc((var(--start) - ${spread}) * 1deg), #0000 0deg, #fff, #0000 ${spread2}deg)`,
          WebkitMaskClip:      'padding-box, border-box',
          WebkitMaskComposite: 'source-in',
          maskImage:           `linear-gradient(#0000,#0000), conic-gradient(from calc((var(--start) - ${spread}) * 1deg), #0000 0deg, #fff, #0000 ${spread2}deg)`,
          maskClip:            'padding-box, border-box',
          maskComposite:       'intersect',
        }}
      />
    </div>
  )
})

GlowingEffect.displayName = 'GlowingEffect'
export default GlowingEffect
