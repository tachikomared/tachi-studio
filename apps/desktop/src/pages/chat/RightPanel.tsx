import React from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../store/chat.store'
import { modelDisplayName } from '../../utils/model-display'
// Subpath import keeps the Node-only core barrel out of the renderer bundle.
import { getProvider } from '@tachi/core/src/providers/registry'

// The panel showed a hardcoded "Bankr Gateway" for every conversation —
// show the conversation's REAL provider (glossary: Provider, no "gateway").
//
// SHORTENINGS ONLY. Anything not listed falls through to the registry's own
// label, so a provider is named in ONE place: 'freellmapi-local' used to be
// hardcoded here as "Free (local router)", a second name for a thing the
// registry already calls "FreeLLM (local router)" — and a shorter, vaguer one,
// where "Free" and "local" sat next to each other with no brand between them.
const PROVIDER_LABELS: Record<string, string> = {
  'bankr-gateway': 'Bankr',
  surplus: 'Surplus Intelligence',
  venice: 'Venice',
  imgnai: 'imgnAI',
  opengateway: 'OpenGateway',
  ollama: 'Ollama',
  'llama-cpp': 'llama.cpp',
}

export function RightPanel() {
  const { t } = useTranslation('chat')
  const conv = useChatStore(s => s.getActive())
  const messages = conv?.messages ?? []
  const lastMsg = [...messages].reverse().find(m => m.role === 'assistant')
  const providerLabel = conv
    ? (PROVIDER_LABELS[conv.providerId]
       ?? getProvider(conv.providerId)?.label
       ?? conv.providerId.replace(/-local$/, ''))
    : ''

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section>
        <h3 style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>{t('rightPanel.provider')}</h3>
        <div style={{ fontSize: 13 }}>{providerLabel}</div>
        <div style={{ fontSize: 12, color: 'var(--accent)', marginTop: 2 }}>&#9679; {t('rightPanel.online')}</div>
      </section>

      {conv?.model && (
        <section>
          <h3 style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>{t('rightPanel.model')}</h3>
          <div style={{ fontSize: 13 }} title={conv.model}>{modelDisplayName(conv.model)}</div>
        </section>
      )}

      {lastMsg?.usage && (
        <section>
          <h3 style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>{t('rightPanel.usage')}</h3>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            <div>{t('rightPanel.promptTokens', { count: lastMsg.usage.promptTokens })}</div>
            <div>{t('rightPanel.completionTokens', { count: lastMsg.usage.completionTokens })}</div>
          </div>
        </section>
      )}

      <section>
        <h3 style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>{t('rightPanel.routing')}</h3>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
          {t('rightPanel.routingHint')}
        </div>
      </section>
    </div>
  )
}
