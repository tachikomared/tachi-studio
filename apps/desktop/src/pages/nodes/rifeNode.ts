// apps/desktop/src/pages/nodes/rifeNode.ts
//
// THE RIFE NODE'S PURE CORE — shared by the canvas card (renderer) and the graph
// phase (main), for the reason localGenParams exists: the media vertical has
// drifted between its two surfaces three times, and every drift was a resolver
// that lived in a React file main could not import.
//
// A rife node is the canvas's first POST-PROCESS node. Everything else on the
// canvas consumes TEXT (a prompt, an instruction) and the media nodes consume a
// picture; this one consumes an ARTIFACT — a whole .mp4 that already exists on
// disk — and produces another one. That single difference is what this module
// encodes:
//
//   • WHICH clip. resolveWiredImages answers with pictures, and the FLF hop
//     answers with a clip's LAST FRAME. A rife node needs neither: it needs the
//     video ITSELF, by path, because ffmpeg opens files. wiredVideoPathsInto is
//     that reader, and graph-to-agentkit's own last-frame hop delegates to it so
//     the two can never disagree about what counts as a carrier.
//   • WHETHER a clip could ever arrive. The doctor has to answer BEFORE any run,
//     from the graph alone — hence hasVideoCapableUpstream, which is deliberately
//     more forgiving than rifeSourcePath (a wired video node that has not run yet
//     is a healthy flow, not a broken one).
//   • WHAT the one control says. Three IPC facts (supported / installed /
//     running) and one graph fact (is a clip wired) collapse into one state, so
//     the card renders a single button and the tests can pin the precedence.
//
// No React, no electron, no fs — everything here is a function of plain data.

import type { TachiEdge, TachiNode } from './types'

// ── The multiplier ────────────────────────────────────────────────────────────
//
// MIRRORS electron/services/rife-plan.ts's RIFE_MULTIPLIERS. It is duplicated
// rather than imported for the reason rife-plan states in its own header: that
// module is on the run path whose zero-egress property is asserted structurally
// (rifeWiring walks its transitive imports), and pulling a renderer module into
// that graph would trade a checked property for a checked property plus a hole.
// A drift is caught by the test that pins both lists against each other.

/** Factors the sidecar does in ONE pass (rife-v4 accepts a custom `-n`). */
export const RIFE_NODE_MULTIPLIERS = [2, 4] as const
export type RifeNodeMultiplier = typeof RIFE_NODE_MULTIPLIERS[number]

/** The default when a node has never been touched — the gallery button's factor. */
export const DEFAULT_RIFE_MULTIPLIER: RifeNodeMultiplier = 2

/**
 * The factor a node actually runs at. Anything the sidecar would reject — a 3, a
 * string "4", a hand-edited 2.5 — degrades to x2 HERE rather than failing at the
 * spawn: the IPC's zod union would refuse it, and a refusal minutes into a run
 * is a worse answer than a conservative one before it starts.
 */
export function resolveRifeMultiplier(data: unknown): RifeNodeMultiplier {
  const raw = (data as { multiplier?: unknown } | null | undefined)?.multiplier
  return (RIFE_NODE_MULTIPLIERS as readonly unknown[]).includes(raw)
    ? (raw as RifeNodeMultiplier)
    : DEFAULT_RIFE_MULTIPLIER
}

/** The on-node toggle: x2 → x4 → x2. Same shape as nextFanoutCount. */
export function nextRifeMultiplier(current: RifeNodeMultiplier): RifeNodeMultiplier {
  return current === 2 ? 4 : 2
}

// ── Which clip is wired in ────────────────────────────────────────────────────

/** The artifact fields this module reads; everything else travels untouched. */
interface WiredVideoArtifact {
  kind?: unknown
  path?: unknown
}

/**
 * Node types that can carry a VIDEO artifact down a wire:
 *   • `media`  — holds its own result under `lastArtifacts`
 *   • `output` — the card mirroring one, under `artifacts`
 *   • `rife`   — an interpolated clip, so x2-then-x2 is a legal chain
 */
const VIDEO_CARRIERS: ReadonlySet<string> = new Set(['media', 'output', 'rife'])

/** The produced-artifact list a carrier keeps, whichever field it uses. */
function artifactsOf(node: TachiNode): unknown[] {
  const data = node.data as { artifacts?: unknown; lastArtifacts?: unknown }
  const list = node.type === 'output' ? data.artifacts : data.lastArtifacts
  return Array.isArray(list) ? list : []
}

function videoPathOf(list: readonly unknown[]): string | undefined {
  for (const a of list) {
    if (!a || typeof a !== 'object') continue
    const art = a as WiredVideoArtifact
    if (art.kind !== 'video') continue
    // A b64-only clip is SKIPPED on purpose: ffmpeg needs a file, and
    // materialising one for a video that never landed on disk would trade a
    // missing input for a wrong one.
    if (typeof art.path === 'string' && art.path.trim() !== '') return art.path
  }
  return undefined
}

/**
 * On-disk paths of every video artifact wired INTO `targetId`, deduped and in
 * edge order. Handle-agnostic like resolveWiredImages: a loose drop lands on
 * whichever plug was nearest, and refusing to see the clip because of that would
 * be a puzzle rather than a rule.
 */
export function wiredVideoPathsInto(
  targetId: string,
  nodes: readonly TachiNode[],
  edges: readonly TachiEdge[],
): string[] {
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return []
  const paths: string[] = []
  for (const e of edges) {
    if (!e || e.target !== targetId) continue
    const src = nodes.find(n => n?.id === e.source)
    if (!src || !VIDEO_CARRIERS.has(String(src.type ?? ''))) continue
    const p = videoPathOf(artifactsOf(src))
    if (p) paths.push(p)
  }
  return [...new Set(paths)]
}

/** The clip THIS rife node interpolates — the first wired one that exists. */
export function rifeSourcePath(
  nodeId: string,
  nodes: readonly TachiNode[],
  edges: readonly TachiEdge[],
): string | undefined {
  return wiredVideoPathsInto(nodeId, nodes, edges)[0]
}

/**
 * Could a clip EVER arrive on this node's input — asked of the graph alone,
 * before anything has run. Deliberately looser than rifeSourcePath:
 *
 *   • a `media` node counts only when its modality is video (an image node on
 *     that wire can never produce a clip — that is a real, honest mistake),
 *   • a `rife` node always counts,
 *   • an Output card counts UNLESS it demonstrably holds something else: a card
 *     that has never run has no artifacts to judge, and warning about it would
 *     be the false alarm the doctor exists not to raise.
 */
export function hasVideoCapableUpstream(
  nodeId: string,
  nodes: readonly TachiNode[],
  edges: readonly TachiEdge[],
): boolean {
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return false
  for (const e of edges) {
    if (!e || e.target !== nodeId) continue
    const src = nodes.find(n => n?.id === e.source)
    if (!src) continue
    const type = String(src.type ?? '')
    if (type === 'rife') return true
    if (type === 'media') {
      if ((src.data as { modality?: unknown }).modality === 'video') return true
      continue
    }
    if (type === 'output') {
      const arts = artifactsOf(src)
      if (arts.length === 0) return true              // never run → fail open
      if (videoPathOf(arts)) return true
      // A card holding artifacts, none of them a clip on disk: it demonstrably
      // carries something else (a picture, a b64-only blob nothing can open).
      continue
    }
  }
  return false
}

// ── What the ONE control on the card says ─────────────────────────────────────

export type RifeNodeState =
  /** The engine status has not come back yet — say nothing, offer nothing. */
  | 'checking'
  /** No published sidecar build for this platform. */
  | 'unsupported'
  /** The 431 MB download has not happened. The press INSTALLS. */
  | 'not-installed'
  /** …and is happening right now. */
  | 'installing'
  /** A run is in flight (here or on another surface). The press STOPS it. */
  | 'running'
  /** Installed, but nothing is wired into the video plug. */
  | 'no-input'
  /** The press interpolates. */
  | 'ready'

export interface RifeNodeStateInput {
  /** From rife:status. `undefined` = not read yet. */
  supported?: boolean
  installed?: boolean
  /** This card started an install and is waiting on it. */
  installing?: boolean
  /** A clip is wired in (rifeSourcePath resolved). */
  hasInput: boolean
  /** A run owns this node's clip — from the run state OR rife:status.active. */
  running: boolean
}

/**
 * Collapse the four facts into the one thing the button is. The ORDER is the
 * product decision: the 431 MB install outranks "no clip wired" because it is
 * worth starting either way and it is the only thing here that costs the user
 * something; a run in flight outranks everything below it because the button
 * must never offer to start a second one.
 */
export function rifeNodeState(input: RifeNodeStateInput): RifeNodeState {
  if (input.supported === undefined && input.installed === undefined) return 'checking'
  if (input.supported === false) return 'unsupported'
  if (input.installing) return 'installing'
  if (!input.installed) return 'not-installed'
  if (input.running) return 'running'
  if (!input.hasInput) return 'no-input'
  return 'ready'
}
