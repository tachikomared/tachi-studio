// apps/desktop/electron/services/llama-cpp-client.ts
//
// llama.cpp sidecar — lifecycle (start/stop/healthcheck) + OpenAI-compatible
// chat completion stream.
//
// llama-server (shipped in the llama.cpp release zip) exposes:
//   GET  /health                  → 200 once model loaded; 503 while loading
//   POST /v1/chat/completions     → OpenAI-compatible streaming/non-streaming
//   POST /v1/completions          → OpenAI-compatible plain completions
//
// We treat it as a stateless local OpenAI gateway. One running instance
// serves one loaded model — switching models requires stop + start.
//
// State:
//   _state: 'stopped' | 'starting' | 'loading' | 'running' | 'error'
//   _proc:  child_process handle
//   _port:  bound port (lazily-allocated in start())
//   _modelId: registry id of the currently-loaded model (for UI display)
//
// 'starting' covers process spawn until first /health probe attempt.
// 'loading' covers the period where llama-server is alive but /health
// returns 503 (model file being mmap'd, weights loading on GPU). Can take
// 10–30s for a 7B Q4 on a cold cache. UI displays [ LOADING MODEL... ].

import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { findFreePort } from '@tachi/core'
import { randomUUID } from 'crypto'
import type { ChatChunk, ChatContentPart, ChatRequest } from '@tachi/core'
import {
  isLlamaCppInstalled,
  isGgufModelDownloaded,
  llamaServerBinaryPath,
  ggufModelPath,
} from './llama-cpp-installer'
import { getGgufModel } from './llama-cpp-models'
import { readOrIdleAbort } from './stream-idle'
import { isEngineMigrating } from './model-storage'

// ─── State ────────────────────────────────────────────────────────────────────

export type LlamaCppState = 'stopped' | 'starting' | 'loading' | 'running' | 'error'

interface LlamaCppSlot {
  state:      LlamaCppState
  port?:      number
  pid?:       number
  startedAt?: number
  error?:     string
  proc?:      ChildProcess
  modelId?:   string
  /** Rolling buffer of recent stderr lines for diagnostics. */
  logTail:    string[]
  /** Last REAL request (not a health poll). Drives the idle auto-unload. */
  lastUsedAt?: number
  /**
   * Why the server is not running, when it stopped for a reason worth saying.
   * An idle unload looks identical to a crash from the outside — same
   * `state: 'stopped'`, same absent port — and a user who finds their model
   * gone deserves the sentence rather than a silent dot.
   */
  stoppedReason?: string
}

const slot: LlamaCppSlot = { state: 'stopped', logTail: [] }
const PREFERRED_PORT = 31417
const LOG_TAIL_MAX_LINES = 200
const HEALTH_POLL_INTERVAL_MS = 1_000
// Generous: model loading for a 7B Q4 can take 10–30s on first load
const MAX_HEALTH_ATTEMPTS = 60   // 60 s total

// ─── Healthcheck ──────────────────────────────────────────────────────────────

/**
 * Poll llama-server's /health endpoint. Returns when status is 200 or
 * MAX_HEALTH_ATTEMPTS elapses. While the model is mmap-loading the server
 * returns 503 with `{ status: "loading model" }` — that's expected and we
 * keep polling.
 */
async function pollUntilHealthy(port: number): Promise<void> {
  for (let i = 0; i < MAX_HEALTH_ATTEMPTS; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(3_000) as AbortSignal,
      })
      if (res.ok) return
      // Status 503 = model loading; flip state to 'loading' once we've seen one
      if (slot.state === 'starting') {
        slot.state = 'loading'
      }
    } catch { /* keep polling — process may not yet have bound the port */ }
    await new Promise(r => setTimeout(r, HEALTH_POLL_INTERVAL_MS))
  }
  throw new Error(`llama-server /health did not return 200 within ${MAX_HEALTH_ATTEMPTS}s`)
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * The `--ctx-size` this model will actually be started with.
 *
 * EXPORTED because the offload planner has to reserve VRAM for the KV cache,
 * and a cache sized against a different context than the server is given is
 * worse than no reservation at all — it would look measured and be wrong. One
 * function, called by the spawn and by the planner, so the two cannot drift.
 */
export function resolveLlamaContextSize(modelId: string, override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override >= 256) return Math.floor(override)
  const registry = getGgufModel(modelId)
  return registry ? registry.contextK * 1024 : 8192
}

export interface StartLlamaCppOptions {
  /** GGUF model id from the curated registry. Must already be downloaded. */
  modelId:        string
  /** Override context size (n_ctx) in tokens. Defaults to model registry contextK*1024. */
  contextSize?:   number
  /** Override layer-offload count (--n-gpu-layers). Defaults to 0 (CPU). */
  nGpuLayers?:    number
  /** Override CPU thread count (--threads). Defaults to llama-server's heuristic. */
  threads?:       number
  /**
   * KV-cache precision. `f16` is llama.cpp's default and what we shipped by
   * omission; `q8_0` roughly halves the cache and `q4_0` roughly quarters it.
   *
   * At long context the KV cache, not the weights, is what fills a card: it
   * grows linearly with tokens while the weights stay fixed. Our whole argv was
   * six arguments, so this lever — already present in the llama.cpp build we
   * ship — was simply never pulled.
   */
  cacheType?: LlamaCacheType
}

/** The cache precisions llama-server accepts, coarsest last. */
export const LLAMA_CACHE_TYPES = ['f16', 'q8_0', 'q4_0'] as const
export type LlamaCacheType = typeof LLAMA_CACHE_TYPES[number]

export function isLlamaCacheType(v: unknown): v is LlamaCacheType {
  return typeof v === 'string' && (LLAMA_CACHE_TYPES as readonly string[]).includes(v)
}

/**
 * Spawn llama-server for the given GGUF model. No-op if already running with
 * the same model. If running with a different model, switches via stop/start.
 */
export async function startLlamaCpp(opts: StartLlamaCppOptions): Promise<void> {
  // Refuse to start while THIS engine's weights are being relocated — starting
  // now could read a half-moved file (Storage → Move models to storage root).
  if (isEngineMigrating('llama')) {
    throw new Error('llama.cpp weights are being moved to the storage folder — try again in a moment.')
  }
  // Already running same model → no-op
  if (slot.state === 'running' && slot.modelId === opts.modelId) return
  // In-flight start for SAME model → wait for it (don't spawn a second proc)
  if ((slot.state === 'starting' || slot.state === 'loading') && slot.modelId === opts.modelId) {
    return
  }
  // In-flight start for DIFFERENT model → small wait so the other start
  // completes (or errors) before we tear it down. Best-effort serialisation.
  if (slot.state === 'starting' || slot.state === 'loading') {
    await new Promise(r => setTimeout(r, 250))
  }
  // Cast through the broader union so TS doesn't narrow away states reachable
  // after the awaits above.
  const current = slot.state as LlamaCppState
  const swapping = current === 'running' && slot.modelId !== opts.modelId

  // ── CHECK BEFORE YOU KILL ──────────────────────────────────────────────────
  // These three checks used to sit AFTER the teardown, so picking a model that
  // was not downloaded — or picking anything at all once the binary had been
  // moved — stopped the model you were happily using and left you with nothing
  // running and an error. The failure was entirely predictable one line
  // earlier; only the ORDER made it destructive.
  //
  // `fatal` is the other half. Writing `state = 'error'` on a swap that never
  // happened would report the STILL-RUNNING engine as broken: the old model is
  // serving requests, and the dashboard would say it failed. When a swap is
  // refused before the teardown, the slot is left exactly as it was and only
  // the caller hears about it.
  //
  // What this CANNOT promise: that the new model loads. Proving a load needs
  // the VRAM the old model is holding, so the two cannot overlap on the card
  // this app is built for. Everything knowable without spending that memory is
  // now known first.
  const fatal = (msg: string): Error => {
    if (!swapping) { slot.state = 'error'; slot.error = msg }
    return new Error(msg)
  }

  if (!isLlamaCppInstalled()) {
    throw fatal('llama.cpp is not installed. Open Status → llama.cpp to install.')
  }
  if (!isGgufModelDownloaded(opts.modelId)) {
    throw fatal(`Model "${opts.modelId}" is not downloaded. Open Status → llama.cpp to download.`)
  }

  const binary    = llamaServerBinaryPath()
  const modelPath = ggufModelPath(opts.modelId)

  if (!existsSync(binary)) {
    throw fatal(`llama-server binary missing at ${binary}`)
  }

  // Only now is the swap safe to commit to.
  if (swapping) stopLlamaCpp()

  const contextSize = resolveLlamaContextSize(opts.modelId, opts.contextSize)

  // Reset state to 'starting' BEFORE the await so concurrent callers see it.
  slot.state     = 'starting'
  slot.modelId   = opts.modelId
  slot.error     = undefined
  slot.startedAt = undefined
  slot.logTail   = []

  const port = await findFreePort(PREFERRED_PORT)
  slot.port = port

  const args: string[] = [
    '--model',       modelPath,
    '--port',        String(port),
    '--host',        '127.0.0.1',
    '--ctx-size',    String(contextSize),
    '--n-gpu-layers', String(opts.nGpuLayers ?? 0),
  ]
  if (opts.threads !== undefined) args.push('--threads', String(opts.threads))

  // ── KV-cache precision ─────────────────────────────────────────────────────
  //
  // THE V-CACHE INTERLOCK, and it is the reason this is not simply two flags.
  // Quantising the VALUE cache requires flash attention; without it llama.cpp
  // dequantises V on every attention step, and the scratch buffer that needs
  // can cost more memory than the quantisation saved — the opposite of the
  // point. The KEY cache has no such coupling.
  //
  // We do not pass --flash-attn (its default has moved around upstream and we
  // pin a specific build), so the conservative reading is the only honest one:
  // quantise K, leave V at the default. That is most of the win — K and V are
  // the same size, so this is still roughly a quarter off the cache at q8_0 —
  // with none of the risk of silently making things worse.
  if (opts.cacheType && opts.cacheType !== 'f16') {
    args.push('--cache-type-k', opts.cacheType)
  }

  // Reject any rogue traffic from non-loopback clients (defence in depth —
  // we already bind to 127.0.0.1 above so this should never trigger).
  // llama-server supports --api-key but for a local sidecar we deliberately
  // skip it: the renderer is the only client, and exposing a token over IPC
  // adds friction without security benefit (the only attacker who could read
  // 127.0.0.1 is one who already owns the user account).

  let rejectOnExit!: (err: Error) => void
  const processExited = new Promise<never>((_, reject) => { rejectOnExit = reject })

  const proc = spawn(binary, args, {
    stdio:    ['ignore', 'pipe', 'pipe'],
    detached: false,
    windowsHide: true,
  })
  slot.proc = proc
  slot.pid  = proc.pid

  const captureLog = (chunk: Buffer): void => {
    const text = chunk.toString()
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue
      slot.logTail.push(line)
      if (slot.logTail.length > LOG_TAIL_MAX_LINES) {
        slot.logTail.splice(0, slot.logTail.length - LOG_TAIL_MAX_LINES)
      }
    }
  }
  proc.stdout?.on('data', captureLog)
  proc.stderr?.on('data', captureLog)

  proc.on('error', err => {
    rejectOnExit(new Error(`spawn error: ${err.message}`))
    slot.state = 'error'
    slot.error = err.message
    slot.proc  = undefined
    slot.pid   = undefined
  })

  proc.on('exit', code => {
    rejectOnExit(new Error(`llama-server exited with code ${code ?? 'null'}`))
    if (slot.state === 'running' || slot.state === 'starting' || slot.state === 'loading') {
      slot.state = code === 0 ? 'stopped' : 'error'
      if (code !== 0) {
        const tail = slot.logTail.slice(-10).join('\n')
        slot.error = `llama-server exited with code ${code}${tail ? `\n${tail}` : ''}`
      }
    }
    slot.proc = undefined
    slot.pid  = undefined
  })

  try {
    await Promise.race([
      pollUntilHealthy(port),
      processExited,
    ])
    slot.state     = 'running'
    slot.startedAt = Date.now()
    slot.stoppedReason = undefined
    // Start the countdown at load: a model that is loaded and never spoken to
    // is the exact case this exists for — someone opened the picker, changed
    // their mind, and left several gigabytes resident.
    markLlamaCppUsed()
  } catch (err) {
    if (proc.exitCode === null) proc.kill()
    slot.state = 'error'
    slot.error = err instanceof Error ? err.message : String(err)
    slot.proc  = undefined
    slot.pid   = undefined
    throw err
  }
}

/** Stop llama-server if running. No-op otherwise. */
export function stopLlamaCpp(reason?: string): void {
  if (slot.proc) {
    try { slot.proc.kill() } catch { /* ignore */ }
  }
  clearIdleTimer()
  slot.state     = 'stopped'
  slot.proc      = undefined
  slot.pid       = undefined
  slot.port      = undefined
  slot.startedAt = undefined
  slot.error     = undefined
  slot.stoppedReason = reason
  // Note: slot.modelId retained so the UI can re-display the last-used model.
}

// ─── Idle auto-unload ────────────────────────────────────────────────────────
//
// WHY: a loaded GGUF holds its weights (and its KV cache) in VRAM for as long
// as the process lives, and nothing in this app ever released them. On the
// machine this was written for — one 12 GB card that also runs Stable
// Diffusion — that means a model you spoke to once at breakfast is still
// occupying gigabytes at dinner, and `sd-cpp-client.ts` does not mention
// `llama` anywhere: the two local engines have never coordinated over the one
// resource they both need. The image path then OOMs, or silently falls back to
// a slower memory mode, because of a chat that ended hours ago.
//
// KoboldCpp reached the same conclusion and shipped "Auto Unload Timeout" in
// v1.110 alongside its router mode. This is that idea, with our own defaults:
// after IDLE_UNLOAD_MS with no request the server is stopped, and the NEXT
// message simply loads it again. The cost of being wrong is one reload; the
// cost of not doing it is a card that stays full.
//
// The timer is reset by real traffic (`markLlamaCppUsed`, called on the
// request path), never by a status poll — the dashboard asking "are you
// running?" every second must not be able to keep a model resident forever.
// That distinction is the whole reason this is not simply `uptimeMs`.

/** How long a loaded model may sit unused before its VRAM is handed back. */
export const IDLE_UNLOAD_MS = 10 * 60 * 1000

let idleTimer: NodeJS.Timeout | undefined

function clearIdleTimer(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined }
}

/**
 * Note that the model was USED — a real generation request, not a health poll
 * or a status read. Restarts the idle countdown.
 */
export function markLlamaCppUsed(): void {
  slot.lastUsedAt = Date.now()
  if (slot.state !== 'running') return
  clearIdleTimer()
  idleTimer = setTimeout(() => {
    // Re-check at fire time: a request may have started in the meantime, and a
    // timer that fired is not evidence about the present.
    if (slot.state !== 'running') return
    const idleFor = Date.now() - (slot.lastUsedAt ?? 0)
    if (idleFor < IDLE_UNLOAD_MS) return
    stopLlamaCpp(`unloaded after ${Math.round(idleFor / 60000)} min idle — the VRAM was handed back`)
  }, IDLE_UNLOAD_MS)
  idleTimer.unref?.()
}

/** Snapshot of llama-server state for IPC. */
export interface LlamaCppStatus {
  state:     LlamaCppState
  port?:     number
  pid?:      number
  modelId?:  string
  uptimeMs?: number
  error?:    string
  /** Why it is not running, when there is something worth saying — today only
   *  the idle auto-unload, which otherwise looks exactly like a crash. */
  stoppedReason?: string
  /** Milliseconds since the last REAL request. Undefined when never used. */
  idleMs?:   number
}

export function getLlamaCppStatus(): LlamaCppStatus {
  return {
    state:    slot.state,
    port:     slot.port,
    pid:      slot.pid,
    modelId:  slot.modelId,
    uptimeMs: slot.startedAt !== undefined ? Date.now() - slot.startedAt : undefined,
    error:    slot.error,
    ...(slot.stoppedReason ? { stoppedReason: slot.stoppedReason } : {}),
    ...(slot.lastUsedAt !== undefined ? { idleMs: Date.now() - slot.lastUsedAt } : {}),
  }
}

/** Return tail of stderr/stdout lines captured from llama-server. */
export function getLlamaCppLogs(maxLines = 100): string[] {
  return slot.logTail.slice(-Math.max(1, maxLines))
}

/** Synchronous read for sidecar-manager / chat-service. */
export function getLlamaCppPort(): number | undefined {
  return slot.state === 'running' ? slot.port : undefined
}

export function isLlamaCppRunning(): boolean {
  return slot.state === 'running' && slot.port !== undefined
}

// ─── Chat proxy ───────────────────────────────────────────────────────────────

const NOT_RUNNING = {
  code:    'LLAMA_CPP_NOT_RUNNING',
  message: 'llama.cpp is not running. Open Status to start it.',
}
const NETWORK_ERROR = {
  code:    'NETWORK_ERROR',
  message: 'Could not connect to llama-server.',
}
const MALFORMED_SSE = {
  code:    'MALFORMED_SSE',
  message: 'Received malformed response from llama-server.',
}

/**
 * Stream a chat completion from the local llama-server.
 * Mirrors the freellmapi-client surface so chat-service can swap providers
 * without restructuring its iteration loop.
 *
 * llama-server's /v1/chat/completions is OpenAI-compatible (SSE with
 * `data: {...}\n\n` frames terminated by `data: [DONE]`).
 */
export async function* streamFromLlamaCpp(
  request: ChatRequest,
  systemMessage?: string,
  signal?: AbortSignal,
  /** Per-chat sampler (T19): resolved temperature/top_p, or omitted for BALANCED. */
  sampler?: { temperature?: number; top_p?: number },
): AsyncIterable<ChatChunk> {
  const messageId = randomUUID()

  const port = getLlamaCppPort()
  if (!port) {
    yield { type: 'start', messageId, model: request.model }
    yield { type: 'error', messageId, error: NOT_RUNNING }
    yield { type: 'done',  messageId }
    return
  }

  const rawMessages = systemMessage
    ? [{ role: 'system' as const, content: systemMessage }, ...request.messages]
    : request.messages

  // Map TachiDesk content-parts to OpenAI-spec content. llama-server's
  // OpenAI front-end only understands plain string content + image_url
  // (with multimodal models); file parts get inlined as text.
  const messages = rawMessages.map(m => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content }
    return {
      role: m.role,
      content: (m.content as ChatContentPart[]).map(p => {
        if (p.type === 'text')  return { type: 'text', text: p.text }
        if (p.type === 'image') return { type: 'image_url', image_url: { url: p.data } }
        if (p.type === 'file') {
          try {
            const b64 = p.data.split(',')[1] ?? p.data
            const decoded = Buffer.from(b64, 'base64').toString('utf8')
            return { type: 'text', text: `--- ${p.filename} ---\n${decoded}` }
          } catch {
            return { type: 'text', text: `--- ${p.filename} ---\n(binary file, cannot inline)` }
          }
        }
        return { type: 'text', text: '' }
      }),
    }
  })

  const body: Record<string, unknown> = {
    // llama-server treats `model` purely cosmetically (one server = one model).
    // We pass the requested name verbatim so the renderer's model label is correct.
    model:    request.model || (slot.modelId ?? 'llama-cpp'),
    messages,
    stream:   true,
  }
  if (request.tools)        body.tools        = request.tools
  if (request.tool_choice)  body.tool_choice  = request.tool_choice
  // Per-chat sampler (T19): llama-server's OpenAI front-end honors these; only
  // present for non-BALANCED presets (BALANCED keeps llama-server's own defaults).
  if (sampler?.temperature !== undefined) body.temperature = sampler.temperature
  if (sampler?.top_p !== undefined)       body.top_p       = sampler.top_p

  // A REAL request — this is what resets the idle countdown, as opposed to the
  // status polls the dashboard makes every second. Marked before the fetch so a
  // long generation cannot expire mid-stream, and again when it ends.
  markLlamaCppUsed()

  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal,
    })
  } catch {
    yield { type: 'start', messageId, model: request.model }
    yield { type: 'error', messageId, error: NETWORK_ERROR }
    yield { type: 'done',  messageId }
    return
  }

  if (!res.ok) {
    let detail = ''
    try { detail = (await res.text()).slice(0, 300) } catch { /* ignore */ }
    yield { type: 'start', messageId, model: request.model }
    yield {
      type: 'error', messageId,
      error: {
        code:    `HTTP_${res.status}`,
        message: `llama-server returned HTTP ${res.status}${detail ? ` — ${detail}` : ''}`,
      },
    }
    yield { type: 'done', messageId }
    return
  }

  const reader = res.body?.getReader()
  if (!reader) {
    yield { type: 'start', messageId, model: request.model }
    yield { type: 'error', messageId, error: MALFORMED_SSE }
    yield { type: 'done',  messageId }
    return
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let startYielded = false

  // On idle stall, cancel the reader — terminates the hung body stream so the
  // catch below yields a visible error instead of an infinite spinner.
  const stallCancel = { abort: () => { void reader.cancel().catch(() => { /* already dead */ }) } }

  try {
    while (true) {
      if (signal?.aborted) break
      const { done, value } = await readOrIdleAbort(() => reader.read(), stallCancel)
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') return
        try {
          const parsed = JSON.parse(data)
          if (!startYielded) {
            const actualModel: string = parsed.model ?? request.model ?? (slot.modelId ?? 'llama-cpp')
            yield { type: 'start', messageId, model: actualModel }
            startYielded = true
          }
          const delta = parsed.choices?.[0]?.delta?.content
          if (typeof delta === 'string' && delta.length > 0) {
            yield { type: 'delta', messageId, text: delta }
          }
          if (parsed.usage) {
            yield {
              type: 'usage', messageId,
              usage: {
                promptTokens:     parsed.usage.prompt_tokens     ?? 0,
                completionTokens: parsed.usage.completion_tokens ?? 0,
                totalTokens:      parsed.usage.total_tokens      ?? 0,
              },
            }
          }
        } catch { /* skip malformed SSE lines */ }
      }
    }
  } catch {
    if (!startYielded) yield { type: 'start', messageId, model: request.model }
    yield { type: 'error', messageId, error: MALFORMED_SSE }
  } finally {
    if (!startYielded) yield { type: 'start', messageId, model: request.model }
    yield { type: 'done', messageId }
    // Restart the countdown from the END of the generation, not its start: a
    // ten-minute stream would otherwise be most of its own idle window.
    markLlamaCppUsed()
  }
}
