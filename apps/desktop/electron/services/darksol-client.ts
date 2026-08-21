// apps/desktop/electron/services/darksol-client.ts
//
// Harness adapter for darksol-terminal — implements the SAME contract
// agent.ipc.ts already drives for openclaude:
//   createSession(workingDir) -> sendTask(token, task, onEvent, signal) -> stopSession(token)
// emitting AgentEvent = text | tool-call | tool-done | done | error.
//
// Transport: darksol is a CLI. Each sendTask spawns
//   node <darksolEntry> agent harness run "<task>" --stream-json --session <id> --cwd <workingDir>
// and parses the child's NDJSON stdout (one JSON object per line) through the
// PURE core mapper parseDarksolEvent (packages/core/src/agent/darksol-events.ts).
// stdout NDJSON parsing mirrors openclaude-client.ts; the createSession/sendTask/
// stopSession shape + AbortSignal handling follow the same createSession/sendTask/
// stopSession contract every harness adapter in this app implements.
//
// ── In-loop tool gating (no client-side pre-execution veto) ─────────────────
// darksol runs its tools autonomously inside its own process and reports them
// via --stream-json events AFTER/AS they execute, so there is no
// client-side pre-execution veto here. The guardrails are:
//   (a) the agent-signer's max-value/daily-limit (hard ceiling, Task 3), and
//   (b) dry-run ON by default (Task 6) — money-moving tools are gated in
//       agent.ipc.ts post-hoc, and dry-run is passed into the signer at start.
// The permission gate + trace in agent.ipc.ts therefore apply post-hoc.

import { spawn, type ChildProcess } from 'child_process'
import { parseDarksolEvent } from '@tachi/core'
import type { AgentEvent } from '@tachi/core'
import { darksolEntry } from './darksol-installer'

export class DarksolClient {
  // The session token IS the darksol session id. darksol persists sessions to
  // ~/.darksol/harness/sessions.json and resumes via { sessionId, resume }; we
  // create a stable id here and pass --session on every run so multi-turn chats
  // accumulate in the same darksol session.
  private readonly liveProcs = new Map<string, ChildProcess>()

  /**
   * Create a harness session for the given working directory. darksol creates
   * the session lazily on first `harness run --session <id>`, so we just mint a
   * stable id (and stash the cwd inside it) and return it as the token.
   */
  async createSession(workingDir: string): Promise<string> {
    const id = `darksol-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    // Encode the cwd into the token so sendTask/stopSession are self-contained
    // (the legacy sidecar clients encoded connectionId||sessionId the same way).
    return `${id}||${workingDir.replace(/\\/g, '/')}`
  }

  /**
   * Send a task to a darksol session and stream the harness output.
   * Spawns `agent harness run "<task>" --stream-json --session <id>` and maps
   * each NDJSON stdout line via parseDarksolEvent. Resolves on done/error/abort.
   */
  async sendTask(
    sessionToken: string,
    task:         string,
    onEvent:      (event: AgentEvent) => void,
    signal:       AbortSignal,
  ): Promise<void> {
    const [sessionId, workingDir] = sessionToken.split('||')
    if (!sessionId) throw new Error(`Invalid darksol session token: ${sessionToken}`)

    const nodeCmd = process.platform === 'win32' ? 'node.exe' : 'node'
    const args = [
      darksolEntry(), 'agent', 'harness', 'run', task,
      '--stream-json',
      '--session', sessionId,
    ]
    if (workingDir) args.push('--cwd', workingDir)

    const proc = spawn(nodeCmd, args, {
      cwd:   workingDir || process.cwd(),
      env:   { ...process.env },   // provider/wallet secrets live in the agent-signer, NOT here
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.liveProcs.set(sessionId, proc)

    // Abort: kill the child; the 'close' handler resolves the promise.
    const onAbort = () => { try { proc.kill() } catch { /* already gone */ } }
    signal.addEventListener('abort', onAbort, { once: true })

    let stdoutBuf = ''
    let stderrBuf = ''
    /**
     * TWO flags, because they were one — and the one conflated a FAILURE with an
     * ENDING. `terminal` was set by either a `done` or an `error`, so a run that
     * reported an error and then exited was considered ended by a vocabulary in
     * which `error` is not an ending: agent.ipc's own callers resolve on
     * `done || error`, but the UI's run state is driven by `done`, and
     * openclaude-client (the sibling harness) gives every exit a `done` with a
     * reason for exactly this reason. Same fix, same words.
     */
    let sawDone  = false
    let sawError = false
    /** One terminal event per run, whichever exit gets there first. */
    const finish = (reason: 'stop' | 'error' | 'abort'): void => {
      if (sawDone) return
      sawDone = true
      onEvent({ type: 'done', reason })
    }

    const flushLines = (chunk: string) => {
      stdoutBuf += chunk
      const lines = stdoutBuf.split('\n')
      stdoutBuf = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        for (const ev of parseDarksolEvent(trimmed)) {
          if (ev.type === 'done') { if (sawDone) continue; sawDone = true }
          if (ev.type === 'error') sawError = true
          onEvent(ev)
        }
      }
    }

    try {
      await new Promise<void>((resolve) => {
        proc.stdout?.on('data', (d: Buffer) => flushLines(d.toString()))
        proc.stderr?.on('data', (d: Buffer) => { stderrBuf += d.toString() })
        proc.on('error', (err) => {
          if (signal.aborted) { finish('abort'); resolve(); return }
          if (!sawError && !sawDone) onEvent({ type: 'error', message: `darksol spawn error: ${err.message}` })
          finish('error')
          resolve()
        })
        proc.on('close', (code) => {
          // Drain any trailing partial line.
          if (stdoutBuf.trim()) flushLines('\n')
          // A FAILURE OUTRANKS AN ABORT, and here that is not a nicety.
          //
          // `agent.ipc.ts` aborts the controller ITSELF the moment an `error`
          // event arrives (`if (e.type === 'done' || e.type === 'error')
          // ctrl.abort()`), so by the time `close` fires on a genuinely failed
          // run, `signal.aborted` is true — set by us, not by the user. Testing
          // it first therefore reported every darksol failure as "stopped".
          //
          // openclaude-client checks its `failed` flag before its abort check
          // for the same reason; this is that ordering, and the two harnesses
          // now agree about which word a failed run gets.
          if (sawError) { finish('error'); resolve(); return }
          // A STOP IS AN ENDING TOO. This branch used to resolve with no event
          // at all, so the one thing the user definitely knows happened — they
          // pressed stop — left the run with no verdict on screen.
          if (signal.aborted) { finish('abort'); resolve(); return }
          // If the harness never emitted a terminal event, synthesize one from
          // the exit code. The error line names the cause; the `done` is what
          // ends the run, and emitting the first without the second is the
          // half-contract openclaude-client documents at length.
          if (!sawDone) {
            if (code === 0 && !sawError) finish('stop')
            else {
              if (!sawError) onEvent({ type: 'error', message: stderrBuf.slice(-500) || `darksol exited with code ${code}` })
              finish('error')
            }
          }
          resolve()
        })
      })
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.liveProcs.delete(sessionId)
    }
  }

  /** Terminate a session. Best-effort — kills any live run for this token. */
  async stopSession(sessionToken: string): Promise<void> {
    const [sessionId] = sessionToken.split('||')
    const proc = this.liveProcs.get(sessionId)
    if (proc) {
      try { proc.kill() } catch { /* already gone */ }
      this.liveProcs.delete(sessionId)
    }
    // darksol persists session state to ~/.darksol/harness/sessions.json on its
    // own; no remote close call is needed.
  }
}
