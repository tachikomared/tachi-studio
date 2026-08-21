// Starter cards for the CHAT empty state (UX #3): the zero state used to say
// "Send a message to start chatting." and teach nothing. Three one-click
// worked examples in the brutalist idiom (2px border, hard shadow, uppercase
// label + one-line promise) — each pre-fills the composer via pendingMessage
// so the user sees WHAT a good prompt looks like and stays in control (no
// auto-send). The COMPARE card additionally arms compare mode when the
// conversation's provider supports panel fan-out.
import React from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../store/chat.store'

const FUSION_PROVIDERS = new Set(['bankr-gateway', 'venice', 'surplus'])

interface StarterSpec {
  key: 'summarizeUrl' | 'explain' | 'compare'
  fallbackLabel: string
  fallbackDesc: string
  prompt: string
}

const STARTERS: StarterSpec[] = [
  {
    key: 'summarizeUrl',
    fallbackLabel: 'SUMMARIZE A URL',
    fallbackDesc: 'Paste any link — get the gist in five bullets.',
    prompt: 'Summarize this page in 5 bullet points, then give me the single most important takeaway:\n<paste URL here>',
  },
  {
    key: 'explain',
    fallbackLabel: 'EXPLAIN SIMPLY',
    fallbackDesc: 'Any concept, explained like you are new to it.',
    prompt: 'Explain <topic> simply, as if I am smart but new to the field. Use one concrete analogy.',
  },
  {
    key: 'compare',
    fallbackLabel: 'COMPARE TWO MODELS',
    fallbackDesc: 'Same question, side-by-side answers — pick the best.',
    prompt: 'Which planning approach is better for a small team: kanban or scrum? Answer in 4 sentences.',
  },
]

export function ChatStarters({ conversationId, providerId }: { conversationId: string; providerId: string }) {
  const { t } = useTranslation('chat')
  const setPendingMessage = useChatStore(s => s.setPendingMessage)
  const setFusionMode = useChatStore(s => s.setFusionMode)
  const setFusionArbiter = useChatStore(s => s.setFusionArbiter)

  const run = (s: StarterSpec) => {
    if (s.key === 'compare' && FUSION_PROVIDERS.has(providerId)) {
      setFusionMode(true)
      setFusionArbiter('compare')
    }
    setPendingMessage(t(`starters.${s.key}.prompt`, { defaultValue: s.prompt }))
  }

  return (
    <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap', padding: '0 24px', marginTop: 18 }}>
      {STARTERS.map(s => (
        <button
          key={s.key}
          onClick={() => run(s)}
          data-testid={`chat-starter-${s.key}`}
          style={{
            width: 210, textAlign: 'left', cursor: 'pointer',
            border: '2px solid var(--border)', background: 'var(--bg-surface)',
            boxShadow: 'var(--shadow-hard)', padding: '10px 12px',
            fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-primary)',
            display: 'flex', flexDirection: 'column', gap: 6,
          }}
        >
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            {t(`starters.${s.key}.label`, { defaultValue: s.fallbackLabel })}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4 }}>
            {t(`starters.${s.key}.desc`, { defaultValue: s.fallbackDesc })}
          </span>
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent-text)', letterSpacing: '0.08em' }}>
            {t('starters.try', { defaultValue: 'TRY ▸' })}
          </span>
        </button>
      ))}
    </div>
  )
}
