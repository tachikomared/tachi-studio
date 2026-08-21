// apps/desktop/electron/services/tachi/verify-policy.ts
//
// VERIFY-AS-POLICY (harness item 5). Post-edit verification stops being opt-in:
// a run that MUTATED the workspace but registered NO success check still has to
// clear a deterministic gate before complete() is accepted. This module is the
// PURE, unit-tested core of that policy — no electron, no network, and (for the
// tested helpers) no fs — so loop.ts's complete() wiring stays a thin call site.
//
//   • isMutatingTool(name)          — which tools count as "changed the workspace"
//   • deriveDefaultCheck(pkg, pm)    — the derivation matrix (typecheck ▸ test ▸ null)
//   • deriveWorkspaceDefaultCheck    — the fs-reading convenience used by the loop
//   • isBareTrueCommand / isTrivialCheck — reject a registered check that can't falsify
//   • decideDerivedRefusal           — the "refuse N times, then allow UNVERIFIED" cap
//   • createVerifyCheck(deps)        — the gate→run wiring complete() calls
//
// Rationale (roadmap 2.1): complete()'s summary validation is cosmetic — it can
// reject "done"/"ok" but cannot tell whether the work is correct. A green
// deterministic check can. When the model does not register one, we derive the
// obvious one from the workspace's own package scripts and enforce it.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type PackageManager = 'pnpm' | 'yarn' | 'npm'

/** The slice of package.json this policy reads — only the npm scripts map. */
export interface MinimalPkg {
  scripts?: Record<string, string>
}

/**
 * write / edit / bash are the mutating tools: a SUCCEEDED call of one means the
 * run changed (or attempted to change) the workspace, so its completion earns a
 * deterministic check. Everything else (read / grep / glob, the code-graph
 * queries, the read-only advisors and meta tools) is side-effect-free.
 *
 * Note the caller must additionally gate on success — a mutator that ERRORED
 * still flows through here, but the loop only flips its `mutated` flag when the
 * tool result was not an error (brief: "any write/edit/bash tool succeeded").
 */
export function isMutatingTool(name: string): boolean {
  return name === 'write' || name === 'edit' || name === 'bash'
}

export interface DerivedCheck {
  /** The shell command complete() will run — must exit 0 to accept completion. */
  command: string
  /** Which package script backed it (for trace + UNVERIFIED-marker wording). */
  kind: 'typecheck' | 'test'
}

/**
 * The `test` invocation per package manager. `scripts.test` is already confirmed
 * present by the caller, so `--if-present` is a defensive no-op on the managers
 * that accept it (npm / pnpm) and is omitted for yarn classic, which treats an
 * unknown flag as a script argument rather than a run-guard.
 */
function testCommand(pm: PackageManager): string {
  return pm === 'yarn' ? 'yarn test' : `${pm} test --if-present`
}

/**
 * Derive the default success check from a workspace's package.json scripts and
 * its package manager — the derivation matrix at the heart of the policy:
 *
 *   scripts.typecheck present ▸ `<pm> run typecheck`   (fast, deterministic, covers edits)
 *   else scripts.test present ▸ `<pm> test --if-present` (broadest safety net)
 *   else                      ▸ null  → caller falls back to the verifyCompletion critic
 *
 * Pure: no fs, no side effects. `typecheck` wins over `test` because it is
 * cheaper and directly catches the class of breakage an edit most often causes.
 */
export function deriveDefaultCheck(pkg: MinimalPkg | null | undefined, pm: PackageManager): DerivedCheck | null {
  const scripts = pkg?.scripts
  if (!scripts || typeof scripts !== 'object') return null
  if (typeof scripts.typecheck === 'string' && scripts.typecheck.trim()) {
    return { command: `${pm} run typecheck`, kind: 'typecheck' }
  }
  if (typeof scripts.test === 'string' && scripts.test.trim()) {
    return { command: testCommand(pm), kind: 'test' }
  }
  return null
}

/**
 * fs-reading convenience over deriveDefaultCheck: reads <root>/package.json and
 * sniffs the package manager from the lockfile (mirroring agents-md-init's
 * detection). Returns null on any error or when nothing deterministic exists, so
 * a missing/broken package.json degrades to the critic rather than throwing into
 * the loop. Kept separate from the pure helper so the derivation matrix stays
 * unit-testable without touching disk.
 */
export function deriveWorkspaceDefaultCheck(workspaceRoot: string): DerivedCheck | null {
  try {
    const pkgPath = join(workspaceRoot, 'package.json')
    if (!existsSync(pkgPath)) return null
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as MinimalPkg
    const pm: PackageManager = existsSync(join(workspaceRoot, 'pnpm-lock.yaml'))
      ? 'pnpm'
      : existsSync(join(workspaceRoot, 'yarn.lock'))
        ? 'yarn'
        : 'npm'
    return deriveDefaultCheck(pkg, pm)
  } catch {
    return null
  }
}

/**
 * A "bare true" command does no real work — it exits 0 no matter what the agent
 * did, so it can never falsify a completion. Detects the echo / true / `:` /
 * `exit 0` class (roadmap 2.1's trivially-true-check risk). Conservative by
 * design: a command is bare-true only when EVERY chained segment is a no-op, so
 * a real check (`pnpm typecheck`, `vitest run x`, `test -f y`) is never
 * misclassified. Chains/pipes are split so `echo hi && true` is caught but
 * `echo building && vitest run` is not.
 */
export function isBareTrueCommand(command: string): boolean {
  const c = (command ?? '').trim()
  if (!c) return true
  const segments = c.split(/&&|\|\||;|\|/).map(s => s.trim()).filter(Boolean)
  if (segments.length === 0) return true
  return segments.every(isNoOpSegment)
}

function isNoOpSegment(seg: string): boolean {
  const s = seg.toLowerCase()
  if (s === 'true' || s === ':') return true
  if (/^exit\s+0$/.test(s)) return true
  if (/^echo(\s|$)/.test(s)) return true   // echo prints and exits 0 regardless of args
  if (/^printf(\s|$)/.test(s)) return true
  return false
}

/**
 * Reject a registered success check that cannot prove anything: it is a bare
 * echo/true no-op AND it references none of the paths/symbols this run has
 * touched. BOTH conditions are required (brief) — a command that does real work,
 * or one that at least names changed work, is always accepted.
 *
 * `changedPaths` is frequently EMPTY at registration time (the tool is meant to
 * be set before editing), in which case the "references reality" escape hatch is
 * unavailable and the decision reduces to the bare-true test — which is exactly
 * the intent: block `echo ok` / `true` up front, accept anything substantive.
 */
export function isTrivialCheck(command: string, changedPaths: readonly string[] = []): boolean {
  if (!isBareTrueCommand(command)) return false      // does real work → not trivial
  return !mentionsAnyPath(command, changedPaths)      // no-op AND names nothing real → trivial
}

/** True when `command` textually references any of `paths` (full path or a
 *  meaningful basename), normalising Windows separators + case. */
function mentionsAnyPath(command: string, paths: readonly string[]): boolean {
  if (paths.length === 0) return false
  const c = command.replace(/\\/g, '/').toLowerCase()
  return paths.some(p => {
    const norm = p.replace(/\\/g, '/').toLowerCase().trim()
    if (!norm) return false
    if (c.includes(norm)) return true
    const base = norm.split('/').pop() ?? norm
    return base.length >= 3 && c.includes(base)
  })
}

export interface RefusalDecision {
  /** true → block completion and inject the (compacted) check output as the tool result. */
  refuse: boolean
  /** true → completion is allowed but the run is NOT verified — emit the loud UNVERIFIED marker. */
  unverified: boolean
}

/**
 * Decide what a FAILED derived check should do, given how many times completion
 * has already been refused for a failing derived check THIS run. Refuse up to
 * `cap` times (default 2) so the model gets room to fix and retry; after the cap
 * stop deadlocking — allow completion but flag it UNVERIFIED so the UI/user sees
 * the check never went green (a stuck check must not burn the run to its ceiling).
 */
export function decideDerivedRefusal(priorRefusals: number, cap = 2): RefusalDecision {
  if (priorRefusals < cap) return { refuse: true, unverified: false }
  return { refuse: false, unverified: true }
}

// ── The verify-gate wiring ────────────────────────────────────────────────────

/** What complete() gets back from a verification attempt. */
export interface VerifyCheckResult {
  /** The command ran AND exited 0. */
  ok: boolean
  /** Output (or the denial's own reason, when it never ran). */
  output: string
  /** false → the check could NOT execute (gate denial / thrown runner). */
  ran: boolean
}

export interface VerifyCheckDeps {
  /**
   * The SAME pre-execution permission gate the agent's own tool calls use. It
   * may block on a human — which is precisely why every gate implementation is
   * registry-backed (services/pending-permissions.ts): an unanswered prompt
   * DENIES after the timeout, and a stopped run denies immediately, so a verify
   * check can never park the run forever waiting for a card nobody can see.
   *
   * A returned STRING is a denial that carries its own reason (timed out / run
   * stopped) and is surfaced verbatim — it explains itself better than a
   * generic line, and it must not read as "the user declined".
   */
  gate: (name: string, args: Record<string, unknown>) => Promise<boolean | string>
  /** Run the command. Only reached after an exact `true` from the gate. */
  exec: (command: string) => Promise<{ isError: boolean; output: string }>
}

/**
 * Build the `verifyCheck` complete() calls for a registered or derived success
 * check: gate first (fail-closed — only an exact `true` runs anything), then run.
 *
 * Extracted from runTachiSession so this — the exact path the derived
 * `pnpm run typecheck` check takes, and the one a live /loop run got stuck on —
 * is unit-testable against a real PendingPermissionRegistry with fake timers.
 * Never throws: a failing runner degrades to `ran:false`, which complete()
 * treats as "couldn't verify" rather than deadlocking on it.
 */
export function createVerifyCheck(deps: VerifyCheckDeps): (command: string) => Promise<VerifyCheckResult> {
  return async (command: string): Promise<VerifyCheckResult> => {
    try {
      const allowed = await deps.gate('bash', { command })
      if (allowed !== true) {
        return {
          ok: false, ran: false,
          output: typeof allowed === 'string' && allowed.trim()
            ? allowed
            : 'the success-check command was not permitted (e.g. plan mode) — completion proceeds without it.',
        }
      }
      const res = await deps.exec(command)
      return { ok: !res.isError, ran: true, output: res.output }
    } catch (e) {
      return { ok: false, ran: false, output: `success check could not run: ${(e as Error).message}` }
    }
  }
}
