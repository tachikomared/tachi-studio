// apps/desktop/src/pages/agent/DropZone.tsx
import React from 'react'
import { useTranslation } from 'react-i18next'

/** Overlay hint shown while a folder is being dragged over the agent page. */
export function DropZone() {
  const { t } = useTranslation('agent')
  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      pointerEvents: 'none',
    }}>
      <div style={{
        background: 'var(--bg-elevated)', border: '2px solid var(--accent)',
        padding: '20px 40px', fontSize: 16, fontWeight: 700,
        color: 'var(--accent)', boxShadow: 'var(--shadow-hard)',
      }}>
        {t('dropZone.hint')}
      </div>
    </div>
  )
}
