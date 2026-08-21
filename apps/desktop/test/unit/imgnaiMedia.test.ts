// apps/desktop/test/unit/imgnaiMedia.test.ts
//
// PURE parts of the imgnAI Katana media engine (imgnai-media-core.ts — no
// electron imports): the combined-credential split, the poll-envelope parser,
// and the terminal-state asset pick. The IO half (submit/poll/download) lives
// in electron/services/imgnai-media.ts and is exercised at runtime.
import { describe, it, expect } from 'vitest'
import {
  splitImgnaiCredential,
  IMGNAI_CREDENTIAL_HINT,
  imgnaiStaticModels,
  parseImgnaiMediaCatalog,
  parseImgnaiTextCatalog,
  IMGNAI_IMAGE_MODELS,
  IMGNAI_VIDEO_MODELS,
  coerceImgnaiAspectRatio,
  coerceImgnaiOutputFormat,
  parseImgnaiPoll,
  isImgnaiTerminal,
  pickImgnaiOutcome,
} from '../../electron/services/imgnai-media-core'

// ── Credential split ──────────────────────────────────────────────────────────

describe('splitImgnaiCredential', () => {
  it('splits "api_key:api_secret" on the FIRST colon', () => {
    expect(splitImgnaiCredential('key123:secret456')).toEqual({ apiKey: 'key123', apiSecret: 'secret456' })
  })

  it('keeps colons INSIDE the secret intact (first-colon split only)', () => {
    expect(splitImgnaiCredential('key:sec:ret:with:colons'))
      .toEqual({ apiKey: 'key', apiSecret: 'sec:ret:with:colons' })
  })

  it('trims surrounding whitespace on the whole credential and both halves', () => {
    expect(splitImgnaiCredential('  key : secret \n')).toEqual({ apiKey: 'key', apiSecret: 'secret' })
  })

  it('returns null for missing / blank input', () => {
    expect(splitImgnaiCredential(null)).toBeNull()
    expect(splitImgnaiCredential(undefined)).toBeNull()
    expect(splitImgnaiCredential('')).toBeNull()
    expect(splitImgnaiCredential('   ')).toBeNull()
  })

  it('returns null when there is no colon (malformed paste)', () => {
    expect(splitImgnaiCredential('justonekey')).toBeNull()
  })

  it('returns null when either half is empty', () => {
    expect(splitImgnaiCredential(':secretonly')).toBeNull()
    expect(splitImgnaiCredential('keyonly:')).toBeNull()
    expect(splitImgnaiCredential(':')).toBeNull()
  })

  it('the hint message points at the two Settings fields + source', () => {
    expect(IMGNAI_CREDENTIAL_HINT).toContain('API key')
    expect(IMGNAI_CREDENTIAL_HINT).toContain('API secret')
    expect(IMGNAI_CREDENTIAL_HINT).toContain('Settings')
    expect(IMGNAI_CREDENTIAL_HINT).toContain('app.imgnai.com/katana-api')
  })
})

// ── Static catalogs + param coercion ─────────────────────────────────────────

describe('imgnaiStaticModels', () => {
  it('image list has pink-image first (the default)', () => {
    const ids = imgnaiStaticModels('image').map(m => m.id)
    expect(ids[0]).toBe('pink-image')
    expect(ids).toContain('gpt-image-2')
    expect(ids).toContain('anima-pink')
  })

  it('video list uses REAL public_model_name ids (llms.txt shorthands 404)', () => {
    const ids = imgnaiStaticModels('video').map(m => m.id)
    expect(ids[0]).toBe('seedance-2-0')
    // The llms.txt shorthand names are NOT valid request ids — never ship them.
    for (const dead of ['seedance-2', 'seedance-2-mini', 'google-omni', 'happy-horse']) {
      expect(ids).not.toContain(dead)
    }
    for (const id of ['seedance-2-0', 'seedance-2-0-mini', 'seedance-2-0-mini-480p']) {
      expect(IMGNAI_VIDEO_MODELS.find(m => m.id === id)?.durationSeconds).toBe(5)
    }
  })

  it('every static entry is tagged with its modality and live:false', () => {
    for (const m of [...IMGNAI_IMAGE_MODELS, ...IMGNAI_VIDEO_MODELS]) {
      expect(m.live).toBe(false)
      expect(['image', 'video']).toContain(m.modality)
    }
  })
})

describe('parseImgnaiMediaCatalog / parseImgnaiTextCatalog', () => {
  const body = {
    images: [
      { public_model_name: 'pink-image', display_name: 'Pink Image', premium_only: false },
      { public_model_name: '', display_name: 'broken' },
      { display_name: 'no id' },
    ],
    videos: [
      { public_model_name: 'seedance-2-0', display_name: 'Seedance 2.0' },
      { public_model_name: 'veo3-1' },
    ],
    text: [
      { public_model_name: 'glm-5-2', display_name: 'GLM 5.2' },
      { public_model_name: 'claude-fable-5', display_name: 'Claude Fable 5' },
    ],
    text_pricing: { whatever: true },
  }

  it('parses the sectioned Katana shape into modality-tagged live entries', () => {
    const models = parseImgnaiMediaCatalog(body)
    expect(models).toEqual([
      { id: 'pink-image',   label: 'Pink Image',   modality: 'image', live: true },
      { id: 'seedance-2-0', label: 'Seedance 2.0', modality: 'video', live: true },
      { id: 'veo3-1',       label: 'veo3-1',       modality: 'video', live: true },
    ])
  })

  it('parses the text section for the chat/code pickers', () => {
    expect(parseImgnaiTextCatalog(body)).toEqual([
      { id: 'glm-5-2',        label: 'GLM 5.2' },
      { id: 'claude-fable-5', label: 'Claude Fable 5' },
    ])
  })

  it('carries a live context window through when Katana publishes one', () => {
    // The gateway's own number is the authority for the model IT serves; the
    // static substring rows in @tachi/core are only the offline fallback.
    const rows = parseImgnaiTextCatalog({
      text: [
        { public_model_name: 'glm-5-2', display_name: 'GLM 5.2', context_length: 1_000_000 },
        { public_model_name: 'q-naifu-a3b', max_context_length: '262144' },
        { public_model_name: 'no-window-published', display_name: 'Quiet' },
      ],
    })
    expect(rows).toEqual([
      { id: 'glm-5-2', label: 'GLM 5.2', contextTokens: 1_000_000 },
      { id: 'q-naifu-a3b', label: 'q-naifu-a3b', contextTokens: 262_144 },
      // THE PIN: a row that publishes nothing gets NO field — absent means
      // "unknown", which is distinguishable from a number. Inventing one here
      // would launder a guess into a fact the picker would print.
      { id: 'no-window-published', label: 'Quiet' },
    ])
  })

  it('a junk or zero window is treated as unpublished, not as a window', () => {
    const rows = parseImgnaiTextCatalog({
      text: [
        { public_model_name: 'zero', context_length: 0 },
        { public_model_name: 'neg', context_length: -1 },
        { public_model_name: 'words', context_length: 'lots' },
        { public_model_name: 'nulled', context_length: null },
      ],
    })
    for (const r of rows) expect(r, r.id).not.toHaveProperty('contextTokens')
  })

  it('tolerates garbage bodies', () => {
    for (const junk of [null, undefined, 'x', 42, [], {}, { data: [{ id: 'openai-shape' }] }]) {
      expect(parseImgnaiMediaCatalog(junk)).toEqual([])
      expect(parseImgnaiTextCatalog(junk)).toEqual([])
    }
  })
})

describe('coerceImgnaiAspectRatio / coerceImgnaiOutputFormat', () => {
  it('passes allowed ratios through', () => {
    for (const r of ['1:1', '16:9', '9:16', '21:9', 'auto']) {
      expect(coerceImgnaiAspectRatio(r)).toBe(r)
    }
  })

  it("coerces unknown / missing ratios to 'auto'", () => {
    expect(coerceImgnaiAspectRatio('4:3')).toBe('auto')   // valid elsewhere, not on Katana
    expect(coerceImgnaiAspectRatio(undefined)).toBe('auto')
    expect(coerceImgnaiAspectRatio(169)).toBe('auto')
  })

  it("coerces output_format to png|jpeg|webp with png default", () => {
    expect(coerceImgnaiOutputFormat('jpeg')).toBe('jpeg')
    expect(coerceImgnaiOutputFormat('webp')).toBe('webp')
    expect(coerceImgnaiOutputFormat('tiff')).toBe('png')
    expect(coerceImgnaiOutputFormat(undefined)).toBe('png')
  })
})

// ── Poll-envelope parsing ─────────────────────────────────────────────────────

describe('parseImgnaiPoll', () => {
  it('parses a completed response with output assets', () => {
    const state = parseImgnaiPoll({
      request_id: 'req-1',
      status: 'completed',
      poll_after_seconds: 5,
      responses: [{
        status: 'completed',
        output_assets: [
          { url: 'https://cdn.example/a.png', width: 1024, height: 1024, expires_at: '2026-07-11T00:00:00Z' },
          { url: 'https://cdn.example/b.png', width: 512, height: 512 },
        ],
      }],
    })
    expect(state.requestId).toBe('req-1')
    expect(state.status).toBe('completed')
    expect(state.assets).toHaveLength(2)
    expect(state.assets[0]).toMatchObject({ url: 'https://cdn.example/a.png', width: 1024, height: 1024, expiresAt: '2026-07-11T00:00:00Z' })
    expect(state.errors).toEqual([])
    expect(isImgnaiTerminal(state.status)).toBe(true)
  })

  it('parses video assets with duration + silent thumbnail url', () => {
    const state = parseImgnaiPoll({
      request_id: 'req-v',
      status: 'completed',
      responses: [{
        output_assets: [{
          url: 'https://cdn.example/v.mp4',
          duration_seconds: 5,
          thumbnail_silent_video_mp4_url: 'https://cdn.example/v-thumb.mp4',
        }],
      }],
    })
    expect(state.assets).toEqual([{
      url: 'https://cdn.example/v.mp4',
      durationSeconds: 5,
      thumbnailVideoUrl: 'https://cdn.example/v-thumb.mp4',
    }])
  })

  it('treats non-terminal statuses as pending and respects poll_after_seconds', () => {
    const state = parseImgnaiPoll({ request_id: 'r', status: 'processing', poll_after_seconds: 9, responses: [] })
    expect(state.status).toBe('pending')
    expect(state.pollAfterSeconds).toBe(9)
    expect(isImgnaiTerminal(state.status)).toBe(false)
  })

  it('defaults poll_after_seconds to 5 and clamps out-of-range values', () => {
    expect(parseImgnaiPoll({ status: 'queued' }).pollAfterSeconds).toBe(5)
    expect(parseImgnaiPoll({ status: 'queued', poll_after_seconds: 0 }).pollAfterSeconds).toBe(5)
    expect(parseImgnaiPoll({ status: 'queued', poll_after_seconds: 500 }).pollAfterSeconds).toBe(30)
    expect(parseImgnaiPoll({ status: 'queued', poll_after_seconds: 0.5 }).pollAfterSeconds).toBe(1)
  })

  it('collects responses[].error strings verbatim (string or {message} object)', () => {
    const state = parseImgnaiPoll({
      request_id: 'r',
      status: 'partial_failure',
      responses: [
        { error: 'model overloaded, try again' },
        { error: { message: 'nsfw filter tripped' } },
        { output_assets: [{ url: 'https://cdn.example/ok.png' }] },
      ],
    })
    expect(state.status).toBe('partial_failure')
    expect(state.errors).toEqual(['model overloaded, try again', 'nsfw filter tripped'])
    expect(state.assets).toHaveLength(1)
  })

  it('never throws on malformed bodies — parses to a pending empty state', () => {
    for (const bad of [null, undefined, 'nope', 42, [], {}, { responses: 'x' }, { responses: [null, 7, { output_assets: [{}, { url: '' }] }] }]) {
      const state = parseImgnaiPoll(bad)
      expect(state.status).toBe('pending')
      expect(state.assets).toEqual([])
    }
  })
})

// ── Terminal-outcome pick ─────────────────────────────────────────────────────

describe('pickImgnaiOutcome', () => {
  const asset = { url: 'https://cdn.example/a.png' }

  it('completed with assets → assets', () => {
    const out = pickImgnaiOutcome({ status: 'completed', pollAfterSeconds: 5, assets: [asset], errors: [] })
    expect(out).toEqual({ assets: [asset] })
  })

  it('partial_failure WITH assets still succeeds (errors carried alongside, not fatal)', () => {
    const out = pickImgnaiOutcome({ status: 'partial_failure', pollAfterSeconds: 5, assets: [asset], errors: ['one leg failed'] })
    expect(out).toEqual({ assets: [asset] })
  })

  it('failed → error quoting the API responses[].error verbatim-ish', () => {
    const out = pickImgnaiOutcome({ status: 'failed', pollAfterSeconds: 5, assets: [asset], errors: ['quota exceeded', 'try later'] })
    expect(out).toEqual({ error: 'quota exceeded; try later' })
  })

  it('completed with ZERO assets → error (falls back to a generic message)', () => {
    const out = pickImgnaiOutcome({ status: 'completed', pollAfterSeconds: 5, assets: [], errors: [] })
    expect('error' in out && out.error.length > 0).toBe(true)
  })

  it('failed with no error strings → generic failed message', () => {
    const out = pickImgnaiOutcome({ status: 'failed', pollAfterSeconds: 5, assets: [], errors: [] })
    expect(out).toEqual({ error: 'imgnAI generation failed' })
  })
})
