// apps/desktop/src/pages/aeon/RepoSetupCard.tsx
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AeonForkStatus } from '../../types/electron'

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

interface RepoSetupCardProps {
  onForked: (fork: AeonForkStatus) => void
}

export function RepoSetupCard({ onForked }: RepoSetupCardProps) {
  const { t } = useTranslation('aeon')
  const [forking, setForking] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleFork() {
    setForking(true)
    setError(null)
    try {
      const fork = await window.tachi.aeon.fork()
      if (fork.forked) {
        onForked(fork)
      } else {
        setError(t('repoSetup.errors.notVisible'))
      }
    } catch (err: any) {
      setError(String(err?.message ?? err))
    } finally {
      setForking(false)
    }
  }

  async function handleDetect() {
    setChecking(true)
    setError(null)
    try {
      const fork = await window.tachi.aeon.detectFork()
      if (fork.forked) {
        onForked(fork)
      } else {
        setError(t('repoSetup.errors.notFound'))
      }
    } catch (err: any) {
      setError(String(err?.message ?? err))
    } finally {
      setChecking(false)
    }
  }

  return (
    <div style={cardStyle}>
      <div style={headerStyle}>{t('repoSetup.header')}</div>
      <div style={bodyStyle}>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          {t('repoSetup.intro.before')} <strong style={{ color: 'var(--text-primary)' }}>aaronjmars/aeon</strong> {t('repoSetup.intro.after')}
        </p>

        <button
          style={{ ...primaryBtnStyle, opacity: forking ? 0.7 : 1 }}
          disabled={forking}
          onClick={handleFork}
        >
          {forking ? t('repoSetup.forking') : t('repoSetup.forkRepo')}
        </button>

        <button
          style={{ ...secondaryBtnStyle, opacity: checking ? 0.7 : 1 }}
          disabled={checking}
          onClick={handleDetect}
        >
          {checking ? t('repoSetup.checking') : t('repoSetup.alreadyForked')}
        </button>

        {error && (
          <div style={{
            padding: '8px 10px',
            border: 'var(--border-width) solid var(--destructive)',
            background: 'rgba(212, 63, 0, 0.08)',
            fontSize: 11,
            color: 'var(--destructive)',
            fontFamily: 'JetBrains Mono, monospace',
          }}>
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
