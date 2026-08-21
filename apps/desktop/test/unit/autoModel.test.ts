// apps/desktop/test/unit/autoModel.test.ts
//
// The AUTO provider router core (src/utils/autoModel.ts). Pure + deterministic,
// so every case is a plain input→output assertion with no mocks. We prove the
// LADDER order (local-fit → free → paid-default), the fail-open behavior for
// empty/partial/absent input, the local-fit ranking (loaded > fit, gpu > cpu >
// tight, too-big excluded), the free-rung connected/free gates, and byte-for-
// byte determinism across repeated calls.
import { describe, it, expect } from 'vitest'
import {
  resolveAutoModel,
  AUTO_HARD_FALLBACK,
  type AutoModelInput,
} from '../../src/utils/autoModel'

const DEFAULT = { provider: 'bankr-gateway', model: 'claude-sonnet-4.6' }

describe('resolveAutoModel — ladder order', () => {
  it('prefers a local fit even when a free provider is also available', () => {
    const input: AutoModelInput = {
      localModels: [{ provider: 'llama-cpp', model: 'qwen3-4b.gguf', loaded: true, fit: 'gpu' }],
      providers: [{ provider: 'freellmapi-local', connected: true, models: [{ model: 'auto', free: true }] }],
      currentDefault: DEFAULT,
    }
    expect(resolveAutoModel(input)).toEqual({
      provider: 'llama-cpp',
      model: 'qwen3-4b.gguf',
      reason: 'local-fit',
    })
  })

  it('falls to free when no local model fits', () => {
    const input: AutoModelInput = {
      localModels: [{ provider: 'llama-cpp', model: 'huge-70b.gguf', fit: 'too-big' }],
      providers: [{ provider: 'freellmapi-local', connected: true, models: [{ model: 'auto', free: true }] }],
      currentDefault: DEFAULT,
    }
    expect(resolveAutoModel(input)).toEqual({
      provider: 'freellmapi-local',
      model: 'auto',
      reason: 'free',
    })
  })

  it('falls to the paid default when nothing local fits and nothing free is connected', () => {
    const input: AutoModelInput = {
      localModels: [{ provider: 'llama-cpp', model: 'huge-70b.gguf', fit: 'too-big' }],
      providers: [{ provider: 'opengateway', connected: true, models: [{ model: 'gpt-x', free: false }] }],
      currentDefault: DEFAULT,
    }
    expect(resolveAutoModel(input)).toEqual({
      provider: 'bankr-gateway',
      model: 'claude-sonnet-4.6',
      reason: 'paid-default',
    })
  })
})

describe('resolveAutoModel — fail-open on missing/partial input', () => {
  it('empty input object → currentDefault', () => {
    expect(resolveAutoModel({ currentDefault: DEFAULT })).toEqual({
      ...DEFAULT,
      reason: 'paid-default',
    })
  })

  it('undefined input → hard fallback constant', () => {
    expect(resolveAutoModel(undefined)).toEqual({ ...AUTO_HARD_FALLBACK, reason: 'paid-default' })
  })

  it('null input → hard fallback constant', () => {
    expect(resolveAutoModel(null)).toEqual({ ...AUTO_HARD_FALLBACK, reason: 'paid-default' })
  })

  it('completely empty {} → hard fallback (no currentDefault supplied)', () => {
    expect(resolveAutoModel({})).toEqual({ ...AUTO_HARD_FALLBACK, reason: 'paid-default' })
  })

  it('local models present but none qualify + no providers → currentDefault', () => {
    const input: AutoModelInput = {
      localModels: [{ provider: 'ollama-local', model: 'llama3.1', fit: 'too-big' }],
      currentDefault: DEFAULT,
    }
    expect(resolveAutoModel(input)).toEqual({ ...DEFAULT, reason: 'paid-default' })
  })

  it('providers present but empty local slice → free still fires', () => {
    const input: AutoModelInput = {
      providers: [{ provider: 'freellmapi-local', connected: true, models: [{ model: 'auto', free: true }] }],
      currentDefault: DEFAULT,
    }
    expect(resolveAutoModel(input)).toEqual({ provider: 'freellmapi-local', model: 'auto', reason: 'free' })
  })

  it('malformed local entries (missing provider/model) are skipped, not thrown', () => {
    const input = {
      localModels: [
        { provider: '', model: 'x', loaded: true },
        { provider: 'llama-cpp', model: '', loaded: true },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        null as any,
      ],
      currentDefault: DEFAULT,
    }
    expect(resolveAutoModel(input)).toEqual({ ...DEFAULT, reason: 'paid-default' })
  })

  it('currentDefault with blank fields → hard fallback', () => {
    const input: AutoModelInput = { currentDefault: { provider: '', model: '' } }
    expect(resolveAutoModel(input)).toEqual({ ...AUTO_HARD_FALLBACK, reason: 'paid-default' })
  })
})

describe('resolveAutoModel — local-fit ranking', () => {
  it('a loaded model outranks a merely-fitting (better-verdict) one', () => {
    const input: AutoModelInput = {
      localModels: [
        { provider: 'ollama-local', model: 'fits-on-gpu', fit: 'gpu' },        // score 3
        { provider: 'llama-cpp', model: 'resident', loaded: true, fit: 'cpu' }, // score 102
      ],
      currentDefault: DEFAULT,
    }
    expect(resolveAutoModel(input).model).toBe('resident')
  })

  it('among non-loaded models, gpu > cpu > tight', () => {
    const input: AutoModelInput = {
      localModels: [
        { provider: 'llama-cpp', model: 'tight-one', fit: 'tight' },
        { provider: 'llama-cpp', model: 'cpu-one', fit: 'cpu' },
        { provider: 'llama-cpp', model: 'gpu-one', fit: 'gpu' },
      ],
      currentDefault: DEFAULT,
    }
    expect(resolveAutoModel(input).model).toBe('gpu-one')
  })

  it('a loaded model with an unknown fit still qualifies', () => {
    const input: AutoModelInput = {
      localModels: [{ provider: 'llama-cpp', model: 'resident-unknown-fit', loaded: true }],
      currentDefault: DEFAULT,
    }
    expect(resolveAutoModel(input)).toEqual({
      provider: 'llama-cpp',
      model: 'resident-unknown-fit',
      reason: 'local-fit',
    })
  })

  it('an unloaded model with unknown fit does NOT qualify (fail-open)', () => {
    const input: AutoModelInput = {
      localModels: [{ provider: 'ollama-local', model: 'unmeasured' }],
      providers: [{ provider: 'freellmapi-local', connected: true, models: [{ model: 'auto', free: true }] }],
      currentDefault: DEFAULT,
    }
    expect(resolveAutoModel(input).reason).toBe('free')
  })

  it('equal-score local candidates break ties by input order (first wins)', () => {
    const input: AutoModelInput = {
      localModels: [
        { provider: 'llama-cpp', model: 'first-gpu', fit: 'gpu' },
        { provider: 'ollama-local', model: 'second-gpu', fit: 'gpu' },
      ],
      currentDefault: DEFAULT,
    }
    expect(resolveAutoModel(input).model).toBe('first-gpu')
  })
})

describe('resolveAutoModel — free rung gates', () => {
  it('disconnected providers are ignored', () => {
    const input: AutoModelInput = {
      providers: [
        { provider: 'freellmapi-local', connected: false, models: [{ model: 'auto', free: true }] },
        { provider: 'opengateway', connected: true, models: [{ model: 'nemotron:free', free: true }] },
      ],
      currentDefault: DEFAULT,
    }
    expect(resolveAutoModel(input)).toEqual({ provider: 'opengateway', model: 'nemotron:free', reason: 'free' })
  })

  it('picks the first free model of the first connected provider (input order)', () => {
    const input: AutoModelInput = {
      providers: [
        { provider: 'opengateway', connected: true, models: [{ model: 'paid-a', free: false }, { model: 'free-a', free: true }] },
        { provider: 'freellmapi-local', connected: true, models: [{ model: 'free-b', free: true }] },
      ],
      currentDefault: DEFAULT,
    }
    expect(resolveAutoModel(input)).toEqual({ provider: 'opengateway', model: 'free-a', reason: 'free' })
  })

  it('a connected provider with only paid models does not satisfy the free rung', () => {
    const input: AutoModelInput = {
      providers: [{ provider: 'bankr-gateway', connected: true, models: [{ model: 'claude', free: false }] }],
      currentDefault: DEFAULT,
    }
    expect(resolveAutoModel(input).reason).toBe('paid-default')
  })
})

describe('resolveAutoModel — determinism', () => {
  it('returns byte-identical results across repeated calls', () => {
    const input: AutoModelInput = {
      localModels: [
        { provider: 'llama-cpp', model: 'a', fit: 'cpu' },
        { provider: 'llama-cpp', model: 'b', fit: 'gpu' },
        { provider: 'ollama-local', model: 'c', loaded: true },
      ],
      providers: [{ provider: 'freellmapi-local', connected: true, models: [{ model: 'auto', free: true }] }],
      currentDefault: DEFAULT,
    }
    const first = resolveAutoModel(input)
    for (let i = 0; i < 50; i++) {
      expect(resolveAutoModel(input)).toEqual(first)
    }
    // 'c' is loaded → outranks the fitting gpu candidate 'b'.
    expect(first).toEqual({ provider: 'ollama-local', model: 'c', reason: 'local-fit' })
  })

  it('does not mutate its input', () => {
    const input: AutoModelInput = {
      localModels: [{ provider: 'llama-cpp', model: 'x', fit: 'gpu' }],
      providers: [{ provider: 'freellmapi-local', connected: true, models: [{ model: 'auto', free: true }] }],
      currentDefault: DEFAULT,
    }
    const snapshot = JSON.parse(JSON.stringify(input))
    resolveAutoModel(input)
    expect(input).toEqual(snapshot)
  })
})
