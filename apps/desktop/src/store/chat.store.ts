// apps/desktop/src/store/chat.store.ts
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { ChatChunk, TokenUsage, type RagCitation } from '@tachi/core'
import { cleanReasoningLeakage } from '../../electron/services/util/clean-reasoning'
import { createEncryptedStorage } from './encryptedStorage'
import { sliceForFork } from '../pages/chat/chat-branching'
import type { AutoReason } from '../utils/autoModel'
import type { SamplerSettings } from '../pages/chat/samplerPresets'

function randomUUID() { return globalThis.crypto.randomUUID() }

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'file'; data: string; mimeType: string; filename: string }
  // Surplus media results. `src` is a renderable source: a data: URL (small
  // inline images) or a file:// URL pointing at the on-disk artifact. `path` is
  // the absolute disk path (used for Save / Reveal). Audio/video are NEVER
  // base64'd into the renderer — they carry a file:// src + path.
  | { type: 'audio'; src: string; mimeType?: string; path?: string }
  | { type: 'video'; src: string; mimeType?: string; path?: string }

export function isContentParts(c: ChatMessage['content']): c is ContentPart[] {
  return Array.isArray(c)
}

export function contentToText(c: ChatMessage['content']): string {
  if (typeof c === 'string') return c
  return c.filter(p => p.type === 'text').map(p => (p as { type: 'text'; text: string }).text).join('')
}

/**
 * Tokens consumed by a single conversation. Prefer the provider-reported usage
 * (TokenUsage.totalTokens carried on each assistant message via the streamed
 * `usage` chunk). For messages with no reported usage yet (e.g. still streaming,
 * or a provider that doesn't emit usage), fall back to a chars/4 estimate over
 * the text of every message so the meter never reads zero for an active chat.
 */
export function conversationTokens(conv: Conversation | null | undefined): number {
  if (!conv) return 0
  let total = 0
  for (const m of conv.messages) {
    if (m.usage && m.usage.totalTokens > 0) {
      total += m.usage.totalTokens
    } else {
      total += Math.ceil(contentToText(m.content).length / 4)
    }
  }
  return total
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string | ContentPart[]
  model?: string
  usage?: TokenUsage
  streaming?: boolean
  error?: string
  /** Fusion compare mode: every panel answer, rendered as pickable columns. */
  panelMembers?: Array<{ model: string; text: string; ok: boolean; ms: number; tokens?: number; ttftMs?: number; error?: string }>
  /** Which column the user picked (its text becomes the message content). */
  chosenPanelIndex?: number
  /**
   * AUTO router provenance: set when this reply was produced via the AUTO
   * provider ladder (local-fit → free → paid-default). The UI stamps
   * "AUTO → <model>" wherever the model name is shown; `provider` is the
   * concrete provider the router resolved to. Absent = a direct, user-pinned
   * provider/model send.
   */
  autoRoute?: { reason: AutoReason; provider?: string }
  /**
   * RAG SOURCE CITATIONS (USER-PAINS T20): the attached-folder chunks this
   * reply was grounded in — file path, line range, score and the exact
   * retrieved text. Present ONLY when folder retrieval actually contributed;
   * absent for every ordinary message, so old persisted transcripts (and any
   * chat without an attached folder) render exactly as before.
   */
  citations?: RagCitation[]
  /**
   * CONNECTION RESILIENCE: set while this reply's stream is being re-requested
   * after a transport blip. Renders as a transient strip on the streaming
   * bubble; cleared by `reconnect-resolved`, `error` or `done`. Transient by
   * design — a persisted transcript never carries it.
   */
  reconnect?: { attempt: number; maxAttempts: number; delayMs: number; reason: string; at: number }
  /**
   * FILE-PATH CHIPS (chat): the working directory that was ACTIVE when this
   * reply's send was issued — the conversation's workspaceDir, else the
   * attached knowledge folder (see pages/chat/messageWorkingDir.ts). Captured
   * at SEND time and stamped here by appendChunk('start'), NOT read live at
   * render time: detaching the folder or switching workspace later must not
   * silently change which paths an OLD answer can resolve.
   *
   * PERSISTED (it is a plain field on a message inside `conversations`, which
   * both the zustand persist blob and the userData/conversations/<id>.json
   * mirror serialize whole), so a reopened chat still renders its chips.
   * ABSENT on every message written before this shipped — readers fall back to
   * the conversation's current dirs and then to absolute-path-only chips.
   */
  workingDir?: string
  /**
   * PROVENANCE: the provider that ACTUALLY produced this reply, captured at
   * SEND time and stamped by appendChunk('start') — never derived at render
   * time from the conversation's current providerId.
   *
   * WHY (driver-proven 2026-08-01): the badge read the conversation's live
   * provider, so flipping the picker relabelled an already-delivered Kilo reply
   * as "[OPENROUTER-OAUTH · Free]" and back. Provenance that rewrites itself is
   * worse than no provenance.
   *
   * PERSISTED (a plain field on a message, like `workingDir`). ABSENT on every
   * message written before this shipped — those render with NO provider segment
   * rather than a guess. The `model` they carry is still their own recorded
   * fact, so old bubbles keep their honest half.
   */
  providerId?: string
}

export interface ConversationUsageSummary {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  messageCount: number
}

/**
 * Pure fold over a conversation's messages summing per-message TokenUsage.
 * Returns zeros for a missing conversation. Used by the Observability console tab.
 */
export function conversationUsageSummary(conv: Conversation | null | undefined): ConversationUsageSummary {
  if (!conv) return { promptTokens: 0, completionTokens: 0, totalTokens: 0, messageCount: 0 }
  let pt = 0, ct = 0, tt = 0
  for (const m of conv.messages) {
    if (m.usage) { pt += m.usage.promptTokens; ct += m.usage.completionTokens; tt += m.usage.totalTokens }
  }
  return { promptTokens: pt, completionTokens: ct, totalTokens: tt, messageCount: conv.messages.length }
}

export interface Conversation {
  id: string
  title: string
  messages: ChatMessage[]
  providerId: string
  model: string
  createdAt: string
  updatedAt: string
  /** C4: per-conversation working directory. Optional — old persisted saves load without it. */
  workspaceDir?: string
  /** Attached knowledge folder (chat RAG): semantic context is retrieved from its local index on every send. */
  ragFolder?: string
  /** Chat folder (project) this conversation lives in. Unset = unfiled. */
  folderId?: string
  /** F16: pinned chats surface in a PINNED section at the top of History. Additive — old blobs parse. */
  pinned?: boolean
  /**
   * CHAT COMPACT (non-destructive context compaction). Index into `messages`:
   * everything BEFORE this index is represented by `compactSummary` in the
   * OUTGOING request context only — the on-screen transcript keeps every
   * message. 0/undefined = no compaction. See pages/chat/chat-context.ts.
   */
  compactedUpTo?: number
  /** Dense summary of messages[0..compactedUpTo) injected as a leading context note on send. */
  compactSummary?: string
  /**
   * THE FROZEN CUT POINT. Index into `messages` the last outgoing request
   * started at. Sent back to `planChatContext` next turn so the request's
   * LEADING BYTES stay identical between sends — which is the only thing
   * llama-server's slot cache and every cloud prefix cache key on.
   *
   * Bookkeeping, not content: undefined means "never cut yet" and the plan
   * simply starts from the compaction floor. A stale value (edit-and-rewind
   * shortened the transcript) is handled inside the planner, so an old blob
   * missing this field, or carrying an impossible one, both parse.
   */
  contextFrom?: number
  /**
   * PER-CHAT SAMPLER PRESET (USER-PAINS T19). Controls the outgoing
   * temperature / top_p for this conversation. ABSENT = BALANCED (provider
   * defaults, nothing sent) — the migration-safe default for old persisted
   * blobs. See pages/chat/samplerPresets.ts.
   */
  sampler?: SamplerSettings
}

/**
 * A chat folder ("project"): groups conversations in ChatHistory and can carry
 * project powers — a system prompt prepended to every send from its
 * conversations, and a default knowledge folder (chat RAG) used when a
 * conversation has none of its own. Deleting a folder unfiles its
 * conversations; it never deletes them.
 */
export interface ChatFolder {
  id: string
  name: string
  createdAt: string
  /** Prepended to the system prompt for sends from conversations in this folder. */
  systemPrompt?: string
  /** Default knowledge folder — used when the conversation has no ragFolder. */
  ragFolder?: string
  /** F16: default provider adopted by NEW conversations created in this folder. */
  defaultProviderId?: string
  /** F16: default model for defaultProviderId (meaningless without it). */
  defaultModel?: string
  collapsed?: boolean
}

interface ChatStore {
  conversations: Conversation[]
  folders: ChatFolder[]
  activeConversationId: string | null
  streamingMessageId: string | null
  streamingConversationId: string | null
  chunkConversationIds: Record<string, string>
  /** Message pre-filled into InputBar on next mount (set by HomePage quick-starts). */
  pendingMessage: string | null
  /**
   * AUTO provider router: the last concrete provider+model the user selected,
   * used as the `currentDefault` (paid-default rung) when a conversation's
   * provider is 'auto' and neither a local model nor a free provider is
   * available. Tracked here (global) so switching TO auto never loses the
   * fallback. See src/utils/autoModel.ts.
   */
  autoFallback: { providerId: string; model: string }
  setAutoFallback: (providerId: string, model: string) => void
  /**
   * Pending AUTO-route decisions keyed by conversationId. Set at SEND time when
   * a conversation's provider is 'auto'; consumed by appendChunk('start') to
   * stamp the resulting assistant message's `autoRoute` meta. Transient (not
   * persisted).
   */
  pendingAutoRoute: Record<string, { reason: AutoReason; provider?: string }>
  setPendingAutoRoute: (conversationId: string, meta: { reason: AutoReason; provider?: string } | null) => void
  /**
   * RAG citations retrieved for an in-flight send, keyed by conversationId.
   * Main emits the `citations` chunk right after folder retrieval — before any
   * provider branch has minted a message id — so we park them here and
   * appendChunk('start') stamps them onto the assistant message it creates.
   * Transient (not persisted); cleared on start/error/done so a failed send
   * can never leak its sources onto a later reply.
   */
  pendingCitations: Record<string, RagCitation[]>
  /**
   * FILE-PATH CHIPS: the working directory active at SEND time, keyed by
   * conversationId. Same park-then-stamp idiom as `pendingCitations` — the
   * composer knows the dir before any provider branch has minted a message id,
   * so it parks it here and appendChunk('start') stamps it onto the assistant
   * message it creates. Transient (never persisted); cleared on start/error/done
   * so an abandoned send can't leak its dir onto a later reply.
   */
  pendingWorkingDir: Record<string, string>
  /** Park (or clear, with null) the send-time working dir for a conversation. */
  setPendingWorkingDir: (conversationId: string, dir: string | null) => void
  /**
   * PROVENANCE: the provider this send is ACTUALLY routed to, keyed by
   * conversationId. Same park-then-stamp idiom as `pendingWorkingDir` — parked
   * by the composer at SEND time (after AUTO resolution, so it is the concrete
   * provider) and stamped onto the assistant message by appendChunk('start').
   *
   * WHY (driver-proven 2026-08-01): the badge used to render the CONVERSATION's
   * current providerId, so switching the picker relabelled an already-delivered
   * Kilo reply as "[OPENROUTER-OAUTH]" — provenance that rewrote itself. A
   * delivered message's provenance is a FACT about the run that produced it,
   * never a function of mutable conversation state.
   */
  pendingProvider: Record<string, string>
  /** Park (or clear, with null) the send-time provider for a conversation. */
  setPendingProvider: (conversationId: string, providerId: string | null) => void
  /** Model pinned for freellmapi sends. Null = AUTO (fallback chain). */
  pinnedFreellmapiModel: string | null
  /** Current fallback sort preset for freellmapi. */
  freellmapiSortMode: 'intelligence' | 'speed' | 'budget'
  setPinnedFreellmapiModel: (model: string | null) => void
  setFreellmapiSortMode: (mode: 'intelligence' | 'speed' | 'budget') => void
  /** Surplus smart router: route by task difficulty when ON (Surplus + auto model). */
  surplusSmartRouting: boolean
  /** Let hard + agentic tasks escalate to the agent-kit workflow (opt-in). */
  allowWorkflowEscalation: boolean
  /** Fusion mode: a panel of models answers in parallel + a judge synthesizes (Bankr only). */
  fusionMode: boolean
  /** Fusion panel preset: 'budget' (cheap cross-family) or 'frontier' (top models). */
  fusionPreset: 'budget' | 'frontier'
  /** Fusion arbiter: how to combine the panel into one answer. */
  fusionArbiter: 'synthesize' | 'best_of_n' | 'majority' | 'compare'
  /**
   * Custom Fusion/COMPARE panel picked in the composer (UX #6). Model ids may
   * be cloud catalog ids OR namespaced local ids (`ollama:<model>` /
   * `llamacpp:<id>`). Empty = the preset panel (AUTO).
   */
  fusionCustomPanel: string[]
  setSurplusSmartRouting: (v: boolean) => void
  setAllowWorkflowEscalation: (v: boolean) => void
  setFusionMode: (v: boolean) => void
  setFusionPreset: (v: 'budget' | 'frontier') => void
  setFusionArbiter: (v: 'synthesize' | 'best_of_n' | 'majority' | 'compare') => void
  setFusionCustomPanel: (models: string[]) => void
  newConversation: (providerId?: string, model?: string) => string
  /** C4: bind a working directory to a conversation. Pass null to unset. */
  setConversationWorkspace(conversationId: string, workspaceDir: string | null): void
  setActive: (id: string) => void
  setStreamingConversation: (id: string | null) => void
  setProvider: (conversationId: string, providerId: string, model?: string) => void
  renameConversation: (id: string, title: string) => void
  /** Attach/detach a knowledge folder for chat RAG (null detaches). */
  setConversationRagFolder: (id: string, folder: string | null) => void
  /**
   * PER-CHAT SAMPLER: set the conversation's sampler preset/knobs. Passing null
   * (or a BALANCED preset with no custom knobs) clears it back to the default —
   * absent = BALANCED, so we never persist a redundant BALANCED marker.
   */
  setConversationSampler: (id: string, sampler: SamplerSettings | null) => void
  /**
   * CHAT COMPACT: record a non-destructive compaction for a conversation. The
   * transcript is untouched; only the outgoing request context shrinks (the
   * head is replaced by `summary`). Pass compactedUpTo=0 to clear compaction.
   */
  setConversationCompaction: (id: string, compactedUpTo: number, summary: string) => void
  /**
   * Persist the frozen cut point (see Conversation.contextFrom). Called only
   * when the planner actually MOVED the cut, so the common turn writes nothing.
   *
   * Deliberately does NOT bump `updatedAt`: this is cache bookkeeping, and a
   * chat must not jump to the top of History because its prefix was re-cut.
   */
  setConversationContextFrom: (id: string, from: number) => void
  // ── Chat folders (projects) ──
  createFolder: (name: string) => string
  renameFolder: (id: string, name: string) => void
  /** Unfiles the folder's conversations, then removes the folder. */
  deleteFolder: (id: string) => void
  toggleFolderCollapsed: (id: string) => void
  /** Move a conversation into a folder (null = unfile). */
  setConversationFolder: (conversationId: string, folderId: string | null) => void
  setFolderSystemPrompt: (id: string, prompt: string | null) => void
  setFolderRagFolder: (id: string, folder: string | null) => void
  /** F16: set/clear a folder's default provider/model for new chats. providerId null clears both. */
  setFolderDefaults: (id: string, defaults: { providerId?: string | null; model?: string | null }) => void
  /** F16: toggle a conversation's pinned flag (does NOT touch updatedAt — pinning must not reorder). */
  togglePinned: (id: string) => void
  /** Fusion compare: adopt panel column `index` as the message's content. */
  choosePanelAnswer: (conversationId: string, messageId: string, index: number) => void
  deleteConversation: (id: string) => void
  addUserMessage: (conversationId: string, content: string | ContentPart[]) => void
  /** Rewind/edit: drop `messageId` and every message after it from a conversation. */
  truncateFrom: (conversationId: string, messageId: string) => void
  /** UX #5 FORK: new conversation seeded with history up to (incl.) messageId.
   *  activate=false keeps the current conversation focused (silent branch
   *  backup on EDIT). Returns the new conversation id, or null. */
  forkConversation: (conversationId: string, messageId: string, opts?: { activate?: boolean; titleSuffix?: string }) => string | null
  /**
   * Append a finished assistant message carrying media result parts (image /
   * audio / video, optionally with a leading/trailing text note). Used by the
   * Surplus media path in Chat where the result is not streamed text but a
   * completed artifact. Returns the new message id.
   */
  appendAssistantMedia: (conversationId: string, parts: ContentPart[], model?: string) => string
  appendChunk: (chunk: ChatChunk) => Conversation | null
  getActive: () => Conversation | null
  setPendingMessage: (msg: string | null) => void
}

// --- streaming delta coalescing -------------------------------------------
// Tokens arrive ~ every few ms. We accumulate per-message pending text and
// flush it via requestAnimationFrame so multiple deltas collapse into one
// zustand set() per frame (~16ms). Final assembled text is identical to the
// un-batched path; only the cadence of intermediate renders differs.
const pendingDeltas = new Map<string, string>()
let rafHandle: number | null = null

function scheduleFlush(flush: () => void): void {
  if (rafHandle !== null) return
  const raf =
    typeof globalThis.requestAnimationFrame === 'function'
      ? globalThis.requestAnimationFrame.bind(globalThis)
      : (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number
  rafHandle = raf(() => {
    rafHandle = null
    flush()
  })
}

export const useChatStore = create<ChatStore>()(persist((set, get) => {
  function flushPendingDeltas(): void {
    if (pendingDeltas.size === 0) return
    const drained = new Map(pendingDeltas)
    pendingDeltas.clear()
    set(s => ({
      conversations: s.conversations.map(c => {
        // Only touch conversations that have at least one buffered message
        const hasAny = c.messages.some(m => drained.has(m.id))
        if (!hasAny) return c
        return {
          ...c,
          messages: c.messages.map(m => {
            const buffered = drained.get(m.id)
            if (buffered === undefined) return m
            return { ...m, content: (typeof m.content === 'string' ? m.content : '') + buffered }
          }),
        }
      }),
    }))
  }

  return ({
  conversations: [],
  folders: [],
  activeConversationId: null,
  streamingMessageId: null,
  streamingConversationId: null,
  chunkConversationIds: {},
  pendingMessage: null,
  autoFallback: { providerId: 'freellmapi-local', model: 'auto' },
  pendingAutoRoute: {},
  pendingCitations: {} as Record<string, RagCitation[]>,
  pendingWorkingDir: {} as Record<string, string>,
  pendingProvider: {} as Record<string, string>,
  pinnedFreellmapiModel: null,
  freellmapiSortMode: 'intelligence' as 'intelligence' | 'speed' | 'budget',
  surplusSmartRouting: false,
  allowWorkflowEscalation: false,
  fusionMode: false,
  fusionPreset: 'budget' as 'budget' | 'frontier',
  fusionArbiter: 'synthesize' as 'synthesize' | 'best_of_n' | 'majority' | 'compare',
  fusionCustomPanel: [] as string[],

  setAutoFallback(providerId, model) {
    if (!providerId || providerId === 'auto') return
    set({ autoFallback: { providerId, model: model || 'auto' } })
  },
  setPendingAutoRoute(conversationId, meta) {
    set(s => {
      if (meta) return { pendingAutoRoute: { ...s.pendingAutoRoute, [conversationId]: meta } }
      // Clear one entry.
      const next = { ...s.pendingAutoRoute }
      delete next[conversationId]
      return { pendingAutoRoute: next }
    })
  },
  setPendingWorkingDir(conversationId, dir) {
    set(s => {
      const next = { ...s.pendingWorkingDir }
      const trimmed = typeof dir === 'string' ? dir.trim() : ''
      if (trimmed) next[conversationId] = trimmed
      else delete next[conversationId]
      return { pendingWorkingDir: next }
    })
  },
  setPendingProvider(conversationId, providerId) {
    set(s => {
      const next = { ...s.pendingProvider }
      const trimmed = typeof providerId === 'string' ? providerId.trim() : ''
      // 'auto' is a pseudo-provider, never a provenance fact — the concrete
      // provider arrives via autoRoute instead.
      if (trimmed && trimmed !== 'auto') next[conversationId] = trimmed
      else delete next[conversationId]
      return { pendingProvider: next }
    })
  },
  setPinnedFreellmapiModel(model) { set({ pinnedFreellmapiModel: model }) },
  setFreellmapiSortMode(mode)     { set({ freellmapiSortMode: mode }) },
  setSurplusSmartRouting(v)       { set({ surplusSmartRouting: v }) },
  setAllowWorkflowEscalation(v)   { set({ allowWorkflowEscalation: v }) },
  setFusionMode(v)                { set({ fusionMode: v }) },
  setFusionPreset(v)              { set({ fusionPreset: v }) },
  setFusionArbiter(v)             { set({ fusionArbiter: v }) },
  setFusionCustomPanel(models)    { set({ fusionCustomPanel: models.slice(0, 6) }) },

  newConversation(providerId?: string, model?: string) {
    // A new chat keeps the provider the user last explicitly picked
    // (autoFallback tracks it via setProvider) instead of resetting to the
    // local router — live-found: every "+ NEW" dropped a Bankr user back onto
    // FreeLLM. Explicit args still win (drag-to-provider, folder defaults).
    const fb = get().autoFallback
    if (providerId === undefined) { providerId = fb.providerId || 'freellmapi-local'; model ??= fb.model || 'auto' }
    model ??= 'auto'
    // Ghost-chat guard (UX #3): an existing EMPTY conversation is reused
    // instead of minting another "New Chat · 0 msgs" row — every "+ NEW"
    // click used to persist a fresh ghost into history. Reuse keeps the
    // caller contract (returns an id that is active) and caps ghosts at 1.
    const empty = get().conversations.find(c => c.messages.length === 0)
    if (empty) {
      set(s => ({
        activeConversationId: empty.id,
        conversations: s.conversations.map(c =>
          c.id === empty.id ? { ...c, title: 'New Chat', providerId, model, updatedAt: new Date().toISOString() } : c),
      }))
      return empty.id
    }
    const id = randomUUID()
    const conv: Conversation = {
      id, title: 'New Chat',
      messages: [], providerId, model,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    set(s => ({ conversations: [conv, ...s.conversations], activeConversationId: id }))
    return id
  },

  setActive(id) { set({ activeConversationId: id }) },

  setStreamingConversation(id) { set({ streamingConversationId: id }) },

  setProvider(conversationId, providerId, model) {
    set(s => {
      const nextConversations = s.conversations.map(c =>
        c.id !== conversationId ? c : {
          ...c,
          providerId,
          model: model ?? c.model,
          updatedAt: new Date().toISOString(),
        }
      )
      // Track the last CONCRETE selection as the AUTO paid-default fallback, so
      // switching a chat to 'auto' never loses a real provider to fall back to.
      if (providerId && providerId !== 'auto') {
        const conv = nextConversations.find(c => c.id === conversationId)
        return { conversations: nextConversations, autoFallback: { providerId, model: model ?? conv?.model ?? 'auto' } }
      }
      return { conversations: nextConversations }
    })
  },

  renameConversation(id, title) {
    set(s => ({
      conversations: s.conversations.map(c =>
        c.id !== id ? c : { ...c, title, updatedAt: new Date().toISOString() }
      ),
    }))
  },

  setConversationRagFolder(id, folder) {
    set(s => ({
      conversations: s.conversations.map(c =>
        c.id !== id ? c : { ...c, ragFolder: folder ?? undefined }
      ),
    }))
  },

  setConversationSampler(id, sampler) {
    // Normalize BALANCED (with no custom knobs) → absent, so the persisted blob
    // stays clean and "absent = BALANCED" holds for every reader.
    const clear = !sampler || (sampler.preset === 'balanced')
    set(s => ({
      conversations: s.conversations.map(c =>
        c.id !== id ? c : { ...c, sampler: clear ? undefined : sampler }
      ),
    }))
  },

  setConversationCompaction(id, compactedUpTo, summary) {
    const clear = !(compactedUpTo > 0)
    let updated: Conversation | null = null
    set(s => ({
      conversations: s.conversations.map(c => {
        if (c.id !== id) return c
        const next: Conversation = {
          ...c,
          compactedUpTo: clear ? undefined : compactedUpTo,
          compactSummary: clear ? undefined : summary,
          updatedAt: new Date().toISOString(),
        }
        updated = next
        return next
      }),
    }))
    // Mirror the on-disk JSON so the compaction survives export/search sync
    // (same best-effort pattern as choosePanelAnswer).
    try { if (updated) window.tachi?.chat?.saveConversation?.(updated)?.catch(() => { /* best-effort */ }) } catch { /* non-electron env (tests) */ }
  },

  setConversationContextFrom(id, from) {
    const next = Number.isFinite(from) && from > 0 ? Math.floor(from) : undefined
    set(s => ({
      conversations: s.conversations.map(c =>
        c.id === id && c.contextFrom !== next ? { ...c, contextFrom: next } : c,
      ),
    }))
  },

  createFolder(name) {
    const id = randomUUID()
    set(s => ({
      folders: [...s.folders, { id, name: name.trim() || 'Project', createdAt: new Date().toISOString() }],
    }))
    return id
  },

  renameFolder(id, name) {
    set(s => ({
      folders: s.folders.map(f => f.id !== id ? f : { ...f, name: name.trim() || f.name }),
    }))
  },

  deleteFolder(id) {
    set(s => ({
      folders: s.folders.filter(f => f.id !== id),
      conversations: s.conversations.map(c =>
        c.folderId !== id ? c : { ...c, folderId: undefined }
      ),
    }))
  },

  toggleFolderCollapsed(id) {
    set(s => ({
      folders: s.folders.map(f => f.id !== id ? f : { ...f, collapsed: !f.collapsed }),
    }))
  },

  setConversationFolder(conversationId, folderId) {
    set(s => ({
      conversations: s.conversations.map(c =>
        c.id !== conversationId ? c : { ...c, folderId: folderId ?? undefined }
      ),
    }))
  },

  setFolderSystemPrompt(id, prompt) {
    set(s => ({
      folders: s.folders.map(f =>
        f.id !== id ? f : { ...f, systemPrompt: prompt?.trim() ? prompt : undefined }
      ),
    }))
  },

  setFolderRagFolder(id, folder) {
    set(s => ({
      folders: s.folders.map(f => f.id !== id ? f : { ...f, ragFolder: folder ?? undefined }),
    }))
  },

  setFolderDefaults(id, defaults) {
    set(s => ({
      folders: s.folders.map(f => {
        if (f.id !== id) return f
        const next = { ...f }
        if (defaults.providerId !== undefined) {
          if (defaults.providerId?.trim()) {
            next.defaultProviderId = defaults.providerId.trim()
          } else {
            // Clearing the provider clears the model too — a bare model id is
            // ambiguous across providers.
            delete next.defaultProviderId
            delete next.defaultModel
          }
        }
        if (defaults.model !== undefined) {
          if (defaults.model?.trim()) next.defaultModel = defaults.model.trim()
          else delete next.defaultModel
        }
        return next
      }),
    }))
  },

  togglePinned(id) {
    set(s => ({
      conversations: s.conversations.map(c =>
        c.id !== id ? c : { ...c, pinned: c.pinned ? undefined : true }
      ),
    }))
  },

  choosePanelAnswer(conversationId, messageId, index) {
    let updated: Conversation | null = null
    set(s => ({
      conversations: s.conversations.map(c => {
        if (c.id !== conversationId) return c
        const next = {
          ...c,
          updatedAt: new Date().toISOString(),
          messages: c.messages.map(m => {
            if (m.id !== messageId || !m.panelMembers?.[index]) return m
            return { ...m, content: m.panelMembers[index].text, model: m.panelMembers[index].model, chosenPanelIndex: index }
          }),
        }
        updated = next
        return next
      }),
    }))
    // Refresh the on-disk JSON mirror so the picked answer (not the placeholder)
    // is what history/search/export see.
    try { if (updated) window.tachi?.chat?.saveConversation?.(updated)?.catch(() => { /* best-effort */ }) } catch { /* non-electron env */ }
  },

  deleteConversation(id) {
    set(s => ({
      conversations: s.conversations.filter(c => c.id !== id),
      activeConversationId: s.activeConversationId === id ? null : s.activeConversationId,
    }))
    // Keep the on-disk JSON mirror in sync — otherwise "deleted" chats survive
    // in userData/conversations and resurface in full-text search.
    try { window.tachi?.chat?.deleteConversation?.(id)?.catch(() => { /* best-effort */ }) } catch { /* non-electron env (tests) */ }
  },

  setPendingMessage(msg) { set({ pendingMessage: msg }) },

  addUserMessage(conversationId, content: string | ContentPart[]) {
    const msgId = randomUUID()
    set(s => ({
      conversations: s.conversations.map(c =>
        c.id !== conversationId ? c : {
          ...c, updatedAt: new Date().toISOString(),
          messages: [...c.messages, { id: msgId, role: 'user' as const, content }],
        }
      ),
    }))
  },

  truncateFrom(conversationId, messageId) {
    set(s => ({
      conversations: s.conversations.map(c => {
        if (c.id !== conversationId) return c
        const idx = c.messages.findIndex(m => m.id === messageId)
        if (idx < 0) return c
        return { ...c, messages: c.messages.slice(0, idx), updatedAt: new Date().toISOString() }
      }),
    }))
  },

  forkConversation(conversationId, messageId, opts) {
    const source = get().conversations.find(c => c.id === conversationId)
    if (!source) return null
    const seeded = sliceForFork(source.messages, messageId, randomUUID)
    if (!seeded) return null
    const id = randomUUID()
    const now = new Date().toISOString()
    const fork: Conversation = {
      ...source,
      id,
      title: `${source.title} ${opts?.titleSuffix ?? '(fork)'}`.slice(0, 120),
      messages: seeded,
      createdAt: now,
      updatedAt: now,
    }
    set(s => ({
      conversations: [fork, ...s.conversations],
      ...(opts?.activate !== false ? { activeConversationId: id } : {}),
    }))
    return id
  },

  appendAssistantMedia(conversationId, parts, model) {
    const msgId = randomUUID()
    set(s => ({
      conversations: s.conversations.map(c =>
        c.id !== conversationId ? c : {
          ...c, updatedAt: new Date().toISOString(),
          messages: [...c.messages, {
            id: msgId, role: 'assistant' as const, content: parts, model, streaming: false,
          }],
        }
      ),
    }))
    return msgId
  },

  appendChunk(chunk) {
    let targetConversationId: string | null = null
    if (chunk.type === 'start') {
      // Flush any pending deltas before mutating structure
      flushPendingDeltas()
      const assistantId = chunk.messageId
      const tcid = get().streamingConversationId ?? get().activeConversationId
      if (!tcid) return null
      targetConversationId = tcid
      // AUTO router: if this send was resolved via the AUTO ladder, stamp the
      // new assistant message so the UI can render "AUTO → <model>". Consume the
      // pending entry so a later non-auto send in the same chat isn't mislabeled.
      const autoMeta = get().pendingAutoRoute[tcid]
      // T20: RAG provenance retrieved for THIS send (emitted before the provider
      // minted `assistantId`) — stamp it onto the message being created, then
      // consume it so the next reply in this chat starts clean.
      const cites = get().pendingCitations?.[tcid]
      // FILE-PATH CHIPS: the dir the composer parked for THIS send. Stamped onto
      // the message being created and consumed, exactly like the citations above,
      // so the answer keeps resolving paths against the dir it was produced in.
      const wdir = get().pendingWorkingDir?.[tcid]
      // PROVENANCE: the provider this send actually ran on, parked by the
      // composer. Stamped onto the message HERE so the badge reads a recorded
      // fact; the conversation's live providerId is never consulted again for
      // an already-delivered reply.
      const sentProvider = get().pendingProvider?.[tcid]
      set(s => {
        const nextPending = { ...s.pendingAutoRoute }
        if (autoMeta) delete nextPending[tcid]
        const nextCitations = { ...s.pendingCitations }
        if (cites) delete nextCitations[tcid]
        const nextWorkingDir = { ...s.pendingWorkingDir }
        if (wdir) delete nextWorkingDir[tcid]
        const nextProvider = { ...s.pendingProvider }
        if (sentProvider) delete nextProvider[tcid]
        return {
          streamingMessageId: assistantId,
          streamingConversationId: tcid,
          chunkConversationIds: { ...s.chunkConversationIds, [assistantId]: tcid },
          pendingAutoRoute: nextPending,
          pendingCitations: nextCitations,
          pendingWorkingDir: nextWorkingDir,
          pendingProvider: nextProvider,
          conversations: s.conversations.map(c =>
            c.id !== tcid ? c : {
              ...c,
              model: chunk.model && chunk.model !== 'auto' ? chunk.model : c.model,
              messages: [...c.messages, {
                id: assistantId, role: 'assistant', content: '', model: chunk.model, streaming: true,
                ...(autoMeta ? { autoRoute: autoMeta } : {}),
                ...(cites && cites.length > 0 ? { citations: cites } : {}),
                ...(wdir ? { workingDir: wdir } : {}),
                ...(sentProvider ? { providerId: sentProvider } : {}),
              }],
            }
          ),
        }
      })
    } else if (chunk.type === 'delta') {
      const tcid = get().chunkConversationIds[chunk.messageId] ?? get().streamingConversationId ?? get().activeConversationId
      if (!tcid) return null
      targetConversationId = tcid
      // Coalesce: append to per-message buffer and schedule a single rAF flush.
      const prev = pendingDeltas.get(chunk.messageId) ?? ''
      pendingDeltas.set(chunk.messageId, prev + chunk.text)
      scheduleFlush(flushPendingDeltas)
    } else if (chunk.type === 'reset') {
      // CONNECTION RESILIENCE: the provider is about to regenerate this answer
      // from scratch after a dropped stream. Drop BOTH the committed content and
      // the un-flushed delta buffer — flushing first would race the reset and
      // re-append the very text we are discarding, which is precisely the
      // "answer rendered twice" bug this chunk exists to prevent.
      pendingDeltas.delete(chunk.messageId)
      const tcid = get().chunkConversationIds[chunk.messageId] ?? get().streamingConversationId ?? get().activeConversationId
      if (!tcid) return null
      targetConversationId = tcid
      set(s => ({
        conversations: s.conversations.map(c =>
          c.id !== tcid ? c : {
            ...c, messages: c.messages.map(m =>
              m.id !== chunk.messageId ? m : { ...m, content: '', streaming: true }
            ),
          }
        ),
      }))
    } else if (chunk.type === 'reconnect') {
      flushPendingDeltas()
      const tcid = get().chunkConversationIds[chunk.messageId] ?? get().streamingConversationId ?? get().activeConversationId
      if (!tcid) return null
      targetConversationId = tcid
      set(s => ({
        conversations: s.conversations.map(c =>
          c.id !== tcid ? c : {
            ...c, messages: c.messages.map(m =>
              m.id !== chunk.messageId ? m : {
                ...m,
                reconnect: { attempt: chunk.attempt, maxAttempts: chunk.maxAttempts, delayMs: chunk.delayMs, reason: chunk.reason, at: Date.now() },
              }
            ),
          }
        ),
      }))
    } else if (chunk.type === 'reconnect-resolved') {
      const tcid = get().chunkConversationIds[chunk.messageId] ?? get().streamingConversationId ?? get().activeConversationId
      if (!tcid) return null
      targetConversationId = tcid
      set(s => ({
        conversations: s.conversations.map(c =>
          c.id !== tcid ? c : {
            ...c, messages: c.messages.map(m =>
              m.id !== chunk.messageId ? m : { ...m, reconnect: undefined }
            ),
          }
        ),
      }))
    } else if (chunk.type === 'panel') {
      // Fusion compare mode: attach every panel answer to the streaming message
      // so the bubble renders pickable columns.
      flushPendingDeltas()
      const tcid = get().chunkConversationIds[chunk.messageId] ?? get().streamingConversationId ?? get().activeConversationId
      if (!tcid) return null
      targetConversationId = tcid
      set(s => ({
        conversations: s.conversations.map(c =>
          c.id !== tcid ? c : {
            ...c, messages: c.messages.map(m =>
              m.id !== chunk.messageId ? m : { ...m, panelMembers: chunk.members }
            ),
          }
        ),
      }))
    } else if (chunk.type === 'citations') {
      // T20 SOURCE CITATIONS. Main emits this right after attached-folder
      // retrieval, normally BEFORE the provider branch minted a message id — so
      // `conversationId` (not messageId) is the authoritative target and the
      // payload is parked for the next `start`. When a producer DOES know the
      // message id and that message already exists, stamp it directly instead.
      const tcid = chunk.conversationId || get().streamingConversationId || get().activeConversationId
      if (!tcid) return null
      targetConversationId = tcid
      const conv = get().conversations.find(c => c.id === tcid)
      const known = Boolean(chunk.messageId) && Boolean(conv?.messages.some(m => m.id === chunk.messageId))
      if (known) {
        flushPendingDeltas()
        set(s => ({
          conversations: s.conversations.map(c =>
            c.id !== tcid ? c : {
              ...c, messages: c.messages.map(m =>
                m.id !== chunk.messageId ? m : { ...m, citations: chunk.citations }
              ),
            }
          ),
        }))
      } else {
        set(s => {
          const next = { ...s.pendingCitations }
          if (chunk.citations.length > 0) next[tcid] = chunk.citations
          else delete next[tcid]
          return { pendingCitations: next }
        })
      }
    } else if (chunk.type === 'usage') {
      // Non-delta chunks must observe the fully-assembled text up to this point.
      flushPendingDeltas()
      const tcid = get().chunkConversationIds[chunk.messageId] ?? get().streamingConversationId ?? get().activeConversationId
      if (!tcid) return null
      targetConversationId = tcid
      set(s => ({
        conversations: s.conversations.map(c =>
          c.id !== tcid ? c : {
            ...c, messages: c.messages.map(m =>
              m.id !== chunk.messageId ? m : { ...m, usage: chunk.usage }
            ),
          }
        ),
      }))
    } else if (chunk.type === 'error') {
      flushPendingDeltas()
      const tcid = get().chunkConversationIds[chunk.messageId] ?? get().streamingConversationId ?? get().activeConversationId
      if (!tcid) return null
      targetConversationId = tcid
      set(s => {
        const isCurrentStream = s.streamingMessageId === chunk.messageId || s.streamingConversationId === tcid
        // A send that died before `start` (bad model, missing key…) leaves its
        // retrieved sources parked — drop them so they can't be stamped onto a
        // later, unrelated reply in this chat. Same for its working dir.
        const nextCitations = { ...s.pendingCitations }
        delete nextCitations[tcid]
        const nextWorkingDir = { ...s.pendingWorkingDir }
        delete nextWorkingDir[tcid]
        const nextProviderOnError = { ...s.pendingProvider }
        delete nextProviderOnError[tcid]
        // A refusal that fired BEFORE `start` (PRIVATE MODE egress block,
        // missing key, IPC send failure…) carries messageId 'unknown' — no
        // assistant bubble exists yet, so stamping by id matches NOTHING and
        // the refusal used to vanish (Kilo + private mode hung silently,
        // driver-proven 2026-08-01). An error the user never sees is the worst
        // kind: append a dedicated error bubble so every refusal RENDERS.
        const conv = s.conversations.find(c => c.id === tcid)
        const hasTarget = Boolean(conv?.messages.some(m => m.id === chunk.messageId))
        return {
          streamingMessageId: isCurrentStream ? null : s.streamingMessageId,
          streamingConversationId: isCurrentStream ? null : s.streamingConversationId,
          pendingCitations: nextCitations,
          pendingWorkingDir: nextWorkingDir,
          pendingProvider: nextProviderOnError,
          // Always clean up the entry so errors don't leak into chunkConversationIds.
          chunkConversationIds: Object.fromEntries(
            Object.entries(s.chunkConversationIds).filter(([id]) => id !== chunk.messageId)
          ),
          conversations: s.conversations.map(c =>
            c.id !== tcid ? c : hasTarget
              ? {
                  ...c, messages: c.messages.map(m =>
                    // reconnect cleared: the run is over, nothing is being retried.
                    m.id !== chunk.messageId ? m : { ...m, streaming: false, error: chunk.error.message, reconnect: undefined }
                  ),
                }
              : {
                  ...c, messages: [...c.messages, {
                    id: chunk.messageId && chunk.messageId !== 'unknown' ? chunk.messageId : randomUUID(),
                    role: 'assistant' as const, content: '', streaming: false, error: chunk.error.message,
                  }],
                }
          ),
        }
      })
    } else if (chunk.type === 'done') {
      flushPendingDeltas()
      const tcid = get().chunkConversationIds[chunk.messageId] ?? get().streamingConversationId ?? get().activeConversationId
      if (!tcid) return null
      targetConversationId = tcid
      set(s => {
        const isCurrentStream = s.streamingMessageId === chunk.messageId || s.streamingConversationId === tcid
        // Normally already consumed by `start`; clearing here keeps the maps
        // from growing when a send never produced a message.
        const nextCitations = { ...s.pendingCitations }
        delete nextCitations[tcid]
        const nextWorkingDir = { ...s.pendingWorkingDir }
        delete nextWorkingDir[tcid]
        const nextProviderOnDone = { ...s.pendingProvider }
        delete nextProviderOnDone[tcid]
        return {
          streamingMessageId: isCurrentStream ? null : s.streamingMessageId,
          streamingConversationId: isCurrentStream ? null : s.streamingConversationId,
          pendingCitations: nextCitations,
          pendingWorkingDir: nextWorkingDir,
          pendingProvider: nextProviderOnDone,
          chunkConversationIds: Object.fromEntries(
            Object.entries(s.chunkConversationIds).filter(([messageId]) => messageId !== chunk.messageId)
          ),
          conversations: s.conversations.map(c =>
            c.id !== tcid ? c : {
              ...c, messages: c.messages.map(m =>
                m.id !== chunk.messageId ? m : {
                  ...m, streaming: false, reconnect: undefined,
                  // STEAL 2026-06-13 (Pulse): scrub leaked reasoning markers from
                  // the FINAL accumulated answer (safe here — the full text is
                  // settled on `done`; never run per-delta). String content only;
                  // structured parts are left untouched.
                  content: typeof m.content === 'string' ? cleanReasoningLeakage(m.content) : m.content,
                }
              ),
            }
          ),
        }
      })
    }
    return targetConversationId
      ? get().conversations.find(c => c.id === targetConversationId) ?? null
      : null
  },

  setConversationWorkspace(conversationId, workspaceDir) {
    set(s => ({
      conversations: s.conversations.map(c =>
        c.id !== conversationId
          ? c
          : { ...c, workspaceDir: workspaceDir ?? undefined, updatedAt: new Date().toISOString() }
      ),
    }))
  },

  getActive() {
    const { conversations, activeConversationId } = get()
    return conversations.find(c => c.id === activeConversationId) ?? null
  },
  })
}, {
  name: 'tachi-chat-v1',
  storage: createJSONStorage(() => createEncryptedStorage('chat')),
  // Don't persist transient streaming state. Only persist conversations + last active.
  partialize: (s) => ({
    conversations: s.conversations,
    folders: s.folders,
    activeConversationId: s.activeConversationId,
    surplusSmartRouting: s.surplusSmartRouting,
    allowWorkflowEscalation: s.allowWorkflowEscalation,
    autoFallback: s.autoFallback,
  }) as Partial<ChatStore>,
  // Drop in-flight streaming flags after rehydration so reloads recover cleanly.
  onRehydrateStorage: () => (state) => {
    if (state) {
      state.streamingMessageId = null
      state.streamingConversationId = null
      state.chunkConversationIds = {}
      state.pendingCitations = {}
      state.pendingWorkingDir = {}
      state.pendingProvider = {}
      // Any messages that were mid-stream when the app closed get error-marked
      for (const c of state.conversations) {
        for (const m of c.messages) {
          if (m.streaming) { m.streaming = false; m.error = m.error ?? 'Interrupted (app restarted)' }
        }
      }
      // GC accumulated ghost chats (0-message rows persisted by old builds).
      // Keep the active one — it may be the draft the user is looking at —
      // and keep PINNED ones (F16): pinning an empty draft is deliberate.
      const ghosts = state.conversations.filter(c => c.messages.length === 0 && c.id !== state.activeConversationId && !c.pinned)
      if (ghosts.length > 0) {
        state.conversations = state.conversations.filter(c => c.messages.length > 0 || c.id === state.activeConversationId || c.pinned)
      }
    }
  },
}))
