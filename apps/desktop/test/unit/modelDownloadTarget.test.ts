// apps/desktop/test/unit/modelDownloadTarget.test.ts
//
// LANE U — a NEW model download must NOT target the full C: drive.
//
// Live complaint: "у меня на C места нет". resolveModelPath used to return the
// LEGACY userData path whenever a weight existed in neither root, on the theory
// that a `.part` file has to stay on the same device as its final path. The
// constraint is real (the landing `renameSync` throws EXDEV across devices) but
// it says ".part NEXT TO its final file", not "everything in userData" — so a
// 2.5-7.7 GB catalog download filled C:, and the dashboard relocation then
// needed that space TWICE to get it off C: again.
//
// This file pins the new contract:
//   • file in NEITHER root  → storage root  (when that root is writable)
//   • storage root unwritable → legacy userData (degraded, never broken)
//   • file already in legacy  → legacy       (nothing ever moves silently)
//   • file already relocated  → storage root
//   • a multi-file item anchors BOTH files to the root that holds either
//   • the .part is same-dir as its final file, by derivation
//
// fs is an in-memory fake whose write path can be blocked by prefix — that IS
// what Controlled Folder Access does: existsSync keeps telling the truth and
// only the write fails, which is exactly the case where new downloads must fall
// back to legacy instead of failing.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join, dirname } from 'path'

// HOISTED, not plain consts: `vi.mock` factories are lifted above every
// top-level statement, so a module that touches `app.getPath` at IMPORT time
// (settings-store computes its file path in a module-level const) reaches these
// before a plain `const` has initialized — a TDZ ReferenceError that looks like
// a bug in the module under test. vi.hoisted values are initialized first.

// Paths are built in the SHAPE OF THE HOST PLATFORM: the code under test walks
// them with node:path, and a `C:\…` literal is a RELATIVE path to a POSIX runner,
// which silently inverts every assertion that depends on being absolute.
const paths = vi.hoisted(() => ({
  USERDATA: process.platform === 'win32' ? 'C:\\FakeUserData' : '/FakeUserData',
  ROOT:     process.platform === 'win32' ? 'D:\\Tachi Studio'  : '/mnt/one/Tachi Studio',
}))
const USERDATA = paths.USERDATA
const ROOT     = paths.ROOT

const fsState = vi.hoisted(() => ({
  files: new Map<string, number>(),   // normalized path -> byte size
  dirs: new Set<string>(),            // normalized path
  /** Path prefixes whose writes fail, with the errno to throw. */
  blocked: [] as Array<{ prefix: string; code: string }>,
  norm: (p: string) => p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, ''),
}))

vi.mock('fs', () => {
  const n = fsState.norm
  function existsSync(p: string): boolean {
    const k = n(p)
    if (fsState.files.has(k) || fsState.dirs.has(k)) return true
    const prefix = k + '/'
    for (const f of fsState.files.keys()) if (f.startsWith(prefix)) return true
    for (const d of fsState.dirs) if (d.startsWith(prefix)) return true
    return false
  }
  function blockFor(p: string): { code: string } | null {
    for (const b of fsState.blocked) if (n(p).startsWith(n(b.prefix))) return b
    return null
  }
  function statSync(p: string) {
    const k = n(p)
    if (fsState.files.has(k)) return { isDirectory: () => false, isFile: () => true, size: fsState.files.get(k)! }
    if (existsSync(p)) return { isDirectory: () => true, isFile: () => false, size: 0 }
    const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException
    err.code = 'ENOENT'
    throw err
  }
  function readdirSync(p: string): string[] {
    const prefix = n(p) + '/'
    const names = new Set<string>()
    for (const key of [...fsState.files.keys(), ...fsState.dirs]) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      names.add(rest.split('/')[0])
    }
    if (names.size === 0 && !fsState.dirs.has(n(p))) {
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return [...names]
  }
  return {
    existsSync,
    statSync,
    readdirSync,
    // CFA blocks file CREATION, not (necessarily) the mkdir — mirroring
    // storageRootWriteRetry.test.ts, mkdir "succeeds" and only writes fail.
    mkdirSync: (p: string) => { fsState.dirs.add(n(p)) },
    writeFileSync: (p: string, data: string | Uint8Array) => {
      const b = blockFor(p)
      if (b) {
        const err = new Error(`${b.code}: write blocked ${p}`) as NodeJS.ErrnoException
        err.code = b.code
        throw err
      }
      fsState.files.set(n(p), typeof data === 'string' ? data.length : data.length)
    },
    copyFileSync: (src: string, dest: string) => { fsState.files.set(n(dest), fsState.files.get(n(src)) ?? 0) },
    renameSync: (src: string, dest: string) => {
      fsState.files.set(n(dest), fsState.files.get(n(src)) ?? 0)
      fsState.files.delete(n(src))
    },
    rmSync: (p: string) => {
      const k = n(p)
      fsState.files.delete(k)
      fsState.dirs.delete(k)
      for (const f of [...fsState.files.keys()]) if (f.startsWith(k + '/')) fsState.files.delete(f)
      for (const d of [...fsState.dirs])        if (d.startsWith(k + '/')) fsState.dirs.delete(d)
    },
    statfsSync: () => ({ bsize: 4096, bavail: 1e9, blocks: 2e9 }),
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => paths.USERDATA, isPackaged: false },
}))

vi.mock('../../electron/services/storage-root', () => ({
  getStorageRoot: () => paths.ROOT,
}))

import {
  resolveModelPath, resolveModelDir, engineLegacyBase, engineNewBase,
  isModelRootWritable, invalidateModelTargetProbe, invalidateUsageCache,
  partPathFor,
} from '../../electron/services/model-storage'
import { PART_SUFFIX, isPartFileName } from '../../electron/services/util/model-storage'

function touch(p: string, bytes = 8): void {
  const k = fsState.norm(p)
  const parts = k.split('/')
  for (let i = 1; i < parts.length; i++) fsState.dirs.add(parts.slice(0, i).join('/'))
  fsState.files.set(k, bytes)
}

beforeEach(() => {
  fsState.files.clear()
  fsState.dirs.clear()
  fsState.blocked.length = 0
  fsState.dirs.add(fsState.norm(USERDATA))
  fsState.dirs.add(fsState.norm(ROOT))
  invalidateModelTargetProbe()
  invalidateUsageCache()
})

// ─── 1. NEW downloads target the storage root ────────────────────────────────

describe('resolveModelPath — NEW download targeting (LANE U)', () => {
  it('targets <storage root>/Models/<engine>/ when the weight is in NEITHER root', () => {
    const p = resolveModelPath('llama', 'qwen3-4b.gguf')
    expect(p).toBe(join(engineNewBase('llama'), 'qwen3-4b.gguf'))
    expect(p.startsWith(ROOT)).toBe(true)
    expect(p.startsWith(USERDATA)).toBe(false) // the whole point: nothing on C:
  })

  it('targets the root for every engine, flat-file and dir-based alike', () => {
    expect(resolveModelPath('whisper', 'ggml-large.bin')).toBe(join(engineNewBase('whisper'), 'ggml-large.bin'))
    expect(resolveModelDir('sd', 'flux-schnell')).toBe(join(engineNewBase('sd'), 'flux-schnell'))
    expect(resolveModelPath('piper', 'en_US-amy', 'en_US-amy.onnx'))
      .toBe(join(engineNewBase('piper'), 'en_US-amy', 'en_US-amy.onnx'))
  })

  it('probes the root for REAL writability (creatable + a probe file lands)', () => {
    expect(isModelRootWritable()).toBe(true)
    expect(fsState.dirs.has(fsState.norm(join(ROOT, 'Models')))).toBe(true)
    // the probe file is cleaned up, never left behind
    expect([...fsState.files.keys()].some(f => f.includes('tachi-model-probe'))).toBe(false)
  })
})

// ─── 2. Fail-back when the root is not writable ──────────────────────────────

describe('resolveModelPath — fallback when the storage root is unwritable', () => {
  it('falls back to legacy userData when the probe write is blocked (CFA-shaped)', () => {
    fsState.blocked.push({ prefix: ROOT, code: 'EPERM' })
    expect(isModelRootWritable()).toBe(false)
    expect(resolveModelPath('llama', 'qwen3-4b.gguf'))
      .toBe(join(engineLegacyBase('llama'), 'qwen3-4b.gguf'))
  })

  it('falls back on every errno shape a refused folder produces', () => {
    for (const code of ['EPERM', 'EACCES', 'EROFS', 'ENOENT']) {
      fsState.blocked.length = 0
      fsState.blocked.push({ prefix: ROOT, code })
      invalidateModelTargetProbe()
      expect(resolveModelPath('whisper', 'ggml-base.bin'))
        .toBe(join(engineLegacyBase('whisper'), 'ggml-base.bin'))
    }
  })

  it('caches the verdict per ROOT, so a hot resolve does not re-probe the disk', () => {
    expect(isModelRootWritable()).toBe(true)
    // Block writes AFTER the verdict was cached — the cached `true` stands
    // until something invalidates it (the root string changing, or an explicit
    // invalidate). Proves the probe is not re-run on every resolve.
    fsState.blocked.push({ prefix: ROOT, code: 'EPERM' })
    expect(isModelRootWritable()).toBe(true)
    invalidateModelTargetProbe()
    expect(isModelRootWritable()).toBe(false)
  })
})

// ─── 3. Files already on disk NEVER move ─────────────────────────────────────

describe('resolveModelPath — existing files keep their root (no silent moves)', () => {
  it('a weight already in LEGACY keeps resolving to legacy, root writable or not', () => {
    const legacy = join(engineLegacyBase('llama'), 'phi.gguf')
    touch(legacy, 4096)
    expect(isModelRootWritable()).toBe(true)          // the root IS available…
    expect(resolveModelPath('llama', 'phi.gguf')).toBe(legacy) // …and is still not used
  })

  it('a RELOCATED weight resolves to the storage root', () => {
    const moved = join(engineNewBase('whisper'), 'ggml-base.en.bin')
    touch(moved, 4096)
    expect(resolveModelPath('whisper', 'ggml-base.en.bin')).toBe(moved)
  })

  it('the NEW root wins when the same weight exists in both (mid-abort relocation)', () => {
    touch(join(engineLegacyBase('llama'), 'dup.gguf'))
    touch(join(engineNewBase('llama'), 'dup.gguf'))
    expect(resolveModelPath('llama', 'dup.gguf')).toBe(join(engineNewBase('llama'), 'dup.gguf'))
  })

  it('a dir-based item already in legacy keeps resolving to legacy', () => {
    touch(join(engineLegacyBase('sd'), 'sd15', 'model.safetensors'), 2048)
    expect(resolveModelDir('sd', 'sd15')).toBe(join(engineLegacyBase('sd'), 'sd15'))
  })
})

// ─── 4. Multi-file items never split across drives ───────────────────────────

describe('resolveModelPath — longest-prefix anchoring', () => {
  it('a piper voice whose sidecar is in legacy resolves its .onnx to legacy too', () => {
    // The 2-file voice: only the tiny .onnx.json landed before (legacy install).
    touch(join(engineLegacyBase('piper'), 'en_US-amy', 'en_US-amy.onnx.json'), 200)
    expect(resolveModelPath('piper', 'en_US-amy', 'en_US-amy.onnx'))
      .toBe(join(engineLegacyBase('piper'), 'en_US-amy', 'en_US-amy.onnx'))
  })

  it('a relocated voice folder pulls a missing member to the storage root', () => {
    touch(join(engineNewBase('piper'), 'en_US-amy', 'en_US-amy.onnx.json'), 200)
    expect(resolveModelPath('piper', 'en_US-amy', 'en_US-amy.onnx'))
      .toBe(join(engineNewBase('piper'), 'en_US-amy', 'en_US-amy.onnx'))
  })

  it('a partially-installed sd model completes into the folder it already has', () => {
    touch(join(engineNewBase('sd'), 'flux', 'vae.safetensors'), 1024)
    expect(resolveModelDir('sd', 'flux')).toBe(join(engineNewBase('sd'), 'flux'))
    expect(resolveModelPath('sd', 'flux', 'clip_l.safetensors'))
      .toBe(join(engineNewBase('sd'), 'flux', 'clip_l.safetensors'))
  })
})

// ─── 5. The .part lives beside its final file ────────────────────────────────

describe('partPathFor — the partial download is SAME-DIR by derivation', () => {
  it('shares the destination directory (the landing rename cannot cross devices)', () => {
    for (const final of [
      resolveModelPath('llama', 'qwen3-4b.gguf'),
      resolveModelPath('whisper', 'ggml-large.bin'),
      join(resolveModelDir('sd', 'flux'), 'diffusion.gguf'),
      resolveModelPath('piper', 'en_US-amy', 'en_US-amy.onnx'),
    ]) {
      expect(dirname(partPathFor(final))).toBe(dirname(final))
    }
  })

  it('APPENDS the suffix so a .part never satisfies an engine extension gate', () => {
    const part = partPathFor(resolveModelPath('llama', 'qwen3-4b.gguf'))
    expect(part.endsWith(PART_SUFFIX)).toBe(true)
    expect(part.toLowerCase().endsWith('.gguf')).toBe(false)
    expect(isPartFileName('qwen3-4b.gguf.part')).toBe(true)
    expect(isPartFileName('qwen3-4b.gguf')).toBe(false)
  })

  it('follows the resolver: when the root is unwritable BOTH sides go legacy', () => {
    fsState.blocked.push({ prefix: ROOT, code: 'EPERM' })
    invalidateModelTargetProbe()
    const final = resolveModelPath('llama', 'qwen3-4b.gguf')
    const part = partPathFor(final)
    expect(dirname(part)).toBe(dirname(final))
    expect(final.startsWith(USERDATA)).toBe(true)
  })
})
