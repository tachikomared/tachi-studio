// apps/desktop/electron/services/telegram-service.ts
//
// Telegram remote channel INTO THE TACHI HARNESS (the user's chosen design:
// the bot IS the TACHI agent — full app context, app_control included, able
// to work on the configured workspace). One bot, ONE paired chat:
//
//   pairing   Settings card shows a 6-digit code → the user sends it to the
//             bot (or taps the /start deep link) → that chat id is saved and
//             everything else is ignored forever.
//   sessions  each incoming message runs a TACHI session in the configured
//             workspace (default: the storage root), composed EXACTLY like
//             the swarm executor's headless path: egress gate + unattended
//             hard-deny (destructive shell / protected paths refused — no
//             human is watching). A rolling history keeps multi-turn context.
//   replies   final assistant text, chunked to Telegram's 4096 limit; tool
//             errors and denials are summarized, not streamed.
//
// SECURITY: token lives in the OS-encrypted keychain ('telegram-bot'); the
// loop only runs when enabled in Settings AND not in private mode (it long-
// polls api.telegram.org — a cloud egress). Messages from unpaired chats are
// dropped without reply (no bot-discovery oracle).

import { retrieveKey } from './keychain'
import { loadSettings, saveSettings } from './settings-store'
import { getCurrentPrivacyMode } from '../ipc/privacy.ipc'
import { checkAgentToolEgress } from './egress-policy'
import { classifyUnattendedTool } from './unattended-gate'
import { getStorageRoot } from './storage-root'
import {
  chunkMessage, formatPairingCode, matchesPairingCode, extractIncoming, nextOffset,
  advanceOffset, extractCallbacks, permissionKeyboard, parsePermissionCallback, formatRunEvent,
} from './telegram-core'
import type { TgIncoming } from './telegram-core'
import { onAgentRunEvent, resolveRemotePermission } from './agent-run-events'
import { randomInt } from 'crypto'
import type { AgentHistoryTurn } from '@tachi/core'

const API = 'https://api.telegram.org'
const POLL_TIMEOUT_S = 25
const HISTORY_TURNS = 12

type TgStatus = {
  enabled: boolean
  running: boolean
  hasToken: boolean
  paired: boolean
  chatId: string
  pairingCode: string | null
  workspace: string
  lastError: string
}

let loopAbort: AbortController | null = null
let offset = 0
let pairingCode: string | null = null
let lastError = ''
let busy = false
const history: AgentHistoryTurn[] = []

function token(): string | null {
  try { return retrieveKey('telegram-bot') } catch { return null }
}

async function tg(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const t = token()
  if (!t) throw new Error('no telegram token')
  const res = await fetch(`${API}/bot${t}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const json = await res.json().catch(() => null) as { ok?: boolean; description?: string } | null
  if (!res.ok || !json?.ok) throw new Error(`telegram ${method}: ${json?.description ?? res.status}`)
  return json
}

async function reply(chatId: string, text: string): Promise<void> {
  for (const chunk of chunkMessage(text)) {
    await tg('sendMessage', { chat_id: chatId, text: chunk, disable_web_page_preview: true }).catch(e => {
      lastError = e instanceof Error ? e.message : String(e)
    })
  }
}

/** Run ONE TACHI session for an incoming message (unattended-gated, swarm-style). */
async function runForMessage(msg: TgIncoming): Promise<void> {
  const workspace = getTelegramWorkspace()
  const ctrl = new AbortController()
  let finalText = ''
  const denials: string[] = []
  const gate = async (name: string, input: Record<string, unknown>): Promise<boolean> => {
    const egress = checkAgentToolEgress(name, input)
    if (!egress.allowed) { denials.push(`${name}: ${egress.reason ?? 'egress denied'}`); return false }
    const u = classifyUnattendedTool(name, input, { workingDir: workspace })
    if (!u.allowed) { denials.push(`${name}: ${u.reason ?? 'unattended-denied'}`); return false }
    return true
  }
  try {
    const { runTachiSession } = await import('./tachi/loop')
    await runTachiSession({
      workspaceRoot: workspace,
      task: msg.text,
      history: history.slice(-HISTORY_TURNS),
      signal: ctrl.signal,
      onEvent: (e) => { if (e.type === 'text' && typeof e.text === 'string') finalText += e.text },
      gate,
      privateMode: getCurrentPrivacyMode() === 'private',
    })
  } catch (err) {
    finalText = `Session failed: ${err instanceof Error ? err.message : String(err)}`
  }
  const answer = finalText.trim() || '(the agent finished without a text answer)'
  history.push({ role: 'user', content: msg.text }, { role: 'assistant', content: answer.slice(0, 8000) })
  while (history.length > HISTORY_TURNS * 2) history.shift()
  const denialNote = denials.length
    ? `\n\n⚠ ${denials.length} action(s) were blocked by the unattended-safety gate (destructive/irreversible steps need you in the app):\n${[...new Set(denials)].slice(0, 5).join('\n')}`
    : ''
  await reply(msg.chatId, answer + denialNote)
}

async function pollLoop(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const body = await tg('getUpdates', { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message', 'callback_query'] }, signal)
      const incoming = extractIncoming(body)
      // Advance over EVERY update (stickers/edits/callbacks included) — the
      // old nextOffset only saw text messages, so one unhandled update kind
      // would re-deliver forever and pin the loop (latent bug, fixed with F19).
      offset = advanceOffset(body, nextOffset(incoming, offset))
      await handleCallbacks(body)
      const s = loadSettings()
      for (const msg of incoming) {
        if (signal.aborted) return
        // Pairing phase: only the code unlocks a chat; everything else is dropped.
        if (!s.telegramChatId) {
          if (pairingCode && matchesPairingCode(msg.text, pairingCode)) {
            saveSettings({ telegramChatId: msg.chatId })
            pairingCode = null
            await reply(msg.chatId, 'Paired with Tachi Studio. This chat now talks to the TACHI agent — send a task.')
          }
          continue
        }
        if (msg.chatId !== s.telegramChatId) continue // strangers: silent drop
        if (busy) { await reply(msg.chatId, '⏳ Still working on the previous task — send this again when I reply.'); continue }
        busy = true
        try {
          await reply(msg.chatId, '⏳ Working…')
          await runForMessage(msg)
        } finally {
          busy = false
        }
      }
      lastError = ''
    } catch (err) {
      if (signal.aborted) return
      lastError = err instanceof Error ? err.message : String(err)
      // Backoff on errors (bad token = 401 loops otherwise).
      await new Promise(r => setTimeout(r, 15_000))
    }
  }
}

// ── F19: run events out + inline permission approve/deny in ─────────────────

/** Handle inline-keyboard presses (permission buttons) from a getUpdates body. */
async function handleCallbacks(body: unknown): Promise<void> {
  const s = loadSettings()
  for (const cb of extractCallbacks(body)) {
    // Only the paired chat may press buttons; strangers get a silent drop.
    if (!s.telegramChatId || cb.chatId !== s.telegramChatId) continue
    const parsed = parsePermissionCallback(cb.data)
    if (!parsed) {
      await tg('answerCallbackQuery', { callback_query_id: cb.callbackId }).catch(() => {})
      continue
    }
    const ok = resolveRemotePermission(parsed.id, parsed.decision)
    await tg('answerCallbackQuery', {
      callback_query_id: cb.callbackId,
      text: ok ? `Sent: ${parsed.decision.replace('_', ' ')}` : 'Expired — already decided in the app.',
    }).catch(() => {})
    if (ok) {
      await reply(cb.chatId, parsed.decision === 'deny' ? '⛔ Denied.' : parsed.decision === 'allow_30m' ? '🕐 Allowed for 30 minutes.' : '✅ Allowed.')
    }
  }
}

/** Forward agent-run lifecycle events to the paired chat (enabled+paired only). */
let runEventsOff: (() => void) | null = null
function syncRunEventForwarding(): void {
  if (runEventsOff) { runEventsOff(); runEventsOff = null }
  runEventsOff = onAgentRunEvent((e) => {
    const s = loadSettings()
    if (!s.telegramEnabled || !s.telegramChatId || loopAbort === null) return
    if (e.type === 'permission-resolved') return // ack happens at the button
    if (e.type === 'permission-requested') {
      // Inline keyboard so the user can un-block the run from the phone.
      for (const chunk of chunkMessage(formatRunEvent(e))) {
        void tg('sendMessage', {
          chat_id: s.telegramChatId, text: chunk, disable_web_page_preview: true,
          reply_markup: permissionKeyboard(e.id),
        }).catch(err => { lastError = err instanceof Error ? err.message : String(err) })
      }
      return
    }
    void reply(s.telegramChatId, formatRunEvent(e))
  })
}

function getTelegramWorkspace(): string {
  const s = loadSettings()
  const ws = s.telegramWorkspace
  return (typeof ws === 'string' && ws.trim()) ? ws.trim() : getStorageRoot()
}

/** (Re)start or stop the loop based on current settings/token/privacy. */
export function syncTelegramService(): void {
  const s = loadSettings()
  const shouldRun = s.telegramEnabled && !!token() && getCurrentPrivacyMode() !== 'private'
  if (loopAbort) { loopAbort.abort(); loopAbort = null }
  if (!shouldRun) return
  if (!s.telegramChatId && !pairingCode) pairingCode = formatPairingCode(randomInt(1_000_000))
  loopAbort = new AbortController()
  syncRunEventForwarding()
  void pollLoop(loopAbort.signal)
}

export function stopTelegramService(): void {
  if (loopAbort) { loopAbort.abort(); loopAbort = null }
}

export function telegramStatus(): TgStatus {
  const s = loadSettings()
  return {
    enabled: !!s.telegramEnabled,
    running: loopAbort !== null,
    hasToken: !!token(),
    paired: !!s.telegramChatId,
    chatId: s.telegramChatId ?? '',
    pairingCode,
    workspace: getTelegramWorkspace(),
    lastError,
  }
}

/** Forget the paired chat (Settings UNPAIR) — a new pairing code is issued on next sync. */
export function unpairTelegram(): void {
  saveSettings({ telegramChatId: '' })
  pairingCode = null
  syncTelegramService()
}
