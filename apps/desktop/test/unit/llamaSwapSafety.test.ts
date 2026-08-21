// apps/desktop/test/unit/llamaSwapSafety.test.ts
//
// A MODEL SWAP MUST NOT KILL A WORKING MODEL TO DISCOVER IT CANNOT SWAP.
//
// From the koboldcpp source study: their loader validates before it tears down;
// ours tore down first. `startLlamaCpp` stopped the running server the moment
// it saw a different model id, and only THEN checked that llama.cpp was
// installed, that the new GGUF was downloaded, and that the binary still
// existed. Picking a model you had not downloaded — one click in the chat
// picker — stopped the model you were using and left you with nothing running.
//
// Every one of those failures was knowable one line earlier. Only the ORDER
// made it destructive.
//
// The second half is quieter and worse: the validation branches wrote
// `state = 'error'` on the shared slot. After the reorder that would report a
// STILL-RUNNING engine as broken — the old model serving requests while the
// dashboard says it failed — so a refusal before the teardown now leaves the
// slot untouched and tells only the caller.
//
// What is NOT claimed: that the new model will load. Proving a load needs the
// VRAM the old model holds, and the two cannot overlap on a 12 GB card. This
// pins everything knowable without spending that memory.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

// ── Collaborators ────────────────────────────────────────────────────────────
// Hoisted so the mock factories (which vitest lifts above the imports) can see
// them — the trap this repo's settings-store header already records.
const state = vi.hoisted(() => ({
  installed: true,
  downloaded: new Set<string>(['model-a', 'model-b']),
  binaryExists: true,
  killed: 0,
}))

vi.mock('electron', () => ({ app: { getPath: () => '' } }))
vi.mock('../../electron/services/llama-cpp-installer', () => ({
  isLlamaCppInstalled:   () => state.installed,
  isGgufModelDownloaded: (id: string) => state.downloaded.has(id),
  llamaServerBinaryPath: () => 'C:/llama/llama-server.exe',
  ggufModelPath:         (id: string) => `C:/models/${id}.gguf`,
}))
vi.mock('../../electron/services/llama-cpp-models', () => ({
  getGgufModel: (id: string) => ({ id, contextK: 8, sizeMb: 3000 }),
}))
vi.mock('../../electron/services/model-storage', () => ({
  isEngineMigrating: () => false,
}))
vi.mock('fs', async (orig) => {
  const real = await orig<typeof import('fs')>()
  return { ...real, existsSync: (p: string) => (String(p).endsWith('llama-server.exe') ? state.binaryExists : real.existsSync(p)) }
})

/** A child process that is alive, says nothing, and counts its own kills. */
function fakeProc() {
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown>
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.pid = 4242
  proc.exitCode = null
  proc.kill = () => { state.killed++; return true }
  return proc
}

// Partial: @tachi/core's runtime probes reach for execFile at import time, so
// replacing the whole module breaks the graph before a test can run.
vi.mock('child_process', async (orig) => {
  const real = await orig<typeof import('child_process')>()
  return { ...real, spawn: () => fakeProc() }
})

import { startLlamaCpp, stopLlamaCpp, getLlamaCppStatus } from '../../electron/services/llama-cpp-client'

// llama-server answers /health immediately in this harness, so a start reaches
// 'running' without a real binary.
const originalFetch = globalThis.fetch
beforeEach(() => {
  state.installed = true
  state.downloaded = new Set(['model-a', 'model-b'])
  state.binaryExists = true
  state.killed = 0
  globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch
})
afterEach(() => {
  stopLlamaCpp()
  globalThis.fetch = originalFetch
})

describe('a refused swap leaves the running model alone', () => {
  it('the model you were using is still running after picking an undownloaded one', async () => {
    await startLlamaCpp({ modelId: 'model-a' })
    expect(getLlamaCppStatus().state).toBe('running')
    const killsBefore = state.killed

    await expect(startLlamaCpp({ modelId: 'model-missing' })).rejects.toThrow(/not downloaded/)

    // THE PIN, both halves. The server was never killed…
    expect(state.killed).toBe(killsBefore)
    const after = getLlamaCppStatus()
    expect(after.state).toBe('running')
    expect(after.modelId).toBe('model-a')
    // …and the still-healthy engine was not labelled broken.
    expect(after.error).toBeUndefined()
  })

  it('same for a binary that has gone missing under a running server', async () => {
    await startLlamaCpp({ modelId: 'model-a' })
    state.binaryExists = false

    await expect(startLlamaCpp({ modelId: 'model-b' })).rejects.toThrow(/binary missing/)
    expect(getLlamaCppStatus().state).toBe('running')
    expect(getLlamaCppStatus().modelId).toBe('model-a')
  })

  it('same for an uninstalled engine', async () => {
    await startLlamaCpp({ modelId: 'model-a' })
    state.installed = false

    await expect(startLlamaCpp({ modelId: 'model-b' })).rejects.toThrow(/not installed/)
    expect(getLlamaCppStatus().state).toBe('running')
  })
})

describe('with nothing running, a bad start still reports an error', () => {
  it('the slot records the failure — there is no working model to protect', async () => {
    await expect(startLlamaCpp({ modelId: 'model-missing' })).rejects.toThrow(/not downloaded/)
    const s = getLlamaCppStatus()
    expect(s.state).toBe('error')
    expect(s.error).toMatch(/not downloaded/)
  })
})

describe('a swap that CAN proceed still swaps', () => {
  it('the old server is stopped and the new model becomes the running one', async () => {
    await startLlamaCpp({ modelId: 'model-a' })
    const killsBefore = state.killed

    await startLlamaCpp({ modelId: 'model-b' })

    expect(state.killed).toBe(killsBefore + 1)
    expect(getLlamaCppStatus().state).toBe('running')
    expect(getLlamaCppStatus().modelId).toBe('model-b')
  })
})
