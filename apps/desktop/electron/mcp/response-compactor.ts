// apps/desktop/electron/mcp/response-compactor.ts
//
// CONTEXT-ECONOMY P1 — compaction of large in-process MCP tool RESPONSES, with
// a lossless recovery path (the tokenjuice "rewind marker" idea, done right).
//
// Large structured tool results (fs_search 500 hits, git diff/log, fetch bodies,
// history) can each fill a big chunk of an external agent's context window. We
// compact the serialized result to a head/tail window with a stable content id,
// stash the full bytes in a session-scoped store, and expose an `expand_output`
// tool so the agent can retrieve the full output (optionally keyword-filtered)
// on demand. This makes aggressive compaction safe — nothing is lost, it is
// paged. The raw bytes in the network-audit log are never touched.
//
// Verbatim tools (file reads) are never compacted: their value IS the exact
// bytes, and they already carry their own size caps.

import { createHash } from 'crypto'
import type { ToolRegistry } from './registry'

// ── Tunables ────────────────────────────────────────────────────────────────

/** Serialized results at or below this many chars are returned whole. */
export const RESPONSE_BUDGET_CHARS = 6000
const HEAD_CHARS = 4000
const TAIL_CHARS = 1200
/** Max stored full-results before the oldest are evicted (session-scoped). */
const STORE_CAP = 200

/**
 * Tools whose output must stay byte-exact (verbatim) — never compacted.
 * `expand_output` is here so a retrieval never recursively compacts itself.
 */
export const VERBATIM_TOOLS = new Set<string>(['fs_read', 'expand_output'])

// ── Session-scoped full-output store ──────────────────────────────────────────

/** id (sha256:12) → full serialized text. Bounded FIFO; cleared on restart. */
const store = new Map<string, string>()

function contentId(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

/** Store full text, return its id. Idempotent for identical text. Bounded. */
export function putFullOutput(text: string): string {
  const id = contentId(text)
  if (!store.has(id)) {
    store.set(id, text)
    while (store.size > STORE_CAP) {
      const oldest = store.keys().next().value as string | undefined
      if (oldest === undefined) break
      store.delete(oldest)
    }
  }
  return id
}

export function getFullOutput(id: string): string | undefined {
  // Accept both the bare id and the "sha256:<id>" form.
  return store.get(id.replace(/^sha256:/, ''))
}

/** Test-only: reset the store between cases. */
export function _clearStore(): void {
  store.clear()
}

// ── Compaction decision + rendering ────────────────────────────────────────────

export interface CompactedResponse {
  text: string
  /** True when the text was reduced (full output stashed under `id`). */
  compacted: boolean
  id?: string
}

/** Char head/tail window with an omission marker. */
function headTailChars(text: string): string {
  if (text.length <= HEAD_CHARS + TAIL_CHARS) return text
  const omitted = text.length - HEAD_CHARS - TAIL_CHARS
  return `${text.slice(0, HEAD_CHARS)}\n[... ${omitted} chars omitted ...]\n${text.slice(text.length - TAIL_CHARS)}`
}

/**
 * Decide + render compaction for one tool result.
 *
 * `serialized` is the JSON (or string) the tool would otherwise return verbatim.
 * Returns the (possibly) compacted text plus whether it was compacted and the
 * content id under which the full output was stored.
 */
export function compactResponse(toolName: string, serialized: string): CompactedResponse {
  if (VERBATIM_TOOLS.has(toolName) || serialized.length <= RESPONSE_BUDGET_CHARS) {
    return { text: serialized, compacted: false }
  }
  const id = putFullOutput(serialized)
  const windowed = headTailChars(serialized)
  const marker =
    `\n\n[tachi-mcp] Output compacted from ${serialized.length} chars to fit context. ` +
    `The full result is stored under content id sha256:${id}. ` +
    `Call expand_output {"id":"${id}"} to retrieve it whole, or ` +
    `expand_output {"id":"${id}","keywords":["..."]} to retrieve only matching lines. ` +
    `Do NOT re-run the original tool to get the rest — a re-run yields the same id.`
  return { text: windowed + marker, compacted: true, id }
}

// ── expand_output tool ─────────────────────────────────────────────────────────

export function registerExpandOutput(registry: ToolRegistry): void {
  registry.set('expand_output', {
    description:
      'Retrieve the full output of a previous tool call that was compacted to fit context. '
      + 'Pass the content id (sha256:...) shown in the compaction marker. Optionally pass '
      + 'keywords to return only matching lines instead of the whole output.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The content id from a compaction marker, e.g. "sha256:ab12cd34ef56" or the bare hex.' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'Optional: return only lines containing any of these (case-insensitive).' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const id = (args as { id?: unknown })?.id
      if (typeof id !== 'string' || !id.trim()) {
        return { error: 'expand_output requires a string "id" from a compaction marker.' }
      }
      const full = getFullOutput(id)
      if (full === undefined) {
        return { error: `No stored output for id "${id}". It may have been evicted (session-scoped) — re-run the original tool.` }
      }
      const kwRaw = (args as { keywords?: unknown })?.keywords
      const keywords = Array.isArray(kwRaw) ? kwRaw.filter((k): k is string => typeof k === 'string' && k.length > 0) : []
      if (keywords.length === 0) {
        return { id: id.replace(/^sha256:/, ''), full }
      }
      const lc = keywords.map(k => k.toLowerCase())
      const lines = full.split('\n')
      const matched = lines.filter(l => { const ll = l.toLowerCase(); return lc.some(k => ll.includes(k)) })
      return {
        id: id.replace(/^sha256:/, ''),
        totalLines: lines.length,
        matchedLines: matched.length,
        keywords,
        result: matched.join('\n'),
      }
    },
  })
}
