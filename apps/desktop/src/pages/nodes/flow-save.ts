// apps/desktop/src/pages/nodes/flow-save.ts
//
// The save GATE for the Nodes canvas (LANE J, 2026-07-27).
//
// Near-miss data loss on a live run: the rail's "+ New flow" ran a best-effort
// `saveCurrent()` whose body was `try { … } catch { /* ignore */ }`, then
// cleared the canvas. Under Defender Controlled Folder Access the save failed
// silently and a ten-node, never-saved canvas was wiped (recovered only via
// Undo). A save that precedes a destructive step is NOT best-effort — it is a
// precondition, so it has to report success or failure and the caller has to
// honour it.
//
// Pure module on purpose: FlowsRail is a component and the desktop test runner
// has no DOM, so the rule ("a failed save aborts the clear") lives here where
// it can actually be tested.

/** The `{ ok, error }` shape every nodes IPC save returns. */
export interface FlowSaveResponse {
  ok: boolean
  error?: string
}

export type SaveOutcome =
  /** `saved:false` = nothing to persist (empty canvas) — safe to continue. */
  | { ok: true; saved: boolean }
  | { ok: false; error: string }

/**
 * Marker the main process puts on a write it believes Controlled Folder Access
 * blocked: `[CFA]<fallback root>|<English text>`. Kept in sync by hand with
 * electron/services/storage-root.ts (the renderer cannot import main modules).
 */
export const CFA_ERROR_TAG = '[CFA]'

/**
 * Run the pre-destructive save. Never throws: a rejected IPC call, a thrown
 * serializer, an `{ ok:false }` reply and a reply that isn't a reply at all all
 * come back as `{ ok:false, error }` so the caller can abort.
 */
export async function runFlowSave(
  hasContent: boolean,
  save: () => Promise<FlowSaveResponse | undefined | null>,
): Promise<SaveOutcome> {
  if (!hasContent) return { ok: true, saved: false }
  try {
    const res = await save()
    if (res && res.ok) return { ok: true, saved: true }
    return { ok: false, error: (res && res.error) || 'save failed' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** What to tell the user about a failed save — an i18n key plus its variables. */
export type SaveFailure =
  | { key: 'cfaBlocked'; fallback: string }
  | { key: 'saveFailed'; error: string }

/**
 * Classify a save error. A CFA-tagged message becomes actionable copy naming
 * Controlled Folder Access and where the data will go instead; anything else
 * keeps its raw text (never hide information).
 */
export function describeSaveFailure(error: string | undefined | null): SaveFailure {
  const text = (error ?? '').trim()
  if (text.startsWith(CFA_ERROR_TAG)) {
    const rest = text.slice(CFA_ERROR_TAG.length)
    const bar = rest.indexOf('|')
    const fallback = (bar >= 0 ? rest.slice(0, bar) : rest).trim()
    if (fallback) return { key: 'cfaBlocked', fallback }
    // Tagged but malformed — fall through to the raw text rather than an
    // empty-path message.
    return { key: 'saveFailed', error: bar >= 0 ? rest.slice(bar + 1).trim() : text }
  }
  return { key: 'saveFailed', error: text || 'unknown error' }
}

// ── naming ───────────────────────────────────────────────────────────────────

/** First name from `base`, `base (2)`, `base (3)`… not already taken. */
export function uniqueFlowName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base} (${i})`)) i++
  return `${base} (${i})`
}

/**
 * The name a FRESH canvas gets. It used to be `Untitled flow ${count + 1}` with
 * no uniqueness check at all, which on a live run handed back a name that
 * ALREADY existed on disk (deleting flows makes count+1 collide) — and the next
 * Save would have silently overwritten that flow. Import and templates always
 * went through uniqueFlowName; now so does this.
 */
export function nextUntitledFlowName(existing: string[]): string {
  const taken = new Set(existing)
  let n = existing.length + 1
  while (taken.has(`Untitled flow ${n}`)) n++
  return uniqueFlowName(`Untitled flow ${n}`, taken)
}
