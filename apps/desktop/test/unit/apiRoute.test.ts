// test/unit/apiRoute.test.ts — routing logic of the local OpenAI-compatible
// API server (electron-free helpers in services/util/api-route.ts).
import { describe, it, expect } from 'vitest'
import { pickUpstream, mergeModelLists, openAiError } from '../../electron/services/util/api-route'

describe('pickUpstream', () => {
  const both = { llamaPort: 31417, llamaModelId: 'qwen2.5-7b-q4', freellmPort: 4310 }

  it('routes the loaded llama model id to llama', () => {
    expect(pickUpstream('qwen2.5-7b-q4', both)).toEqual({ kind: 'llama', port: 31417 })
  })

  it('routes the generic aliases to llama', () => {
    expect(pickUpstream('llama-cpp', both).kind).toBe('llama')
    expect(pickUpstream('local', both).kind).toBe('llama')
    expect(pickUpstream('llama-cpp:whatever', both).kind).toBe('llama')
  })

  it('routes everything else to freellm', () => {
    expect(pickUpstream('auto', both)).toEqual({ kind: 'freellm', port: 4310 })
    expect(pickUpstream('gpt-4o-mini', both).kind).toBe('freellm')
    expect(pickUpstream(undefined, both).kind).toBe('freellm')
    expect(pickUpstream('', both).kind).toBe('freellm')
  })

  it('falls back to llama when it is the only running engine', () => {
    const llamaOnly = { llamaPort: 31417, llamaModelId: 'qwen2.5-7b-q4', freellmPort: null }
    expect(pickUpstream('gpt-4o-mini', llamaOnly)).toEqual({ kind: 'llama', port: 31417 })
  })

  it('reports none when nothing is running', () => {
    const pick = pickUpstream('auto', { llamaPort: null, llamaModelId: null, freellmPort: null })
    expect(pick.kind).toBe('none')
    if (pick.kind === 'none') expect(pick.reason).toMatch(/no local engine/i)
  })

  // WAS: `it('does not route alias names to llama when llama is down')`, which
  // asserted `pickUpstream('llama-cpp', freellmOnly).kind === 'freellm'`.
  //
  // That test was green and it was defending the wrong idea. What it actually
  // pinned is that a caller asking for the model on their OWN MACHINE gets
  // answered by a cloud router, with their prompt, in a response shaped exactly
  // like the local one. The single reason a person picks a local model is the
  // single thing that silently stopped happening.
  //
  // The path was always reachable (stop the engine by hand, or crash it) but
  // the idle auto-unload made it routine: ten quiet minutes and every API call
  // became a cloud call. The unload is right; routing around it was not.
  it('REFUSES to answer a local-model request from the cloud router', () => {
    const freellmOnly = { llamaPort: null, llamaModelId: null, freellmPort: 4310 }
    const pick = pickUpstream('llama-cpp', freellmOnly)
    expect(pick.kind).toBe('llama-not-loaded')
    expect(pick.kind === 'freellm').toBe(false)
  })

  it('names the model to wake: last-served first, else the only one on disk', () => {
    const unloaded = {
      llamaPort: null, llamaModelId: 'qwen2.5-7b-q4', freellmPort: 4310,
      localModelIds: ['qwen2.5-7b-q4', 'gemma-4-e2b'],
    }
    // A bare alias wakes what we served last.
    expect(pickUpstream('local', unloaded)).toEqual({ kind: 'llama-not-loaded', modelId: 'qwen2.5-7b-q4' })
    // A NAMED model on disk wakes that one, not the last-served one.
    expect(pickUpstream('gemma-4-e2b', unloaded)).toEqual({ kind: 'llama-not-loaded', modelId: 'gemma-4-e2b' })
  })

  it('an alias with nothing downloaded reports null rather than pretending', () => {
    const pick = pickUpstream('local', { llamaPort: null, llamaModelId: null, freellmPort: 4310, localModelIds: [] })
    expect(pick).toEqual({ kind: 'llama-not-loaded', modelId: null })
  })

  it('a model that is NOT ours still goes to the cloud router — this is not a blanket block', () => {
    // The refusal is scoped to models this machine actually holds. Everything
    // else is exactly what freellmapi exists to resolve.
    const unloaded = {
      llamaPort: null, llamaModelId: 'qwen2.5-7b-q4', freellmPort: 4310,
      localModelIds: ['qwen2.5-7b-q4'],
    }
    expect(pickUpstream('gpt-4o-mini', unloaded)).toEqual({ kind: 'freellm', port: 4310 })
    expect(pickUpstream('auto', unloaded).kind).toBe('freellm')
  })

  it('a loaded engine is unaffected — the new branch only fires when it is down', () => {
    const loaded = {
      llamaPort: 31417, llamaModelId: 'qwen2.5-7b-q4', freellmPort: 4310,
      localModelIds: ['qwen2.5-7b-q4', 'gemma-4-e2b'],
    }
    expect(pickUpstream('qwen2.5-7b-q4', loaded)).toEqual({ kind: 'llama', port: 31417 })
    expect(pickUpstream('local', loaded).kind).toBe('llama')
    // A different downloaded model while another is loaded: llama-server serves
    // one model, so this stays the existing passthrough rather than a swap.
    expect(pickUpstream('gemma-4-e2b', loaded).kind).toBe('freellm')
  })
})

describe('mergeModelLists', () => {
  it('puts the llama model first and dedupes by id', () => {
    const merged = mergeModelLists(
      [{ id: 'auto', owned_by: 'freellm' }, { id: 'qwen2.5-7b-q4' }, { id: 'llama-3.3-70b', created: 123 }],
      'qwen2.5-7b-q4',
    )
    expect(merged.object).toBe('list')
    expect(merged.data.map(m => m.id)).toEqual(['qwen2.5-7b-q4', 'auto', 'llama-3.3-70b'])
    expect(merged.data[0].owned_by).toBe('llama.cpp')
    expect(merged.data[2].created).toBe(123)
  })

  it('handles missing inputs', () => {
    expect(mergeModelLists(null, null).data).toEqual([])
    expect(mergeModelLists(undefined, 'm1').data).toEqual([
      { id: 'm1', object: 'model', created: 0, owned_by: 'llama.cpp' },
    ])
  })

  it('skips malformed entries', () => {
    const merged = mergeModelLists([{ id: 42 as unknown as string }, {}, { id: 'ok' }], null)
    expect(merged.data.map(m => m.id)).toEqual(['ok'])
  })
})

describe('openAiError', () => {
  it('produces the OpenAI error envelope', () => {
    const parsed = JSON.parse(openAiError('boom', 'api_error', 'engine_unavailable'))
    expect(parsed).toEqual({ error: { message: 'boom', type: 'api_error', code: 'engine_unavailable' } })
  })
  it('omits code when not given', () => {
    const parsed = JSON.parse(openAiError('boom', 'invalid_request_error'))
    expect(parsed.error.code).toBeUndefined()
  })
})
