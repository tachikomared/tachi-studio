// apps/desktop/src/pages/aeon/AuthCard.tsx
import React, { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAeonStore } from '../../store/aeon.store'

const cardStyle: React.CSSProperties = {
  border: 'var(--border-width) solid var(--border)',
  background: 'var(--bg-surface)',
  boxShadow: 'var(--shadow-hard)',
  maxWidth: 480,
  margin: '48px auto',
}

const headerStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: 'var(--border-width) solid var(--border)',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.1em',
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  fontFamily: 'JetBrains Mono, monospace',
}

const bodyStyle: React.CSSProperties = {
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
}

const primaryBtnStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '9px 12px',
  border: 'var(--border-width) solid var(--accent)',
  background: 'var(--accent)',
  color: '#ffffff',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  fontWeight: 700,
  cursor: 'pointer',
  textAlign: 'left',
  boxShadow: 'var(--shadow-hard)',
  letterSpacing: '0.04em',
}

const secondaryBtnStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '7px 12px',
  border: 'var(--border-width) solid var(--border)',
  background: 'transparent',
  color: 'var(--text-muted)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  cursor: 'pointer',
  textAlign: 'left',
}

const openBrowserBtnStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '9px 12px',
  border: 'var(--border-width) solid var(--accent)',
  background: 'transparent',
  color: 'var(--accent)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  fontWeight: 700,
  cursor: 'pointer',
  textAlign: 'left',
  letterSpacing: '0.04em',
}

interface AuthCardProps {
  onAuthed: () => void
}

export function AuthCard({ onAuthed }: AuthCardProps) {
  const { t } = useTranslation('aeon')
  const {
    loginCode,
    loginVerifyUri,
    loginPending,
    setLoginCode,
    setLoginPending,
  } = useAeonStore()

  useEffect(() => {
    const offCode = window.tachi.aeon.onLoginCode(({ code, verificationUri }) => {
      setLoginCode(code, verificationUri)
    })
    const offDone = window.tachi.aeon.onLoginDone(({ ok }) => {
      setLoginPending(false)
      setLoginCode(undefined, undefined)
      if (ok) onAuthed()
    })
    return () => { offCode(); offDone() }
  }, [onAuthed, setLoginCode, setLoginPending])

  function handleStart() {
    setLoginPending(true)
    setLoginCode(undefined, undefined)
    window.tachi.aeon.loginStart().catch(() => {
      setLoginPending(false)
    })
  }

  function handleCancel() {
    window.tachi.aeon.loginCancel().catch(() => {})
    setLoginPending(false)
    setLoginCode(undefined, undefined)
  }

  function handleOpenBrowser() {
    if (loginVerifyUri) {
      window.tachi.shell.openExternal(loginVerifyUri).catch(() => {})
    }
  }

  return (
    <div style={cardStyle}>
      <div style={headerStyle}>{t('auth.header')}</div>
      <div style={bodyStyle}>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          {t('auth.intro')}
        </p>

        {!loginPending && (
          <button style={primaryBtnStyle} onClick={handleStart}>
            {t('auth.signIn')}
          </button>
        )}

        {loginPending && (
          <>
            <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)' }}>
              {t('auth.waiting')}
            </p>

            {loginCode && (
              <div style={{
                padding: '12px 16px',
                border: 'var(--border-width) solid var(--accent)',
                background: 'var(--bg-elevated)',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}>
                <span style={{
                  fontSize: 9,
                  color: 'var(--text-dim)',
                  fontFamily: 'JetBrains Mono, monospace',
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                }}>
                  {t('auth.deviceCode')}
                </span>
                <span style={{
                  fontSize: 28,
                  fontWeight: 900,
                  fontFamily: 'JetBrains Mono, monospace',
                  color: 'var(--text-primary)',
                  letterSpacing: '0.1em',
                }}>
                  {loginCode}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
                  {t('auth.copyHint')}
                </span>
              </div>
            )}

            {loginVerifyUri && (
              <button style={openBrowserBtnStyle} onClick={handleOpenBrowser}>
                {t('auth.openDevicePage')}
              </button>
            )}

            <button style={secondaryBtnStyle} onClick={handleCancel}>
              {t('auth.cancel')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
