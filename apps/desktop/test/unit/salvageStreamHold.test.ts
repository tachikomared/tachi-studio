// apps/desktop/test/unit/salvageStreamHold.test.ts
//
// A tool call must not be READ ALOUD on its way to being executed.
//
// The salvage middleware parses text-encoded tool calls at `finish` — correctly
// — but forwarded every text-delta the instant it arrived, so on a
// `native-then-salvage` model the user watched the raw call appear in the
// answer first:
//
//     I'll check that for you. <tool_call>{"name":"read_file","arg…
//
// The parse was right and the presentation was broken. These pin the two rules
// that fix it without ever eating prose: withhold a possible marker PREFIX
// until the next delta settles it, and stop forwarding entirely once a marker
// actually opens.

import { describe, it, expect } from 'vitest'
import {
  pendingMarkerOverlap,
  firstMarkerIndex,
} from '../../electron/services/tachi/salvage-middleware'

describe('a suffix that could still become a marker is held back', () => {
  it('holds a partial opening', () => {
    // Three keystrokes from `<tool_call>` and also from a sentence about tools.
    expect(pendingMarkerOverlap('let me look: <tool')).toBe(5)
    expect(pendingMarkerOverlap('ok <func')).toBe(5)
    expect(pendingMarkerOverlap('here: ```')).toBe(3)
  })

  it('prefers the LONGEST plausible overlap', () => {
    // Withholding too little is the bug; too much costs one delta of latency.
    expect(pendingMarkerOverlap('<tool_call')).toBe(10)
  })

  it('holds nothing for ordinary prose', () => {
    for (const s of ['all done.', 'the tool ran', 'a < b and c > d', '']) {
      expect(pendingMarkerOverlap(s), s).toBe(0)
    }
  })

  it('never withholds more than a marker could need', () => {
    const long = 'x'.repeat(500) + '<tool'
    expect(pendingMarkerOverlap(long)).toBeLessThan('<tool_call>'.length)
  })
})

describe('a marker that has actually opened is found at its first character', () => {
  it('locates each recognised opening', () => {
    expect(firstMarkerIndex('hello <tool_call>{}')).toBe(6)
    expect(firstMarkerIndex('hi <function=read_file>')).toBe(3)
    expect(firstMarkerIndex('text ```json\n{}')).toBe(5)
  })

  it('reports the EARLIEST when several appear', () => {
    expect(firstMarkerIndex('a ```json b <tool_call>')).toBe(2)
  })

  it('is -1 for prose, including prose that merely mentions the words', () => {
    for (const s of ['no markers here', 'the tool_call finished', 'a function of x', '']) {
      expect(firstMarkerIndex(s), s).toBe(-1)
    }
  })
})

// ── The behaviour the two helpers produce, simulated over a delta stream ─────
//
// Reproduces the transform's loop so the rules can be checked end-to-end
// without standing up an AI-SDK stream.
function run(deltas: string[]): { shown: string; parsed: string } {
  let held = ''
  let suppressing = false
  let shown = ''
  let parsed = ''
  for (const d of deltas) {
    parsed += d
    if (suppressing) continue
    held += d
    const at = firstMarkerIndex(held)
    if (at >= 0) {
      suppressing = true
      shown += held.slice(0, at)
      held = ''
      continue
    }
    const keep = pendingMarkerOverlap(held)
    shown += held.slice(0, held.length - keep)
    held = held.slice(held.length - keep)
  }
  if (held && !suppressing) shown += held   // the finish flush
  return { shown, parsed }
}

describe('over a real delta sequence', () => {
  it('shows the prose and never a character of the call', () => {
    const { shown, parsed } = run(['I will check', ' that. ', '<tool', '_call>', '{"name":"read_file"}', '</tool_call>'])
    expect(shown).toBe('I will check that. ')
    expect(shown).not.toContain('<')
    // …while the parser still receives every character.
    expect(parsed).toContain('<tool_call>{"name":"read_file"}</tool_call>')
  })

  it('a marker split across FOUR deltas is still caught', () => {
    const { shown } = run(['done ', '<', 'tool', '_ca', 'll>', '{}'])
    expect(shown).toBe('done ')
  })

  it('prose that merely starts like a marker is delivered in full', () => {
    // The withheld tail must be a delay, never a deletion.
    const { shown } = run(['use the ', '<b>', 'bold', '</b>', ' tag'])
    expect(shown).toBe('use the <b>bold</b> tag')
  })

  it('a trailing partial that never completes is flushed at the end', () => {
    const { shown } = run(['almost ', '<too'])
    expect(shown).toBe('almost <too')
  })

  it('text after a call is suppressed too — it is payload, not prose', () => {
    const { shown } = run(['ok ', '<tool_call>{"name":"x"}</tool_call>', ' trailing noise'])
    expect(shown).toBe('ok ')
  })

  it('an ordinary answer is byte-identical to what it always was', () => {
    const deltas = ['The ', 'answer ', 'is ', '42.']
    expect(run(deltas).shown).toBe('The answer is 42.')
  })
})
