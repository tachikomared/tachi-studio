import React, { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useOnboardingStore } from '../../../store/onboarding.store'

interface DoneStepProps {
  onFinish: () => void
  onBack: () => void
}

const VIBE_ROUTES: Record<string, string> = {
  chat: '/chat',
  code: '/agent',
  aeon: '/aeon',
}

export function DoneStep({ onFinish, onBack }: DoneStepProps) {
  const { selectedVibe, firstRunChoice } = useOnboardingStore()
  const { t } = useTranslation('onboarding')

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Enter') onFinish()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onFinish])

  // RUN LOCAL path skips the vibe step and finishes into the model catalog —
  // tell the user that is what opens next.
  const hintKey = selectedVibe ?? (firstRunChoice === 'local' ? 'local' : 'default')
  const hint = t(`done.hints.${hintKey}`)

  return (
    <div style={container}>
      <div style={inner}>
        <div style={statusLine}>
          <span style={statusDot} />
          <span style={statusText}>{t('done.status')}</span>
        </div>

        <h2 style={heading}>{t('done.heading')}</h2>

        <p style={hintText}>{hint}</p>

        <ul style={nextStepsList}>
          <li style={nextStepItem}>
            <span style={bullet}>01</span>
            {t('done.next.settings')}
          </li>
          <li style={nextStepItem}>
            <span style={bullet}>02</span>
            {t('done.next.shortcut')}
          </li>
          <li style={nextStepItem}>
            <span style={bullet}>03</span>
            {t('done.next.sidebar')}
          </li>
        </ul>

        <div style={navRow}>
          <button onClick={onBack} style={secondaryBtn}>{t('nav.back')}</button>
          <button
            onClick={onFinish}
            style={primaryBtn}
            autoFocus
          >
            {t('done.open')}
          </button>
        </div>
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
  maxWidth: 520,
  width: '100%',
  padding: '0 24px',
}

const statusLine: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 20,
}

const statusDot: React.CSSProperties = {
  width: 8,
  height: 8,
  background: 'var(--success)',
  flexShrink: 0,
  display: 'inline-block',
}

const statusText: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.16em',
  color: 'var(--success)',
}

const heading: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 36,
  fontWeight: 800,
  color: 'var(--text-primary)',
  letterSpacing: '-1px',
  lineHeight: 1.1,
  marginBottom: 16,
}

const hintText: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 13,
  color: 'var(--text-muted)',
  lineHeight: 1.6,
  marginBottom: 32,
}

const nextStepsList: React.CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: '0 0 40px 0',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
}

const nextStepItem: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 12,
  color: 'var(--text-primary)',
  display: 'flex',
  alignItems: 'baseline',
  gap: 12,
  lineHeight: 1.5,
}

const bullet: React.CSSProperties = {
  color: 'var(--text-dim)',
  fontWeight: 700,
  fontSize: 10,
  flexShrink: 0,
  letterSpacing: '0.04em',
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
  padding: '12px 32px',
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
  padding: '12px 28px',
  border: '2px solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-muted)',
  cursor: 'pointer',
}

export { VIBE_ROUTES }
