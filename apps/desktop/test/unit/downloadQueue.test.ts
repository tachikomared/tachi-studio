// test/unit/downloadQueue.test.ts — pure helpers behind the resumable
// download manager (UX #11): persistence (de)serialization contract,
// percent maths, and the HuggingFace resolve-URL parser that feeds the
// LFS-oid integrity lookup.
import { describe, it, expect } from 'vitest'
import {
  percentOf,
  serializeDownloads,
  parsePersistedDownloads,
  parseHfResolveUrl,
  isSha256Hex,
  isDownloadKind,
  shouldFallBackToLegacyDownload,
  sdManagedId,
  sdManagedIdPrefix,
  approxBytesFromSizeLabel,
  DOWNLOAD_KINDS,
  DOWNLOADS_PERSIST_VERSION,
  type SerializableTask,
} from '../../electron/services/util/download-queue'

const baseTask: SerializableTask = {
  id: 'qwen2.5-3b-instruct-q4',
  name: 'Qwen2.5 3B Instruct (Q4_K_M)',
  kind: 'gguf-model',
  url: 'https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf',
  destPath: 'C:/ud/llama-cpp/models/qwen2.5-3b-instruct-q4.gguf',
  partPath: 'C:/ud/llama-cpp/downloads/qwen2.5-3b-instruct-q4.gguf.tmp',
  state: 'active',
}

describe('percentOf', () => {
  it('is -1 when the total is unknown', () => {
    expect(percentOf(500, 0)).toBe(-1)
    expect(percentOf(500, -3)).toBe(-1)
  })
  it('floors and clamps to 100', () => {
    expect(percentOf(1, 3)).toBe(33)
    expect(percentOf(7, 3)).toBe(100)
  })
})

describe('serializeDownloads', () => {
  it('drops done tasks — nothing to restore', () => {
    const file = serializeDownloads([{ ...baseTask, state: 'done' }])
    expect(file.tasks).toHaveLength(0)
    expect(file.version).toBe(DOWNLOADS_PERSIST_VERSION)
  })
  it('demotes active/queued/verifying to paused — restart must NOT auto-network', () => {
    for (const state of ['active', 'queued', 'verifying'] as const) {
      const file = serializeDownloads([{ ...baseTask, state }])
      expect(file.tasks[0].state).toBe('paused')
    }
  })
  it('keeps error state + message so the strip can offer RETRY after restart', () => {
    const file = serializeDownloads([{ ...baseTask, state: 'error', error: 'boom', errorCode: 'NETWORK' }])
    expect(file.tasks[0]).toMatchObject({ state: 'error', error: 'boom', errorCode: 'NETWORK' })
  })
  it('strips error fields from non-error states', () => {
    const file = serializeDownloads([{ ...baseTask, state: 'paused', error: 'stale', errorCode: 'NETWORK' }])
    expect(file.tasks[0].error).toBeUndefined()
    expect(file.tasks[0].errorCode).toBeUndefined()
  })
})

describe('parsePersistedDownloads', () => {
  it('round-trips through serializeDownloads', () => {
    const file = serializeDownloads([{
      ...baseTask,
      state: 'paused',
      expectedSha256: '9c9f56a391a3abbd5b89d0245bf6106081bcc3173119d4229235dd9d23253f94',
      approxTotalBytes: 2_097_152_000,
      headerTotalBytes: 2_100_000_123,
    }])
    const restored = parsePersistedDownloads(JSON.stringify(file))
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({
      id: baseTask.id,
      state: 'paused',
      expectedSha256: '9c9f56a391a3abbd5b89d0245bf6106081bcc3173119d4229235dd9d23253f94',
      approxTotalBytes: 2_097_152_000,
      headerTotalBytes: 2_100_000_123,
    })
  })
  it('returns [] on garbage / wrong version / missing fields — never throws', () => {
    expect(parsePersistedDownloads('not json {')).toEqual([])
    expect(parsePersistedDownloads(JSON.stringify({ version: 99, tasks: [baseTask] }))).toEqual([])
    expect(parsePersistedDownloads(JSON.stringify({ version: 1, tasks: [{ id: 'x' }] }))).toEqual([])
  })
  it('rejects non-https urls and malformed sha256 pins', () => {
    const bad = serializeDownloads([{ ...baseTask, state: 'paused' }])
    ;(bad.tasks[0] as { url: string }).url = 'http://insecure.example/file.gguf'
    expect(parsePersistedDownloads(JSON.stringify(bad))).toEqual([])

    const shaBad = serializeDownloads([{ ...baseTask, state: 'paused', expectedSha256: 'nothex' }])
    const restored = parsePersistedDownloads(JSON.stringify(shaBad))
    expect(restored[0].expectedSha256).toBeUndefined()
  })
})

describe('parseHfResolveUrl', () => {
  it('parses owner/repo, revision and nested path', () => {
    expect(parseHfResolveUrl(
      'https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/sub/dir/Qwen2.5-3B-Instruct-Q4_K_M.gguf',
    )).toEqual({
      repoId: 'bartowski/Qwen2.5-3B-Instruct-GGUF',
      revision: 'main',
      path: 'sub/dir/Qwen2.5-3B-Instruct-Q4_K_M.gguf',
    })
  })
  it('accepts hf.co and cdn subdomains, decodes escaped segments', () => {
    expect(parseHfResolveUrl('https://hf.co/o/r/resolve/refs%2Fpr%2F1/f.gguf')).toEqual({
      repoId: 'o/r', revision: 'refs/pr/1', path: 'f.gguf',
    })
  })
  it('rejects non-HF hosts, non-resolve paths, and http', () => {
    expect(parseHfResolveUrl('https://evil.example/o/r/resolve/main/f.gguf')).toBeNull()
    expect(parseHfResolveUrl('https://huggingface.co/o/r/blob/main/f.gguf')).toBeNull()
    expect(parseHfResolveUrl('https://huggingface.co/o/r/resolve/main')).toBeNull()
    expect(parseHfResolveUrl('http://huggingface.co/o/r/resolve/main/f.gguf')).toBeNull()
    expect(parseHfResolveUrl('not a url')).toBeNull()
  })
})

describe('isSha256Hex', () => {
  it('accepts 64 hex chars, rejects everything else', () => {
    expect(isSha256Hex('9c9f56a391a3abbd5b89d0245bf6106081bcc3173119d4229235dd9d23253f94')).toBe(true)
    expect(isSha256Hex('9C9F56A391A3ABBD5B89D0245BF6106081BCC3173119D4229235DD9D23253F94')).toBe(true)
    expect(isSha256Hex('xyz')).toBe(false)
    expect(isSha256Hex(undefined)).toBe(false)
    expect(isSha256Hex(42)).toBe(false)
  })
})

describe('isDownloadKind — every routed installer has a registered kind', () => {
  it('accepts all registered kinds (llama gguf, sd, piper, whisper)', () => {
    expect(DOWNLOAD_KINDS).toEqual(
      expect.arrayContaining(['gguf-model', 'gguf-url', 'sd-model', 'piper-voice', 'whisper-model']),
    )
    for (const k of DOWNLOAD_KINDS) expect(isDownloadKind(k)).toBe(true)
  })
  it('rejects unknown/absent kinds', () => {
    expect(isDownloadKind('kokoro-model')).toBe(false) // deliberately NOT routed
    expect(isDownloadKind('')).toBe(false)
    expect(isDownloadKind(undefined)).toBe(false)
    expect(isDownloadKind(42)).toBe(false)
  })
  it('round-trips the new kinds through persistence', () => {
    for (const kind of ['sd-model', 'piper-voice', 'whisper-model'] as const) {
      const file = serializeDownloads([{ ...baseTask, kind, state: 'paused' }])
      const restored = parsePersistedDownloads(JSON.stringify(file))
      expect(restored).toHaveLength(1)
      expect(restored[0].kind).toBe(kind)
    }
  })
  it('drops persisted tasks with a kind this build does not know', () => {
    const file = serializeDownloads([{ ...baseTask, state: 'paused' }])
    ;(file.tasks[0] as { kind: string }).kind = 'from-the-future'
    expect(parsePersistedDownloads(JSON.stringify(file))).toEqual([])
  })
})

describe('shouldFallBackToLegacyDownload', () => {
  it('propagates deliberate coded outcomes (pause/cancel/disk/integrity)', () => {
    for (const code of ['PAUSED', 'CANCELLED', 'DISK_FULL', 'CHECKSUM_MISMATCH', 'SIZE_MISMATCH']) {
      expect(shouldFallBackToLegacyDownload(Object.assign(new Error('x'), { code }))).toBe(false)
    }
  })
  it('falls back on uncoded errors (network drop / manager bug)', () => {
    expect(shouldFallBackToLegacyDownload(new Error('ECONNRESET'))).toBe(true)
    expect(shouldFallBackToLegacyDownload(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBe(true)
    expect(shouldFallBackToLegacyDownload(Object.assign(new Error('x'), { code: 42 }))).toBe(true)
    expect(shouldFallBackToLegacyDownload('string throw')).toBe(true)
    expect(shouldFallBackToLegacyDownload(null)).toBe(true)
    expect(shouldFallBackToLegacyDownload(undefined)).toBe(true)
  })
})

describe('approxBytesFromSizeLabel', () => {
  it('parses the whisper registry labels', () => {
    expect(approxBytesFromSizeLabel('~75 MB')).toBe(75 * 1024 ** 2)
    expect(approxBytesFromSizeLabel('~142 MB')).toBe(142 * 1024 ** 2)
    expect(approxBytesFromSizeLabel('~466 MB')).toBe(466 * 1024 ** 2)
    expect(approxBytesFromSizeLabel('~1.5 GB')).toBe(Math.round(1.5 * 1024 ** 3))
  })
  it('tolerates missing tilde/space and any case', () => {
    expect(approxBytesFromSizeLabel('142MB')).toBe(142 * 1024 ** 2)
    expect(approxBytesFromSizeLabel('2 gb')).toBe(2 * 1024 ** 3)
    expect(approxBytesFromSizeLabel('512 Kb')).toBe(512 * 1024)
  })
  it('returns undefined on garbage — caller just skips the estimate', () => {
    expect(approxBytesFromSizeLabel('huge')).toBeUndefined()
    expect(approxBytesFromSizeLabel('')).toBeUndefined()
    expect(approxBytesFromSizeLabel(undefined)).toBeUndefined()
    expect(approxBytesFromSizeLabel('0 MB')).toBeUndefined()
    expect(approxBytesFromSizeLabel(75)).toBeUndefined()
  })
})

// ─── sd.cpp component ids (the STOP contract) ────────────────────────────────
//
// CatalogPage's Stop passes the MODEL id; sd-cpp-installer pauses every task
// under the model's prefix. An sd.cpp model is a SET of files, so the id
// scheme and the prefix have to agree exactly — including the trailing colon,
// without which one model's Stop would pause a different model's download.

describe('sdManagedId / sdManagedIdPrefix — the sd.cpp Stop contract', () => {
  it('builds one id per component role', () => {
    expect(sdManagedId('sd-turbo', 'model')).toBe('sd:sd-turbo:model')
    expect(sdManagedId('flux-schnell-q4', 't5xxl')).toBe('sd:flux-schnell-q4:t5xxl')
  })

  it('the prefix matches every component of its own model', () => {
    const prefix = sdManagedIdPrefix('flux-schnell-q4')
    for (const role of ['diffusion', 'vae', 'clip_l', 't5xxl']) {
      expect(sdManagedId('flux-schnell-q4', role).startsWith(prefix)).toBe(true)
    }
  })

  it('the prefix NEVER matches a model whose id merely starts the same', () => {
    const prefix = sdManagedIdPrefix('sd15')
    expect(sdManagedId('sd15-inpaint', 'model').startsWith(prefix)).toBe(false)
    expect(sdManagedId('sd15x', 'model').startsWith(prefix)).toBe(false)
    expect(sdManagedId('sd15', 'model').startsWith(prefix)).toBe(true)
  })

  it('does not collide with the other engines routed through the manager', () => {
    const prefix = sdManagedIdPrefix('sd-turbo')
    expect('llama:sd-turbo'.startsWith(prefix)).toBe(false)
    expect('whisper:base.en'.startsWith(prefix)).toBe(false)
  })
})
