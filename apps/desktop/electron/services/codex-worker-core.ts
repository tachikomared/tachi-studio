// apps/desktop/electron/services/codex-worker-core.ts
//
// PURE helpers for the Codex worker (no electron imports — unit-testable):
// building `codex exec` argv and mining the --json NDJSON event stream for
// the session id + a compact progress line. Kept schema-TOLERANT on purpose:
// codex's event shapes drift between releases, and we only need two facts
// (which session this is, roughly what it's doing) — the authoritative final
// answer comes from --output-last-message, not from event parsing.

/**
 * Result of one Codex task, shared by BOTH transports (exec-CLI and
 * app-server). Defined in this pure, electron-free module so both
 * codex-worker.ts and codex-app-server.ts can import it without a cycle.
 */
export interface CodexTaskResult {
  ok: boolean
  /** Final agent message (exec: --output-last-message; app-server: last agentMessage item). */
  answer: string
  /** Thread/session id for `resume_session` continuation, when one was reported. */
  sessionId?: string
  /** Compact progress lines (commands run, files touched) for the run log. */
  progress: string[]
  error?: string
}

export interface CodexExecArgs {
  task: string
  /** false/absent = sandbox read-only (analysis); true = workspace-write. */
  write?: boolean
  model?: string
  /** Session id from a prior run — continues that thread via `exec resume`. */
  resumeSessionId?: string
  /** File the CLI writes the final agent message into (-o). */
  lastMessageFile: string
}

/** argv for `codex <…>` (headless; `exec` never prompts in 0.144.x — the
 *  `--ask-for-approval` flag was REMOVED from exec and would break parsing,
 *  live-verified. The sandbox is the guard.)
 *  `exec resume` rejects `--sandbox` outright (clap error, live-verified) —
 *  there the sandbox rides in as a `-c sandbox_mode=<mode>` config override
 *  (bare value: invalid TOML falls back to a literal string per the CLI). */
export function buildExecArgs(a: CodexExecArgs): string[] {
  const args = ['exec']
  const sandbox = a.write ? 'workspace-write' : 'read-only'
  if (a.resumeSessionId) {
    args.push('resume', a.resumeSessionId, '-c', `sandbox_mode=${sandbox}`)
  } else {
    args.push('--sandbox', sandbox)
  }
  args.push(
    '--json',
    '--skip-git-repo-check',
    '--output-last-message', a.lastMessageFile,
  )
  if (a.model && a.model.trim()) args.push('--model', a.model.trim())
  // Prompt goes via STDIN ('-' placeholder): the task is arbitrary text —
  // stdin is quoting-free and dodges Windows argv length limits.
  args.push('-')
  return args
}

/**
 * Pull a session/thread id out of any --json event object, wherever the CLI
 * put it this release. Checked in likelihood order.
 */
export function extractSessionId(evt: unknown): string | null {
  if (!evt || typeof evt !== 'object') return null
  const o = evt as Record<string, unknown>
  const direct = o.session_id ?? o.thread_id ?? o.sessionId ?? o.threadId
  if (typeof direct === 'string' && direct) return direct
  for (const key of ['session', 'thread', 'msg', 'payload']) {
    const nested = o[key]
    if (nested && typeof nested === 'object') {
      const found = extractSessionId(nested)
      if (found) return found
    }
  }
  return null
}

/**
 * One short human line per event for the run log / progress UI, or null for
 * noise. Tolerant: unknown types are summarized by their `type` tag only.
 */
export function summarizeEvent(evt: unknown): string | null {
  if (!evt || typeof evt !== 'object') return null
  const o = evt as Record<string, unknown>
  const type = typeof o.type === 'string' ? o.type : ''
  if (!type) return null
  if (/delta/i.test(type)) return null // token noise
  const item = (o.item ?? o.msg ?? o.payload ?? {}) as Record<string, unknown>
  // Content-first: a command/path payload identifies the event regardless of
  // which type tag this CLI release wrapped it in.
  const cmd = item.command ?? o.command
  if (typeof cmd === 'string') return `$ ${cmd.slice(0, 120)}`
  if (Array.isArray(cmd)) return `$ ${cmd.join(' ').slice(0, 120)}`
  const path = item.path ?? o.path
  if (typeof path === 'string' && /file|patch|change/i.test(type)) return `edit ${path.slice(0, 120)}`
  if (/error/i.test(type)) {
    const msg = item.message ?? o.message ?? o.error
    return `error: ${String(msg ?? type).slice(0, 160)}`
  }
  return type
}

/** Parse one NDJSON line defensively. */
export function parseEventLine(line: string): unknown | null {
  const t = line.trim()
  if (!t.startsWith('{')) return null
  try { return JSON.parse(t) } catch { return null }
}
