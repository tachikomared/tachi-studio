// apps/desktop/electron/services/destructive-commands.ts
//
// PURE denylist of catastrophic / irreversible / exfil-exec shell commands, used
// to HARD-DENY shell calls on the UNATTENDED agent paths (swarm-executor,
// approve-plan) where no human is in the loop to confirm.
//
// WHY (audit 2026-06-12, dimension 6 / HIGH): bash is an arbitrary unsandboxed
// shell and the unattended gates only checked network egress. True confinement
// needs OS-level isolation (out of scope); this is DEFENSE-IN-DEPTH — it blocks
// the obvious disasters (rm -rf /, dd, fork bombs, curl|sh, force-push) while
// still letting an autonomous worker do normal work (build/test/commit, scoped
// cleanup like `rm -rf node_modules`). A denylist is inherently incomplete; pair
// it with the private-mode egress denylist and never treat it as a sandbox.

export interface DestructiveVerdict {
  destructive: boolean
  reason?: string
}

// Unconditional catastrophic patterns (matched anywhere in the command line).
const UNCONDITIONAL: { re: RegExp; reason: string }[] = [
  { re: /\bdd\s+if=/i,                          reason: 'dd can overwrite raw devices' },
  { re: /\bmkfs(\.\w+)?\b/i,                     reason: 'mkfs formats a filesystem' },
  { re: /\bformat\s+[a-z]:/i,                    reason: 'format wipes a drive' },
  { re: /\b(diskpart|fdisk)\b/i,                 reason: 'partition table manipulation' },
  { re: /\b(Clear-Disk|Format-Volume)\b/i,       reason: 'wipes/formats a volume' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i,  reason: 'changes system power state' },
  { re: /\b(Stop-Computer|Restart-Computer)\b/i, reason: 'changes system power state' },
  { re: /(^|\s)sudo\s/i,                         reason: 'privilege escalation (sudo)' },
  { re: /\brunas\b/i,                            reason: 'privilege escalation (runas)' },
  { re: /:\(\)\s*\{.*:\s*\|\s*:/,                reason: 'fork bomb' },
  { re: /\|\s*(sh|bash|zsh|iex|Invoke-Expression)\b/i, reason: 'pipes output into a shell/evaluator (exfil-exec)' },
  { re: /\bInvoke-Expression\b/i,                reason: 'evaluates arbitrary code (iex)' },
  { re: /\bchmod\s+(-R\s+)?[0-7]?7{3}\s+(\/|~|\$HOME)/i, reason: 'world-writable permissions on a root/home path' },
  { re: /\bgit\s+push\b.*(\s-f(\s|$)|--force)/i, reason: 'force push (irreversible remote rewrite)' },
]

// Targets that make a recursive delete catastrophic.
const DANGEROUS_LITERAL = new Set(['/', '/*', '~', '~/', '.', './', '..', '../', '*', '$HOME', '$home'])

function stripQuotes(t: string): string {
  return t.replace(/^['"]|['"]$/g, '').trim()
}

function isDangerousTarget(raw: string): boolean {
  const x = stripQuotes(raw)
  if (!x) return false
  if (DANGEROUS_LITERAL.has(x)) return true
  if (/^[a-z]:[\\/]?\*?$/i.test(x)) return true   // drive root: C:  C:\  C:\*  C:/
  if (/^[a-z]:[\\/]/i.test(x)) return true         // absolute windows path
  if (x.startsWith('/')) return true               // absolute unix path
  if (x.startsWith('~')) return true               // home
  if (x.startsWith('..')) return true              // escapes the cwd
  return false
}

function baseName(cmd: string): string {
  let b = cmd
  const slash = Math.max(b.lastIndexOf('/'), b.lastIndexOf('\\'))
  if (slash >= 0) b = b.slice(slash + 1)
  if (b.toLowerCase().endsWith('.exe')) b = b.slice(0, -4)
  return b.toLowerCase()
}

const RM_NAMES = new Set(['rm'])
const WIN_DELETE_NAMES = new Set(['remove-item', 'ri', 'rmdir', 'rd', 'del', 'erase'])

/** Is a token a flag/switch (not a target) for a delete command? */
function isDeleteFlag(t: string): boolean {
  return /^-/.test(t) || /^\/[a-z]$/i.test(t) // -rf / --force / /s / /q / /f
}

/** Recursive-flag detection for unix rm and windows delete commands. */
function hasRecursiveFlag(tokens: string[]): boolean {
  return tokens.some(t =>
    t === '--recursive' ||
    /^-{1}[a-z]*r[a-z]*$/i.test(t) ||  // -r, -rf, -fr, -Rf …
    /^\/s$/i.test(t) ||                // windows /s
    /^-recurse$/i.test(t),             // PowerShell -Recurse
  )
}

function checkRecursiveDelete(segment: string): DestructiveVerdict | null {
  const tokens = segment.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  const base = baseName(tokens[0])
  const isUnixRm = RM_NAMES.has(base)
  const isWinDel = WIN_DELETE_NAMES.has(base)
  if (!isUnixRm && !isWinDel) return null
  if (!hasRecursiveFlag(tokens.slice(1))) return null
  const targets = tokens.slice(1).filter(t => !isDeleteFlag(t))
  for (const t of targets) {
    if (isDangerousTarget(t)) {
      return { destructive: true, reason: `recursive delete of "${stripQuotes(t)}" (root/home/cwd/absolute)` }
    }
  }
  return null
}

/** Split on shell separators so each segment is checked independently. */
function segments(command: string): string[] {
  return command.split(/[;&|]+/).map(s => s.trim()).filter(Boolean)
}

/**
 * Classify a shell command as destructive (must be hard-denied on unattended
 * paths) or not. Conservative on catastrophes, permissive on normal work.
 */
export function isDestructiveCommand(command: string): DestructiveVerdict {
  if (typeof command !== 'string' || command.trim() === '') {
    return { destructive: false }
  }
  for (const { re, reason } of UNCONDITIONAL) {
    if (re.test(command)) return { destructive: true, reason }
  }
  for (const seg of segments(command)) {
    const rd = checkRecursiveDelete(seg)
    if (rd) return rd
  }
  return { destructive: false }
}
