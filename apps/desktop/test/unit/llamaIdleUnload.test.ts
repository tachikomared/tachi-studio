// apps/desktop/test/unit/llamaIdleUnload.test.ts
//
// The idle auto-unload, and the distinction that makes it correct.
//
// Adopted from KoboldCpp's "Auto Unload Timeout" (v1.110) after finding that
// our two local engines have never coordinated over the one resource they both
// need: `sd-cpp-client.ts` does not mention `llama` anywhere, so a GGUF loaded
// at breakfast still holds its weights and KV cache when you generate an image
// at dinner — on a 12 GB card, that is the difference between a render and an
// OOM.
//
// The rule this pins: the countdown is reset by TRAFFIC, never by a status
// poll. The dashboard asks "are you running?" every second, and if that counted
// as use, no model would ever unload and the feature would be decorative.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(
  join(__dirname, '../../electron/services/llama-cpp-client.ts'), 'utf8')

/** Drop comments so a claim about CODE is never satisfied by prose. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('the countdown is driven by use, not by observation', () => {
  it('a real request marks the model used — on the way in AND on the way out', () => {
    const c = code(SRC)
    // Before the fetch, so a long generation cannot expire mid-stream…
    expect(c).toContain('markLlamaCppUsed()')
    // …and in the generator's finally, so the window starts when the stream
    // ENDS. A ten-minute stream would otherwise be most of its own idle time.
    const finallyBlock = c.slice(c.lastIndexOf('} finally {'))
    expect(finallyBlock).toContain('markLlamaCppUsed()')
  })

  it('getLlamaCppStatus does NOT mark the model used', () => {
    // The whole point. A status read is an observation, and an observation
    // that changes the thing it observes is how a timer never fires.
    const status = code(SRC).slice(code(SRC).indexOf('export function getLlamaCppStatus'))
      .slice(0, 600)
    expect(status).not.toContain('markLlamaCppUsed')
  })

  it('loading counts as use, so a model nobody speaks to still unloads', () => {
    // The case that motivated it: the picker was opened, a model loaded, and
    // then nothing happened for hours.
    const c = code(SRC)
    const afterRunning = c.slice(c.indexOf("slot.state     = 'running'"))
    expect(afterRunning.slice(0, 300)).toContain('markLlamaCppUsed()')
  })
})

describe('the timer cannot fire on stale evidence', () => {
  it('re-checks idleness when it fires rather than trusting that it fired', () => {
    const c = code(SRC)
    const timer = c.slice(c.indexOf('idleTimer = setTimeout'))
    expect(timer).toContain("if (slot.state !== 'running') return")
    expect(timer).toContain('if (idleFor < IDLE_UNLOAD_MS) return')
  })

  it('is cleared on an explicit stop, so a dead slot has no pending unload', () => {
    expect(code(SRC)).toContain('clearIdleTimer()')
  })

  it('never holds the process open', () => {
    expect(code(SRC)).toContain('idleTimer.unref?.()')
  })
})

describe('an unload has a voice', () => {
  it('says why it stopped — otherwise it is indistinguishable from a crash', () => {
    // Same `state: 'stopped'`, same absent port. A user who finds their model
    // gone is owed the sentence; this repo has deleted enough silent dots.
    const c = code(SRC)
    expect(c).toContain('stoppedReason')
    expect(SRC).toContain('the VRAM was handed back')
    expect(c).toContain('...(slot.stoppedReason ? { stoppedReason: slot.stoppedReason } : {})')
  })

  it('a successful start clears the previous reason', () => {
    expect(code(SRC)).toContain('slot.stoppedReason = undefined')
  })

  it('reports how long it has been idle, so the countdown is legible', () => {
    expect(code(SRC)).toContain('idleMs')
  })
})

describe('the window itself', () => {
  it('is a named, exported constant rather than a number in a call', () => {
    expect(code(SRC)).toContain('export const IDLE_UNLOAD_MS = 10 * 60 * 1000')
  })
})

// ── KV-cache precision ───────────────────────────────────────────────────────
//
// The largest unclaimed VRAM lever, and it was unclaimed for a dull reason: our
// entire engine argv was six arguments, so a flag already present in the
// llama.cpp build we ship had simply never been passed. At long context the KV
// cache is what fills a card — it grows with tokens while the weights do not.
describe('KV-cache precision reaches the argv, and only through the closed set', () => {
  it('emits the K-cache flag for a quantised type', () => {
    const c = code(SRC)
    expect(c).toContain("args.push('--cache-type-k', opts.cacheType)")
  })

  it('says nothing for f16 — the default is expressed by silence', () => {
    // Passing the default explicitly would be a claim about a build whose own
    // defaults have moved; omitting it keeps llama.cpp's.
    expect(code(SRC)).toContain("opts.cacheType !== 'f16'")
  })

  it('leaves the V cache alone — the flash-attention interlock', () => {
    // Quantising V without flash attention makes llama.cpp dequantise it every
    // attention step, and that scratch can cost more than the quantisation
    // saved. We do not pass --flash-attn, so V stays at the default.
    const c = code(SRC)
    expect(c).not.toContain('--cache-type-v')
    expect(SRC).toContain('flash attention')
  })

  it('the accepted set is closed and ordered coarsest-last', () => {
    expect(code(SRC)).toContain("export const LLAMA_CACHE_TYPES = ['f16', 'q8_0', 'q4_0'] as const")
  })

  it('the IPC validates against that set rather than forwarding a raw string', () => {
    // This value becomes a spawn argument. Same rule as every other knob on
    // that handler: coerce or drop, never pass through.
    const ipc = readFileSync(
      join(__dirname, '../../electron/ipc/llama-cpp.ipc.ts'), 'utf8')
    expect(ipc).toContain('isLlamaCacheType(')
  })
})

// ── …AND SOMETHING HAS TO SET IT ─────────────────────────────────────────────
//
// The flag above shipped with no control, which made it inert: correct
// plumbing that nothing could ever reach. The preference is read ONCE, in the
// IPC handler, rather than threaded through the four renderer call sites that
// start a model (catalog page, status row, chat model picker, compare panel
// picker) — a value four callers must remember is a value three of them will
// eventually forget.
describe('the stored preference reaches the spawn', () => {
  const IPC = readFileSync(
    join(__dirname, '../../electron/ipc/llama-cpp.ipc.ts'), 'utf8')

  it('main reads llamaKvCache from settings when the caller omits one', () => {
    const c = code(IPC)
    expect(c).toContain('loadSettings().llamaKvCache')
  })

  it('re-validates what it read — a hand-edited settings file skipped the schema', () => {
    // The write-side zod enum only guards values that arrive through
    // settings:save. Nothing guards the file itself.
    const c = code(IPC)
    const readBlock = c.slice(c.indexOf('loadSettings().llamaKvCache') - 200, c.indexOf('loadSettings().llamaKvCache') + 200)
    expect(readBlock).toContain('isLlamaCacheType(')
  })

  it('an explicit cacheType from the caller still wins over the setting', () => {
    const c = code(IPC)
    // The stored value is only consulted when the explicit one did not validate.
    expect(c).toMatch(/isLlamaCacheType\(explicitCache\)\s*\?\s*explicitCache\s*:\s*undefined/)
    expect(c).toContain('if (!cacheType)')
  })

  it('unreadable settings fall back to silence, not to a guess', () => {
    // No flag at all means the installed build keeps its own default, which is
    // the only honest answer when we could not read the preference.
    expect(code(IPC)).toContain('...(cacheType ? { cacheType } : {})')
  })
})
