// apps/desktop/electron/services/codex-app-server.ts
//
// APP-SERVER transport for the Codex worker — an ADDITIVE alternative to the
// per-task `codex exec` spawn (codex-worker.ts). Instead of a fresh process per
// task, this keeps ONE warm `codex app-server` child speaking JSON-RPC over
// stdio (newline-delimited), so runs reuse the same warm process (no cold
// re-init, no re-auth handshake per task).
//
// PROTOCOL PROVENANCE (0.144.5, discovered — not guessed): the binary is
// self-describing. `codex app-server generate-ts --out <dir> --experimental`
// emits the full request/notification type set, and a live handshake probe
// confirmed the flow end-to-end with real ~/.codex auth on this machine:
//   client -> initialize            server -> InitializeResponse
//   client -> initialized (notif)
//   client -> thread/start          server -> ThreadStartResponse { thread.id }
//   client -> turn/start            server -> TurnStartResponse (inProgress)
//   server -> item/* + turn/completed notifications (stream)
// The final agent message arrives on `item/completed` (item.type ===
// 'agentMessage'); `turn/completed` carries `itemsView: "notLoaded"` (empty
// items), so we capture the answer from item events, NOT from the turn payload.
// Resume = `thread/resume { threadId }` — verified to recall state across a
// COLD process. app-server and `codex exec` COEXIST (exec is not blocked by the
// warm server's sqlite state lock — live-verified), so the exec fallback is
// safe even while this child is alive. Two app-servers, however, contend on the
// CODEX_HOME sqlite lock — we keep exactly ONE singleton, and a lock held by an
// EXTERNAL codex surfaces as a start/handshake timeout -> transport-failed ->
// exec fallback.
//
// This module is deliberately electron-free at the top level (only Node
// builtins) so the pure codec + decision helpers are unit-testable without an
// electron runtime. Everything that touches electron / the installer is behind
// a dynamic import inside the client.

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import type { CodexTaskResult } from './codex-worker-core'

// ── Wire types (a schema-TOLERANT subset of the generated protocol) ──────────
// We only model the handful of fields the transport reads. Kept loose on
// purpose: codex's shapes drift between releases and we degrade gracefully.

export type RpcId = string | number

export interface RpcResponse { jsonrpc?: string; id: RpcId; result?: unknown; error?: { code?: number; message?: string; data?: unknown } }
export interface RpcServerRequest { jsonrpc?: string; id: RpcId; method: string; params?: unknown }
export interface RpcNotification { jsonrpc?: string; method: string; params?: unknown }
export type RpcMessage = RpcResponse | RpcServerRequest | RpcNotification

export type RpcKind = 'response' | 'serverRequest' | 'notification' | 'unknown'

// ── PURE CODEC (exported for tests) ──────────────────────────────────────────

/** Encode one JSON-RPC message as a single newline-delimited frame. */
export function encodeRpc(msg: unknown): string {
  return JSON.stringify(msg) + '\n'
}

/**
 * Newline-delimited JSON reassembly across arbitrary chunk boundaries.
 * `pending` is the leftover from the previous call; returns parsed `messages`
 * plus the still-incomplete `rest` to carry into the next chunk. Blank lines
 * and non-JSON lines (stray banners/log noise on stdout) are skipped, never
 * thrown — a single malformed line must not desync the stream.
 */
export function decodeFrames(pending: string, chunk: string): { messages: RpcMessage[]; rest: string } {
  const buf = (pending + chunk).replace(/\r/g, '')
  const parts = buf.split('\n')
  // The final element is an incomplete line (or '' when buf ended on '\n').
  const rest = parts.pop() ?? ''
  const messages: RpcMessage[] = []
  for (const line of parts) {
    const t = line.trim()
    if (!t || t[0] !== '{') continue // fast-skip blank + obvious non-JSON
    try { messages.push(JSON.parse(t) as RpcMessage) } catch { /* skip malformed line */ }
  }
  return { messages, rest }
}

/** Classify a decoded message by its JSON-RPC role. */
export function classifyMessage(msg: RpcMessage | null | undefined): RpcKind {
  if (!msg || typeof msg !== 'object') return 'unknown'
  const m = msg as unknown as Record<string, unknown>
  const hasId = m.id !== undefined && m.id !== null
  const hasMethod = typeof m.method === 'string'
  if (hasId && !hasMethod && ('result' in m || 'error' in m)) return 'response'
  if (hasId && hasMethod) return 'serverRequest'
  if (!hasId && hasMethod) return 'notification'
  return 'unknown'
}

/** The id a response correlates to, or null if the message is not a response. */
export function responseIdOf(msg: RpcMessage | null | undefined): RpcId | null {
  if (classifyMessage(msg) !== 'response') return null
  return (msg as RpcResponse).id
}

/**
 * One short human progress line for a streamed thread item, or null for noise.
 * Mirrors codex-worker-core.summarizeEvent's contract (commands / file edits /
 * errors) but reads the app-server's ThreadItem shape instead of exec NDJSON.
 */
export function summarizeThreadItem(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null
  const it = item as Record<string, unknown>
  const type = typeof it.type === 'string' ? it.type : ''
  switch (type) {
    case 'commandExecution': {
      const cmd = it.command
      if (typeof cmd === 'string' && cmd.trim()) return `$ ${cmd.slice(0, 120)}`
      return '$ (command)'
    }
    case 'fileChange': {
      const changes = Array.isArray(it.changes) ? it.changes : []
      const first = changes[0] as { path?: unknown } | undefined
      const path = typeof first?.path === 'string' ? first.path : ''
      return changes.length > 1 ? `edit ${path.slice(0, 100)} (+${changes.length - 1} more)` : `edit ${path.slice(0, 120)}`
    }
    case 'mcpToolCall':
      return `mcp ${String(it.server ?? '')}/${String(it.tool ?? '')}`.slice(0, 120)
    case 'webSearch':
      return 'web search'
    case 'dynamicToolCall':
      return `tool ${String(it.tool ?? '')}`.slice(0, 120)
    default:
      return null // agentMessage/reasoning/userMessage/etc. are not progress noise
  }
}

// ── FALLBACK DECISION (pure, exported for tests) ─────────────────────────────

/**
 * Outcome of an app-server transport attempt.
 *  - 'ran'             a turn actually executed (ok true OR false); use its
 *                      result verbatim — a genuine codex failure (auth, usage
 *                      limit, timeout, user abort) must NOT re-run under exec.
 *  - 'transport-failed' the app-server could not be used at all (spawn error,
 *                      handshake/request timeout, protocol error, child died
 *                      before completion); DO fall back to exec.
 *  - 'disabled'        the feature flag is off; use exec directly.
 */
export type TransportAttempt =
  | { kind: 'ran'; result: CodexTaskResult }
  | { kind: 'transport-failed'; reason: string }
  | { kind: 'disabled' }

/** Whether to run the exec-CLI fallback for a given transport attempt. */
export function shouldFallbackToExec(attempt: TransportAttempt): boolean {
  return attempt.kind !== 'ran'
}

// ── Pending-request registry (id correlation + per-request timeout) ──────────
// Stateful but electron-free and unit-testable with fake timers.

interface PendingEntry { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export class PendingRequests {
  private map = new Map<RpcId, PendingEntry>()

  /** Register a request id; the promise rejects after `timeoutMs` if unanswered. */
  register(id: RpcId, timeoutMs: number): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.map.delete(id)) reject(new Error(`codex app-server request ${String(id)} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      // Never let a pending JSON-RPC timer hold the event loop open.
      ;(timer as { unref?: () => void }).unref?.()
      this.map.set(id, { resolve, reject, timer })
    })
  }

  /** Resolve a pending request by id (no-op if unknown/already settled). */
  settle(id: RpcId, result: unknown): boolean {
    const e = this.map.get(id)
    if (!e) return false
    clearTimeout(e.timer)
    this.map.delete(id)
    e.resolve(result)
    return true
  }

  /** Reject a pending request by id (no-op if unknown/already settled). */
  fail(id: RpcId, err: Error): boolean {
    const e = this.map.get(id)
    if (!e) return false
    clearTimeout(e.timer)
    this.map.delete(id)
    e.reject(err)
    return true
  }

  /** Reject ALL pending requests (used when the child dies). */
  failAll(err: Error): void {
    for (const [id, e] of this.map) { clearTimeout(e.timer); e.reject(err); void id }
    this.map.clear()
  }

  get size(): number { return this.map.size }
}

// ── Client ───────────────────────────────────────────────────────────────────

const INITIALIZE_TIMEOUT_MS = 20_000
const REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_TURN_TIMEOUT_MS = 15 * 60_000

interface TurnHandler {
  threadId: string
  write: boolean
  onItem: (item: Record<string, unknown>) => void
  onAgentDelta: (delta: string) => void
  onTurnCompleted: (turn: Record<string, unknown>) => void
  onError: (message: string, willRetry: boolean) => void
}

let quitHookInstalled = false

/**
 * The warm `codex app-server` child. One per app process (singleton via
 * getCodexAppServer). Owns framing, id correlation, defensive server-request
 * replies, and lifecycle (lazy start, handshake health check, restart-once,
 * dispose on quit).
 */
export class CodexAppServerClient {
  private proc: ChildProcessWithoutNullStreams | null = null
  private ready: Promise<void> | null = null
  private stdoutBuf = ''
  private stderrTail = ''
  private nextId = 1
  private readonly pending = new PendingRequests()
  private readonly turnHandlers = new Map<string, TurnHandler>()
  private disposed = false

  isAlive(): boolean { return !!this.proc && !this.proc.killed && this.proc.exitCode === null }

  /** Lazy start + handshake, with a single automatic restart on failure. */
  async ensureReady(): Promise<void> {
    if (this.disposed) throw new Error('codex app-server client was disposed')
    if (this.isAlive() && this.ready) { await this.ready; return }
    try {
      await this.startAndHandshake()
    } catch (firstErr) {
      // auto-restart ONCE: a stale/half-dead child gets one clean retry.
      this.hardReset(firstErr instanceof Error ? firstErr : new Error(String(firstErr)))
      await this.startAndHandshake()
    }
  }

  /**
   * How to launch the app-server child. Isolated so it can be overridden in an
   * out-of-electron integration harness (codex-installer imports electron at
   * the top level and can't load in a bare Node test).
   */
  protected async resolveLaunchSpec(): Promise<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> {
    const { codexLaunchSpec } = await import('./codex-installer')
    return codexLaunchSpec(['app-server', '--stdio'])
  }

  private async startAndHandshake(): Promise<void> {
    if (this.isAlive() && this.ready) { await this.ready; return }
    this.ready = (async () => {
      const spec = await this.resolveLaunchSpec()
      // windowsHide:true is MANDATORY — a console-subsystem child spawned hidden
      // gives its PowerShell/PTY descendants a hidden console they inherit
      // (same rationale as spawnCodex/runCodexTask; a visible Windows Terminal
      // flashed otherwise).
      const proc = spawn(spec.file, spec.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: spec.env,
      }) as ChildProcessWithoutNullStreams
      this.proc = proc
      this.stdoutBuf = ''
      this.stderrTail = ''

      proc.stdout.on('data', (d: Buffer) => this.onStdout(d))
      proc.stderr.on('data', (d: Buffer) => { this.stderrTail = (this.stderrTail + d.toString()).slice(-2000) })
      proc.on('error', (err) => this.onChildGone(`spawn error: ${err.message}`))
      proc.on('exit', (code, signal) => this.onChildGone(`app-server exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})${this.stderrTail.trim() ? ` — ${this.stderrTail.trim().slice(-300)}` : ''}`))

      await this.installQuitHook()

      // Handshake: initialize -> initialized. A locked CODEX_HOME (external
      // app-server holding the sqlite state) manifests here as a timeout.
      await this.request('initialize', {
        clientInfo: { name: 'tachi-studio', title: 'TACHI Studio', version: '1.0.0' },
        capabilities: { experimentalApi: false, requestAttestation: false },
      }, INITIALIZE_TIMEOUT_MS)
      this.notify('initialized')
    })()
    try {
      await this.ready
    } catch (e) {
      this.ready = null
      throw e
    }
  }

  private async installQuitHook(): Promise<void> {
    if (quitHookInstalled) return
    try {
      const { app } = await import('electron')
      app.once('before-quit', () => { try { disposeCodexAppServer() } catch { /* teardown best-effort */ } })
      quitHookInstalled = true
    } catch { /* not in electron (tests) — nothing to hook */ }
  }

  private onStdout(d: Buffer): void {
    const { messages, rest } = decodeFrames(this.stdoutBuf, d.toString())
    this.stdoutBuf = rest
    for (const m of messages) this.dispatch(m)
  }

  private dispatch(msg: RpcMessage): void {
    switch (classifyMessage(msg)) {
      case 'response': {
        const r = msg as RpcResponse
        if (r.error) this.pending.fail(r.id, new Error(`codex app-server error ${r.error.code ?? ''}: ${r.error.message ?? 'unknown'}`))
        else this.pending.settle(r.id, r.result)
        return
      }
      case 'serverRequest':
        this.handleServerRequest(msg as RpcServerRequest)
        return
      case 'notification':
        this.handleNotification(msg as RpcNotification)
        return
      default:
        return
    }
  }

  /**
   * Server -> client requests. With approvalPolicy 'never' + a sandbox guard
   * (our contract), approval requests should NOT arrive; we still answer every
   * server request so the turn can never hang, and reply with an error for
   * anything we deliberately do not service.
   */
  private handleServerRequest(req: RpcServerRequest): void {
    const params = (req.params ?? {}) as Record<string, unknown>
    const write = this.writeForThread(typeof params.threadId === 'string' ? params.threadId : undefined)
    switch (req.method) {
      case 'currentTime/read':
        this.reply(req.id, { currentTimeAt: Math.floor(Date.now() / 1000) })
        return
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
      case 'item/permissions/requestApproval':
        // v2 decision vocabulary. Sandbox already gates the effect; mirror the
        // exec "never prompt, just run in-sandbox" stance: accept when writing,
        // decline when read-only.
        this.reply(req.id, { decision: write ? 'accept' : 'decline' })
        return
      case 'execCommandApproval':
      case 'applyPatchApproval':
        // Legacy ReviewDecision vocabulary.
        this.reply(req.id, { decision: write ? 'approved' : 'denied' })
        return
      default:
        // Elicitations, dynamic tool calls, attestation, token refresh, etc.
        // We opted out of those capabilities; decline cleanly so nothing hangs.
        this.replyError(req.id, -32601, `tachi app-server client does not service ${req.method}`)
        return
    }
  }

  private handleNotification(notif: RpcNotification): void {
    const method = notif.method
    const params = (notif.params ?? {}) as Record<string, unknown>
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined
    const handler = threadId ? this.turnHandlers.get(threadId) : undefined
    if (!handler) return
    switch (method) {
      case 'item/started':
      case 'item/completed': {
        const item = params.item as Record<string, unknown> | undefined
        if (item) handler.onItem(item)
        return
      }
      case 'item/agentMessage/delta': {
        const delta = typeof params.delta === 'string' ? params.delta : ''
        if (delta) handler.onAgentDelta(delta)
        return
      }
      case 'turn/completed': {
        const turn = params.turn as Record<string, unknown> | undefined
        if (turn) handler.onTurnCompleted(turn)
        return
      }
      case 'error': {
        const err = params.error as { message?: unknown } | undefined
        handler.onError(typeof err?.message === 'string' ? err.message : 'codex error', params.willRetry === true)
        return
      }
      default:
        return
    }
  }

  private writeForThread(threadId: string | undefined): boolean {
    if (!threadId) return false
    return this.turnHandlers.get(threadId)?.write ?? false
  }

  /** Fire a request and await its correlated response (or timeout). */
  request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (!this.proc || !this.isAlive()) return Promise.reject(new Error('codex app-server is not running'))
    const id = this.nextId++
    const p = this.pending.register(id, timeoutMs)
    try {
      this.proc.stdin.write(encodeRpc({ jsonrpc: '2.0', id, method, params }))
    } catch (e) {
      this.pending.fail(id, e instanceof Error ? e : new Error(String(e)))
    }
    return p
  }

  private notify(method: string, params?: unknown): void {
    if (!this.proc || !this.isAlive()) return
    try { this.proc.stdin.write(encodeRpc(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })) } catch { /* child gone; exit handler cleans up */ }
  }

  private reply(id: RpcId, result: unknown): void {
    if (!this.proc || !this.isAlive()) return
    try { this.proc.stdin.write(encodeRpc({ jsonrpc: '2.0', id, result })) } catch { /* child gone */ }
  }

  private replyError(id: RpcId, code: number, message: string): void {
    if (!this.proc || !this.isAlive()) return
    try { this.proc.stdin.write(encodeRpc({ jsonrpc: '2.0', id, error: { code, message } })) } catch { /* child gone */ }
  }

  registerTurn(handler: TurnHandler): void { this.turnHandlers.set(handler.threadId, handler) }
  unregisterTurn(threadId: string): void { this.turnHandlers.delete(threadId) }

  private onChildGone(reason: string): void {
    const err = new Error(reason)
    this.pending.failAll(err)
    for (const h of this.turnHandlers.values()) h.onError(reason, false)
    this.proc = null
    this.ready = null
    this.stdoutBuf = ''
  }

  private hardReset(err: Error): void {
    const proc = this.proc
    this.proc = null
    this.ready = null
    this.stdoutBuf = ''
    this.pending.failAll(err)
    if (proc) killTree(proc)
  }

  dispose(): void {
    this.disposed = true
    const proc = this.proc
    this.proc = null
    this.ready = null
    this.turnHandlers.clear()
    this.pending.failAll(new Error('codex app-server disposed'))
    if (proc) killTree(proc)
  }
}

function killTree(proc: ChildProcessWithoutNullStreams): void {
  try {
    if (process.platform === 'win32' && proc.pid) {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true })
    } else {
      proc.kill('SIGKILL')
    }
  } catch { /* already gone */ }
}

// ── Singleton + disposal ─────────────────────────────────────────────────────

let singleton: CodexAppServerClient | null = null

export function getCodexAppServer(): CodexAppServerClient {
  if (!singleton) singleton = new CodexAppServerClient()
  return singleton
}

/** Kill the warm child (app quit / explicit teardown). Safe to call twice. */
export function disposeCodexAppServer(): void {
  if (singleton) { singleton.dispose(); singleton = null }
}

// ── Task API (mirrors runCodexTask's contract) ───────────────────────────────

export interface CodexAppServerTaskOpts {
  workspaceRoot: string
  task: string
  write?: boolean
  model?: string
  resumeSessionId?: string
  timeoutMs?: number
  signal?: AbortSignal
  onProgress?: (line: string) => void
  /** Injected in tests; defaults to the real getCodexAppServer() singleton. */
  client?: CodexAppServerClient
  /** Injected in tests; defaults to recordCodexLog (dynamically imported). */
  recordLog?: (line: { runId: string; kind: 'start' | 'progress' | 'answer' | 'error' | 'exit'; text: string }) => void
}

/**
 * Run one task over the warm app-server. Returns a TransportAttempt: 'ran' with
 * a CodexTaskResult when a turn actually executed (caller uses it verbatim), or
 * 'transport-failed' when the app-server could not be used (caller falls back
 * to exec). Never throws for transport problems — they become 'transport-failed'.
 */
export async function runCodexTaskViaAppServer(opts: CodexAppServerTaskOpts): Promise<TransportAttempt> {
  const client = opts.client ?? getCodexAppServer()
  const record = opts.recordLog ?? (await loadRecorder())
  const runId = randomUUID().slice(0, 8)
  const sandbox: 'read-only' | 'workspace-write' = opts.write ? 'workspace-write' : 'read-only'

  // 1) Bring the warm child up (transport failure -> fall back to exec).
  try {
    await client.ensureReady()
  } catch (e) {
    return { kind: 'transport-failed', reason: `app-server unavailable: ${e instanceof Error ? e.message : String(e)}` }
  }

  record({ runId, kind: 'start', text: `${opts.write ? 'WRITE' : 'READ-ONLY'}${opts.resumeSessionId ? ' · resume ' + opts.resumeSessionId.slice(0, 8) : ''} · APP-SERVER · ${opts.task.slice(0, 160)}` })

  // 2) Start or resume the thread.
  let threadId: string
  try {
    const params: Record<string, unknown> = { sandbox, approvalPolicy: 'never', cwd: opts.workspaceRoot }
    if (opts.model && opts.model.trim()) params.model = opts.model.trim()
    if (opts.resumeSessionId) {
      params.threadId = opts.resumeSessionId
      const res = (await client.request('thread/resume', params)) as { thread?: { id?: string } }
      threadId = res?.thread?.id ?? opts.resumeSessionId
    } else {
      const res = (await client.request('thread/start', params)) as { thread?: { id?: string } }
      const id = res?.thread?.id
      if (typeof id !== 'string' || !id) return { kind: 'transport-failed', reason: 'thread/start returned no thread id' }
      threadId = id
    }
  } catch (e) {
    return { kind: 'transport-failed', reason: `thread ${opts.resumeSessionId ? 'resume' : 'start'} failed: ${e instanceof Error ? e.message : String(e)}` }
  }

  // 3) Stream the turn to completion.
  const progress: string[] = []
  let answer = ''
  let deltaAccum = ''
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS

  const pushProgress = (line: string | null): void => {
    if (!line) return
    if (progress[progress.length - 1] === line) return
    progress.push(line)
    if (progress.length > 200) progress.splice(0, progress.length - 200)
    record({ runId, kind: 'progress', text: line })
    try { opts.onProgress?.(line) } catch { /* observer must not break the run */ }
  }

  const outcome = await new Promise<{ status: 'completed' | 'failed' | 'interrupted'; error?: string }>((resolve) => {
    let settled = false
    const finish = (r: { status: 'completed' | 'failed' | 'interrupted'; error?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      client.unregisterTurn(threadId)
      resolve(r)
    }
    const onAbort = () => { void interrupt(); finish({ status: 'interrupted', error: 'Codex run aborted by the user.' }) }

    const timer = setTimeout(() => { void interrupt(); finish({ status: 'interrupted', error: `Codex worker timed out after ${Math.round(timeoutMs / 60_000)} min.` }) }, timeoutMs)
    ;(timer as { unref?: () => void }).unref?.()

    const interrupt = async () => { try { await client.request('turn/interrupt', { threadId, turnId: activeTurnId ?? '' }, 5_000) } catch { /* best effort */ } }

    let activeTurnId: string | undefined
    client.registerTurn({
      threadId,
      write: !!opts.write,
      onItem: (item) => {
        const type = typeof item.type === 'string' ? item.type : ''
        if (type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) answer = item.text // last agentMessage wins (mirrors --output-last-message)
        else pushProgress(summarizeThreadItem(item))
      },
      onAgentDelta: (delta) => { deltaAccum += delta },
      onTurnCompleted: (turn) => {
        const status = turn.status
        if (status === 'completed') finish({ status: 'completed' })
        else if (status === 'interrupted') finish({ status: 'interrupted', error: 'Codex turn interrupted.' })
        else {
          const err = turn.error as { message?: unknown } | null | undefined
          finish({ status: 'failed', error: typeof err?.message === 'string' ? err.message : 'Codex turn failed.' })
        }
      },
      onError: (message) => finish({ status: 'failed', error: message }),
    })

    opts.signal?.addEventListener('abort', onAbort, { once: true })

    // Kick off the turn. A rejection here (child died / write failed) is a
    // transport drop mid-run -> report as failed so the caller falls back.
    client.request('turn/start', { threadId, input: [{ type: 'text', text: opts.task, text_elements: [] }] })
      .then((res) => { const t = (res as { turn?: { id?: string } })?.turn?.id; if (typeof t === 'string') activeTurnId = t })
      .catch((e) => finish({ status: 'failed', error: `turn/start failed: ${e instanceof Error ? e.message : String(e)}` }))
  })

  const finalAnswer = answer || deltaAccum.trim()

  // A mid-run transport drop (child died) surfaces as onError with a message
  // mentioning the app-server exiting — treat that as transport-failed so exec
  // takes over, rather than reporting a spurious task failure.
  if (outcome.status === 'failed' && outcome.error && /app-server exited|spawn error|not running/i.test(outcome.error)) {
    record({ runId, kind: 'error', text: `app-server transport dropped: ${outcome.error.slice(0, 200)}` })
    return { kind: 'transport-failed', reason: outcome.error }
  }

  if (outcome.status === 'completed') {
    record({ runId, kind: 'exit', text: `turn completed · thread ${threadId.slice(0, 8)}` })
    record({ runId, kind: 'answer', text: (finalAnswer || '(no final message)').slice(0, 400) })
    return { kind: 'ran', result: { ok: true, answer: finalAnswer || '(Codex finished without a final message)', sessionId: threadId, progress } }
  }

  // failed / interrupted (timeout or user abort or model error) — a real run
  // outcome, NOT a transport failure. Return it verbatim (no exec re-run).
  record({ runId, kind: 'error', text: `${outcome.status}${outcome.error ? ': ' + outcome.error.slice(0, 200) : ''}` })
  return { kind: 'ran', result: { ok: false, answer: finalAnswer, sessionId: threadId, progress, error: outcome.error ?? `Codex turn ${outcome.status}.` } }
}

async function loadRecorder(): Promise<NonNullable<CodexAppServerTaskOpts['recordLog']>> {
  try {
    const { recordCodexLog } = await import('./codex-run-log')
    return recordCodexLog
  } catch {
    return () => { /* no-op outside electron */ }
  }
}
