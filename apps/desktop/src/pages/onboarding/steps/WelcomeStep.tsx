// apps/desktop/src/pages/onboarding/steps/WelcomeStep.tsx
//
// First-run three-card choice (UX-benchmark #1). The welcome screen IS the
// fork in the road now:
//   01 RUN LOCAL     → privacy step, wizard finishes into /catalog
//   02 BRING API KEY → provider key form, wizard finishes into /chat
//   03 JUST EXPLORE  → skip everything, straight into the app
//
// The wizard owns what each choice does (flow + finish route); this step only
// reports the pick via onChoice. Keyboard: 1/2/3 pick a card, Escape = explore.

import React, { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useOnboardingStore } from '../../../store/onboarding.store'
import type { FirstRunChoice } from '../../../store/onboarding.store'

interface WelcomeStepProps {
  onChoice: (choice: FirstRunChoice) => void
}

const CHOICES: FirstRunChoice[] = ['local', 'cloud', 'explore']

export function WelcomeStep({ onChoice }: WelcomeStepProps) {
  const { t } = useTranslation('onboarding')
  const previousChoice = useOnboardingStore(s => s.firstRunChoice)

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onChoice('explore')
      if (e.key === '1') onChoice('local')
      if (e.key === '2') onChoice('cloud')
      if (e.key === '3') onChoice('explore')
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onChoice])

  return (
    <div style={container}>
      <div style={inner}>
        <div style={badge}>TACHIDESK</div>

        <h1 style={heading}>
          {t('welcome.heading')}
        </h1>

        <p style={subtext}>
          {t('welcome.builtBy')}
        </p>

        <div style={chooseLabel}>{t('welcome.choose')}</div>

        <div style={cardRow}>
          {CHOICES.map((id, i) => {
            const isPrevious = previousChoice === id
            return (
              <div
                key={id}
                role="button"
                tabIndex={0}
                aria-pressed={isPrevious}
                data-testid={`first-run-card-${id}`}
                onClick={() => onChoice(id)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChoice(id) } }}
                style={{
                  ...card,
                  border: isPrevious ? '2px solid var(--accent)' : '2px solid var(--border)',
                  background: isPrevious ? 'var(--accent-muted)' : 'var(--bg-elevated)',
                  boxShadow: isPrevious ? 'var(--shadow-hard)' : 'none',
                }}
              >
                <span style={cardIndex}>0{i + 1}</span>
                <span style={cardTitle}>{t(`welcome.cards.${id}.title`)}</span>
                <p style={cardDesc}>{t(`welcome.cards.${id}.desc`)}</p>
                <span style={cardHint}>{t(`welcome.cards.${id}.hint`)}</span>
              </div>
            )
          })}
        </div>

        <p style={privacyNote}>
          <span style={privacyBullet}>--</span>
          {t('welcome.privacyNote')}
        </p>
      </div>
    </div>
  )
}

const container: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100%',
}

const inner: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  maxWidth: 860,
  width: '100%',
  padding: '0 24px',
}

const badge: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.2em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  border: '2px solid var(--accent)',
  padding: '3px 8px',
  marginBottom: 24,
  display: 'inline-block',
}

const heading: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 36,
  fontWeight: 800,
  color: 'var(--text-primary)',
  letterSpacing: '-1px',
  lineHeight: 1.1,
  marginBottom: 10,
}

const subtext: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 12,
  color: 'var(--text-muted)',
  marginBottom: 28,
  letterSpacing: '0.04em',
}

const chooseLabel: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  marginBottom: 12,
}

const cardRow: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: 16,
  marginBottom: 20,
  width: '100%',
}

const card: React.CSSProperties = {
  padding: '18px 16px 16px',
  display: 'flex',
  flexDirection: 'column',
  cursor: 'pointer',
  outline: 'none',
  minHeight: 180,
}

const cardIndex: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.1em',
  color: 'var(--text-dim)',
  marginBottom: 10,
}

const cardTitle: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 15,
  fontWeight: 800,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-primary)',
  marginBottom: 8,
}

const cardDesc: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  color: 'var(--text-muted)',
  lineHeight: 1.5,
  margin: '0 0 14px',
  flex: 1,
}

const cardHint: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
}

const privacyNote: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  color: 'var(--text-muted)',
  letterSpacing: '0.04em',
  lineHeight: 1.5,
  margin: 0,
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
}

const privacyBullet: React.CSSProperties = {
  color: 'var(--accent)',
  fontWeight: 700,
  flexShrink: 0,
}
