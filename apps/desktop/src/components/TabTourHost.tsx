// apps/desktop/src/components/TabTourHost.tsx
//
// Route-aware host for tab walkthroughs whose PAGES are actively developed
// (Design, Catalog): the tour wiring lives here, outside the page files, and
// each step spotlights a stable `data-tour="..."` anchor inside them. Mounted
// once in AppShell next to the other global overlays.
//
// Same UX contract as the in-page tours (Chat / Media / Swarm / Agent):
//   · auto-opens on the FIRST visit to the tab, ever (localStorage
//     `tachi-tour-<tab>-seen`, identical key scheme to useTourFirstVisit)
//   · dismissable, Back/Next/Done — the same TabTour panel component
// One extra wrinkle: these routes are lazy-loaded, so we wait for the page's
// first anchor to appear in the DOM before opening — otherwise the spotlight
// would fire against an empty Suspense fallback. If the anchor never shows
// (e.g. an unusual empty state), the tour still opens after a short cap;
// TabTour degrades gracefully when a selector matches nothing.
//
// Brutalist: all visuals come from TabTour itself — this file renders no UI.

import { Suspense, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { TabTour, type TourStep } from './TabTour'

interface StepKey {
  /** i18n sub-key under `tour.` in the tab's namespace, e.g. 'mode' → tour.mode.title/body. */
  key: string
  /** data-tour anchor to spotlight for this step. */
  selector: string
}

const DESIGN_TOUR_KEYS: StepKey[] = [
  { key: 'mode',     selector: '[data-tour="design-mode"]' },
  { key: 'composer', selector: '[data-tour="design-composer"]' },
  { key: 'brand',    selector: '[data-tour="design-brand"]' },
  { key: 'export',   selector: '[data-tour="design-export"]' },
]

const CATALOG_TOUR_KEYS: StepKey[] = [
  { key: 'search',   selector: '[data-tour="catalog-search"]' },
  { key: 'hardware', selector: '[data-tour="catalog-hw"]' },
  { key: 'fit',      selector: '[data-tour="catalog-fit"]' },
  { key: 'download', selector: '[data-tour="catalog-download"]' },
]

/** Poll cadence / cap while waiting for the lazy page to mount its anchors. */
const POLL_MS = 150
const MAX_TRIES = 20 // ≈3s, then open anyway

function RouteTour({ tabKey, ns, stepKeys }: {
  tabKey: string
  ns: string
  stepKeys: StepKey[]
}) {
  const { t } = useTranslation(ns)
  const [open, setOpen] = useState(false)

  // First-visit auto-open — same localStorage contract as useTourFirstVisit,
  // gated on the page's first anchor existing (the route is lazy-loaded).
  useEffect(() => {
    try {
      if (localStorage.getItem(`tachi-tour-${tabKey}-seen`)) return
    } catch { return /* storage unavailable — never auto-open */ }
    let cancelled = false
    let tries = 0
    let timer = 0
    const attempt = () => {
      if (cancelled) return
      if (document.querySelector(stepKeys[0]!.selector) || tries >= MAX_TRIES) {
        try { localStorage.setItem(`tachi-tour-${tabKey}-seen`, '1') } catch { /* ignore */ }
        setOpen(true)
        return
      }
      tries += 1
      timer = window.setTimeout(attempt, POLL_MS)
    }
    timer = window.setTimeout(attempt, POLL_MS)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [tabKey, stepKeys])

  const steps: TourStep[] = stepKeys.map(s => ({
    title: t(`tour.${s.key}.title`),
    body: t(`tour.${s.key}.body`),
    selector: s.selector,
  }))

  return <TabTour open={open} onClose={() => setOpen(false)} steps={steps} title={t('tour.windowTitle')} />
}

export function TabTourHost() {
  const { pathname } = useLocation()
  // Each branch remounts RouteTour when the route changes (state resets); the
  // per-tab localStorage key keeps "seen once, ever" persistence.
  // Suspense: useTranslation(ns) lazy-loads the namespace — never let that
  // suspend the whole AppShell.
  if (pathname.startsWith('/design')) {
    return (
      <Suspense fallback={null}>
        <RouteTour tabKey="design" ns="design" stepKeys={DESIGN_TOUR_KEYS} />
      </Suspense>
    )
  }
  if (pathname.startsWith('/catalog')) {
    return (
      <Suspense fallback={null}>
        <RouteTour tabKey="catalog" ns="catalog" stepKeys={CATALOG_TOUR_KEYS} />
      </Suspense>
    )
  }
  return null
}
