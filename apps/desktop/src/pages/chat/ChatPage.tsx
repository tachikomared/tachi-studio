// apps/desktop/src/pages/chat/ChatPage.tsx
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useParams } from 'react-router-dom'
import { MessageList } from './MessageList'
import { InputBar } from './InputBar'
import { ChatHistory } from './ChatHistory'
import { ArtifactsPanel } from './ArtifactsPanel'
import { ChatCompactControl } from './ChatCompactControl'
import { useChatStore } from '../../store/chat.store'
import { useArtifactsStore } from '../../store/artifacts.store'
import { PageTopbar } from '../../components/layout/PageTopbar'
import { useAgentStore } from '../../store/agent.store'
import { TabTour, useTourFirstVisit, type TourStep } from '../../components/TabTour'
import { useMemoryAutoCapture } from './useMemoryAutoCapture'

function buildChatTour(t: TFunction): TourStep[] {
  return [
    { title: t('tour.step1.title'), body: t('tour.step1.body') },
    { title: t('tour.step2.title'), body: t('tour.step2.body'), selector: '[data-tour="chat-provider"]' },
    { title: t('tour.step3.title'), body: t('tour.step3.body'), selector: '[data-tour="chat-input"]' },
    { title: t('tour.step4.title'), body: t('tour.step4.body'), selector: '[data-tour="chat-send"]' },
    { title: t('tour.step5.title'), body: t('tour.step5.body') },
  ]
}

export function ChatPage() {
  const { t } = useTranslation('chat')
  const { id } = useParams<{ id: string }>()
  const activeConv = useChatStore(s => s.getActive())
  const newConversation = useChatStore(s => s.newConversation)
  const { setActive } = useChatStore()
  const [historyOpen, setHistoryOpen] = useState(true)
  const [artifactsOpen, setArtifactsOpen] = useState(false)
  const [tourOpen, setTourOpen] = useState(false)
  useTourFirstVisit('chat', setTourOpen)
  // T16: propose a memory fact when a finished reply's user message looks like a
  // durable preference (never auto-saves — shows a "Remember this?" toast).
  useMemoryAutoCapture(t)

  const getForConversation = useArtifactsStore(s => s.getForConversation)
  const activeConvId = activeConv?.id
  const artifactCount = activeConvId ? getForConversation(activeConvId).length : 0

  // D4: subscribe to context-chars IPC events and update the store + show red-zone toast
  const bumpContextChars     = useAgentStore(s => s.bumpContextChars)
  const markRedZoneTriggered = useAgentStore(s => s.markRedZoneTriggered)

  useEffect(() => {
    const unsub1 = window.tachi.chat.onContextCharsUpdated?.(({ conversationId, deltaChars }) => {
      bumpContextChars(conversationId, deltaChars)
    })
    const unsub2 = window.tachi.chat.onRedZoneEntered?.(({ conversationId }) => {
      markRedZoneTriggered(conversationId)
      // Honest, actionable red-zone notice. We do NOT hard-block the next send
      // (that traps the user); instead we warn once and offer a one-click fresh
      // chat. History is already capped per-send, so this is guidance, not a wall.
      window.dispatchEvent(new CustomEvent('tachi:toast', {
        detail: {
          kind: 'warning',
          ttl: 0, // sticky until dismissed — important enough not to auto-vanish
          text: t('redZone.toast'),
          actions: [
            { label: t('redZone.newChat'), onClick: () => { const id = newConversation(); setActive(id) } },
          ],
        },
      }))
    })
    return () => {
      unsub1?.()
      unsub2?.()
    }
  }, [bumpContextChars, markRedZoneTriggered, newConversation, setActive, t])

  useEffect(() => {
    if (useChatStore.getState().conversations.length === 0) {
      useChatStore.getState().newConversation()
    }
  }, [])

  // When navigating to /chat/:id, activate the conversation
  useEffect(() => {
    if (id) {
      setActive(id)
    }
  }, [id, setActive])

  // Close artifacts panel when switching to a conversation with no artifacts
  useEffect(() => {
    if (artifactCount === 0) setArtifactsOpen(false)
  }, [activeConvId, artifactCount])

  const artifactsToggle = artifactCount > 0 ? (
    <button
      onClick={() => setArtifactsOpen(o => !o)}
      title={artifactsOpen ? t('topbar.hideArtifacts') : t('topbar.showArtifacts')}
      aria-label={artifactsOpen ? t('topbar.hideArtifactsPanel') : t('topbar.showArtifactsPanel')}
      style={{
        padding: '4px 10px',
        border: '2px solid var(--border)',
        background: artifactsOpen ? 'var(--accent-muted)' : 'var(--bg-elevated)',
        color: artifactsOpen ? 'var(--accent-text)' : 'var(--text-muted)',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.06em',
        cursor: 'pointer',
        textTransform: 'uppercase',
      }}
    >
      {t('topbar.artifactsButton', { count: artifactCount })}
    </button>
  ) : undefined

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <ChatHistory open={historyOpen} onClose={() => setHistoryOpen(false)} />
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', minWidth: 0 }}>
        {/* ctxModelId: the context window is a per-MODEL fact, so the CTX chip
            cannot be honest with the provider alone (see CtxBadge). */}
        <PageTopbar
          section="Chat"
          sessionName={activeConv?.title}
          onNew={() => newConversation()}
          ctxConversationId={activeConvId}
          ctxProviderId={activeConv?.providerId}
          ctxModelId={activeConv?.model}
          leftAction={
            <span style={{ display: 'inline-flex', gap: 6 }}>
              {!historyOpen && (
                <button
                  onClick={() => setHistoryOpen(true)}
                  title={t('topbar.showHistory')}
                  aria-label={t('topbar.showHistoryAria')}
                  style={{
                    padding: '4px 10px',
                    border: '2px solid var(--border)',
                    background: 'var(--bg-elevated)',
                    color: 'var(--text-muted)',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '0.06em',
                    cursor: 'pointer',
                    textTransform: 'uppercase',
                  }}
                >{t('topbar.history')}</button>
              )}
              <button
                onClick={() => setTourOpen(true)}
                title={t('topbar.howToTitle')}
                style={{
                  padding: '4px 10px',
                  border: '2px solid var(--accent)',
                  background: 'var(--accent)',
                  color: '#ffffff',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  cursor: 'pointer',
                  textTransform: 'uppercase',
                }}
              >{t('topbar.howTo')}</button>
            </span>
          }
          rightAction={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {/* CHAT COMPACT lives next to the CTX badge (the context area). It
                  self-hides until the conversation is long enough to compact. */}
              <ChatCompactControl />
              {artifactsToggle}
            </span>
          }
        />
        <MessageList />
        <InputBar />
      </div>
      <ArtifactsPanel
        conversationId={activeConvId}
        open={artifactsOpen}
        onClose={() => setArtifactsOpen(false)}
      />
      {/*
       * Workspace panel removed from regular Chat — it's only meaningful when
       * the conversation has tool-call activity (Agent / CODE tab). Mounted in
       * AgentPage instead. Regular chat is a thin chat surface with no files /
       * tool outputs / sidecar state to display.
       */}
      <TabTour open={tourOpen} onClose={() => setTourOpen(false)} steps={buildChatTour(t)} title={t('tour.title')} />
    </div>
  )
}
