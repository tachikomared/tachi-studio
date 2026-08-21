// apps/desktop/src/pages/chat/messageWorkingDir.ts
//
// PER-MESSAGE WORKING DIRECTORY for the chat transcript's file-path chips.
//
// The CODE tab has had clickable file chips (thumbnails, click-to-enlarge,
// workspace registration) since batch-earlier; chat never got them for one
// reason: a chat message has NO working directory. The agent page reads
// agent.store.workingDir, chat has nothing equivalent — and FilePathChips
// deliberately renders nothing without one, because agent:read-file confines
// every read to an authorized workspace root.
//
// This module is the missing seam. Two candidate dirs exist on the chat side:
//
//   1. `conversation.workspaceDir` — the C4 per-conversation working directory
//      (the value WorkspacePanel renders as its `effectiveDir`). Explicit, set
//      by the user, so it WINS when present.
//   2. the attached knowledge folder (`conversation.ragFolder`, or the chat
//      folder's default) — what the composer actually attaches today and by far
//      the more common case in regular chat.
//
// `resolveSendWorkingDir` picks between them at SEND time; the result is parked
// in chat.store's `pendingWorkingDir` and stamped onto the assistant message by
// appendChunk('start'). Capturing at send time (rather than reading live at
// render time) is the whole point: detaching the folder or re-pointing the
// workspace later must not silently change which paths an OLD answer resolves.
//
// Everything here is PURE and unit-tested in test/unit/chatFilePathChips.test.ts.

import { extractFilePaths } from '../agent/FilePathChips'

/** Trim + treat blank as absent, so '' never masquerades as a directory. */
function clean(value: string | null | undefined): string | null {
  const s = typeof value === 'string' ? value.trim() : ''
  return s.length > 0 ? s : null
}

export interface WorkingDirSources {
  /** conversation.workspaceDir — WorkspacePanel's `effectiveDir`. Wins. */
  workspaceDir?: string | null
  /** The knowledge folder actually attached for this send (conv.ragFolder, or
   *  the chat folder's default — the composer resolves that precedence first). */
  attachedFolder?: string | null
}

/**
 * The dir that is ACTIVE for a send — explicit workspace first, attached folder
 * second, null when the chat has neither (⇒ the degraded absolute-path chips).
 */
export function resolveSendWorkingDir(src: WorkingDirSources | null | undefined): string | null {
  if (!src) return null
  return clean(src.workspaceDir) ?? clean(src.attachedFolder)
}

/**
 * The dir a RENDERED message resolves its paths against.
 *
 * Precedence — own stamp, then the conversation's current dirs, then null:
 *   • `message.workingDir` is the send-time truth and always wins.
 *   • Messages written before this shipped carry no stamp; falling back to the
 *     conversation's dirs keeps chips working in every old chat that still has
 *     a workspace/folder attached, instead of silently rendering nothing.
 *   • null ⇒ the caller degrades to absolute-path-only chips (no thumbnails).
 */
export function resolveMessageWorkingDir(
  message: { workingDir?: string | null } | null | undefined,
  conversation?: { workspaceDir?: string | null; ragFolder?: string | null } | null,
): string | null {
  const own = clean(message?.workingDir)
  if (own) return own
  return resolveSendWorkingDir({
    workspaceDir:   conversation?.workspaceDir,
    attachedFolder: conversation?.ragFolder,
  })
}

/**
 * The render gate for the chips: FINISHED, non-errored ASSISTANT messages only.
 *
 * Streaming is excluded on purpose — a half-arrived path
 * ("D:\proj\dia" → "D:\proj\diagram.png") would flash a chip for a file that
 * does not exist and burn the bounded thumbnail-read budget on it. User turns
 * are excluded because the chips answer "what did the assistant just write?".
 */
export function shouldRenderFileChips(
  message: { role?: string; streaming?: boolean; error?: string } | null | undefined,
): boolean {
  if (!message) return false
  return message.role === 'assistant' && !message.streaming && !message.error
}

// ── Degraded (no working dir) extraction ──────────────────────────────────────

/** Bound the fallback scan — a message naming five drives is not a real case. */
const MAX_DRIVE_ROOTS = 4

/**
 * The distinct drive roots ('D:\') mentioned in a message, in first-seen order.
 *
 * WHY: `extractFilePaths` confines its results to a working directory by
 * design. With no dir we still want chips for ABSOLUTE paths — so we call the
 * same (unmodified) extractor once per drive root found in the text. The drive
 * root is the widest possible confinement, which is exactly "absolute paths on
 * that drive". This REUSES the extractor's quoting/punctuation/extension rules
 * instead of forking a second, drifting copy of them.
 */
export function driveRootsIn(text: string): string[] {
  if (!text) return []
  const out: string[] = []
  const seen = new Set<string>()
  const re = /(?:^|[^A-Za-z0-9])([A-Za-z]):[\\/]/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const letter = m[1].toUpperCase()
    if (seen.has(letter)) continue
    seen.add(letter)
    out.push(`${letter}:\\`)
    if (out.length >= MAX_DRIVE_ROOTS) break
  }
  return out
}

/** Chip cap — mirrors FilePathChips' own MAX_CHIPS so both modes look the same. */
const MAX_FALLBACK_CHIPS = 8

/**
 * Previewable absolute paths in a message, for the NO-WORKING-DIR fallback.
 * Deduped across drives, order preserved, capped. These chips are deliberately
 * plain: with no authorized workspace root, agent:read-file would refuse a
 * thumbnail read, so the only honest action is REVEAL in the OS file manager.
 */
export function absoluteFilePathsFallback(text: string, max: number = MAX_FALLBACK_CHIPS): string[] {
  if (!text) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const root of driveRootsIn(text)) {
    for (const p of extractFilePaths(text, root)) {
      const key = p.replace(/\//g, '\\').toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(p)
      if (out.length >= max) return out
    }
  }
  return out
}
