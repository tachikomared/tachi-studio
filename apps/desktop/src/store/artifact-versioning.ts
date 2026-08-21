// apps/desktop/src/store/artifact-versioning.ts
//
// Pure version-merge logic for chat artifacts (Claude-Artifacts semantics):
// regenerating an artifact with the same title+kind must never silently
// overwrite — the previous content is stashed as a version and the tab is
// reused instead of growing a duplicate. Extracted from artifacts.store.ts so
// the decision logic is unit-testable without zustand/persist shims.
//
// Version timestamps record when the content was STASHED (not when it was
// authored) — that is what the manual-edit debounce gate compares against.

import type { Artifact, ArtifactKind } from './artifacts.store'

/** An incoming extraction candidate (same shape addArtifact accepts). */
export interface ArtifactCandidate {
  messageId: string
  title: string
  kind: ArtifactKind
  language?: string
  content: string
}

export type MergeDecision =
  /** No matching artifact — append a new tab (legacy behavior). */
  | { action: 'append' }
  /** Same title+kind+content already stored — do nothing but focus it. */
  | { action: 'noop'; id: string }
  /** Same title+kind, different content — reuse the tab, stash old content. */
  | { action: 'newVersion'; id: string; artifact: Artifact }

/**
 * Decide how an incoming candidate merges into a conversation's artifact list.
 * Matching key is title+kind within the conversation (the Claude-Artifacts
 * "same artifact, new revision" heuristic).
 */
export function decideMerge(
  existing: readonly Artifact[],
  candidate: ArtifactCandidate,
  nowIso: string,
): MergeDecision {
  const match = existing.find(a => a.title === candidate.title && a.kind === candidate.kind)
  if (!match) return { action: 'append' }
  if (match.content === candidate.content) return { action: 'noop', id: match.id }
  // Replay guard: on app reload every finished message re-extracts. A candidate
  // whose exact (content, messageId) pair is already stashed as a version is an
  // OLD message replaying — merging it would roll content backwards and stack
  // junk versions on every reload.
  if ((match.versions ?? []).some(v => v.content === candidate.content && v.messageId === candidate.messageId)) {
    return { action: 'noop', id: match.id }
  }
  return {
    action: 'newVersion',
    id: match.id,
    artifact: {
      ...match,
      // The artifact now reflects the newest generating message, so reload-time
      // re-extraction of that message dedupes against it.
      messageId: candidate.messageId,
      language: candidate.language ?? match.language,
      versions: [...(match.versions ?? []), { content: match.content, createdAt: nowIso, messageId: match.messageId }],
      content: candidate.content,
      updatedAt: nowIso,
    },
  }
}

/** Manual Monaco edits only stash a version if the last stash is older than this. */
export const MANUAL_VERSION_GAP_MS = 60_000

/**
 * Apply a hand-edit to an artifact. Debounce-friendly: the previous content is
 * stashed as a version only when versions is empty or the last version was
 * stashed more than MANUAL_VERSION_GAP_MS ago — a typing burst edits in place.
 */
export function applyManualEdit(artifact: Artifact, content: string, nowIso: string): Artifact {
  if (artifact.content === content) return artifact
  const versions = artifact.versions ?? []
  const last = versions[versions.length - 1]
  const lastMs = last ? Date.parse(last.createdAt) : Number.NaN
  const stash = !last || Number.isNaN(lastMs) || Date.parse(nowIso) - lastMs > MANUAL_VERSION_GAP_MS
  return {
    ...artifact,
    content,
    updatedAt: nowIso,
    versions: stash
      ? [...versions, { content: artifact.content, createdAt: nowIso, messageId: artifact.messageId }]
      : versions,
  }
}

/**
 * Restore versions[versionIndex] as the current content, pushing the current
 * content onto versions (history stays complete; nothing is deleted).
 */
export function applyRestore(artifact: Artifact, versionIndex: number, nowIso: string): Artifact {
  const versions = artifact.versions ?? []
  const target = versions[versionIndex]
  if (!target || target.content === artifact.content) return artifact
  return {
    ...artifact,
    content: target.content,
    updatedAt: nowIso,
    versions: [...versions, { content: artifact.content, createdAt: nowIso, messageId: artifact.messageId }],
  }
}
