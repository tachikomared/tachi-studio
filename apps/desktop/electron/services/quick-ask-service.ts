// apps/desktop/electron/services/quick-ask-service.ts
//
// Global QUICK-ASK launcher: a small always-on-top window summoned from
// anywhere with a global hotkey (action id 'quick-ask' in HOTKEY_ACTIONS).
// Ask a question, get a STREAMED answer, keep asking follow-ups.
//
// The answer comes from the local FreeLLM router (keyless, auto-started with
// the app) via its OpenAI-compatible endpoint — the same first-run path chat
// defaults to, so quick-ask works on a machine with zero configured keys.
// PRIVATE MODE: freellmapi is a localhost sidecar (its own egress policy
// gates the outbound call), so quick-ask stays functional there too.
//
// Window pattern mirrors overlay-service: one module-local window, renderer
// routed by URL hash (#quickask), toggled by hotkey / IPC.
//
// STATE (all module-local, in MEMORY only — nothing user-typed is written to
// disk from this surface, so private mode needs no special case here):
//   • turns          — the running conversation (cap QUICKASK_MAX_TURNS)
//   • lastExchange   — the {prompt, answer, ts} replayed on re-summon, so
//                      clicking away no longer destroys the answer
//   • promptHistory  — REPL-style Up/Down recall ring (cap 20)
//   • pinned         — while pinned, losing focus does NOT hide the window
//   • context        — the clipboard/selection chip armed for the NEXT send
// The only things that persist are the window SIZE and the auto-capture flag
// (settings-store); both skip the write in private mode. Captured TEXT never
// touches disk.
//
// AUTO-CAPTURE (opt-out, quickAskAutoCapture): summoning the bar synthesizes a
// Ctrl+C into whatever app currently has focus, so "select text → hotkey" arms
// the selection as context and the user only picks a prompt. See
// synthesizeCopyKeystroke() for the SendKeys tradeoff note.

import { BrowserWindow, ipcMain, screen, clipboard } from 'electron'
import { spawn } from 'node:child_process'
import { join } from 'path'
import { getFreellmapiPort, getFreellmapiApiKey } from './sidecar-manager'
import { loadSettings, saveSettings } from './settings-store'
import { notifyTaskDone } from './notifications'
import { getCurrentPrivacyMode } from '../ipc/privacy.ipc'

let quickAskWindow: BrowserWindow | null = null
let mainWindowRef: BrowserWindow | null = null

const WIN_W = 640
const WIN_H = 420
const MIN_W = 420
const MIN_H = 220

/** Conversation cap: the bar keeps a SHORT thread, not a chat history. */
export const QUICKASK_MAX_TURNS = 8
/** Typed-prompt character budget (matches the original single-shot slice). */
export const QUICKASK_MAX_CHARS = 4000
/** Attached clipboard/selection context sent with a message. */
export const QUICKASK_CONTEXT_MAX = 8000
/** Chip preview length — what the user sees, not what the model gets. */
export const QUICKASK_CONTEXT_PREVIEW = 200
/** A message may carry the typed prompt PLUS one attached context block. */
export const QUICKASK_MESSAGE_MAX = QUICKASK_MAX_CHARS + QUICKASK_CONTEXT_MAX
/** Up/Down prompt-recall ring size. */
export const QUICKASK_HISTORY_MAX = 20
/** Renderer update batching — one IPC push per window, not per token. */
export const QUICKASK_CHUNK_FLUSH_MS = 150
/** Hard timebox on the synthetic-copy child process. */
export const QUICKASK_CAPTURE_TIMEOUT_MS = 500
/** How long the OS gets to put the selection on the clipboard afterwards. */
export const QUICKASK_CAPTURE_SETTLE_MS = 150

export type QuickAskTurn = { role: 'user' | 'assistant'; content: string }
/** The clipboard/selection chip offered above the input on summon. */
export type QuickAskContext = {
  kind: 'clipboard' | 'selection'
  /** Full text handed to the model (capped at QUICKASK_CONTEXT_MAX). */
  text: string
  /** Short preview for the chip label. */
  preview: string
  chars: number
  /** Armed = appended to the next send unless the user dismisses it. */
  armed: boolean
}
export type QuickAskExchange = { prompt: string; answer: string; ts: number }
export type QuickAskChunk =
  | { type: 'delta'; text: string }
  | { type: 'done'; text: string }
  | { type: 'error'; error: string }
/** Payload replayed to the renderer on every 'quickask:shown'. */
export type QuickAskShownPayload = {
  turns: QuickAskTurn[]
  lastExchange: QuickAskExchange | null
  pinned: boolean
  history: string[]
  /** True when an answer is still streaming — the renderer must not wipe it. */
  busy: boolean
  /** Clipboard/selection chip for THIS summon (null = nothing to offer). */
  context: QuickAskContext | null
  /** Current quickAskAutoCapture setting (the footer toggle mirrors it). */
  autoCapture: boolean
}

// ── module state ────────────────────────────────────────────────────────────

let turns: QuickAskTurn[] = []
let lastExchange: QuickAskExchange | null = null
let promptHistory: string[] = []
let pinned = false
/** Hash of the clipboard as of the PREVIOUS summon (arming decision only). */
let lastClipboardHash: string | null = null
/** Chip computed for the current summon — memory only, never persisted. */
let currentContext: QuickAskContext | null = null
/** Cached quickAskAutoCapture (null = not read from settings yet). */
let autoCaptureMem: boolean | null = null

/** Append a turn, trimming content and keeping only the last N turns. */
export function appendTurn(role: QuickAskTurn['role'], content: string): QuickAskTurn[] {
  const text = String(content ?? '').slice(0, QUICKASK_MESSAGE_MAX)
  turns = [...turns, { role, content: text }].slice(-QUICKASK_MAX_TURNS)
  return turns
}

export function getTurns(): QuickAskTurn[] { return turns }

/** Remember the completed exchange (replayed on re-summon) + recall ring. */
export function recordExchange(prompt: string, answer: string, now = Date.now()): QuickAskExchange {
  lastExchange = { prompt, answer, ts: now }
  pushPromptHistory(prompt)
  return lastExchange
}

export function getLastExchange(): QuickAskExchange | null { return lastExchange }

/** Most-recent-first, de-duplicated, capped. */
export function pushPromptHistory(prompt: string): string[] {
  const p = String(prompt ?? '').trim()
  if (!p) return promptHistory
  promptHistory = [p, ...promptHistory.filter(x => x !== p)].slice(0, QUICKASK_HISTORY_MAX)
  return promptHistory
}

export function getPromptHistory(): string[] { return promptHistory }

/** Explicit New (Ctrl+N / the NEW button) — drops the thread and the replay,
 *  KEEPS the prompt-recall ring (that is the whole point of a recall ring). */
export function resetQuickAskSession(): void {
  turns = []
  lastExchange = null
}

export function setQuickAskPinned(v: boolean): boolean { pinned = !!v; return pinned }
export function isQuickAskPinned(): boolean { return pinned }

/** Everything the renderer needs to redraw itself on (re-)summon. */
export function buildShownPayload(): QuickAskShownPayload {
  return {
    turns,
    lastExchange,
    pinned,
    history: promptHistory,
    busy: inflight !== null,
    context: currentContext,
    autoCapture: isAutoCaptureEnabled(),
  }
}

/** Test-only: wipe every module-local field back to boot state. */
export function __resetQuickAskStateForTests(): void {
  turns = []
  lastExchange = null
  promptHistory = []
  pinned = false
  lastClipboardHash = null
  currentContext = null
  autoCaptureMem = null
}

// ── clipboard / selection context ───────────────────────────────────────────

/** FNV-1a — enough to answer "did the clipboard change since last summon?"
 *  without keeping the previous clipboard TEXT alive in memory. */
export function hashText(s: string): string {
  let h = 0x811c9dc5
  const str = String(s ?? '')
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

function makeContext(kind: QuickAskContext['kind'], text: string, armed: boolean): QuickAskContext | null {
  const full = String(text ?? '').slice(0, QUICKASK_CONTEXT_MAX)
  if (!full.trim()) return null
  return {
    kind,
    text: full,
    preview: full.slice(0, QUICKASK_CONTEXT_PREVIEW).replace(/\s+/g, ' ').trim(),
    chars: full.length,
    armed,
  }
}

/** Plain clipboard chip: armed only when the clipboard CHANGED since the last
 *  summon (re-summoning on stale clipboard shows the chip, unarmed). */
export function clipboardChip(text: string, prevHash: string | null): QuickAskContext | null {
  const chip = makeContext('clipboard', text, false)
  if (!chip) return null
  return { ...chip, armed: hashText(chip.text) !== prevHash }
}

/** Selection chip: the user just selected it and pressed the hotkey — armed. */
export function selectionChip(text: string): QuickAskContext | null {
  return makeContext('selection', text, true)
}

/**
 * The capture state machine, kept pure so the tests can drive every branch:
 *   • clipboard CHANGED after the synthetic copy → that is the selection
 *     (arm it and put the user's original clipboard back)
 *   • unchanged / capture skipped / capture FAILED (caller passes after=before)
 *     → degrade to the plain clipboard chip, clipboard untouched
 */
export function resolveCapture(input: {
  before: string
  after: string
  prevHash: string | null
}): { context: QuickAskContext | null; restoreClipboard: boolean } {
  const before = String(input.before ?? '')
  const after = String(input.after ?? '')
  if (after && after !== before) {
    const sel = selectionChip(after)
    // Whitespace-only "selection" is not worth a chip, but the clipboard was
    // still clobbered by our synthetic copy — restore it either way.
    return { context: sel ?? clipboardChip(before, input.prevHash), restoreClipboard: true }
  }
  return { context: clipboardChip(before, input.prevHash), restoreClipboard: false }
}

/** quickAskAutoCapture, default ON (the flow the user asked for). */
export function isAutoCaptureEnabled(): boolean {
  if (autoCaptureMem !== null) return autoCaptureMem
  try {
    const v = (loadSettings() as unknown as QuickAskPersisted).quickAskAutoCapture
    autoCaptureMem = v === undefined ? true : !!v
  } catch {
    autoCaptureMem = true
  }
  return autoCaptureMem
}

export function setAutoCaptureEnabled(v: boolean): boolean {
  autoCaptureMem = !!v
  // Same persistence rule as the window size: private mode writes nothing from
  // this surface (the toggle still applies for the rest of the session).
  try { if (getCurrentPrivacyMode() === 'private') return autoCaptureMem } catch { /* default: save */ }
  try {
    saveSettings({ quickAskAutoCapture: autoCaptureMem } as unknown as Parameters<typeof saveSettings>[0])
  } catch { /* best-effort */ }
  return autoCaptureMem
}

/** Gate in front of every synthetic keystroke. */
function shouldAutoCapture(): boolean {
  // SendKeys is a Windows-only API; elsewhere the plain clipboard chip stands in.
  if (process.platform !== 'win32') return false
  if (!isAutoCaptureEnabled()) return false
  // One of OUR windows has focus → the user is selecting inside Tachi Studio and
  // the synthetic Ctrl+C would hit our own UI. Skip.
  try { if (BrowserWindow.getFocusedWindow()) return false } catch { /* treat as foreign app */ }
  return true
}

/**
 * Synthesize Ctrl+C into the FOREGROUND app (still the user's app — the bar has
 * not been shown yet, which is the whole point).
 *
 * TRADEOFF: SendKeys is banned for driving this app during automation; this is
 * the opposite case — a feature the user invokes by hotkey, exactly what Windows
 * launchers do (PowerToys Advanced Paste, QTranslate). It runs ONLY when
 * quickAskAutoCapture is on (footer toggle), never when our own window has
 * focus, and is timeboxed; any failure degrades to the plain clipboard chip.
 */
function synthesizeCopyKeystroke(): Promise<void> {
  return new Promise<void>(resolve => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    try {
      const child = spawn(
        'powershell.exe',
        [
          '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
          "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^c')",
        ],
        { detached: true, stdio: 'ignore', windowsHide: true },
      )
      const timer = setTimeout(() => { try { child.kill() } catch { /* already gone */ } finish() }, QUICKASK_CAPTURE_TIMEOUT_MS)
      child.once('error', () => { clearTimeout(timer); finish() })
      child.once('exit', () => { clearTimeout(timer); finish() })
      child.unref()
    } catch {
      finish()
    }
  })
}

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Compute the chip for THIS summon. Runs before the window is shown. */
async function refreshContext(): Promise<void> {
  let before = ''
  try { before = clipboard.readText() ?? '' } catch { before = '' }

  let after = before
  if (shouldAutoCapture()) {
    try {
      await synthesizeCopyKeystroke()
      await delay(QUICKASK_CAPTURE_SETTLE_MS)
      after = clipboard.readText() ?? before
    } catch {
      after = before   // degrade silently to clipboard-chip behaviour
    }
  }

  const { context, restoreClipboard } = resolveCapture({ before, after, prevHash: lastClipboardHash })
  if (restoreClipboard) {
    // The user's clipboard is theirs — our synthetic copy must not clobber it.
    try { if (before) clipboard.writeText(before); else clipboard.clear() } catch { /* best-effort */ }
  }
  // Arming tracks the USER's clipboard, not the text we briefly borrowed.
  lastClipboardHash = before.trim() ? hashText(before.slice(0, QUICKASK_CONTEXT_MAX)) : null
  currentContext = context
}

// ── window ──────────────────────────────────────────────────────────────────

/** Persisted size lives beside the rest of the app settings under a key the
 *  AppSettings interface does not declare — loadSettings() spreads the raw JSON
 *  over the defaults, so unknown keys round-trip untouched. */
type QuickAskPersisted = {
  quickAskBounds?: { width?: number; height?: number }
  quickAskAutoCapture?: boolean
}

function readPersistedSize(): { width: number; height: number } {
  try {
    const saved = (loadSettings() as unknown as QuickAskPersisted).quickAskBounds
    const width = Math.max(MIN_W, Math.round(Number(saved?.width) || WIN_W))
    const height = Math.max(MIN_H, Math.round(Number(saved?.height) || WIN_H))
    return { width, height }
  } catch {
    return { width: WIN_W, height: WIN_H }
  }
}

function persistSize(width: number, height: number): void {
  // Private mode writes nothing to disk from this surface.
  try { if (getCurrentPrivacyMode() === 'private') return } catch { /* default: save */ }
  try {
    saveSettings({ quickAskBounds: { width, height } } as unknown as Parameters<typeof saveSettings>[0])
  } catch { /* best-effort */ }
}

/** The display under the CURSOR — not always the primary one on a multi-head desk. */
function cursorWorkArea(): Electron.Rectangle {
  try {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  } catch {
    return screen.getPrimaryDisplay().workArea
  }
}

function hideQuickAsk(): void {
  if (quickAskWindow && !quickAskWindow.isDestroyed()) quickAskWindow.hide()
}

async function showQuickAsk(): Promise<void> {
  // BEFORE the window steals focus: capture whatever the user selected in the
  // app they are looking at (auto-capture), else read the clipboard.
  await refreshContext()
  if (!quickAskWindow || quickAskWindow.isDestroyed()) createWindow()
  if (!quickAskWindow) return
  const workArea = cursorWorkArea()
  const saved = readPersistedSize()
  const width = Math.min(saved.width, workArea.width)
  const height = Math.min(saved.height, workArea.height)
  quickAskWindow.setBounds({
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height * 0.18),
    width,
    height,
  })
  quickAskWindow.show()
  quickAskWindow.focus()
  quickAskWindow.webContents.send('quickask:shown', buildShownPayload())
}

function toggleQuickAsk(): void {
  if (quickAskWindow && !quickAskWindow.isDestroyed() && quickAskWindow.isVisible()) hideQuickAsk()
  else void showQuickAsk()
}

let resizeSaveTimer: NodeJS.Timeout | null = null

function createWindow(): void {
  const { width, height } = readPersistedSize()
  quickAskWindow = new BrowserWindow({
    width,
    height,
    minWidth: MIN_W,
    minHeight: MIN_H,
    frame: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    backgroundColor: '#0f0f0f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  quickAskWindow.setAlwaysOnTop(true, 'screen-saver')
  // Summoned windows get out of the way on their own — EXCEPT while an answer
  // is streaming (hiding mid-run is how the answer used to get destroyed) and
  // except when the user pinned the bar.
  quickAskWindow.on('blur', () => {
    if (isQuickAskPinned()) return
    if (inflight) return
    hideQuickAsk()
  })
  quickAskWindow.on('resize', () => {
    if (resizeSaveTimer) clearTimeout(resizeSaveTimer)
    resizeSaveTimer = setTimeout(() => {
      resizeSaveTimer = null
      if (!quickAskWindow || quickAskWindow.isDestroyed()) return
      const [w, h] = quickAskWindow.getSize()
      persistSize(w, h)
    }, 400)
  })
  quickAskWindow.on('closed', () => { quickAskWindow = null })

  if (process.env.ELECTRON_RENDERER_URL) {
    quickAskWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}#quickask`)
  } else {
    quickAskWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'quickask' })
  }
}

// ── streaming completion ────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  'You are a quick launcher assistant. Answer concisely — a few sentences unless more is truly needed. Plain text, no markdown headers.'

/**
 * STREAMED completion against the local FreeLLM router ('auto' model), carrying
 * the whole short thread so follow-ups work. Deltas are pushed through `emit`
 * batched every QUICKASK_CHUNK_FLUSH_MS (a minimal OpenAI-compat SSE loop —
 * the full driver in chat-stream.ts is deliberately not dragged in here).
 */
async function askStream(
  msgs: QuickAskTurn[],
  signal: AbortSignal,
  emit: (chunk: QuickAskChunk) => void,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  // On abort we still return whatever streamed — a cancelled run keeps its
  // partial answer instead of throwing the user's tokens away.
  const port = getFreellmapiPort()
  if (!port) return { ok: false, error: 'freellm-not-running' }

  let pending = ''
  let full = ''
  let timer: NodeJS.Timeout | null = null
  const flush = () => { if (pending) { emit({ type: 'delta', text: pending }); pending = '' } }

  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(getFreellmapiApiKey() ? { Authorization: `Bearer ${getFreellmapiApiKey()}` } : {}),
      },
      body: JSON.stringify({
        model: 'auto',
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...msgs],
        stream: true,
      }),
    })
    if (!res.ok) return { ok: false, error: `router ${res.status}: ${(await res.text()).slice(0, 200)}` }
    const reader = res.body?.getReader()
    if (!reader) return { ok: false, error: 'router sent no stream body' }

    timer = setInterval(flush, QUICKASK_CHUNK_FLUSH_MS)
    const decoder = new TextDecoder()
    let carry = ''
    let streamDone = false
    while (!streamDone) {
      if (signal.aborted) break
      const { done, value } = await reader.read()
      if (done) break
      carry += decoder.decode(value, { stream: true })
      const lines = carry.split('\n')
      carry = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') { streamDone = true; break }
        try {
          const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }
          const delta = parsed.choices?.[0]?.delta?.content
          if (typeof delta === 'string' && delta) { full += delta; pending += delta }
        } catch { /* skip malformed SSE lines */ }
      }
    }
    if (timer) { clearInterval(timer); timer = null }
    flush()
    if (signal.aborted) return { ok: false, error: 'aborted', text: full.trim() }
    const text = full.trim()
    if (!text) return { ok: false, error: 'empty answer' }
    return { ok: true, text }
  } catch (err) {
    // The usual abort path: aborting the fetch errors the body stream mid-read.
    if (signal.aborted) {
      flush()
      return { ok: false, error: 'aborted', text: full.trim() }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (timer) clearInterval(timer)
  }
}

let inflight: AbortController | null = null

function emitChunk(chunk: QuickAskChunk): void {
  if (quickAskWindow && !quickAskWindow.isDestroyed()) {
    quickAskWindow.webContents.send('quickask:chunk', chunk)
  }
}

export function registerQuickAsk(mainWindow: BrowserWindow): void {
  mainWindowRef = mainWindow

  ipcMain.on('hotkey:fired-internal', (_e, payload: { id: string }) => {
    if (payload.id === 'quick-ask') toggleQuickAsk()
  })

  // Exposed for the tray menu / tests / palette.
  ipcMain.handle('quickask:toggle', () => { toggleQuickAsk(); return { ok: true } })
  ipcMain.handle('quickask:hide', () => { hideQuickAsk(); return { ok: true } })

  ipcMain.handle('quickask:ask', async (event: Electron.IpcMainInvokeEvent, payload: unknown) => {
    const { prompt } = (payload ?? {}) as { prompt?: string }
    if (typeof prompt !== 'string' || !prompt.trim()) return { ok: false, error: 'empty prompt' }
    // Budget = typed prompt + one attached context block (clipboard/selection).
    const q = prompt.trim().slice(0, QUICKASK_MESSAGE_MAX)

    // Other surfaces reuse this route as a plain keyless one-shot completion
    // (the audio-overview script writer does). Only calls coming FROM the bar
    // join the bar's thread / stream chunks / touch the replay + recall state.
    const fromBar = !!quickAskWindow && !quickAskWindow.isDestroyed()
      && event.sender === quickAskWindow.webContents
    if (!fromBar) {
      return askStream([{ role: 'user', content: q }], new AbortController().signal, () => {})
    }

    inflight?.abort()
    const ctrl = new AbortController()
    inflight = ctrl
    appendTurn('user', q)
    const r = await askStream(getTurns(), ctrl.signal, emitChunk)
    if (inflight === ctrl) inflight = null
    // A cancelled run that already produced text is KEPT (partial answer) —
    // Esc stops the model, it does not delete what you already have.
    if ((r.ok || r.error === 'aborted') && r.text) {
      appendTurn('assistant', r.text)
      recordExchange(q, r.text)
      emitChunk({ type: 'done', text: r.text })
      // The answer landed while the bar was away — tell the user (Raycast does
      // exactly this). Local OS notification, nothing leaves the machine.
      const hidden = !quickAskWindow || quickAskWindow.isDestroyed() || !quickAskWindow.isVisible()
      if (hidden) {
        try { notifyTaskDone('Quick ask answered', r.text.slice(0, 140)) } catch { /* non-fatal */ }
      }
    } else {
      emitChunk({ type: 'error', error: r.error ?? 'error' })
    }
    return r
  })

  // Esc while streaming: cancel the run but KEEP the window and the thread.
  ipcMain.handle('quickask:abort', () => {
    inflight?.abort()
    inflight = null
    return { ok: true }
  })

  // Explicit New (Ctrl+N / the NEW button).
  ipcMain.handle('quickask:new', () => {
    inflight?.abort()
    inflight = null
    resetQuickAskSession()
    return { ok: true, ...buildShownPayload() }
  })

  ipcMain.handle('quickask:set-pinned', (_e, payload: unknown) => {
    const { pinned: want } = (payload ?? {}) as { pinned?: boolean }
    return { ok: true, pinned: setQuickAskPinned(!!want) }
  })

  // The renderer subscribes to 'quickask:shown' on mount — i.e. AFTER the first
  // summon already fired it. Pulling the same payload closes that race so the
  // context chip shows up on the very first open too.
  ipcMain.handle('quickask:sync', () => ({ ok: true, ...buildShownPayload() }))

  // Footer toggle for the selection auto-capture (quickAskAutoCapture).
  ipcMain.handle('quickask:set-auto-capture', (_e, payload: unknown) => {
    const { enabled } = (payload ?? {}) as { enabled?: boolean }
    return { ok: true, autoCapture: setAutoCaptureEnabled(!!enabled) }
  })

  // Hand off to the full app: focus the main window on the chat tab.
  ipcMain.handle('quickask:open-app', () => {
    hideQuickAsk()
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      if (mainWindowRef.isMinimized()) mainWindowRef.restore()
      mainWindowRef.show()
      mainWindowRef.focus()
    }
    return { ok: true }
  })

  // REAL handoff (Ctrl+J): carry the whole thread into a fresh main-window
  // chat — same send pattern as overlay-service's 'overlay:capture-done'.
  ipcMain.handle('quickask:handoff', () => {
    const payload = { turns: getTurns() }
    if (!payload.turns.length) return { ok: false, error: 'nothing to hand off' }
    hideQuickAsk()
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      if (mainWindowRef.isMinimized()) mainWindowRef.restore()
      mainWindowRef.show()
      mainWindowRef.focus()
      mainWindowRef.webContents.send('quickask:handoff', payload)
    }
    // The thread now lives in the main window; the bar starts clean.
    resetQuickAskSession()
    return { ok: true, turns: payload.turns.length }
  })
}
