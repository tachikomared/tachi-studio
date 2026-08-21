// apps/desktop/src/pages/settings/DeleteAllDataSection.tsx
import React, { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

const MONO: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
}

const CONFIRM_TIMEOUT_S = 5

export function DeleteAllDataSection() {
  const { t } = useTranslation('settings')
  const [phase, setPhase]       = useState<'idle' | 'confirm' | 'deleting' | 'done' | 'error'>('idle')
  const [countdown, setCountdown] = useState(CONFIRM_TIMEOUT_S)
  const [errorMsg, setErrorMsg]   = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Start countdown when entering confirm phase
  useEffect(() => {
    if (phase !== 'confirm') {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
      setCountdown(CONFIRM_TIMEOUT_S)
      return
    }
    setCountdown(CONFIRM_TIMEOUT_S)
    timerRef.current = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) {
          if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
          setPhase('idle')
          return CONFIRM_TIMEOUT_S
        }
        return c - 1
      })
    }, 1000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [phase])

  const handleFirstClick = () => {
    setPhase('confirm')
  }

  const handleConfirmClick = async () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    setPhase('deleting')
    setErrorMsg(null)
    try {
      await window.tachi.app.deleteAllData()
      // Clear renderer-side storage
      try { localStorage.clear() } catch { /* ignore */ }
      try { sessionStorage.clear() } catch { /* ignore */ }
      setPhase('done')
      // Reload the app after a brief pause to let the user see the success state
      setTimeout(() => { window.location.reload() }, 1500)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
      setPhase('error')
    }
  }

  const handleCancel = () => setPhase('idle')

  return (
    <div style={{
      border: '2px solid var(--danger, #ef4444)',
      background: 'var(--bg-elevated)',
      boxShadow: 'var(--shadow-hard)',
      marginBottom: 24,
      ...MONO,
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 14px',
        borderBottom: '2px solid var(--danger, #ef4444)',
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--danger, #ef4444)' }}>
          {t('deleteData.title')}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.4 }}>
          {t('deleteData.description')}
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>

        {phase === 'idle' && (
          <button
            onClick={handleFirstClick}
            style={{
              padding: '7px 16px',
              border: '2px solid var(--danger, #ef4444)',
              background: 'transparent',
              color: 'var(--danger, #ef4444)',
              fontSize: 10, fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.08em',
              cursor: 'pointer',
              alignSelf: 'flex-start',
              ...MONO,
            }}
          >
            {t('deleteData.deleteButton')}
          </button>
        )}

        {phase === 'confirm' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 10, color: 'var(--warning)', fontWeight: 700 }}>
              {t('deleteData.confirmWarning')}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                onClick={handleConfirmClick}
                style={{
                  padding: '7px 16px',
                  border: '2px solid var(--danger, #ef4444)',
                  background: 'var(--danger, #ef4444)',
                  color: '#fff',
                  fontSize: 10, fontWeight: 700,
                  textTransform: 'uppercase', letterSpacing: '0.08em',
                  cursor: 'pointer',
                  ...MONO,
                }}
              >
                {t('deleteData.confirmButton', { seconds: countdown })}
              </button>
              <button
                onClick={handleCancel}
                style={{
                  padding: '7px 16px',
                  border: '2px solid var(--border)',
                  background: 'transparent',
                  color: 'var(--text-muted)',
                  fontSize: 10, fontWeight: 700,
                  textTransform: 'uppercase', letterSpacing: '0.08em',
                  cursor: 'pointer',
                  ...MONO,
                }}
              >
                {t('deleteData.cancel')}
              </button>
            </div>
          </div>
        )}

        {phase === 'deleting' && (
          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            {t('deleteData.deleting')}
          </div>
        )}

        {phase === 'done' && (
          <div style={{ fontSize: 10, color: 'var(--success)', fontWeight: 700 }}>
            {t('deleteData.done')}
          </div>
        )}

        {phase === 'error' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 10, color: 'var(--danger, #ef4444)', fontWeight: 700 }}>
              {t('deleteData.error', { message: errorMsg })}
            </div>
            <button
              onClick={() => setPhase('idle')}
              style={{
                padding: '5px 12px', fontSize: 9,
                border: '2px solid var(--border)',
                background: 'transparent', color: 'var(--text-muted)',
                cursor: 'pointer', alignSelf: 'flex-start',
                textTransform: 'uppercase', letterSpacing: '0.06em',
                ...MONO,
              }}
            >
              {t('deleteData.dismiss')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
