import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore, contentToText, isContentParts } from '../../store/chat.store'
import { MessageBubble } from './MessageBubble'
import { resolveMessageWorkingDir } from './messageWorkingDir'
import { ChatStarters } from './ChatStarters'
import { CompactMarker } from './CompactMarker'
import { groupMessages } from './chat-branching'
import { WaitingIndicator } from '../../components/WaitingIndicator'
import { isChatWaiting } from '../../components/waitingState'

export function MessageList() {
  const { t } = useTranslation('chat')
  const conv = useChatStore(s => s.getActive())
  const streamingConversationId = useChatStore(s => s.streamingConversationId)
  const msgCount = conv?.messages.length ?? 0
  const bottomRef = useRef<HTMLDivElement>(null)
  // UX #5 version stepper: regenerations stack as consecutive assistant
  // messages — grouped at RENDER time, one bubble + "◀ 2/3 ▶" per group.
  // Keyed by group anchor id; absent = show the latest version.
  const [versionPick, setVersionPick] = useState<Record<string, number>>({})

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [msgCount, conv?.id])

  useEffect(() => { setVersionPick({}) }, [conv?.id])

  if (!conv) return <div style={{ flex: 1 }} />

  // LANE E — CHAT had NOTHING between send and the first streamed token: the
  // store only appends the assistant bubble on the provider's `start` chunk, so
  // the transcript simply sat there. Same indicator the CODE transcript uses.
  const lastMsg = conv.messages.length > 0 ? conv.messages[conv.messages.length - 1] : null
  const chatWaiting = isChatWaiting({
    streaming: streamingConversationId === conv.id,
    lastRole: lastMsg?.role ?? null,
    lastAssistantText: lastMsg ? contentToText(lastMsg.content) : '',
    lastAssistantHasParts: lastMsg ? isContentParts(lastMsg.content) && lastMsg.content.some(p => p.type !== 'text') : false,
    lastAssistantErrored: Boolean(lastMsg?.error),
  })

  const groups = groupMessages(conv.messages)
  // CHAT COMPACT: the boundary marker sits before the first group that begins at
  // or after `compactedUpTo` (the messages above it are sent as a summary). We
  // resolve which group it precedes up front; if the boundary lands inside the
  // final (regeneration) group it pins to the top so the marker always shows.
  const compactedUpTo = conv.compactedUpTo ?? 0
  const compactSummary = conv.compactSummary ?? ''
  const showMarker = compactedUpTo > 0 && compactSummary.trim().length > 0
  let markerBeforeGroup = -1
  if (showMarker) {
    let consumed = 0
    for (let i = 0; i < groups.length; i++) {
      if (consumed >= compactedUpTo) { markerBeforeGroup = i; break }
      consumed += groups[i].versions.length
    }
    if (markerBeforeGroup === -1) markerBeforeGroup = 0
  }

  return (
    // ARIA FEED, deliberately not `log`: `role="log"` carries an implicit
    // aria-live="polite", which on a token-by-token stream would fire an
    // announcement per frame. `feed` is the WAI-ARIA pattern for a scrollable
    // stream of authored articles — it is NOT a live region, so the transcript
    // stays navigable while MessageBubble's own aria-live body keeps owning the
    // "the answer changed" announcement. aria-busy marks the streaming turn.
    <div
      role="feed"
      aria-label={t('a11y.transcript', { defaultValue: 'Chat transcript' })}
      aria-busy={streamingConversationId === conv.id}
      style={{ flex: 1, overflowY: 'auto', padding: '20px 0' }}
    >
      {conv.messages.length === 0 && (
        <>
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', marginTop: 48, fontSize: 14 }}>
            {t('messages.emptyState')}
          </div>
          <ChatStarters conversationId={conv.id} providerId={conv.providerId} />
        </>
      )}
      {groups.map((g, idx) => {
        // While any version streams, pin to the streaming (last) one.
        const streaming = g.versions.some(v => v.streaming)
        const latest = g.versions.length - 1
        const sel = streaming ? latest : Math.min(versionPick[g.anchorId] ?? latest, latest)
        const m = g.versions[sel]
        return (
          <React.Fragment key={g.anchorId}>
            {idx === markerBeforeGroup && <CompactMarker count={compactedUpTo} summary={compactSummary} />}
            {g.versions.length > 1 && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', marginTop: 2,
                fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'var(--text-dim)',
              }}>
                <button
                  type="button"
                  onClick={() => setVersionPick(p => ({ ...p, [g.anchorId]: Math.max(0, sel - 1) }))}
                  disabled={sel === 0 || streaming}
                  title={t('versions.prev', 'Previous version')}
                  aria-label={t('versions.prev', 'Previous version')}
                  style={stepperBtnStyle(sel === 0 || streaming)}
                ><span aria-hidden="true">◀</span></button>
                <span style={{ fontWeight: 700, letterSpacing: '0.08em' }}>
                  {t('versions.counter', { defaultValue: 'v{{n}} / {{total}}', n: sel + 1, total: g.versions.length })}
                </span>
                <button
                  type="button"
                  onClick={() => setVersionPick(p => ({ ...p, [g.anchorId]: Math.min(latest, sel + 1) }))}
                  disabled={sel === latest || streaming}
                  title={t('versions.next', 'Next version')}
                  aria-label={t('versions.next', 'Next version')}
                  style={stepperBtnStyle(sel === latest || streaming)}
                ><span aria-hidden="true">▶</span></button>
              </div>
            )}
            {/* NOTE: the conversation's providerId is deliberately NOT passed —
                the badge reads the message's OWN recorded provider so a picker
                change cannot rewrite delivered provenance. */}
            <MessageBubble
              message={m}
              conversationId={conv.id}
              /* FILE-PATH CHIPS: send-time stamp first, then the conversation's
                 current dirs so pre-stamp transcripts still resolve. */
              workingDir={resolveMessageWorkingDir(m, conv)}
            />
          </React.Fragment>
        )
      })}
      {chatWaiting && (
        <div style={{ padding: '0 16px' }}>
          <WaitingIndicator label={t('messages.waiting', { defaultValue: 'Waiting for response…' })} />
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  )
}

function stepperBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: '1px 7px',
    border: '2px solid var(--border)',
    background: 'var(--bg-elevated)',
    color: disabled ? 'var(--text-dim)' : 'var(--text-muted)',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 9,
    fontWeight: 700,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.4 : 1,
  }
}
