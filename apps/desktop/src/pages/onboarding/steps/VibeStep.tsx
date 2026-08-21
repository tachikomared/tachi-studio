import React, { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useOnboardingStore } from '../../../store/onboarding.store'
import type { OnboardingVibe } from '../../../store/onboarding.store'

interface VibeDef {
  id: OnboardingVibe
  label: string
  description: string
  detail: string
}

const VIBES: VibeDef[] = [
  {
    id: 'chat',
    label: 'Chat',
    description: 'Just talk to a model',
    detail: 'Open-ended conversation with any provider. Best for Q&A, writing, brainstorming.',
  },
  {
    id: 'code',
    label: 'Code',
    description: 'Ship features with an agent',
    detail: 'Agentic loop that reads, writes, and runs code on your machine. Zero terminal required.',
  },
  {
    id: 'aeon',
    label: 'Aeon HQ',
    description: 'Kanban + skills on GitHub Actions',
    detail: 'Dispatch cloud agents from a kanban board. Skills run in GitHub Actions on your fork.',
  },
]

interface VibeStepProps {
  onContinue: () => void
  onBack: () => void
}

export function VibeStep({ onContinue, onBack }: VibeStepProps) {
  const { selectedVibe, setSelectedVibe } = useOnboardingStore()
  const { t } = useTranslation('onboarding')

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Enter' && selectedVibe) onContinue()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onContinue, selectedVibe])

  const canContinue = selectedVibe !== undefined

  return (
    <div style={container}>
      <div style={inner}>
        <h2 style={heading}>{t('vibe.heading')}</h2>
        <p style={subtext}>{t('vibe.subtext')}</p>

        <div style={cardGrid}>
          {VIBES.map(v => {
            const isSelected = selectedVibe === v.id

            return (
              <div
                key={v.id}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                onClick={() => setSelectedVibe(v.id)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedVibe(v.id) } }}
                style={{
                  ...card,
                  border: isSelected
                    ? '2px solid var(--accent)'
                    : '2px solid var(--border)',
                  background: isSelected ? 'var(--accent-muted)' : 'var(--bg-elevated)',
                  boxShadow: isSelected ? 'var(--shadow-hard)' : 'none',
                }}
              >
                {isSelected && (
                  <div style={selectedBadge}>{t('vibe.selected')}</div>
                )}
                <div style={cardLabel}>{t(`vibe.list.${v.id}.label`)}</div>
                <div style={cardDesc}>{t(`vibe.list.${v.id}.desc`)}</div>
                <div style={cardDetail}>{t(`vibe.list.${v.id}.detail`)}</div>
              </div>
            )
          })}
        </div>

        <div style={navRow}>
          <button onClick={onBack} style={secondaryBtn}>{t('nav.back')}</button>
          <button
            onClick={onContinue}
            disabled={!canContinue}
            style={{ ...primaryBtn, opacity: canContinue ? 1 : 0.4, cursor: canContinue ? 'pointer' : 'default' }}
          >
            {t('nav.continue')}
          </button>
        </div>
      </div>
    </div>
  )
}

const container: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  width: '100%',
}

const inner: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  maxWidth: 680,
  width: '100%',
  padding: '0 24px',
}

const heading: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 26,
  fontWeight: 800,
  color: 'var(--text-primary)',
  marginBottom: 6,
  letterSpacing: '-0.5px',
}

const subtext: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  color: 'var(--text-muted)',
  marginBottom: 24,
  letterSpacing: '0.04em',
}

const cardGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: 12,
  marginBottom: 32,
}

const card: React.CSSProperties = {
  padding: '20px 16px',
  cursor: 'pointer',
  position: 'relative',
  outline: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const selectedBadge: React.CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.1em',
  color: 'var(--accent)',
  border: 'var(--border-width) solid var(--accent)',
  padding: '1px 5px',
}

const cardLabel: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 18,
  fontWeight: 800,
  color: 'var(--text-primary)',
  letterSpacing: '-0.3px',
}

const cardDesc: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 12,
  fontWeight: 700,
  color: 'var(--accent)',
  letterSpacing: '0.02em',
}

const cardDetail: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  color: 'var(--text-muted)',
  lineHeight: 1.5,
}

const navRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
}

const primaryBtn: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  padding: '10px 28px',
  border: '2px solid var(--accent)',
  background: 'var(--accent)',
  color: '#ffffff',
  cursor: 'pointer',
  boxShadow: 'var(--shadow-hard)',
}

const secondaryBtn: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  padding: '10px 28px',
  border: '2px solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-muted)',
  cursor: 'pointer',
}
