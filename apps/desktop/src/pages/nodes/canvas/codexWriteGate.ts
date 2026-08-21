// apps/desktop/src/pages/nodes/canvas/codexWriteGate.ts
//
// WRITE-MODE gate for the canvas Codex agent node. A PURE, side-effect-free core
// (unit-tested in test/unit/codexWriteGate.test.ts) plus a tiny one-per-session
// consent latch used by the renderer run paths. No React, no store, no IPC — so
// BOTH the renderer (consent collection) and the MAIN process (sandbox-mode
// decision) can import it, exactly like errorBranch.ts.
//
// ────────────────────────────────────────────────────────────────────────────
// CONTRACT (v1 — do not "improve" without updating the tests):
//
// A canvas Codex node is an AGENT node with data.harnessId === 'codex'. It ships
// READ-ONLY. WRITE-MODE (codex's own `workspace-write` sandbox) is enabled ONLY
// when ALL of these hold — fail-closed on every missing one:
//   1. the node's data.codexAllowWrite === true            (explicit opt-in)
//   2. private mode is OFF                                  (it's a cloud call)
//   3. a Folder node with a non-empty path is wired to it   (never the storage
//      root — write-mode must target the user-chosen folder, nothing else)
//
// The RENDERER additionally requires one-per-session explicit user consent (a
// brutalist confirm listing the folders) before it dispatches a run that
// includes ANY write-enabled codex node. `collectWriteConsentTargets` computes
// which nodes/folders that dialog must name. The MAIN process re-derives the
// sandbox decision independently (never trusts the renderer) via
// `decideCodexSandbox` — defense in depth.
// ────────────────────────────────────────────────────────────────────────────

/** data.harnessId value that identifies a canvas Codex agent node. */
export const CODEX_HARNESS_ID = 'codex'

/** Minimal structural node shape (xyflow-agnostic, main-importable). */
export interface CodexGateNode {
  id: string
  type: string
  data?: Record<string, unknown>
}

/** Minimal structural edge shape. */
export interface CodexGateEdge {
  source: string
  target: string
}

/** One write-enabled codex node that will run, plus the folders it may write. */
export interface CodexWriteTarget {
  nodeId: string
  nodeLabel: string
  /** Non-empty: absolute paths of the wired Folder nodes codex may modify. */
  folderPaths: string[]
}

/** True iff `node` is a canvas Codex agent node. */
export function isCodexNode(node: CodexGateNode): boolean {
  return node.type === 'agent'
    && String((node.data ?? {}).harnessId ?? '') === CODEX_HARNESS_ID
}

/**
 * Absolute paths of every Folder node wired DIRECTLY to `codexId` (either edge
 * direction) that carries a non-empty path. Mirrors the main-process workspace
 * resolution (subFlowForAgent keeps folder nodes connected in either direction;
 * the worker uses a folder with a non-blank path). Deduped, order-stable.
 */
export function wiredFolderPaths(
  codexId: string,
  nodes: readonly CodexGateNode[],
  edges: readonly CodexGateEdge[],
): string[] {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const paths: string[] = []
  const seen = new Set<string>()
  for (const e of edges) {
    const otherId = e.source === codexId ? e.target : e.target === codexId ? e.source : null
    if (!otherId) continue
    const other = byId.get(otherId)
    if (!other || other.type !== 'folder') continue
    const p = String((other.data ?? {}).path ?? '').trim()
    if (p && !seen.has(p)) { seen.add(p); paths.push(p) }
  }
  return paths
}

/**
 * The write-enabled codex nodes among `runIds` that ALSO have a wired folder —
 * i.e. the nodes that will actually run codex in `workspace-write`. Every other
 * node is EXCLUDED:
 *   • codexAllowWrite !== true  → excluded (toggle off; stays read-only)
 *   • no wired folder           → excluded (stays read-only in main regardless,
 *     so no write consent is owed; write-mode never targets the storage root)
 * Order follows `runIds`.
 */
export function collectWriteConsentTargets(
  nodes: readonly CodexGateNode[],
  edges: readonly CodexGateEdge[],
  runIds: readonly string[],
): CodexWriteTarget[] {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const out: CodexWriteTarget[] = []
  for (const id of runIds) {
    const node = byId.get(id)
    if (!node || !isCodexNode(node)) continue
    if ((node.data ?? {}).codexAllowWrite !== true) continue
    const folderPaths = wiredFolderPaths(node.id, nodes, edges)
    if (folderPaths.length === 0) continue // no folder → read-only regardless
    const label = String((node.data ?? {}).label ?? '').trim() || 'codex'
    out.push({ nodeId: node.id, nodeLabel: label, folderPaths })
  }
  return out
}

// ── Main-side sandbox decision (independent of the renderer) ──────────────────

export type CodexSandboxMode = 'read-only' | 'workspace-write'

export interface CodexSandboxDecision {
  mode: CodexSandboxMode
  /** The `write` flag to pass runCodexTask (true only for workspace-write). */
  write: boolean
  /** Short machine reason — logged so the run record shows which mode ran. */
  reason: string
}

/**
 * Decide the sandbox mode for a codex node run. WRITE only when the node opted
 * in AND private mode is off AND a Folder node is wired; otherwise READ-ONLY.
 * Pure + fail-closed: ANY missing condition yields read-only, checked in a fixed
 * order so the reason is deterministic.
 */
export function decideCodexSandbox(input: {
  allowWrite: boolean
  privateMode: boolean
  hasWiredFolder: boolean
}): CodexSandboxDecision {
  if (!input.allowWrite)     return { mode: 'read-only', write: false, reason: 'allow-write-off' }
  if (input.privateMode)     return { mode: 'read-only', write: false, reason: 'private-mode' }
  if (!input.hasWiredFolder) return { mode: 'read-only', write: false, reason: 'no-wired-folder' }
  return { mode: 'workspace-write', write: true, reason: 'write-enabled' }
}

// ── Renderer one-per-session consent latch ────────────────────────────────────
// After the user approves the write-consent dialog once, later write runs in the
// same app session proceed without re-prompting. Module state (resets on reload);
// NOT part of the pure API above (kept here so both run paths share one latch).

let sessionConsented = false

/** Test seam: reset the one-per-session consent latch. */
export function resetCodexWriteConsentForTests(): void { sessionConsented = false }

/** Whether write consent has already been granted this session. */
export function hasCodexWriteConsent(): boolean { return sessionConsented }

/** The confirm() surface this gate needs — a subset of ConfirmProvider's API. */
export type CodexConfirmFn = (opts: {
  title?: string
  message: string
  okLabel?: string
  cancelLabel?: string
  danger?: boolean
}) => Promise<boolean>

/** The translate() surface this gate needs (react-i18next `t`, ns already bound). */
export type CodexTranslateFn = (key: string, opts?: Record<string, unknown>) => string

/**
 * Gate a run that includes write-enabled codex nodes. Returns true when the run
 * may proceed: immediately if nothing writes or consent was already granted this
 * session, else after the user approves the danger-styled confirm listing the
 * folders codex may modify. Cancel → false (the caller aborts the run cleanly).
 */
export async function ensureCodexWriteConsent(
  targets: readonly CodexWriteTarget[],
  confirm: CodexConfirmFn,
  t: CodexTranslateFn,
): Promise<boolean> {
  if (targets.length === 0) return true
  if (sessionConsented) return true
  const folders = [...new Set(targets.flatMap(x => x.folderPaths))]
  const message = t('codexWrite.consentMessage', {
    folders: folders.map(p => `- ${p}`).join('\n'),
    defaultValue:
      'The Codex agent will run in WRITE mode. It may create, modify, or delete files inside these folders only:\n\n{{folders}}\n\nNothing outside them is touched. Continue?',
  })
  const ok = await confirm({
    title:       t('codexWrite.consentTitle',  { defaultValue: 'ALLOW CODEX WRITE' }),
    message,
    okLabel:     t('codexWrite.consentRun',    { defaultValue: 'RUN' }),
    cancelLabel: t('codexWrite.consentCancel', { defaultValue: 'CANCEL' }),
    danger: true,
  })
  if (ok) sessionConsented = true
  return ok
}
