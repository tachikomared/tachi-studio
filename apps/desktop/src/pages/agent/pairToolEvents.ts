// apps/desktop/src/pages/agent/pairToolEvents.ts
//
// Collapses the flat agent event stream into render blocks. Each `tool-call` /
// `tool-done` pair becomes one collapsible <ToolCallBlock>; everything else
// (text, user-text, error, done) passes through as `event` blocks rendered by
// <EventRow>.
//
// Pairing rule: a `tool-done` attaches to the most recent un-paired tool
// block whose `name` matches. Falls back to name-agnostic matching when the
// harness reports a different name on done (rare — defensive). Orphan
// `tool-done` events are dropped (the harness emitted them without a prior
// `tool-call`, which means we already finalized the block somehow).
//
// Lives outside AgentPage.tsx because it is a PURE transform and the transcript
// contract most worth pinning in tests (pairing, abort marking, grouping, and
// the codex progress routing below) — test/unit/pairToolEvents.test.ts drives it
// directly with no React in sight.
import type { AgentEvent } from '@tachi/core'
// PROVENANCE (type only — no runtime import, so this module stays a pure leaf
// the store can depend on). The stamp travels WITH the message through the
// sweep; nothing here derives it.
import type { AgentRunOrigin } from '../../store/agent.store'
import { appendProgress, isCodexFamilyTool, splitCodexProgress } from './codexProgress'

export type AgentMessageItem = { id: string; event: AgentEvent; timestamp?: number; origin?: AgentRunOrigin }

// ToolBlock is exported so ToolGroupSummary can reference it.
export type ToolBlock = {
  kind:    'tool'
  id:      string
  name:    string
  input:   string
  output?: string
  running: boolean
  /** True when the session ended (done/error) without a matching tool-done event. */
  aborted?: boolean
  /** Event-arrival epoch of the tool-call (for live elapsed + duration). */
  startAt?: number
  /** Wall-clock ms between tool-call and tool-done arrival (UX #7). */
  durationMs?: number
  /**
   * Live worker progress re-routed INTO this block. Only codex tools get one:
   * loop.ts forwards `[codex] …` lines as plain text events, and the sweep below
   * moves them onto the owning card instead of leaving a grey prose block
   * floating under it.
   */
  progress?: string[]
}

// GroupBlock: ≥3 consecutive tool blocks collapsed into one badge.
export type GroupBlock = {
  kind:  'group'
  id:    string
  tools: ToolBlock[]
}

export type EventBlock = {
  kind: 'event'
  id: string
  event: AgentEvent
  /** Provenance of the message this block came from. Absent on pre-stamp ones. */
  origin?: AgentRunOrigin
}
export type Block = ToolBlock | GroupBlock | EventBlock

/** Minimum run of consecutive tool blocks to collapse into a group. */
export const GROUP_THRESHOLD = 3

// A6 — O(1) tool-call pairing index.
//
// Previous implementation scanned `blocks` backwards on every `tool-done` to
// find its matching `tool-call`. With N tool calls in a heavy session this
// was O(N²) per render. Inspired by AionUi's `Messages/hooks.ts` three-index
// pattern: we keep two indices during the single forward sweep:
//
//   openByName: name → most-recent open block index
//   openAny:    stack of every open block index, regardless of name
//
// Both operations (open / close) become O(1). The function is still a
// pure transform of `messages` → `blocks` so callers can memo it cheaply.
export function pairToolEvents(messages: AgentMessageItem[]): Block[] {
  const paired: Block[] = []

  // name → index of the most recent OPEN tool block with that name.
  const openByName = new Map<string, number>()
  // Stack of every open block index, oldest at the front. Used as the
  // name-agnostic fallback when a harness renames a tool between call/done.
  const openAny: number[] = []

  // Track whether a terminal event (done/error) was seen. Used post-sweep
  // to mark any open tool blocks that appeared AFTER the terminal as aborted.
  let sawTerminal = false

  /** Most recent OPEN codex block, or -1 — the owner of any `[codex] ` line. */
  const openCodexIdx = (): number => {
    for (let k = openAny.length - 1; k >= 0; k--) {
      const b = paired[openAny[k]]
      if (b && b.kind === 'tool' && isCodexFamilyTool(b.name)) return openAny[k]
    }
    return -1
  }

  for (const m of messages) {
    const e = m.event
    if (e.type === 'tool-call') {
      const idx = paired.length
      paired.push({ kind: 'tool', id: m.id, name: e.name, input: e.input, running: true, startAt: m.timestamp })
      openByName.set(e.name, idx)
      openAny.push(idx)
      continue
    }
    if (e.type === 'tool-done') {
      // 1. exact-name match — O(1)
      let idx = openByName.get(e.name)
      if (idx !== undefined) {
        const b = paired[idx] as ToolBlock
        b.output  = e.output
        b.running = false
        if (b.startAt && m.timestamp) b.durationMs = Math.max(0, m.timestamp - b.startAt)
        openByName.delete(e.name)
        // Pop this idx from openAny — at most O(stack-depth), but typically tail.
        const stackPos = openAny.lastIndexOf(idx)
        if (stackPos !== -1) openAny.splice(stackPos, 1)
        continue
      }
      // 2. name-agnostic fallback — attach to the most recent open block.
      if (openAny.length > 0) {
        idx = openAny.pop()!
        const b = paired[idx] as ToolBlock
        b.output  = e.output
        b.running = false
        if (b.startAt && m.timestamp) b.durationMs = Math.max(0, m.timestamp - b.startAt)
        openByName.delete(b.name)
        continue
      }
      // 3. truly orphaned tool-done — render as plain event so info isn't lost.
      paired.push({ kind: 'event', id: m.id, event: e, ...(m.origin ? { origin: m.origin } : {}) })
      continue
    }
    // CODEX PROGRESS ROUTING. `[codex] …` text belongs to the delegation card
    // that is producing it, not to the transcript. Move those lines onto the
    // open codex block; anything else in the same (coalesced) text blob stays a
    // normal text event so no prose is swallowed.
    if (e.type === 'text') {
      const owner = openCodexIdx()
      if (owner !== -1) {
        const { progress, rest } = splitCodexProgress(e.text)
        if (progress.length > 0) {
          const b = paired[owner] as ToolBlock
          b.progress = appendProgress(b.progress, progress)
          if (!rest.trim()) continue
          paired.push({ kind: 'event', id: m.id, event: { type: 'text', text: rest }, ...(m.origin ? { origin: m.origin } : {}) })
          continue
        }
      }
    }
    // Session terminal event: close any tool blocks still open as aborted.
    // This handles the case where a tool errors at the harness level and the
    // process exits without ever emitting a matching tool-done event.
    if (e.type === 'done' || e.type === 'error') {
      sawTerminal = true
      if (openAny.length > 0) {
        for (const idx of openAny) {
          const b = paired[idx] as ToolBlock
          b.running = false
          b.aborted = true
        }
        openByName.clear()
        openAny.length = 0
      }
    }
    paired.push({ kind: 'event', id: m.id, event: e, ...(m.origin ? { origin: m.origin } : {}) })
  }

  // Post-sweep: if we saw a terminal event and any tool blocks are STILL open
  // (i.e. the harness emitted a tool-call AFTER the done event — a rare but
  // observed race condition), mark them all aborted so the UI doesn't show a
  // permanent "Running — waiting for result..." spinner.
  if (sawTerminal && openAny.length > 0) {
    for (const idx of openAny) {
      const b = paired[idx] as ToolBlock
      b.running = false
      b.aborted = true
    }
    openByName.clear()
    openAny.length = 0
  }

  // If the sweep ended with open tool blocks AND no terminal event was seen,
  // the session is still in-flight — leave them running: true (live stream).
  // Nothing to do here: blocks stay running: true, aborted: undefined.

  // ── B2.2: Group consecutive tool blocks into GroupBlock when run ≥ threshold ──
  const blocks: Block[] = []
  let i = 0
  while (i < paired.length) {
    const b = paired[i]
    if (b.kind !== 'tool') {
      blocks.push(b)
      i++
      continue
    }
    // Count consecutive tool blocks starting at i.
    let j = i
    while (j < paired.length && paired[j].kind === 'tool') j++
    const run = j - i
    if (run >= GROUP_THRESHOLD) {
      const tools = paired.slice(i, j) as ToolBlock[]
      blocks.push({ kind: 'group', id: tools[0].id, tools })
      i = j
    } else {
      // Less than threshold — keep individual blocks.
      for (let k = i; k < j; k++) blocks.push(paired[k])
      i = j
    }
  }

  return blocks
}
