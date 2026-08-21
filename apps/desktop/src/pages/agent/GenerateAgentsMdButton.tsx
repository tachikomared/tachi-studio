// apps/desktop/src/pages/agent/GenerateAgentsMdButton.tsx
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'

export function GenerateAgentsMdButton({ workingDir }: { workingDir: string }) {
  const { t } = useTranslation('agent')
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'error'>('idle')
  const [msg, setMsg]     = useState('')

  const generate = async () => {
    setState('working')
    setMsg('')
    try {
      const result = await window.tachi.agent.generateAgentsMd(workingDir)
      if (result.ok) {
        setState('done')
        setMsg(result.path)
      } else {
        setState('error')
        setMsg(result.reason ?? t('agentsMd.unknownError'))
      }
    } catch (err) {
      setState('error')
      setMsg(err instanceof Error ? err.message : String(err))
    }
  }

  const color = state === 'error' ? 'var(--danger)' : state === 'done' ? 'var(--success)' : 'var(--text-muted)'

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
      <button
        onClick={generate}
        disabled={state === 'working'}
        title={t('agentsMd.tooltip')}
        style={{
          padding: '4px 10px', fontSize: 10, fontWeight: 700,
          textTransform: 'uppercase', letterSpacing: '0.06em',
          border: 'var(--border-width) solid var(--border)',
          background: state === 'done' ? 'rgba(74,222,128,0.1)' : 'var(--bg-elevated)',
          color: state === 'working' ? 'var(--text-dim)' : 'var(--text-muted)',
          cursor: state === 'working' ? 'not-allowed' : 'pointer',
        }}
      >
        {state === 'working' ? `⏳ ${t('agentsMd.generating')}` : `📝 ${t('agentsMd.generate')}`}
      </button>
      {msg && (
        <span style={{ fontSize: 10, color, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {state === 'done' ? '✓ ' : '✗ '}{msg}
        </span>
      )}
    </div>
  )
}
