// apps/desktop/src/pages/agent/PlaybookIndicator.tsx
//
// Small pill shown in the Agent page header when a playbook exists for the
// current workspace. Uses --success CSS var (brutalist: 2px border, mono font,
// no border-radius).

import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  workingDir: string | null
}

export function PlaybookIndicator({ workingDir }: Props) {
  const { t } = useTranslation('agent')
  const [hasPlaybook, setHasPlaybook] = useState(false)

  useEffect(() => {
    if (!workingDir) {
      setHasPlaybook(false)
      return
    }

    let cancelled = false

    window.tachi.playbook.load(workingDir)
      .then(content => {
        if (!cancelled) setHasPlaybook(content !== null)
      })
      .catch(() => {
        if (!cancelled) setHasPlaybook(false)
      })

    return () => { cancelled = true }
  }, [workingDir])

  if (!hasPlaybook) return null

  return (
    <span
      title={t('playbook.tooltip')}
      style={{
        display:        'inline-flex',
        alignItems:     'center',
        gap:            5,
        padding:        '3px 8px',
        border:         '2px solid var(--success, #22c55e)',
        color:          'var(--success, #22c55e)',
        background:     'var(--bg-elevated)',
        fontFamily:     'JetBrains Mono, monospace',
        fontSize:       10,
        fontWeight:     700,
        letterSpacing:  '0.08em',
        textTransform:  'uppercase',
        flexShrink:     0,
        boxShadow:      'var(--shadow-soft)',
      }}
    >
      <span style={{ width: 6, height: 6, background: 'var(--success, #22c55e)', display: 'inline-block' }} />
      {t('playbook.loaded')}
    </span>
  )
}
