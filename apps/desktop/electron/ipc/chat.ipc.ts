import { ipcMain, BrowserWindow, app } from 'electron'
import { mkdirSync, writeFileSync, unlinkSync } from 'fs'
import { join, sep } from 'path'
import { z } from 'zod'
import { sendChatMessage, abortMessage, registerConversationProvider } from '../services/chat-service'
import { notifyTaskDone } from '../services/notifications'
import { formatError } from '../services/format-error'
import type { ChatChunk } from '@tachi/core'

const contentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'),  text: z.string() }),
  z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() }),
  z.object({ type: z.literal('file'),  data: z.string(), mimeType: z.string(), filename: z.string() }),
])

const messageContentSchema = z.union([
  z.string().min(1),
  z.array(contentPartSchema).min(1),
])

const sendSchema = z.object({
  conversationId:    z.string(),
  message:           messageContentSchema,
  // Conversation memory: prior turns (text-flattened) sent so the model has
  // context. Capped at 100 entries here; the renderer caps tighter (last 20).
  history:           z.array(z.object({
    role:    z.enum(['user', 'assistant']),
    content: z.string(),
  })).max(100).optional(),
  model:             z.string().min(1).optional(),
  providerId:        z.string().min(1).optional(),
  profileId:         z.string().min(1).optional(),
  workspaceRoot:     z.string().min(1).optional(),
  systemMessage:     z.string().max(2000).optional(),
  /** Attached knowledge folder — chat RAG over the local per-folder index. */
  ragFolder:         z.string().min(1).optional(),
  githubToolsEnabled: z.boolean().optional(),
  /** D6: Thinking depth — forwarded to chat-service for Anthropic thinking param. */
  depth:             z.enum(['normal', 'think', 'ultra']).optional(),
  /** Surplus smart router: when true (+ Surplus provider + auto model), route by difficulty. */
  surplusSmartRouting:     z.boolean().optional(),
  /** Allow a hard + agentic task to escalate to the agent-kit workflow (opt-in). */
  allowWorkflowEscalation: z.boolean().optional(),
  /** Fusion: panel of models answer in parallel + a judge synthesizes (bankr/venice/surplus). */
  fusionMode:   z.boolean().optional(),
  /** Fusion panel preset: cheap cross-family vs top models. */
  fusionPreset: z.enum(['budget', 'frontier']).optional(),
  /** Fusion arbiter: how to combine the panel into one answer ('compare' = no judge, user picks). */
  fusionArbiter: z.enum(['synthesize', 'best_of_n', 'majority', 'compare']).optional(),
  /** Optional custom panel model ids; omitted = the preset default. */
  fusionPanel:  z.array(z.string().min(1)).max(6).optional(),
  /** Optional judge/synthesizer model id; omitted = the preset default. */
  fusionJudge:  z.string().min(1).optional(),
  /**
   * The context window the routed model's provider PUBLISHED, forwarded from
   * the renderer's catalog cache (modelWindow.store — the same rows the picker
   * prints). Main has no access to that cache, and it used to substitute a
   * per-provider constant for the red-zone budget. Optional on purpose: absent
   * means "nobody published one for this model", and the service falls through
   * to the static resolver rather than to a guess about the whole provider.
   */
  contextTokens: z.number().int().positive().optional(),
  /**
   * Per-chat sampler (T19): already-resolved temperature/top_p from the
   * renderer's preset. Bounds are enforced HERE at the IPC boundary so a
   * bad value can never reach a provider. Omitted for BALANCED — nothing sent.
   */
  sampler: z.object({
    temperature: z.number().min(0).max(2).optional(),
    top_p:       z.number().min(0).max(1).optional(),
  }).optional(),
}).refine(p => Boolean(p.profileId) || Boolean(p.providerId && p.model), {
  message: 'Either profileId, or both providerId and model, must be provided.',
})

const CHAT_NOTIFY_THRESHOLD_MS = 10_000

/**
 * What the renderer is told when sendChatMessage() rejects.
 *
 * P0 2026-07-25: this used to be `.catch(() => {})` — a throw before the first
 * provider branch (e.g. the memory-facts injection failing to resolve inside the
 * packaged bundle) produced ZERO chunks, no log and no error, so the composer
 * spun forever and chat looked simply dead. A chat failure must never be silent
 * again.
 *
 * Chunk shape mirrors chat-service's own sendError(): messageId 'unknown', the
 * renderer resolves the conversation from its streaming state and clears the
 * spinner. Exported + dependency-injected so the contract is unit-testable
 * without a BrowserWindow.
 */
export function emitSendFailureChunk(
  err: unknown,
  deps: { send: (chunk: ChatChunk) => void; log?: (msg: string, err: unknown) => void },
): void {
  deps.log?.('[chat:send] send failed:', err)
  deps.send({
    type: 'error', messageId: 'unknown',
    error: { code: 'INTERNAL', message: formatError(err) },
  } satisfies ChatChunk)
}

export function registerChatIpc(win: BrowserWindow) {
  ipcMain.handle('chat:send', async (_event, payload: unknown) => {
    const validated = sendSchema.parse(payload)
    const startedAt = Date.now()

    // D4: record the ROUTE (provider + model + the model's published window)
    // for this conversation before streaming starts, so emitContextCharsUpdated
    // can compute the fill pct against the right denominator. Model-level,
    // because that is the level a context window exists at.
    if (validated.providerId) {
      registerConversationProvider(validated.conversationId, validated.providerId, {
        ...(validated.model ? { model: validated.model } : {}),
        ...(validated.contextTokens ? { contextTokens: validated.contextTokens } : {}),
      })
    }

    // Intercept chat:chunk events forwarded from the service so we can fire a
    // notification when a slow response finishes and the window is not focused.
    // `chat:chunk` is a custom IPC channel, not a typed WebContents event — use
    // the underlying EventEmitter surface so on/off typecheck.
    const wc = win.webContents as unknown as import('node:events').EventEmitter
    const chunkListener = (_: unknown, chunk: unknown) => {
      const c = chunk as { type?: string } | null
      if (c?.type !== 'done') return
      wc.off('chat:chunk', chunkListener)
      const elapsed = Date.now() - startedAt
      if (elapsed >= CHAT_NOTIFY_THRESHOLD_MS && !win.isDestroyed() && !win.isFocused()) {
        notifyTaskDone('Chat reply ready', 'Your response is waiting.')
      }
    }
    wc.on('chat:chunk', chunkListener)

    sendChatMessage(win, validated).catch((err: unknown) => {
      wc.off('chat:chunk', chunkListener)
      if (win.isDestroyed()) {
        console.error('[chat:send] send failed (window gone):', err)
        return
      }
      emitSendFailureChunk(err, {
        send: (chunk) => win.webContents.send('chat:chunk', chunk),
        log:  (msg, e) => console.error(msg, e),
      })
    })
  })

  ipcMain.handle('chat:abort', (_event, payload: unknown) => {
    const { conversationId } = z.object({ conversationId: z.string() }).parse(payload)
    abortMessage(conversationId)
  })

  ipcMain.handle('chat:save-conversation', (_event, conv: unknown) => {
    try {
      if (typeof conv !== 'object' || conv === null) return
      const parsed = conv as Record<string, unknown>
      if (typeof parsed.id !== 'string' || !/^[\w-]{1,128}$/.test(parsed.id)) return
      const dir = join(app.getPath('userData'), 'conversations')
      mkdirSync(dir, { recursive: true })
      const filePath = join(dir, `${parsed.id}.json`)
      if (!filePath.startsWith(dir + sep)) return
      writeFileSync(filePath, JSON.stringify(parsed, null, 2))
    } catch (err) {
      console.error('[chat:save-conversation] failed to persist:', err)
    }
  })

  // Deleting a chat in the UI previously only removed it from the renderer
  // store — the mirrored JSON under ${userData}/conversations survived forever
  // (privacy gap: "deleted" chats stayed on disk and would resurface in the
  // full-text search index). Same id hardening as save.
  ipcMain.handle('chat:delete-conversation', (_event, payload: unknown) => {
    try {
      const { id } = z.object({ id: z.string().regex(/^[\w-]{1,128}$/) }).parse(payload)
      const dir = join(app.getPath('userData'), 'conversations')
      const filePath = join(dir, `${id}.json`)
      if (!filePath.startsWith(dir + sep)) return { ok: false }
      unlinkSync(filePath)
      return { ok: true }
    } catch {
      return { ok: false } // missing file / bad payload — nothing to leak either way
    }
  })
}
