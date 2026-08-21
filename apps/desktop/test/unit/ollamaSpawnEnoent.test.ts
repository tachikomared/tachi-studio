// apps/desktop/test/unit/ollamaSpawnEnoent.test.ts
//
// THE CRASH A CLEAN MACHINE SEES (driver-reproduced on a fresh laptop install):
//
//   A JavaScript error occurred in the main process
//   Uncaught Exception:
//   Error: spawn ollama ENOENT
//       at ChildProcess._handle.onexit (node:internal/child_process:287:19)
//       at onErrorNT (node:internal/child_process:508:16)
//
// Opening the chat tab was enough. The picker asks main to list Ollama models,
// listing calls ensureOllamaRunning, and on a machine with no Ollama the spawn
// fails.
//
// ROOT CAUSE — `spawn()` does NOT throw for ENOENT. It resolves, returns a
// ChildProcess, and reports the failure ASYNCHRONOUSLY as an 'error' event.
// The code wrapped the spawn in try/catch, which cannot catch that, and
// attached only an 'exit' listener. An EventEmitter that emits 'error' with no
// 'error' listener rethrows it as an uncaught exception — in Electron's main
// process, that is the modal dialog above.
//
// So the invariant is not "handle the error somewhere" but the narrower one
// this file pins: THE SPAWNED CHILD MUST HAVE AN 'error' LISTENER, attached
// before anything can be emitted, and the failure must come back to the caller
// as a rejected promise saying what to do about it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

/** The ChildProcess shape ollama-service actually touches. */
class FakeChild extends EventEmitter {
  exitCode: number | null = null
  unref = vi.fn()
}

const spawned = vi.hoisted(() => ({ calls: [] as Array<{ cmd: string; args: string[] }>, last: null as unknown }))

vi.mock('child_process', async () => {
  const { EventEmitter: EE } = await import('node:events')
  return {
    spawn: (cmd: string, args: string[]) => {
      const child = new (class extends EE {
        exitCode: number | null = null
        unref = () => undefined
      })()
      spawned.calls.push({ cmd, args })
      spawned.last = child
      return child
    },
  }
})

// No Ollama anywhere on disk → the service falls back to the bare name and
// lets PATH resolve it, which is exactly the path that produced ENOENT.
vi.mock('fs', () => ({ existsSync: () => false }))

/**
 * Let the service run as far as the spawn. The health probe awaits a real
 * `fetch` rejection first, so a couple of microtasks are not enough — this
 * yields the macrotask queue too.
 */
async function reachTheSpawn(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))
}

/** ENOENT as Node reports it for a missing executable. */
function enoent(): NodeJS.ErrnoException {
  const e = new Error('spawn ollama ENOENT') as NodeJS.ErrnoException
  e.code = 'ENOENT'
  e.syscall = 'spawn ollama'
  return e
}

beforeEach(() => {
  spawned.calls.length = 0
  spawned.last = null
  vi.resetModules()
  // Nothing is listening on :11434 — the health probe must come back false, or
  // the service short-circuits and never reaches the spawn.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
})

afterEach(() => { vi.unstubAllGlobals() })

describe('ensureOllamaRunning — a machine with no Ollama installed', () => {
  it('attaches an error listener to the child BEFORE the failure can arrive', async () => {
    const { ensureOllamaRunning } = await import('../../electron/services/ollama-service')

    const p = ensureOllamaRunning()
    p.catch(() => { /* asserted below; this keeps the rejection handled */ })

    await reachTheSpawn()

    const child = spawned.last as FakeChild
    expect(child, 'nothing was spawned — the test never reached the code under test').toBeTruthy()
    expect(spawned.calls[0]!.cmd).toBe('ollama')
    expect(
      child.listenerCount('error'),
      "THE BUG: spawn reports ENOENT as an 'error' event, and with no listener " +
      "an EventEmitter rethrows it as an uncaught exception — the modal dialog",
    ).toBeGreaterThan(0)

    child.emit('error', enoent())
    await expect(p).rejects.toThrow()
  })

  it('rejects with something the person reading it can act on', async () => {
    const { ensureOllamaRunning } = await import('../../electron/services/ollama-service')

    const p = ensureOllamaRunning()
    const seen = p.then(() => null, (e: unknown) => e as Error)
    await reachTheSpawn()

    const child = spawned.last as FakeChild
    if (child.listenerCount('error') === 0) {
      // Emitting now would throw out of the test instead of failing it; the
      // first case already reports the real problem.
      expect.fail("no 'error' listener — see the first case")
    }
    child.emit('error', enoent())

    const err = await seen
    expect(err).toBeInstanceOf(Error)
    expect(err!.message, 'the message must name Ollama').toMatch(/ollama/i)
    expect(err!.message, 'and say where to get it').toMatch(/ollama\.com\/download/i)
    expect(err!.message, 'never a bare Node syscall string').not.toMatch(/^spawn ollama ENOENT$/)
  })

  it('does not hold a dead child as "already starting" for the next call', async () => {
    const { ensureOllamaRunning } = await import('../../electron/services/ollama-service')

    const first = ensureOllamaRunning()
    first.catch(() => {})
    await reachTheSpawn()
    const child = spawned.last as FakeChild
    if (child.listenerCount('error') === 0) expect.fail("no 'error' listener — see the first case")
    child.emit('error', enoent())
    await first.catch(() => {})

    // A second attempt must try again rather than waiting ~10s on the corpse of
    // the first: `spawnedProc.exitCode === null` is still true for a child that
    // never started, so a failed spawn has to clear it.
    const second = ensureOllamaRunning()
    second.catch(() => {})
    await reachTheSpawn()
    expect(spawned.calls.length, 'the second call re-spawned instead of waiting on a child that never existed').toBe(2)
  })
})

describe('listOllamaModels — opening a picker must not launch a daemon', () => {
  it('spawns nothing when nothing is listening on :11434', async () => {
    const { listOllamaModels } = await import('../../electron/services/ollama-service')

    const models = await listOllamaModels()

    expect(models).toEqual([])
    expect(
      spawned.calls.length,
      'listing the models started Ollama — that is what turned opening the chat tab into a spawn',
    ).toBe(0)
  })

  it('still returns what Ollama reports when it IS running', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ models: [{ name: 'llama3.2:latest', size: 42, modified_at: '', digest: 'd' }] }),
    })))
    const { listOllamaModels } = await import('../../electron/services/ollama-service')

    const models = await listOllamaModels()

    expect(models.map(m => m.name)).toEqual(['llama3.2:latest'])
    expect(spawned.calls.length, 'a running Ollama needs no spawn either').toBe(0)
  })
})
