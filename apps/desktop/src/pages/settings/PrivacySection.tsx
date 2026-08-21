// apps/desktop/src/pages/settings/PrivacySection.tsx
import React from 'react'
import { useTranslation } from 'react-i18next'
import { usePrivacyStore } from '../../store/privacy.store'
import { Switch } from '../../components/Switch'

// The visible headings NAME their switches (aria-labelledby) — no invented
// aria-label string that a translation could drift away from the text next to it.
const PRIVATE_MODE_LABEL_ID = 'privacy-private-mode-label'
const SCRUB_LABEL_ID        = 'privacy-scrub-label'

const MONO: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
}

export function PrivacySection() {
  const { t } = useTranslation('settings')
  const privateMode = usePrivacyStore(s => s.mode === 'private')
  const setMode     = usePrivacyStore(s => s.setMode)
  const [scrub, setScrub] = React.useState(false)
  React.useEffect(() => {
    window.tachi.settings.load().then(s => setScrub(Boolean(s.scrubSecretsOutbound))).catch(() => { /* default off */ })
  }, [])

  const toggleScrub = async (v: boolean) => {
    setScrub(v)
    try { await window.tachi.settings.save({ scrubSecretsOutbound: v }) } catch { setScrub(!v) }
  }

  const toggle = async (v: boolean) => {
    setMode(v ? 'private' : 'open')
    try {
      await window.tachi.settings.save({ strictPrivacyMode: v } as Parameters<typeof window.tachi.settings.save>[0])
    } catch {
      // Revert on failure
      setMode(v ? 'open' : 'private')
    }
  }

  return (
    <div style={{
      border: '2px solid var(--border)',
      background: 'var(--bg-elevated)',
      boxShadow: 'var(--shadow-hard)',
      marginBottom: 24,
      ...MONO,
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 14px',
        borderBottom: '2px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
      }}>
        <div>
          <div id={PRIVATE_MODE_LABEL_ID} style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-primary)' }}>
            Private Mode
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.4 }}>
            {t('privacy.description')}
          </div>
        </div>

        {/* Brutalist toggle — same pixels, now an actual switch (Switch.tsx). */}
        <Switch
          checked={privateMode}
          onChange={v => { void toggle(v) }}
          onLabel={t('privacy.on')}
          offLabel={t('privacy.off')}
          labelledBy={PRIVATE_MODE_LABEL_ID}
        />
      </div>

      {/* Outbound secret/PII scrub sub-toggle (independent of Private Mode) */}
      <div style={{
        padding: '10px 14px',
        borderTop: '2px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
      }}>
        <div>
          <div id={SCRUB_LABEL_ID} style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-primary)' }}>
            Scrub secrets before cloud send
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.4 }}>
            Replace API keys, tokens, emails, cards &amp; PII with stable placeholders in your message, chat history &amp; system prompt before they reach a CLOUD provider (file attachments aren&apos;t scrubbed). Local models are never affected. Off by default.
          </div>
        </div>
        <Switch
          checked={scrub}
          onChange={v => { void toggleScrub(v) }}
          onLabel="ON"
          offLabel="OFF"
          labelledBy={SCRUB_LABEL_ID}
        />
      </div>

      {/* Active state disclosure box */}
      {privateMode && (
        <div style={{
          margin: 12,
          padding: 10,
          border: '2px solid var(--warning)',
          background: 'transparent',
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--warning)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
            {t('privacy.hiddenHeading')}
          </div>
          <ul style={{ margin: 0, padding: '0 0 0 14px', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.8 }}>
            <li>{t('privacy.hiddenItems.cloud')}</li>
            <li>{t('privacy.hiddenItems.webSearch')}</li>
            <li>{t('privacy.hiddenItems.aeon')}</li>
          </ul>
        </div>
      )}
    </div>
  )
}
