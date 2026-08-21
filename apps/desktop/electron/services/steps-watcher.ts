// apps/desktop/electron/services/steps-watcher.ts
//
// Port of parallel-code's `electron/ipc/steps.ts` — a per-worktree watcher
// for a JSON array file at `<worktree>/.claude/steps.json`. The agent
// running inside the worktree appends step entries; we tail the file and
// broadcast each new entry to the renderer.
//
// Key design choices (mirrored from the source):
//   - Use raw `fs.watch` rather than chokidar — adding chokidar to satisfy
//     a single watcher would balloon the install footprint. `fs.watch` is
//     unreliable across platforms for individual files but works well when
//     pointed at a *directory*.
//   - Debounce file-changed events at 200ms so a burst of writes from the
//     agent (which often writes whole-file replacement) collapses into one
//     read.
//   - If `.claude/` doesn't exist yet (very first run before the agent has
//     started), watch the worktree root and re-arm once the dir appears.
//   - Stamp `timestamp` on entries that don't carry one — agents are not
//     guaranteed to set it.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  watch as fsWatch,
  type FSWatcher,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { EventEmitter } from 'node:events'

const DEBOUNCE_MS = 200

export interface StepEntry {
  /** Stable id (caller-supplied or auto-generated). */
  id?:        string
  /** When the step was emitted. Stamped by us if missing. */
  timestamp?: number
  /** Free-form payload — surfaced to the renderer as-is. */
  [key: string]: unknown
}

export interface StepsWatcherEvents {
  /** Emitted with the full current array on every refresh (debounced). */
  steps:     (entries: StepEntry[]) => void
  /** Emitted exactly once per NEW entry seen since last emit. */
  step:      (entry: StepEntry) => void
  /** Emitted on watcher setup failure. Non-fatal — watcher keeps trying. */
  error:     (err: Error) => void
}

export interface StepsWatcher {
  /** Stop watching and tear down listeners. */
  stop(): void
  /** Force an immediate re-read of the file. */
  refresh(): void
  on<E extends keyof StepsWatcherEvents>(event: E, cb: StepsWatcherEvents[E]): void
  off<E extends keyof StepsWatcherEvents>(event: E, cb: StepsWatcherEvents[E]): void
}

/**
 * Watch `<worktreePath>/.claude/steps.json`. Resolves immediately with a
 * handle; events fire asynchronously. Never throws — surface watcher
 * failures via the 'error' event so callers can keep operating.
 */
export function startStepsWatcher(worktreePath: string): StepsWatcher {
  const emitter = new EventEmitter()
  const claudeDir = join(worktreePath, '.claude')
  const stepsFile = join(claudeDir, 'steps.json')

  let debounceTimer: NodeJS.Timeout | null = null
  let dirWatcher: FSWatcher | null = null
  let rootWatcher: FSWatcher | null = null
  let lastSeenIds = new Set<string>()
  let lastEntries: StepEntry[] = []
  let stopped = false

  function readAndEmit(): void {
    if (stopped) return
    if (!existsSync(stepsFile)) {
      // File hasn't been created yet; nothing to read. Don't emit empty
      // arrays repeatedly — wait for the file to appear.
      return
    }
    let raw: string
    try {
      raw = readFileSync(stepsFile, 'utf8')
    } catch (err) {
      emitter.emit('error', err)
      return
    }
    if (!raw.trim()) return
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      // The agent might be mid-write — partial JSON is normal. We'll see
      // the completed file on the next tick.
      return
    }
    if (!Array.isArray(parsed)) {
      emitter.emit('error', new Error(`steps.json is not an array: ${typeof parsed}`))
      return
    }

    // Normalise: ensure every entry has a timestamp; ensure every entry has
    // an id (falling back to a deterministic-ish hash of its index + ts).
    const now = Date.now()
    const normalised: StepEntry[] = []
    const seen = new Set<string>()
    const fresh: StepEntry[] = []

    for (let i = 0; i < parsed.length; i++) {
      const entry = parsed[i] as StepEntry
      if (entry === null || typeof entry !== 'object') continue
      const ts = typeof entry.timestamp === 'number' ? entry.timestamp : now
      const id = typeof entry.id === 'string' && entry.id ? entry.id : `auto-${i}-${ts}`
      const out: StepEntry = { ...entry, id, timestamp: ts }
      normalised.push(out)
      seen.add(id)
      if (!lastSeenIds.has(id)) fresh.push(out)
    }

    lastEntries = normalised
    lastSeenIds = seen

    emitter.emit('steps', normalised)
    for (const f of fresh) emitter.emit('step', f)
  }

  function scheduleRead(): void {
    if (stopped) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      readAndEmit()
    }, DEBOUNCE_MS)
  }

  function armDirWatcher(): void {
    if (stopped) return
    if (!existsSync(claudeDir)) {
      // Not yet — watch the worktree root for `.claude/` to appear.
      armRootWatcher()
      return
    }
    try {
      dirWatcher = fsWatch(claudeDir, { persistent: false }, (_event, filename) => {
        // Only react when steps.json itself moved.
        if (filename === 'steps.json' || filename === null) {
          scheduleRead()
        }
      })
      dirWatcher.on('error', (err) => emitter.emit('error', err))
      // Read once immediately in case the file already has content.
      readAndEmit()
    } catch (err) {
      emitter.emit('error', err as Error)
      // Retry after a short delay — the dir may have just been created
      // and the kernel hadn't published an inotify watch slot yet.
      setTimeout(armRootWatcher, 500)
    }
  }

  function armRootWatcher(): void {
    if (stopped) return
    if (!existsSync(worktreePath)) {
      // Worktree itself is gone — nothing to do. Caller will stop() us shortly.
      return
    }
    try {
      rootWatcher = fsWatch(worktreePath, { persistent: false }, (_event, filename) => {
        if (filename === '.claude') {
          // Dir appeared — tear down root watcher, arm the dir watcher.
          if (rootWatcher) {
            rootWatcher.close()
            rootWatcher = null
          }
          armDirWatcher()
        }
      })
      rootWatcher.on('error', (err) => emitter.emit('error', err))
    } catch (err) {
      emitter.emit('error', err as Error)
    }
  }

  // Kick things off on a microtask boundary so the caller has a chance to
  // attach listeners before the first emit fires.
  setImmediate(() => {
    armDirWatcher()
  })

  return {
    stop(): void {
      stopped = true
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      if (dirWatcher) {
        try { dirWatcher.close() } catch { /* ignore */ }
        dirWatcher = null
      }
      if (rootWatcher) {
        try { rootWatcher.close() } catch { /* ignore */ }
        rootWatcher = null
      }
      emitter.removeAllListeners()
    },
    refresh(): void {
      readAndEmit()
    },
    on(event, cb): void {
      emitter.on(event as string, cb as (...args: unknown[]) => void)
    },
    off(event, cb): void {
      emitter.off(event as string, cb as (...args: unknown[]) => void)
    },
  }
}

/**
 * Quick helper used by manager to seed an empty steps file when desired so
 * watchers see something immediately. Used in tests; production code can
 * leave it alone (the agent will create the file on its first write).
 */
export function ensureStepsFileExists(worktreePath: string): string {
  const claudeDir = join(worktreePath, '.claude')
  const stepsFile = join(claudeDir, 'steps.json')
  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true })
  if (!existsSync(stepsFile)) {
    writeFileSync(stepsFile, '[]', 'utf8')
  }
  return stepsFile
}

// Keep dirname imported (used implicitly by future helpers, suppress unused
// import linting).
void dirname
