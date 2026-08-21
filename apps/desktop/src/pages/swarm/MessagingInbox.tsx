// apps/desktop/src/pages/swarm/MessagingInbox.tsx
//
// Renderer-only inter-agent messaging UI for the swarm. Renders inside the
// AgentsPane area of SwarmPage: an unread-count badge per agent tile plus a
// small expandable thread/inbox view per agent.
//
// Backed entirely by useSwarmMessagesStore (in-memory, no IPC). Brutalist:
// 2px borders, hard edges, JetBrains Mono, type-coloured chips. The expand
// animation is delegated to AnimatedExpandableContainer, which already guards
// prefers-reduced-motion, so no raw CSS animation is needed here.

import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SwarmAgent } from '../../store/swarm.store'
import {
  useSwarmMessagesStore,
  MESSAGE_KIND_META,
  summarizeMessage,
  type SwarmMessage,
  type SwarmMessageKind,
  type TaskPriority,
} from '../../store/swarm-messages.store'
import { AnimatedExpandableContainer } from '../../components/ui/AnimatedExpandableContainer'

interface MessagingInboxProps {
  agents: SwarmAgent[]
}

/**
 * A coloured type chip for one message. Pulls colour/label from the store's
 * MESSAGE_KIND_META so the taxonomy stays centralised.
 */
function KindChip({ kind }: { kind: SwarmMessageKind }) {
  const meta = MESSAGE_KIND_META[kind]
  return (
    <span
      style={{
        display:       'inline-block',
        padding:       '1px 5px',
        border:        `2px solid ${meta.color}`,
        color:         meta.color,
        background:    'transparent',
        fontSize:      9,
        fontWeight:    700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        lineHeight:    1.3,
        flexShrink:    0,
      }}
    >
      {meta.label}
    </span>
  )
}

/** Unread-count badge. Renders nothing when count is 0. */
export function UnreadBadge({ count }: { count: number }) {
  const { t } = useTranslation('swarm')
  if (count <= 0) return null
  return (
    <span
      title={t('messaging.unreadTitle', { count })}
      style={{
        display:        'inline-flex',
        alignItems:     'center',
        justifyContent: 'center',
        minWidth:       16,
        height:         16,
        padding:        '0 4px',
        border:         '2px solid var(--danger, #ff5252)',
        background:     'var(--danger, #ff5252)',
        color:          '#ffffff',
        fontSize:       9,
        fontWeight:     700,
        lineHeight:     1,
        fontFamily:     'JetBrains Mono, monospace',
      }}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}

/** A single message row inside a thread. */
function MessageRow({
  msg,
  selfId,
  nameOf,
}: {
  msg:    SwarmMessage
  selfId: string
  nameOf: (id: string) => string
}) {
  const { t } = useTranslation('swarm')
  const outbound = msg.from === selfId
  const counterparty = outbound ? msg.to : msg.from
  const time = new Date(msg.ts).toLocaleTimeString([], {
    hour:   '2-digit',
    minute: '2-digit',
  })

  return (
    <div
      style={{
        padding:      '6px 8px',
        borderBottom: 'var(--border-width) solid var(--border)',
        display:      'flex',
        flexDirection: 'column',
        gap:          3,
        background:   msg.read ? 'transparent' : 'var(--bg-elevated)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <KindChip kind={msg.kind} />
        <span
          style={{
            fontSize: 9,
            color:    'var(--text-dim)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex:     1,
          }}
        >
          {outbound ? `→ ${nameOf(counterparty)}` : `← ${nameOf(counterparty)}`}
        </span>
        <span style={{ fontSize: 9, color: 'var(--text-dim)', flexShrink: 0 }}>
          {time}
        </span>
      </div>
      <div
        style={{
          fontSize:   10,
          color:      'var(--text-primary)',
          lineHeight: 1.4,
          wordBreak:  'break-word',
        }}
      >
        {summarizeMessage(msg)}
      </div>
      {msg.kind === 'task_handoff' && msg.context && (
        <div style={{ fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.4 }}>
          {t('messaging.ctxLabel')} {msg.context}
        </div>
      )}
      {msg.kind === 'completed' && msg.filesChanged.length > 0 && (
        <div style={{ fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.4 }}>
          {msg.filesChanged.join(', ')}
        </div>
      )}
    </div>
  )
}

/**
 * Per-agent inbox tile: header row (name + unread badge + expand toggle),
 * an expandable thread list grouped by counterparty, and a tiny "send test
 * handoff" affordance for demoing the channel without a backend.
 */
function AgentInboxTile({
  agent,
  agents,
}: {
  agent:  SwarmAgent
  agents: SwarmAgent[]
}) {
  const { t } = useTranslation('swarm')
  const messages       = useSwarmMessagesStore((s) => s.messages)
  const send           = useSwarmMessagesStore((s) => s.send)
  const markThreadRead = useSwarmMessagesStore((s) => s.markThreadRead)

  const [open, setOpen] = useState(false)

  const nameOf = useMemo(() => {
    const map = new Map(agents.map((a) => [a.id, a.name]))
    return (id: string) => map.get(id) ?? id
  }, [agents])

  // Every message this agent is party to, oldest-first (append order is
  // already oldest-first in the store).
  const inbox = useMemo(
    () => messages.filter((m) => m.to === agent.id || m.from === agent.id),
    [messages, agent.id],
  )

  const unread = useMemo(
    () => inbox.reduce((n, m) => (m.to === agent.id && !m.read ? n + 1 : n), 0),
    [inbox, agent.id],
  )

  // Other agents this one can hand off to (first one used by the test button).
  const peers = useMemo(
    () => agents.filter((a) => a.id !== agent.id),
    [agents, agent.id],
  )

  function toggle() {
    const next = !open
    setOpen(next)
    // Opening the inbox marks everything addressed to this agent as read.
    if (next && unread > 0) markThreadRead(agent.id)
  }

  function sendTestHandoff() {
    const target = peers[0]
    if (!target) return
    const priorities: TaskPriority[] = ['low', 'normal', 'high']
    send({
      kind:     'task_handoff',
      from:     agent.id,
      to:       target.id,
      task:     t('messaging.testHandoff.task'),
      context:  t('messaging.testHandoff.context', { name: agent.name }),
      priority: priorities[inbox.length % priorities.length],
    })
  }

  return (
    <div style={{ borderBottom: 'var(--border-width) solid var(--border)' }}>
      {/* Header row — doubles as the tile + expand toggle */}
      <button
        type="button"
        onClick={toggle}
        style={{
          width:       '100%',
          textAlign:   'left',
          padding:     '6px 12px',
          border:      'none',
          background:  open ? 'var(--bg-surface)' : 'transparent',
          color:       'var(--text-primary)',
          fontFamily:  'JetBrains Mono, monospace',
          cursor:      'pointer',
          display:     'flex',
          alignItems:  'center',
          gap:         6,
        }}
      >
        <span style={{ fontSize: 9, color: 'var(--text-dim)', flexShrink: 0 }}>
          {open ? '▾' : '▸'}
        </span>
        <span
          style={{
            fontSize:   11,
            fontWeight: 700,
            overflow:   'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex:       1,
          }}
        >
          {agent.name}
        </span>
        <UnreadBadge count={unread} />
      </button>

      <AnimatedExpandableContainer isExpanded={open}>
        <div style={{ background: 'var(--bg-base)' }}>
          {inbox.length === 0 ? (
            <div style={{ padding: '8px 12px', fontSize: 10, color: 'var(--text-dim)' }}>
              {t('messaging.noMessages')}
            </div>
          ) : (
            inbox.map((m) => (
              <MessageRow key={m.id} msg={m} selfId={agent.id} nameOf={nameOf} />
            ))
          )}

          {peers.length > 0 && (
            <div style={{ padding: 8 }}>
              <button
                type="button"
                onClick={sendTestHandoff}
                title={t('messaging.sendTestTitle', { name: peers[0].name })}
                style={{
                  width:         '100%',
                  padding:       '4px 6px',
                  border:        '2px solid var(--border-strong)',
                  background:    'var(--bg-elevated)',
                  color:         'var(--text-primary)',
                  fontFamily:    'JetBrains Mono, monospace',
                  fontSize:      9,
                  fontWeight:    700,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  cursor:        'pointer',
                }}
              >
                {t('messaging.sendTestButton', { name: peers[0].name })}
              </button>
            </div>
          )}
        </div>
      </AnimatedExpandableContainer>
    </div>
  )
}

/**
 * The messaging section rendered below the agent roster. One collapsible
 * inbox per registered agent, each showing its unread badge and thread.
 */
export function MessagingInbox({ agents }: MessagingInboxProps) {
  const { t } = useTranslation('swarm')
  const totalUnread = useSwarmMessagesStore((s) =>
    s.messages.reduce((n, m) => (m.read ? n : n + 1), 0),
  )

  return (
    <div
      style={{
        borderTop:     '2px solid var(--border)',
        background:    'var(--bg-base)',
        display:       'flex',
        flexDirection: 'column',
        flexShrink:    0,
        maxHeight:     '45%',
        overflow:      'hidden',
        fontFamily:    'JetBrains Mono, monospace',
      }}
    >
      <div
        style={{
          padding:       '8px 12px',
          borderBottom:  '2px solid var(--border)',
          fontSize:      10,
          fontWeight:    700,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color:         'var(--text-muted)',
          flexShrink:    0,
          display:       'flex',
          alignItems:    'center',
          gap:           6,
        }}
      >
        <span style={{ flex: 1 }}>{t('messaging.header')}</span>
        <UnreadBadge count={totalUnread} />
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {agents.length === 0 ? (
          <div style={{ padding: '12px', fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            {t('messaging.registerPrompt')}
          </div>
        ) : (
          agents.map((agent) => (
            <AgentInboxTile key={agent.id} agent={agent} agents={agents} />
          ))
        )}
      </div>
    </div>
  )
}

export default MessagingInbox
