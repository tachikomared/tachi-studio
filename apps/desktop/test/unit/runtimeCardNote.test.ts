// apps/desktop/test/unit/runtimeCardNote.test.ts
//
// 2026-08-01 follow-up to the bankr-gateway degraded fix: RuntimeCardUpdate.error
// is threaded by the detector but was never rendered anywhere — a user being
// rate-limited saw a dim dot and no explanation, only marginally better than
// the "unreachable" lie it replaced. This pins:
//
//   1. runtime-display.ts's `runtimeNote` helper — the one place that decides
//      whether a card has an explanation worth showing.
//   2. That StudioPage's RuntimesCard and the Sidebar's "Running Now" list
//      both actually call it and gate the note span on it being truthy, so a
//      card with no `error` renders no note element at all (no empty span, no
//      stray separator) — checked at the source level, same convention as
//      mediaNodeStaleModel.test.ts (no @testing-library/react in this repo).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runtimeNote, filterDisplayableRuntimes, resolveLaunchUrl } from '../../src/pages/studio/runtime-display'
import type { RuntimeCardUpdate } from '@tachi/core'

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map(l => (l.trimStart().startsWith('//') ? '' : l))
    .join('\n')
}

const read = (rel: string): string => stripComments(readFileSync(resolve(__dirname, '..', '..', rel), 'utf8'))

const baseCard: RuntimeCardUpdate = {
  runtimeId: 'bankr-gateway',
  kind: 'cloud_gateway',
  status: 'unknown',
  checkedAt: new Date().toISOString(),
}

describe('runtimeNote — the reason a card is in its current status', () => {
  it('surfaces the detector-supplied error verbatim (a degraded Bankr card)', () => {
    const card: RuntimeCardUpdate = { ...baseCard, error: 'Models endpoint returned 429' }
    expect(runtimeNote(card)).toBe('Models endpoint returned 429')
  })

  it('returns undefined when no error was set — nothing for callers to render', () => {
    expect(runtimeNote(baseCard)).toBeUndefined()
  })

  it('returns undefined for a blank/whitespace-only error (defensive — not currently emitted by any detector)', () => {
    expect(runtimeNote({ ...baseCard, error: '   ' })).toBeUndefined()
    expect(runtimeNote({ ...baseCard, error: '' })).toBeUndefined()
  })

  it('trims incidental whitespace around a real message', () => {
    expect(runtimeNote({ ...baseCard, error: '  gateway is degraded  ' })).toBe('gateway is degraded')
  })

  it('is not status-specific — it renders for ANY status the field is set on, not just Bankr\'s "unknown"', () => {
    expect(runtimeNote({ ...baseCard, status: 'unreachable', error: 'DNS lookup failed' })).toBe('DNS lookup failed')
  })
})

// ── What a "detected on this machine" list is allowed to contain ────────────
//
// The card that renders these was headed "Detected Local Servers" and listed
// bankr-gateway, whose launch URL is https://bankr.bot/api. A cloud gateway is
// a remote API with a health probe: no process here, no port, nothing to
// install. The exclusion is derived from the detector's own `kind` so the NEXT
// cloud gateway is out on the day it is added, not the day someone notices.

describe('filterDisplayableRuntimes — nothing remote in a list about this machine', () => {
  const card = (over: Partial<RuntimeCardUpdate>): RuntimeCardUpdate => ({ ...baseCard, ...over })

  it('drops every cloud_gateway, whatever its id', () => {
    const kept = filterDisplayableRuntimes([
      card({ runtimeId: 'bankr-gateway', kind: 'cloud_gateway' }),
      // A hypothetical future gateway nobody remembered to list:
      card({ runtimeId: 'some-future-gateway', kind: 'cloud_gateway' }),
      card({ runtimeId: 'ollama', kind: 'local_model_server', status: 'running' }),
    ])
    expect(kept.map(c => c.runtimeId)).toEqual(['ollama'])
  })

  it('still drops the named noise (own tab / tangential), which is not kind-derivable', () => {
    const kept = filterDisplayableRuntimes([
      card({ runtimeId: 'aeon', kind: 'coding_agent' }),
      card({ runtimeId: 'lmstudio', kind: 'local_model_server' }),
      card({ runtimeId: 'jan', kind: 'local_model_server' }),
      card({ runtimeId: 'bankr-buddy', kind: 'companion' }),
      card({ runtimeId: 'codex', kind: 'coding_agent' }),
    ])
    expect(kept.map(c => c.runtimeId)).toEqual(['codex'])
  })

  it('keeps what really is here: local servers, CLI agents, custom APIs', () => {
    const kept = filterDisplayableRuntimes([
      card({ runtimeId: 'comfyui', kind: 'local_model_server' }),
      card({ runtimeId: 'claude-code', kind: 'coding_agent' }),
      card({ runtimeId: 'n8n', kind: 'custom_api' }),
    ])
    expect(kept).toHaveLength(3)
  })

  // The filter above is what makes the launch-URL entry dead: every surface
  // that resolves a URL renders the FILTERED list, so no bankr-gateway row can
  // reach resolveLaunchUrl any more. The entry (https://bankr.bot/api) is gone.
  it('has no launch URL left for the gateway it stopped displaying', () => {
    expect(resolveLaunchUrl(card({ runtimeId: 'bankr-gateway', status: 'not_installed' }))).toBeNull()
    expect(resolveLaunchUrl(card({ runtimeId: 'bankr-gateway', status: 'unknown' }))).toBeNull()
  })

  it('still resolves launch URLs for things that ARE on this machine', () => {
    expect(resolveLaunchUrl(card({ runtimeId: 'ollama', kind: 'local_model_server', status: 'installed' })))
      .toBe('http://127.0.0.1:11434/')
  })
})

describe('StudioPage RuntimesCard renders the note', () => {
  const src = read('src/pages/studio/StudioPage.tsx')

  it('imports runtimeNote from runtime-display', () => {
    expect(src).toMatch(/runtimeNote,?\s*\n?\s*\} from '\.\/runtime-display'/)
  })

  it('computes the note per card and gates the span on it being truthy', () => {
    expect(src).toContain('const note  = runtimeNote(c)')
    expect(src).toMatch(/\{note && \(/)
  })

  it('the note span carries the full text in `title` (hover affordance) and truncates visually rather than hard-cutting mid-word', () => {
    const start = src.indexOf('{note && (')
    expect(start).toBeGreaterThan(-1)
    const noteBlock = src.slice(start, start + 400)
    expect(noteBlock).toContain('title={note}')
    expect(noteBlock).toContain("textOverflow: 'ellipsis'")
    expect(noteBlock).toContain("whiteSpace: 'nowrap'")
    expect(noteBlock).not.toContain('.slice(')
  })

  it('the note color is the SAME variable driving the status dot/label — neutral falls back automatically, a real error stays red, no new color idiom invented', () => {
    const start = src.indexOf('{note && (')
    const noteBlock = src.slice(start, start + 400)
    expect(noteBlock).toMatch(/color,\s*\n/) // `color` shorthand, not a literal
  })
})

describe('Sidebar "Running Now" list renders the note', () => {
  const src = read('src/components/layout/Sidebar.tsx')

  it('imports runtimeNote from runtime-display', () => {
    expect(src).toMatch(/runtimeNote,?\s*\n?\s*\} from '\.\.\/\.\.\/pages\/studio\/runtime-display'/)
  })

  it('computes the note per card and gates the span on it being truthy', () => {
    expect(src).toContain('const note = runtimeNote(card)')
    expect(src).toMatch(/\{note && \(/)
  })

  it('the note span carries the full text in `title` and truncates visually', () => {
    const start = src.indexOf('{note && (')
    expect(start).toBeGreaterThan(-1)
    const noteBlock = src.slice(start, start + 400)
    expect(noteBlock).toContain('title={note}')
    expect(noteBlock).toContain("textOverflow: 'ellipsis'")
  })

  it('the name and the optional note live in the same flex column wrapper (so an absent note adds zero extra elements/height)', () => {
    // Anchor on code, not the JSX comment above it — stripComments() removes
    // `{/* ... */}` blocks along with `//` lines, so a comment-text anchor
    // would never be found in `src` here.
    const wrapperIdx = src.indexOf('const note = runtimeNote(card)')
    expect(wrapperIdx).toBeGreaterThan(-1)
    const wrapperBlock = src.slice(wrapperIdx, wrapperIdx + 1800)
    expect(wrapperBlock).toContain('flexDirection: \'column\'')
    expect(wrapperBlock).toContain('{note && (')
  })
})
