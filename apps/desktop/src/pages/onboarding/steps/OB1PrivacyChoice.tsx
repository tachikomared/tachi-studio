// apps/desktop/src/pages/onboarding/steps/OB1PrivacyChoice.tsx
//
// Two-polar choice surfaced on first launch: FREE+FAST (cloud providers,
// default) vs PRIVATE+LOCAL (Ollama only, no network egress, tool calls
// denylisted).
//
// Picking PRIVATE+LOCAL flips `usePrivacyStore.setMode('private')` which:
//   - locks cloud providers in ProvidersCard,
//   - mirrors the mode to the main process for Tier 2 enforcement.
//
// We ALSO persist `strictPrivacyMode` to the settings file, because boot
// (App.tsx) re-derives the privacy mode from `settings.strictPrivacyMode` and
// would otherwise clobber the rehydrated choice back to 'open' on the 2nd
// launch — silently re-enabling cloud egress for a user who chose PRIVATE.
// (Mirrors PrivacySection.toggle.)
//
// Picking FREE+FAST sets mode 'open' + strictPrivacyMode:false. Either way we
// advance the wizard to the next step.

import React, { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { usePrivacyStore } from '../../../store/privacy.store'

interface OB1PrivacyChoiceProps {
  onContinue: () => void
  onBack:     () => void
  onSkip:     () => void
}

export function OB1PrivacyChoice({ onContinue, onBack, onSkip }: OB1PrivacyChoiceProps) {
  const setMode = usePrivacyStore(s => s.setMode)
  const { t } = useTranslation('onboarding')

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onSkip()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onSkip])

  const pickFree = () => {
    setMode('open')
    void window.tachi.settings.save({ strictPrivacyMode: false }).catch(() => { /* non-fatal */ })
    onContinue()
  }

  const pickPrivate = () => {
    setMode('private')
    // Persist to the settings file so boot (App.tsx) doesn't overwrite the
    // choice back to 'open' on the next launch.
    void window.tachi.settings.save({ strictPrivacyMode: true }).catch(() => { /* non-fatal */ })
    onContinue()
  }

  return (
    <div style={container}>
      <div style={inner}>
        <h2 style={heading}>{t('privacy.heading')}</h2>
        <p style={subtext}>
          {t('privacy.subtext')}
        </p>

        <div style={cardRow}>
          {/* FREE + FAST */}
          <div style={card}>
            <div style={cardHeader}>
              <span style={cardTitle}>{t('privacy.free.title')}</span>
              <span style={recommendedPill}>{t('privacy.free.recommended')}</span>
            </div>
            <p style={cardTagline}>{t('privacy.free.tagline')}</p>
            <ul style={featureList}>
              <li style={featureItem}><span style={bullet}>--</span>{t('privacy.free.features.cloud')}</li>
              <li style={featureItem}><span style={bullet}>--</span>{t('privacy.free.features.freeTier')}</li>
              <li style={featureItem}><span style={bullet}>--</span>{t('privacy.free.features.oneClick')}</li>
              <li style={featureItem}><span style={bullet}>--</span>{t('privacy.free.features.noKey')}</li>
            </ul>
            <button onClick={pickFree} style={primaryBtn} autoFocus>
              {t('privacy.free.pick')}
            </button>
          </div>

          {/* PRIVATE + LOCAL */}
          <div style={cardDark}>
            <div style={cardHeader}>
              <span style={cardTitle}>{t('privacy.private.title')}</span>
              <span style={privatePill}>{t('privacy.private.strict')}</span>
            </div>
            <p style={cardTagline}>{t('privacy.private.tagline')}</p>
            <ul style={featureList}>
              <li style={featureItem}><span style={bulletDanger}>--</span>{t('privacy.private.features.cloudLocked')}</li>
              <li style={featureItem}><span style={bulletDanger}>--</span>{t('privacy.private.features.ollamaOnly')}</li>
              <li style={featureItem}><span style={bulletDanger}>--</span>{t('privacy.private.features.noEgress')}</li>
              <li style={featureItem}><span style={bulletDanger}>--</span>{t('privacy.private.features.toolsDenied')}</li>
            </ul>
            <button onClick={pickPrivate} style={dangerBtn}>
              {t('privacy.private.pick')}
            </button>
          </div>
        </div>

        <div style={navRow}>
          <button onClick={onBack} style={secondaryBtn}>
            {t('nav.back')}
          </button>
          <button onClick={onSkip} style={skipLink}>
            {t('privacy.skipForNow')}
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
  maxWidth: 760,
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
  textTransform: 'uppercase',
}

const subtext: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  color: 'var(--text-muted)',
  marginBottom: 24,
  letterSpacing: '0.04em',
}

const cardRow: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 16,
  marginBottom: 24,
}

const card: React.CSSProperties = {
  padding: '18px 18px 16px',
  border: '2px solid var(--border)',
  background: 'var(--bg-elevated)',
  display: 'flex',
  flexDirection: 'column',
}

const cardDark: React.CSSProperties = {
  ...card,
  border: '2px solid var(--danger, #d43f00)',
  background: 'var(--bg-surface)',
}

const cardHeader: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 4,
  gap: 8,
}

const cardTitle: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 14,
  fontWeight: 800,
  color: 'var(--text-primary)',
  letterSpacing: '0.06em',
}

const recommendedPill: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.1em',
  border: 'var(--border-width) solid var(--accent)',
  color: 'var(--accent)',
  padding: '1px 6px',
  whiteSpace: 'nowrap',
}

const privatePill: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.1em',
  border: 'var(--border-width) solid var(--danger, #d43f00)',
  color: 'var(--danger, #d43f00)',
  padding: '1px 6px',
  whiteSpace: 'nowrap',
}

const cardTagline: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  color: 'var(--text-dim)',
  letterSpacing: '0.04em',
  margin: '0 0 14px',
}

const featureList: React.CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: '0 0 18px 0',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  flex: 1,
}

const featureItem: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 12,
  color: 'var(--text-primary)',
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  lineHeight: 1.4,
}

const bullet: React.CSSProperties = {
  color: 'var(--accent)',
  fontWeight: 700,
  flexShrink: 0,
}

const bulletDanger: React.CSSProperties = {
  color: 'var(--danger, #d43f00)',
  fontWeight: 700,
  flexShrink: 0,
}

const primaryBtn: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  padding: '10px 14px',
  border: '2px solid var(--accent)',
  background: 'var(--accent)',
  color: '#ffffff',
  cursor: 'pointer',
  boxShadow: 'var(--shadow-hard)',
  width: '100%',
}

const dangerBtn: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  padding: '10px 14px',
  border: '2px solid var(--danger, #d43f00)',
  background: 'transparent',
  color: 'var(--danger, #d43f00)',
  cursor: 'pointer',
  width: '100%',
}

const navRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
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

const skipLink: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  color: 'var(--text-muted)',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: 0,
  textDecoration: 'underline',
  marginLeft: 'auto',
}
