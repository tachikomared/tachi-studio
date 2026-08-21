// packages/core/src/tachi/safety.ts
//
// Auto-safe shell-command classifier for the TACHI harness. Decides whether a
// command the model wants to run is provably read-only (no filesystem writes,
// no process spawning, no network) and can therefore be auto-approved without a
// human-in-the-loop confirmation.
//
// This PORTS the design of OpenAI Codex's safe-command classifier
// (codex-rs/shell-command/src/command_safety/is_safe_command.rs — Apache-2.0,
// ideas portable): a conservative allow-list of read-only base commands plus
// argument-aware exceptions for the few that CAN mutate (find/rg/grep/git/sed),
// and a pipeline rule that a composite is safe iff EVERY segment is safe and
// only side-effect-free operators (| && || ;) join them.
//
// Anything we cannot PROVE safe is reported unsafe with a human-readable reason.
// Pure TypeScript — no I/O, no spawning; it only inspects the command string.

import type { CommandSafety } from './contract.js'

const SAFE = (): CommandSafety => ({ safe: true })
const UNSAFE = (reason: string): CommandSafety => ({ safe: false, reason })

// Base commands that are read-only with no dangerous default behaviour. The
// argument-aware ones (find/rg/grep/git/sed) are listed too but get extra
// scrutiny in `classifySegment`.
const SAFE_BASE = new Set([
  'cat', 'cd', 'echo', 'grep', 'head', 'ls', 'nl', 'pwd', 'rg', 'sed', 'tail',
  'tr', 'true', 'false', 'wc', 'which', 'whoami', 'uniq', 'sort', 'cut', 'find',
  'git',
])

// `find` options that can execute commands, delete, or write to files.
const UNSAFE_FIND_OPTIONS = new Set([
  '-exec', '-execdir', '-ok', '-okdir', '-delete',
  '-fls', '-fprint', '-fprint0', '-fprintf',
])

// ripgrep/grep options that take a value and run an external command.
const UNSAFE_GREP_OPTIONS_WITH_ARGS = ['--pre', '--hostname-bin']
// ripgrep/grep value-less options that shell out to decompression tools.
const UNSAFE_GREP_OPTIONS_WITHOUT_ARGS = new Set(['--search-zip', '-z'])

// git subcommands that only read repository state.
const READ_ONLY_GIT_SUBCOMMANDS = new Set(['status', 'log', 'diff', 'show', 'branch'])

// `git branch` flags that are read-only (listing / current). Anything else
// (a positional, -d/-m, etc.) can create/rename/delete a branch.
const READ_ONLY_GIT_BRANCH_FLAGS = new Set([
  '--list', '-l', '--show-current', '-a', '--all', '-r', '--remotes',
  '-v', '-vv', '--verbose',
])

/**
 * Classify a shell command string as auto-safe (read-only) or not.
 *
 * Strategy:
 *  1. Scan the raw string once, honouring single/double quotes, to (a) reject
 *     any unquoted side-effecting construct — redirection (> >> <), command
 *     substitution ($(...) / backticks), background (&), subshell parens — and
 *     (b) split it into pipeline segments on the safe operators | && || ;.
 *  2. Tokenise each segment (quote-aware) into an argv.
 *  3. A command is safe iff every segment is non-empty and individually safe.
 */
export function classifyCommand(command: string): CommandSafety {
  if (command.trim().length === 0) return UNSAFE('empty command')

  const scan = scanPipeline(command)
  if (!scan.ok) return UNSAFE(scan.reason)
  if (scan.segments.length === 0) return UNSAFE('empty command')

  for (const segment of scan.segments) {
    if (segment.length === 0) return UNSAFE('empty pipeline segment')
    const verdict = classifySegment(segment)
    if (!verdict.safe) return verdict
  }
  return SAFE()
}

interface ScanResult {
  ok: true
  /** Each segment is the already-tokenised argv between safe operators. */
  segments: string[][]
}
interface ScanFail { ok: false; reason: string }

/**
 * Single-pass scanner: walks the raw command honouring quotes, rejects any
 * unsafe shell construct, and otherwise produces tokenised argv segments split
 * on the side-effect-free operators (| && || ;). Inside quotes, every
 * metacharacter is literal data and is appended to the current token.
 */
function scanPipeline(command: string): ScanResult | ScanFail {
  const segments: string[][] = []
  let current: string[] = []
  let token = ''
  let tokenStarted = false // distinguishes "" (a real empty arg) from no token

  const pushToken = () => {
    if (tokenStarted) {
      current.push(token)
      token = ''
      tokenStarted = false
    }
  }
  const pushSegment = () => {
    pushToken()
    segments.push(current)
    current = []
  }

  let i = 0
  const n = command.length
  while (i < n) {
    const c = command[i]

    // Quoted spans: copy verbatim, metacharacters become literal.
    if (c === '\'' || c === '"') {
      const quote = c
      tokenStarted = true
      i++
      let closed = false
      while (i < n) {
        const q = command[i]
        // Backslash escapes the next char inside double quotes only (POSIX-ish).
        if (q === '\\' && quote === '"' && i + 1 < n) {
          token += command[i + 1]
          i += 2
          continue
        }
        if (q === quote) {
          closed = true
          i++
          break
        }
        token += q
        i++
      }
      if (!closed) return { ok: false, reason: `unbalanced ${quote === '\'' ? 'single' : 'double'} quote` }
      continue
    }

    // Backslash escape outside quotes: take the next char literally.
    if (c === '\\') {
      if (i + 1 < n) {
        token += command[i + 1]
        tokenStarted = true
        i += 2
        continue
      }
      // trailing backslash — treat as literal, harmless
      token += c
      tokenStarted = true
      i++
      continue
    }

    // Whitespace separates tokens.
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      pushToken()
      i++
      continue
    }

    // ── Forbidden side-effecting constructs (unquoted) ──────────────────────
    if (c === '>' || c === '<') {
      return { ok: false, reason: 'redirection is not auto-safe' }
    }
    if (c === '`') {
      return { ok: false, reason: 'command substitution (backticks) is not auto-safe' }
    }
    if (c === '$' && command[i + 1] === '(') {
      return { ok: false, reason: 'command substitution $(...) is not auto-safe' }
    }
    if (c === '(' || c === ')') {
      return { ok: false, reason: 'subshell / grouping is not auto-safe' }
    }

    // ── Operators ───────────────────────────────────────────────────────────
    if (c === '|') {
      // `||` and `|` both split segments; reject `|&` (stderr pipe).
      if (command[i + 1] === '&') return { ok: false, reason: 'pipe-to-stderr (|&) is not auto-safe' }
      pushSegment()
      i += command[i + 1] === '|' ? 2 : 1
      continue
    }
    if (c === '&') {
      // `&&` splits segments; a lone `&` is backgrounding.
      if (command[i + 1] === '&') {
        pushSegment()
        i += 2
        continue
      }
      return { ok: false, reason: 'background execution (&) is not auto-safe' }
    }
    if (c === ';') {
      pushSegment()
      i++
      continue
    }

    // Ordinary character — part of the current token.
    token += c
    tokenStarted = true
    i++
  }

  pushSegment()

  // Drop trailing empty segment produced by a command ending in an operator,
  // BUT only the final one — interior empties (e.g. `ls |`) must stay so the
  // caller reports "empty pipeline segment". We detect the genuine trailing
  // case by checking whether the raw command ends with an operator.
  // Simpler: never auto-drop; an empty segment anywhere is unsafe and that is
  // the correct, conservative behaviour.
  return { ok: true, segments }
}

/** Classify one already-tokenised command segment (no operators inside). */
function classifySegment(argv: string[]): CommandSafety {
  const cmd = argv[0]
  if (cmd === undefined) return UNSAFE('empty pipeline segment')

  const base = baseName(cmd)
  if (!SAFE_BASE.has(base)) {
    return UNSAFE(`${cmd} is not on the auto-safe allow-list`)
  }

  switch (base) {
    case 'find':
      return classifyFind(argv)
    case 'rg':
    case 'grep':
      return classifyGrep(argv)
    case 'git':
      return classifyGit(argv)
    case 'sed':
      return classifySed(argv)
    default:
      // Plain read-only base command — safe regardless of its (benign) args.
      return SAFE()
  }
}

/** `find` is safe unless it carries an exec/delete/write option. */
function classifyFind(argv: string[]): CommandSafety {
  for (const arg of argv.slice(1)) {
    if (UNSAFE_FIND_OPTIONS.has(arg)) {
      return UNSAFE(`find ${arg} can modify the filesystem or execute commands`)
    }
  }
  return SAFE()
}

/** rg/grep are safe unless they shell out (--pre/--hostname-bin) or unzip (-z). */
function classifyGrep(argv: string[]): CommandSafety {
  for (const arg of argv.slice(1)) {
    if (UNSAFE_GREP_OPTIONS_WITHOUT_ARGS.has(arg)) {
      return UNSAFE(`${argv[0]} ${arg} shells out to a decompression tool`)
    }
    for (const opt of UNSAFE_GREP_OPTIONS_WITH_ARGS) {
      if (arg === opt || arg.startsWith(`${opt}=`)) {
        return UNSAFE(`${argv[0]} ${opt} executes an external command`)
      }
    }
  }
  return SAFE()
}

/**
 * git is safe ONLY for read-only subcommands (status/log/diff/show, and branch
 * when used to list). The first non-option token is the subcommand; we reject
 * any global option before it (those can rewrite config/paths) to stay
 * conservative.
 */
function classifyGit(argv: string[]): CommandSafety {
  let idx = -1
  let subcommand: string | undefined
  for (let k = 1; k < argv.length; k++) {
    const a = argv[k]
    if (a.startsWith('-')) {
      // A global option before the subcommand — Codex treats several of these
      // as unsafe (-C, -c, --git-dir, --paginate, ...). We stay strict and
      // reject ANY global option preceding the subcommand.
      return UNSAFE(`git global option ${a} before a subcommand is not auto-safe`)
    }
    idx = k
    subcommand = a
    break
  }
  if (subcommand === undefined) return UNSAFE('git with no subcommand is not auto-safe')
  if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
    return UNSAFE(`git ${subcommand} is not a read-only subcommand`)
  }

  const subArgs = argv.slice(idx + 1)

  // --output / --ext-diff / --textconv / --exec can write files or run programs
  // even on otherwise-read subcommands.
  for (const a of subArgs) {
    if (
      a === '--output' || a.startsWith('--output=') ||
      a === '--ext-diff' || a === '--textconv' ||
      a === '--exec' || a.startsWith('--exec=')
    ) {
      return UNSAFE(`git ${subcommand} ${a} can write files or run a program`)
    }
  }

  if (subcommand === 'branch') {
    if (subArgs.length === 0) return SAFE() // bare `git branch` lists branches
    let sawReadFlag = false
    for (const a of subArgs) {
      if (READ_ONLY_GIT_BRANCH_FLAGS.has(a) || a.startsWith('--format=')) {
        sawReadFlag = true
        continue
      }
      // Any other flag/positional may create/rename/delete a branch.
      return UNSAFE(`git branch ${a} may create, rename, or delete a branch`)
    }
    return sawReadFlag ? SAFE() : UNSAFE('git branch with these arguments is not provably read-only')
  }

  return SAFE()
}

/**
 * sed is safe only for the read pattern `sed -n {N|M,N}p [file]` — i.e. print
 * selected lines. In-place editing (`-i`) and any other script are unsafe.
 */
function classifySed(argv: string[]): CommandSafety {
  // Reject in-place editing explicitly (covers -i and -i.bak / -iSUFFIX).
  if (argv.some((a) => a === '-i' || a.startsWith('-i'))) {
    return UNSAFE('sed -i edits files in place')
  }
  if (argv[1] !== '-n' || !isValidSedNArg(argv[2])) {
    return UNSAFE('sed is only auto-safe as `sed -n <line>p` (print selected lines)')
  }
  // Allow an optional single file argument after the line spec.
  if (argv.length > 4) {
    return UNSAFE('sed with extra arguments is not provably read-only')
  }
  return SAFE()
}

/** True iff `arg` matches /^(\d+,)?\d+p$/ (e.g. "10p" or "1,5p"). */
function isValidSedNArg(arg: string | undefined): boolean {
  if (arg === undefined) return false
  if (!arg.endsWith('p')) return false
  const core = arg.slice(0, -1)
  const parts = core.split(',')
  if (parts.length === 1) {
    return parts[0].length > 0 && /^\d+$/.test(parts[0])
  }
  if (parts.length === 2) {
    return parts[0].length > 0 && parts[1].length > 0 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])
  }
  return false
}

/**
 * Reduce a command token to its lookup key: strip any directory prefix and a
 * trailing `.exe` (Windows) so `/usr/bin/git` and `git.exe` resolve to `git`.
 */
function baseName(cmd: string): string {
  let b = cmd
  const slash = Math.max(b.lastIndexOf('/'), b.lastIndexOf('\\'))
  if (slash >= 0) b = b.slice(slash + 1)
  if (b.toLowerCase().endsWith('.exe')) b = b.slice(0, -4)
  return b
}
