// apps/desktop/src/components/FooterHints.tsx
//
// Contextual shortcut hints in the bottom status bar (UX-benchmark #8).
// One static dim mono string per active tab, resolved from the router path.
// Every claimed shortcut was verified against the page's real key handlers —
// tabs with no real keyboard shortcut show their core verb instead:
//   chat    → Enter send (InputBar) · Ctrl+K palette · Ctrl+Shift+Space quick-ask
//   code    → Enter runs the task · ↺ button reverts the auto checkpoint
//   nodes   → Ctrl+Enter run all (run panel) · Ctrl+Z canvas undo
//   design  → Ctrl+Enter send · ↺ edit-to-rewind on any user turn
//   media   → core verb + Esc closes the fullscreen preview
//   catalog → core verb (quant pill → fit verdict)
//   swarm   → core verb (NEW SWARM · live commit feed)
//   studio  → core verb (live stats, 3s auto-refresh)

import React from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router-dom'

const isMac = (((navigator as any).userAgentData?.platform) ?? navigator.platform).includes('Mac')
const MOD = isMac ? '⌘' : 'Ctrl'

/** First route segment → footerHints.* key. Routes without hints are omitted. */
const TAB_HINT_KEYS: Record<string, string> = {
  chat:      'chat',
  agent:     'code',
  nodes:     'nodes',
  design:    'design',
  media:     'media',
  artifacts: 'media',
  catalog:   'catalog',
  swarm:     'swarm',
  studio:    'dashboard',
}

export function FooterHints() {
  const { t } = useTranslation('common')
  const location = useLocation()

  // The overlay / quick-ask satellite windows never mount AppShell, but guard
  // anyway so a future reuse can't leak hints into them.
  if (typeof window !== 'undefined' &&
      (window.location.hash === '#overlay' || window.location.hash === '#quickask')) {
    return null
  }

  const seg = location.pathname.split('/')[1] ?? ''
  const key = TAB_HINT_KEYS[seg]
  if (!key) return null

  const text = t(`footerHints.${key}`, { mod: MOD })

  return (
    <span
      title={text}
      style={{
        marginLeft: 'auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: 10,
        color: 'var(--text-muted)',
        opacity: 0.6,
        letterSpacing: '0.04em',
        userSelect: 'none',
      }}
    >
      {text}
    </span>
  )
}
