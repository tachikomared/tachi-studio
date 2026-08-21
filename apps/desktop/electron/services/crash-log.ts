// apps/desktop/electron/services/crash-log.ts
//
// Crash telemetry — the app fully exited twice under automation with ZERO
// evidence (no dump, no log). This module instruments every process-death
// signal Electron 31 exposes so the NEXT crash leaves a trail:
//
//   app 'render-process-gone'    — renderer crashed/killed/oom (+ which URL)
//   app 'child-process-gone'     — GPU / utility / any child process died
//   webContents 'unresponsive'   — renderer hang breadcrumb (+ 'responsive')
//   process 'uncaughtExceptionMonitor' — observes MAIN fatals WITHOUT
//                                  overriding Electron's default fatal path
//                                  (i.e. "log then rethrow" semantics for free)
//   process 'unhandledRejection' — log-and-continue (mirrors the default
//                                  Electron-main behavior of warn-and-keep-going,
//                                  just durably)
//   app 'before-quit'            — clean-shutdown breadcrumb with uptime, so a
//                                  crash.jsonl that ends WITHOUT one = hard death
//
// Sink: JSON-lines appended to <userData>/logs/crash.jsonl (same logs/ dir as
// log-service's daily files), rotated at 1 MB keeping exactly one crash.jsonl.old.
// Contract: logging can NEVER throw into the app — every entry point is
// try/catch-wrapped, writes are best-effort, and console.error mirrors every
// entry so the trail also lands in the terminal / CI capture.
//
// Electron is imported TYPE-ONLY: the pure helpers (entry format, safe
// stringify, rotation) stay unit-testable under plain-node vitest; main.ts
// injects the real `app` via installCrashTelemetry().

import { appendFileSync, statSync, renameSync, rmSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { App, WebContents } from 'electron'

export type CrashKind =
  | 'render-process-gone'
  | 'child-process-gone'
  | 'unresponsive'
  | 'responsive'
  | 'uncaught-exception'
  | 'unhandled-rejection'
  | 'before-quit'

export interface CrashLogEntry {
  /** ISO-8601 timestamp. */
  ts: string
  kind: CrashKind
  pid: number
  /** Main-process uptime in whole seconds at the moment of the event. */
  uptimeS: number
  detail: Record<string, unknown>
}

export const CRASH_LOG_FILENAME = 'crash.jsonl'
export const CRASH_LOG_OLD_SUFFIX = '.old'
export const CRASH_LOG_MAX_BYTES = 1024 * 1024 // rotate at 1 MB

// ── Pure helpers (unit-tested in test/unit/crashLog.test.ts) ────────────────

export function makeCrashEntry(
  kind: CrashKind,
  detail: Record<string, unknown>,
  meta: { now?: Date; pid?: number; uptimeS?: number } = {},
): CrashLogEntry {
  return {
    ts: (meta.now ?? new Date()).toISOString(),
    kind,
    pid: meta.pid ?? process.pid,
    uptimeS: meta.uptimeS ?? Math.round(process.uptime()),
    detail,
  }
}

/**
 * JSON.stringify replacer that survives everything a crash detail can carry:
 * Error objects (→ {name,message,stack}), circular references (→ '[circular]'),
 * bigints and functions (JSON.stringify would throw / drop them).
 */
function safeReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>()
  return (_key, value) => {
    if (typeof value === 'bigint') return `${value}n`
    if (typeof value === 'function') return '[function]'
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack }
    }
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[circular]'
      seen.add(value)
    }
    return value
  }
}

/**
 * One JSON line (with trailing '\n') for the entry. NEVER throws: anything
 * unserializable (e.g. a detail getter that throws mid-stringify) degrades to
 * a fallback line that still records the kind + a fresh timestamp.
 */
export function formatCrashLine(entry: CrashLogEntry): string {
  try {
    return JSON.stringify(entry, safeReplacer()) + '\n'
  } catch {
    const kind = typeof entry?.kind === 'string' ? entry.kind : 'unknown'
    return (
      JSON.stringify({
        ts: new Date().toISOString(),
        kind,
        pid: typeof entry?.pid === 'number' ? entry.pid : 0,
        uptimeS: 0,
        detail: { note: 'entry was not serializable' },
      }) + '\n'
    )
  }
}

/** Rotation predicate: the CURRENT file size has reached the cap. */
export function shouldRotate(sizeBytes: number, maxBytes: number = CRASH_LOG_MAX_BYTES): boolean {
  return maxBytes > 0 && sizeBytes >= maxBytes
}

/**
 * Append one pre-formatted line to `filePath`, creating the parent directory
 * and rotating filePath → filePath.old first when the cap is reached (exactly
 * one .old generation is kept; Windows rename fails on an existing target so
 * the previous .old is dropped before the rename). Best-effort: never throws.
 */
export function appendCrashLine(
  filePath: string,
  line: string,
  maxBytes: number = CRASH_LOG_MAX_BYTES,
): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    let size = 0
    try {
      size = statSync(filePath).size
    } catch {
      size = 0 // no file yet
    }
    if (shouldRotate(size, maxBytes)) {
      rmSync(filePath + CRASH_LOG_OLD_SUFFIX, { force: true })
      renameSync(filePath, filePath + CRASH_LOG_OLD_SUFFIX)
    }
    appendFileSync(filePath, line, 'utf8')
  } catch {
    /* disk full / locked / bogus path — a crash log must never crash the app */
  }
}

// ── App wiring ───────────────────────────────────────────────────────────────

let crashLogPathProvider: (() => string) | null = null
let installed = false

/** Format + mirror + append one crash entry. Never throws. */
export function logCrash(kind: CrashKind, detail: Record<string, unknown>): void {
  try {
    const line = formatCrashLine(makeCrashEntry(kind, detail))
    try {
      console.error('[crash]', line.trimEnd())
    } catch {
      /* EPIPE on a dead stdout — keep going, the file write still matters */
    }
    if (crashLogPathProvider) {
      let path: string | null = null
      try {
        path = crashLogPathProvider()
      } catch {
        path = null
      }
      if (path) appendCrashLine(path, line)
    }
  } catch {
    /* logging can never throw into the app */
  }
}

function tryGetUrl(wc: WebContents): string {
  try {
    return wc.getURL()
  } catch {
    return '' // webContents may already be destroyed
  }
}

export interface CrashTelemetryOptions {
  app: App
  /** Usually () => app.getPath('userData') — injected so tests never touch electron. */
  getUserDataDir: () => string
}

/**
 * Register every app/process-level death signal. Call ONCE, as early as
 * possible in main (before app ready), so even startup crashes leave a trail.
 */
export function installCrashTelemetry(opts: CrashTelemetryOptions): void {
  if (installed) return
  installed = true
  crashLogPathProvider = () => join(opts.getUserDataDir(), 'logs', CRASH_LOG_FILENAME)

  const { app } = opts
  try {
    // A renderer died. reason: 'clean-exit' | 'abnormal-exit' | 'killed' |
    // 'crashed' | 'oom' | 'launch-failed' | 'integrity-failure'. We log ALL
    // reasons (even clean-exit) — the point is evidence, filtering can lie.
    app.on('render-process-gone', (_event, webContents, details) => {
      try {
        logCrash('render-process-gone', {
          reason: details.reason,
          exitCode: details.exitCode,
          url: tryGetUrl(webContents),
        })
      } catch {
        /* never throw back into Electron's emitter */
      }
    })

    // Any non-renderer child died: GPU / Utility / Zygote / Pepper Plugin /
    // Sandbox Helper. type:'GPU' here is how a GPU-process crash shows up.
    app.on('child-process-gone', (_event, details) => {
      try {
        logCrash('child-process-gone', {
          type: details.type,
          reason: details.reason,
          exitCode: details.exitCode,
          serviceName: details.serviceName,
          name: details.name,
        })
      } catch {
        /* ignore */
      }
    })

    // Clean-shutdown breadcrumb. A crash.jsonl whose last line is NOT a
    // before-quit is the signature of a hard process death.
    app.on('before-quit', () => {
      try {
        logCrash('before-quit', {})
      } catch {
        /* ignore */
      }
    })

    // Observes fatal main-process exceptions WITHOUT overriding the default
    // handler (unlike 'uncaughtException', the monitor hook doesn't mark the
    // exception handled) — Electron's fatal path still runs after we log.
    process.on('uncaughtExceptionMonitor', (err, origin) => {
      try {
        logCrash('uncaught-exception', { origin, error: err })
      } catch {
        /* ignore */
      }
    })

    // Electron main's default is warn-and-continue; we keep those semantics
    // but make the warning durable (registering the listener suppresses the
    // built-in console warning — logCrash's console.error mirror replaces it).
    process.on('unhandledRejection', (reason) => {
      try {
        logCrash('unhandled-rejection', { reason })
      } catch {
        /* ignore */
      }
    })
  } catch {
    /* telemetry is best-effort — never block startup */
  }
}

/**
 * Renderer hang/recovery breadcrumbs for one window. Called from createWindow
 * (needs a live webContents, so it can't live in installCrashTelemetry).
 */
export function watchWebContentsHealth(wc: WebContents, label: string): void {
  try {
    wc.on('unresponsive', () => {
      try {
        logCrash('unresponsive', { label, url: tryGetUrl(wc) })
      } catch {
        /* ignore */
      }
    })
    wc.on('responsive', () => {
      try {
        logCrash('responsive', { label, url: tryGetUrl(wc) })
      } catch {
        /* ignore */
      }
    })
  } catch {
    /* ignore */
  }
}
