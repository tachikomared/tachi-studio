// apps/desktop/electron/services/telegram-core.ts
//
// PURE helpers for the Telegram remote channel (no electron imports —
// unit-testable): message chunking for Telegram's 4096-char limit, pairing-
// code handling, and update filtering. The service (telegram-service.ts)
// owns all I/O.

/** Telegram hard message limit is 4096; leave headroom for our prefixes. */
export const TG_CHUNK = 3900

/** Split a reply into Telegram-sized chunks, preferring newline boundaries. */
export function chunkMessage(text: string, max = TG_CHUNK): string[] {
  const t = (text ?? '').trim()
  if (!t) return []
  if (t.length <= max) return [t]
  const chunks: string[] = []
  let rest = t
  while (rest.length > max) {
    // Prefer breaking at the last newline inside the window, then last space.
    let cut = rest.lastIndexOf('\n', max)
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max)
    if (cut < max * 0.5) cut = max
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) chunks.push(rest)
  return chunks
}

/** 6-digit pairing code (crypto-random supplied by the caller). */
export function formatPairingCode(n: number): string {
  return String(Math.abs(n) % 1_000_000).padStart(6, '0')
}

/**
 * True when an incoming message text matches the pairing code — accepts the
 * bare code and "/start <code>" (Telegram deep-link start payload).
 */
export function matchesPairingCode(text: string, code: string): boolean {
  const t = (text ?? '').trim()
  if (!t || !code) return false
  if (t === code) return true
  const m = /^\/start\s+(\S+)$/.exec(t)
  return m !== null && m[1] === code
}

export interface TgIncoming {
  updateId: number
  chatId: string
  text: string
}

/**
 * Extract plain-text messages from a getUpdates result body. Tolerant of
 * unknown update kinds (edited messages, stickers, joins → skipped).
 */
export function extractIncoming(body: unknown): TgIncoming[] {
  const out: TgIncoming[] = []
  const results = (body as { result?: unknown[] } | null)?.result
  if (!Array.isArray(results)) return out
  for (const u of results) {
    const upd = u as { update_id?: number; message?: { chat?: { id?: number | string }; text?: string } }
    if (typeof upd.update_id !== 'number') continue
    const chatId = upd.message?.chat?.id
    const text = upd.message?.text
    if (chatId === undefined || chatId === null || typeof text !== 'string' || !text.trim()) continue
    out.push({ updateId: upd.update_id, chatId: String(chatId), text: text.trim() })
  }
  return out
}

/** Next getUpdates offset after processing a batch (max update_id + 1). */
export function nextOffset(incoming: TgIncoming[], current: number): number {
  return incoming.reduce((acc, i) => Math.max(acc, i.updateId + 1), current)
}

/**
 * Advance the offset over EVERY update in the raw body — including kinds we
 * do not extract (stickers, edits, callback queries). Without this, a single
 * unhandled update kind re-delivers forever and pins the poll loop (latent
 * bug: nextOffset only saw extracted text messages).
 */
export function advanceOffset(body: unknown, current: number): number {
  const results = (body as { result?: unknown[] } | null)?.result
  if (!Array.isArray(results)) return current
  let acc = current
  for (const u of results) {
    const id = (u as { update_id?: number }).update_id
    if (typeof id === 'number') acc = Math.max(acc, id + 1)
  }
  return acc
}

// ── F19: remote run events + inline permission approve/deny ─────────────────

export interface TgCallback {
  updateId: number
  /** Telegram's callback_query id — required by answerCallbackQuery. */
  callbackId: string
  chatId: string
  data: string
}

/** Extract inline-keyboard button presses (callback queries) from getUpdates. */
export function extractCallbacks(body: unknown): TgCallback[] {
  const out: TgCallback[] = []
  const results = (body as { result?: unknown[] } | null)?.result
  if (!Array.isArray(results)) return out
  for (const u of results) {
    const upd = u as { update_id?: number; callback_query?: { id?: string; data?: string; message?: { chat?: { id?: number | string } } } }
    if (typeof upd.update_id !== 'number' || !upd.callback_query) continue
    const cq = upd.callback_query
    const chatId = cq.message?.chat?.id
    if (typeof cq.id !== 'string' || typeof cq.data !== 'string' || chatId === undefined || chatId === null) continue
    out.push({ updateId: upd.update_id, callbackId: cq.id, chatId: String(chatId), data: cq.data })
  }
  return out
}

/** The permission decisions offered remotely (subset — no permanent grants from a phone). */
export type TgPermissionDecision = 'allow' | 'deny' | 'allow_30m'

/** Inline keyboard for a permission request (callback_data ≤64 bytes: uuid36 + prefix fits). */
export function permissionKeyboard(requestId: string): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return {
    inline_keyboard: [
      [
        { text: '✅ Allow', callback_data: `perm:${requestId}:allow` },
        { text: '⛔ Deny', callback_data: `perm:${requestId}:deny` },
      ],
      [{ text: '🕐 Allow 30 min', callback_data: `perm:${requestId}:allow_30m` }],
    ],
  }
}

/** Parse a permission callback_data; null for anything else (fail-closed). */
export function parsePermissionCallback(data: string): { id: string; decision: TgPermissionDecision } | null {
  const m = /^perm:([0-9a-f-]{8,64}):(allow|deny|allow_30m)$/.exec(data ?? '')
  if (!m) return null
  return { id: m[1], decision: m[2] as TgPermissionDecision }
}

/** One-line run-event texts for the paired chat. */
export function formatRunEvent(e:
  | { type: 'run-started'; harness: string; task: string }
  | { type: 'run-finished'; harness: string; ok: boolean; ms: number; error?: string }
  | { type: 'permission-requested'; toolName: string; reason: string },
): string {
  if (e.type === 'run-started') {
    return `▸ ${e.harness.toUpperCase()} run started: ${e.task.slice(0, 200)}`
  }
  if (e.type === 'run-finished') {
    const dur = e.ms >= 60_000 ? `${Math.round(e.ms / 60_000)}m` : `${Math.round(e.ms / 1000)}s`
    return e.ok
      ? `■ ${e.harness.toUpperCase()} run finished (${dur})`
      : `✕ ${e.harness.toUpperCase()} run FAILED (${dur})${e.error ? `: ${e.error.slice(0, 200)}` : ''}`
  }
  return `⚠ Approval needed — ${e.toolName}\n${e.reason.slice(0, 300)}`
}
