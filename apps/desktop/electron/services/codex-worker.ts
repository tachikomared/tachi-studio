// apps/desktop/electron/services/codex-worker.ts
//
// Runs one delegated task on the Codex worker sidecar. TWO transports, chosen
// per run:
//
//   1. APP-SERVER (default, feature-flagged ON): a persistent `codex app-server`
//      child speaking JSON-RPC over stdio, so runs reuse one warm process
//      (codex-app-server.ts). Preferred when available.
//   2. EXEC-CLI (always-available fallback): the DOCUMENTED non-interactive
//      surface `codex exec --json` (+ `exec resume <id>`), a fresh process per
//      task. This stays the working default fallback — it must never break.
//
// The dispatcher (runCodexTask) tries the app-server first and falls back to
// exec on ANY transport failure (spawn/handshake/timeout/protocol/child-death),
// logging the fallback. A genuine codex run outcome (auth error, usage limit,
// user abort, timeout) is returned verbatim and does NOT trigger a re-run.
//
// Safety model (mirrors the OpenAI plugin's defaults), identical across both
// transports:
//   - approvalPolicy is ALWAYS 'never' (headless — no approval round-trips);
//     the SANDBOX is the guard: read-only unless the caller passed write=true,
//     and write=true is what the TACHI permission gate prompts the user for.
//   - cwd is the session workspaceRoot; env is scrubbed (filterEnv) so no
//     ambient secrets reach the CLI; auth comes from the CLI's own ~/.codex.
//   - PRIVATE MODE never reaches this file (the tool isn't wired then).

import { join } from 'path'
import { tmpdir } from 'os'
import { readFileSync, rmSync, existsSync } from 'fs'
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { isCodexInstalled, codexLaunchSpec } from './codex-installer'
import { buildExecArgs, extractSessionId, summarizeEvent, parseEventLine, type CodexTaskResult } from './codex-worker-core'
import { recordCodexLog } from './codex-run-log'
import { runCodexTaskViaAppServer, shouldFallbackToExec } from './codex-app-server'

export type { CodexTaskResult }

const DEFAULT_TIMEOUT_MS = 15 * 60_000

export interface RunCodexTaskOpts {
  workspaceRoot: string
  task: string
  write?: boolean
  model?: string
  resumeSessionId?: string
  timeoutMs?: number
  /** Abort (e.g. the user pressed STOP) — kills the whole process tree. */
  signal?: AbortSignal
  /** Optional live progress hook (one summarized line per interesting event). */
  onProgress?: (line: string) => void
}

/** True unless the user explicitly turned the app-server transport OFF. */
async function appServerEnabled(): Promise<boolean> {
  try {
    const { loadSettings } = await import('./settings-store')
    return loadSettings().codexAppServerEnabled !== false
  } catch {
    return true // settings unavailable → keep the default-ON behavior
  }
}

/**
 * Dispatch one Codex task: prefer the warm app-server transport (behind a
 * feature flag defaulting ON), fall back to the exec-CLI on ANY transport
 * failure. Both paths honor the same contract (args, CodexTaskResult, run-log
 * events, read-only sandbox default, resume via session/thread id).
 */
export async function runCodexTask(opts: RunCodexTaskOpts): Promise<CodexTaskResult> {
  if (!isCodexInstalled()) {
    return { ok: false, answer: '', progress: [], error: 'Codex worker is not installed. Install it in Settings → CODEX WORKER, then log in with your ChatGPT account or API key.' }
  }
  if (await appServerEnabled()) {
    try {
      const attempt = await runCodexTaskViaAppServer(opts)
      if (!shouldFallbackToExec(attempt)) return (attempt as { kind: 'ran'; result: CodexTaskResult }).result
      const reason = attempt.kind === 'transport-failed' ? attempt.reason : 'transport disabled'
      recordCodexLog({ runId: randomUUID().slice(0, 8), kind: 'progress', text: `app-server transport unavailable (${reason.slice(0, 160)}) — falling back to exec CLI` })
    } catch (e) {
      // Belt: any unexpected throw from the app-server path must never block a
      // run — fall through to the proven exec transport.
      recordCodexLog({ runId: randomUUID().slice(0, 8), kind: 'progress', text: `app-server transport threw (${(e instanceof Error ? e.message : String(e)).slice(0, 160)}) — falling back to exec CLI` })
    }
  }
  return await runCodexTaskExec(opts)
}

/**
 * EXEC-CLI transport — the always-available fallback. Fresh `codex exec` per
 * task. This is the original, battle-tested worker path; keep it intact.
 */
export async function runCodexTaskExec(opts: RunCodexTaskOpts): Promise<CodexTaskResult> {
  if (!isCodexInstalled()) {
    return { ok: false, answer: '', progress: [], error: 'Codex worker is not installed. Install it in Settings → CODEX WORKER, then log in with your ChatGPT account or API key.' }
  }
  const runId = randomUUID().slice(0, 8)
  recordCodexLog({ runId, kind: 'start', text: `${opts.write ? 'WRITE' : 'READ-ONLY'}${opts.resumeSessionId ? ' · resume ' + opts.resumeSessionId.slice(0, 8) : ''} · ${opts.task.slice(0, 160)}` })
  const lastMessageFile = join(tmpdir(), `tachi-codex-${randomUUID()}.txt`)
  const args = buildExecArgs({
    task: opts.task,
    write: opts.write,
    model: opts.model,
    resumeSessionId: opts.resumeSessionId,
    lastMessageFile,
  })

  return await new Promise<CodexTaskResult>((resolve) => {
    // Launch the NATIVE codex binary directly with a hidden console
    // (codexLaunchSpec): windowsHide on a console-subsystem child creates a
    // hidden console its PowerShell descendants inherit — nothing flashes.
    // Any node/cmd hop in between broke that chain and Win11 opened a visible
    // Windows Terminal for the grandchild (seen live). stdio stays PIPED so
    // codex sees no TTY and keeps emitting clean NDJSON (a ConPTY made it go
    // interactive-silent). The task is fed via STDIN ('-' arg) — quoting-free.
    const spec = codexLaunchSpec(args)
    const proc = spawn(spec.file, spec.args, {
      cwd: opts.workspaceRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: spec.env,
    })
    proc.stdin?.write(opts.task)
    proc.stdin?.end()

    const progress: string[] = []
    let sessionId: string | undefined
    let stdoutTail = ''
    let settled = false

    const killTree = () => {
      try {
        if (process.platform === 'win32' && proc.pid) {
          spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true })
        } else {
          proc.kill('SIGKILL')
        }
      } catch { /* already gone */ }
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killTree()
      finish({ ok: false, answer: readLastMessage(), sessionId, progress, error: `Codex worker timed out after ${Math.round((opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 60_000)} min (process tree killed). Partial progress above; resume with resume_session if a session id was captured.` })
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    // User abort (STOP button / session teardown) → kill the tree, keep what we have.
    opts.signal?.addEventListener('abort', () => {
      if (settled) return
      settled = true
      killTree()
      finish({ ok: false, answer: readLastMessage(), sessionId, progress, error: 'Codex run aborted by the user.' })
    }, { once: true })

    const readLastMessage = (): string => {
      try { return existsSync(lastMessageFile) ? readFileSync(lastMessageFile, 'utf8').trim() : '' } catch { return '' }
    }
    const finish = (r: CodexTaskResult) => {
      clearTimeout(timer)
      try { rmSync(lastMessageFile, { force: true }) } catch { /* temp file */ }
      resolve(r)
    }

    let lineBuf = ''
    proc.stdout?.on('data', (d: Buffer) => {
      const clean = d.toString().replace(/\r/g, '')
      lineBuf += clean
      stdoutTail = (stdoutTail + clean).slice(-4000)
      let nl: number
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, nl)
        lineBuf = lineBuf.slice(nl + 1)
        const evt = parseEventLine(line)
        if (!evt) continue
        if (!sessionId) { const id = extractSessionId(evt); if (id) sessionId = id }
        const summary = summarizeEvent(evt)
        if (summary && progress[progress.length - 1] !== summary) {
          progress.push(summary)
          if (progress.length > 200) progress.splice(0, progress.length - 200)
          recordCodexLog({ runId, kind: 'progress', text: summary })
          try { opts.onProgress?.(summary) } catch { /* observer must not break the run */ }
        }
      }
    })
    proc.stderr?.on('data', (d: Buffer) => { stdoutTail = (stdoutTail + d.toString()).slice(-4000) })
    proc.on('error', (err) => {
      if (settled) return
      settled = true
      finish({ ok: false, answer: '', progress, error: `codex launch failed: ${err.message}` })
    })
    proc.on('exit', (exitCode) => {
      if (settled) return
      settled = true
      const answer = readLastMessage() || stdoutTail.trim().slice(-2000)
      recordCodexLog({ runId, kind: exitCode === 0 ? 'exit' : 'error', text: `exit ${exitCode}${sessionId ? ' · session ' + sessionId.slice(0, 8) : ''}` })
      if (exitCode === 0) {
        recordCodexLog({ runId, kind: 'answer', text: (answer || '(no final message)').slice(0, 400) })
        finish({ ok: true, answer: answer || '(Codex finished without a final message)', sessionId, progress })
      } else {
        const hint = /log ?in|log ?out|auth|token|unauthorized|401/i.test(stdoutTail)
          ? ' Codex needs a fresh login (its refresh token can be consumed by the ChatGPT app) — Settings → CODEX WORKER → LOG IN.'
          : ''
        finish({ ok: false, answer, sessionId, progress, error: `codex exec exited ${exitCode}.${hint} output tail: ${stdoutTail.trim().slice(-400)}` })
      }
    })
  })
}

