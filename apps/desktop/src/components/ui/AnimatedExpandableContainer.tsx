import React, { useEffect, useRef, useState } from 'react'

/**
 * AnimatedExpandableContainer (Twenty-style)
 *
 * Smoothly height-animates expand/collapse using the CSS `grid-template-rows`
 * `0fr -> 1fr` trick. No JS height measuring, no external deps — works cleanly
 * in this Vite/React setup and avoids layout thrash.
 *
 * Brutalist: no rounded corners. Honors `prefers-reduced-motion` (becomes
 * instant when the user has reduced motion enabled).
 *
 * @example
 * const [open, setOpen] = useState(false)
 * return (
 *   <>
 *     <button onClick={() => setOpen(o => !o)}>Toggle</button>
 *     <AnimatedExpandableContainer isExpanded={open}>
 *       <div style={{ padding: 12 }}>Hidden content that slides open.</div>
 *     </AnimatedExpandableContainer>
 *   </>
 * )
 */
export interface AnimatedExpandableContainerProps {
  /** When true the container animates open; when false it collapses to 0 height. */
  isExpanded: boolean
  /** Content to reveal/hide. */
  children: React.ReactNode
  /** Transition duration in ms. Default 120 (matches the tachi motion language). */
  durationMs?: number
  /** Optional className applied to the outer grid wrapper. */
  className?: string
  /** Optional style merged onto the outer grid wrapper. */
  style?: React.CSSProperties
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches)
    // Safari < 14 fallback
    if (mq.addEventListener) mq.addEventListener('change', onChange)
    else mq.addListener(onChange)
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange)
      else mq.removeListener(onChange)
    }
  }, [])

  return reduced
}

export function AnimatedExpandableContainer({
  isExpanded,
  children,
  durationMs = 120,
  className,
  style,
}: AnimatedExpandableContainerProps) {
  const reducedMotion = usePrefersReducedMotion()
  const innerRef = useRef<HTMLDivElement | null>(null)
  // Track inert state so collapsed content is not focusable / does not leak below.
  const [collapsedHidden, setCollapsedHidden] = useState<boolean>(!isExpanded)

  useEffect(() => {
    if (isExpanded) {
      setCollapsedHidden(false)
      return
    }
    if (reducedMotion) {
      setCollapsedHidden(true)
      return
    }
    const t = window.setTimeout(() => setCollapsedHidden(true), durationMs)
    return () => window.clearTimeout(t)
  }, [isExpanded, reducedMotion, durationMs])

  const easing = 'cubic-bezier(0.2, 0.8, 0.2, 1)'
  const effectiveDuration = reducedMotion ? 0 : durationMs

  return (
    <div
      className={className}
      data-expanded={isExpanded ? 'true' : 'false'}
      style={{
        display: 'grid',
        // 0fr -> 1fr is the height-animation trick; no measuring needed.
        gridTemplateRows: isExpanded ? '1fr' : '0fr',
        transition: `grid-template-rows ${effectiveDuration}ms ${easing}`,
        // Brutalist: keep hard edges.
        borderRadius: 0,
        ...style,
      }}
    >
      <div
        ref={innerRef}
        // The inner wrapper MUST have min-height:0 + overflow:hidden for the
        // grid-row collapse to actually clip its content.
        style={{
          minHeight: 0,
          overflow: 'hidden',
          // Fade in/out in lockstep with the height for a softer reveal.
          opacity: isExpanded ? 1 : 0,
          transition: `opacity ${effectiveDuration}ms ${easing}`,
          visibility: collapsedHidden && !isExpanded ? 'hidden' : 'visible',
        }}
        aria-hidden={!isExpanded}
      >
        {children}
      </div>
    </div>
  )
}

export default AnimatedExpandableContainer
