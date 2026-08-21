// apps/desktop/src/store/swarm-messages.store.ts
//
// Inter-agent messaging for the swarm (ECC — Event/Command/Coordination
// pattern). RENDERER-ONLY, in-memory. No IPC, no backend, no filesystem.
// This is deliberately separate from swarm.store.ts (which mirrors the
// on-disk .gnap/ state via IPC): these messages are an ephemeral coordination
// channel between agent tiles in the UI, not persisted gnap messages.
//
// The log is a discriminated union keyed on `kind` so consumers can switch()
// exhaustively and render type-coloured chips:
//   TaskHandoff { task, context, priority }
//   Query       { question }
//   Response    { answer }
//   Completed   { summary, filesChanged }
//   Conflict    { file, description }
//
// Every message carries the common envelope { id, from, to, ts, read }.
// `from`/`to` are agent ids (matching GnapAgent.id in swarm.store).

import { create } from 'zustand'

// ─── Message model ─────────────────────────────────────────────────────────

export type SwarmMessageKind =
  | 'task_handoff'
  | 'query'
  | 'response'
  | 'completed'
  | 'conflict'

/** Common envelope shared by every message variant. */
export interface SwarmMessageBase {
  id:   string
  /** Sender agent id. */
  from: string
  /** Recipient agent id. */
  to:   string
  /** Epoch ms the message was sent. */
  ts:   number
  /** Whether the recipient has read it. */
  read: boolean
}

export type TaskPriority = 'low' | 'normal' | 'high'

export interface TaskHandoffMessage extends SwarmMessageBase {
  kind:     'task_handoff'
  task:     string
  context:  string
  priority: TaskPriority
}

export interface QueryMessage extends SwarmMessageBase {
  kind:     'query'
  question: string
}

export interface ResponseMessage extends SwarmMessageBase {
  kind:   'response'
  answer: string
  /** Optional id of the Query this responds to. */
  replyTo?: string
}

export interface CompletedMessage extends SwarmMessageBase {
  kind:         'completed'
  summary:      string
  filesChanged: string[]
}

export interface ConflictMessage extends SwarmMessageBase {
  kind:        'conflict'
  file:        string
  description: string
}

/** Discriminated union of every inter-agent message type. */
export type SwarmMessage =
  | TaskHandoffMessage
  | QueryMessage
  | ResponseMessage
  | CompletedMessage
  | ConflictMessage

/**
 * Payload accepted by send(): the full message minus the auto-generated
 * envelope fields (id/ts/read). Callers supply from/to + the variant body.
 */
export type SendPayload =
  | Omit<TaskHandoffMessage, 'id' | 'ts' | 'read'>
  | Omit<QueryMessage,       'id' | 'ts' | 'read'>
  | Omit<ResponseMessage,    'id' | 'ts' | 'read'>
  | Omit<CompletedMessage,   'id' | 'ts' | 'read'>
  | Omit<ConflictMessage,    'id' | 'ts' | 'read'>

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeId(): string {
  // crypto.randomUUID is available in Electron's renderer; fall back to a
  // timestamp+random combo if it ever isn't (keeps the store dep-free).
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

// ─── Store ───────────────────────────────────────────────────────────────────

interface SwarmMessagesStore {
  /** Full log, oldest-first (append order). */
  messages: SwarmMessage[]

  /** Append a message, stamping id/ts/read. Returns the created message. */
  send: (payload: SendPayload) => SwarmMessage
  /** Mark a single message read by id. No-op if missing/already read. */
  markRead: (id: string) => void
  /** Mark every message addressed to `agentId` as read. */
  markThreadRead: (agentId: string) => void
  /** Drop the whole log (e.g. on repo switch). */
  clear: () => void

  // ── Derived selectors (pure, take current messages from the store) ─────────
  /**
   * All messages exchanged between two agents in either direction, oldest
   * first. Order-independent in its arguments.
   */
  threadBetween: (a: string, b: string) => SwarmMessage[]
  /** Count of unread messages addressed TO the given agent. */
  unreadFor: (agentId: string) => number
}

export const useSwarmMessagesStore = create<SwarmMessagesStore>((set, get) => ({
  messages: [],

  send: (payload) => {
    const msg = {
      ...payload,
      id:   makeId(),
      ts:   Date.now(),
      read: false,
    } as SwarmMessage
    set((s) => ({ messages: [...s.messages, msg] }))
    return msg
  },

  markRead: (id) =>
    set((s) => {
      let changed = false
      const next = s.messages.map((m) => {
        if (m.id === id && !m.read) {
          changed = true
          return { ...m, read: true }
        }
        return m
      })
      return changed ? { messages: next } : s
    }),

  markThreadRead: (agentId) =>
    set((s) => {
      let changed = false
      const next = s.messages.map((m) => {
        if (m.to === agentId && !m.read) {
          changed = true
          return { ...m, read: true }
        }
        return m
      })
      return changed ? { messages: next } : s
    }),

  clear: () => set({ messages: [] }),

  threadBetween: (a, b) =>
    get().messages.filter(
      (m) =>
        (m.from === a && m.to === b) || (m.from === b && m.to === a),
    ),

  unreadFor: (agentId) =>
    get().messages.reduce(
      (n, m) => (m.to === agentId && !m.read ? n + 1 : n),
      0,
    ),
}))

// ─── Presentation metadata ─────────────────────────────────────────────────
// Type → colour + short label, used by the inbox chips. Kept here so the
// store is the single source of truth for message taxonomy.

export interface MessageKindMeta {
  label: string
  /** A CSS var() expression (with fallback) for the chip colour. */
  color: string
}

export const MESSAGE_KIND_META: Record<SwarmMessageKind, MessageKindMeta> = {
  task_handoff: { label: 'HANDOFF',   color: 'var(--accent, #6c5ce7)' },
  query:        { label: 'QUERY',     color: 'var(--warning, #f59e0b)' },
  response:     { label: 'RESPONSE',  color: 'var(--text-muted, #9aa0a6)' },
  completed:    { label: 'COMPLETED', color: 'var(--success, #4ade80)' },
  conflict:     { label: 'CONFLICT',  color: 'var(--danger, #ff5252)' },
}

/** One-line human summary of a message body, used in the inbox list rows. */
export function summarizeMessage(m: SwarmMessage): string {
  switch (m.kind) {
    case 'task_handoff':
      return `${m.task}${m.priority === 'high' ? ' (!)' : ''}`
    case 'query':
      return m.question
    case 'response':
      return m.answer
    case 'completed':
      return m.filesChanged.length
        ? `${m.summary} · ${m.filesChanged.length} file(s)`
        : m.summary
    case 'conflict':
      return `${m.file}: ${m.description}`
    default: {
      // Exhaustiveness guard — TS errors here if a variant is unhandled.
      const _never: never = m
      return _never
    }
  }
}
