// apps/desktop/src/pages/catalog/HardwareBanner.tsx
import React from 'react'
import type { HardwareProfile } from '@tachi/core'
import { useTranslation } from 'react-i18next'

const GB = 1024 * 1024 * 1024
const gb = (b: number) => `${(b / GB).toFixed(1)} GB`

export function HardwareBanner({ hw }: { hw: HardwareProfile | null }) {
  const { t } = useTranslation('catalog')
  if (!hw) return null
  const gpu = hw.gpus[0]
  return (
    <div data-tour="catalog-hw" style={{
      display: 'flex', gap: 24, flexWrap: 'wrap',
      padding: '10px 16px',
      borderBottom: 'var(--border-width) solid var(--border)',
      fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
      color: 'var(--text-muted)',
    }}>
      <span>{t('ram')}: <b style={{ color: 'var(--text-primary)' }}>{gb(hw.ramFreeBytes)}</b> {t('free')} / {gb(hw.ramTotalBytes)}</span>
      <span>{t('gpu')}: <b style={{ color: 'var(--text-primary)' }}>{gpu?.model ?? '—'}</b></span>
      <span>{t('vram')}: <b style={{ color: 'var(--text-primary)' }}>{hw.vramFreeBytes != null ? gb(hw.vramFreeBytes) : t('unknown')}</b></span>
      <span>{t('cpu')}: <b style={{ color: 'var(--text-primary)' }}>{hw.cpuCores} {t('cores')}</b></span>
    </div>
  )
}
