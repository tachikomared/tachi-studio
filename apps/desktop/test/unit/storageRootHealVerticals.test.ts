// apps/desktop/test/unit/storageRootHealVerticals.test.ts
//
// LANE L — every MAIN-PROCESS writer of user content under the storage root now
// goes through the storage-root heal contract, not a bare fs call. This file
// proves it per VERTICAL (design assets, kokoro TTS takes, design audio import,
// flow rename/restore) plus the two new primitives those verticals lean on:
//
//   ensureStorageDir(kind, sub)  — the mkdir-step heal: writers whose bytes are
//     produced by something else (sd-cli, piper, yt-dlp, ffmpeg, Remotion) or
//     who drop MANY files into one folder heal ONCE, before the batch starts.
//   openStorageWriteStream(...)  — the streamed-write variant: pre-heal, plus a
//     single reopen when the OPEN itself is refused. Mid-write failures are
//     deliberately OUT of the contract (documented in storage-root.ts).
//
// Same in-memory-fs idiom as storageRootWriteRetry.test.ts (that file owns the
// primitive's own semantics): CFA is modelled as "existsSync keeps telling the
// truth, writes just fail", by PREFIX. Windows-shaped on purpose — the CFA copy
// is a Windows claim.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { join } from 'path'

// vi.hoisted, NOT plain consts: the vi.mock('electron') factory below reads
// these, and vitest hoists mock factories above module-level declarations —
// plain consts are still in their TDZ when the factory runs, which failed the
// whole file at COLLECTION ("Cannot access 'DOCS' before initialization") and
// silently zeroed this suite's coverage.
const { DOCS, HOME, USERDATA } = vi.hoisted(() => ({
  DOCS: 'C:\\FakeDocs',
  HOME: 'C:\\FakeHome',
  USERDATA: 'C:\\FakeUserData',
}))

type Block = {
  prefix: string
  code: string
  /** 'stream' blocks only createWriteStream (writeFileSync still works). */
  mode?: 'all' | 'stream'
  /** Let the first N writeFileSync calls under `prefix` through, then bite —
   *  models CFA switching on BETWEEN the writability probe and the real write. */
  afterWrites?: number
}

const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Set<string>(),
  /** Path prefixes whose writes fail, with the errno to throw. */
  blocked: [] as Array<{ prefix: string; code: string; mode?: 'all' | 'stream'; afterWrites?: number }>,
  /** Every writeFileSync target, in order. */
  writes: [] as string[],
  /** Every createWriteStream target, in order — proves "reopened ONCE". */
  streamOpens: [] as string[],
}))

vi.mock('fs', () => {
  function existsSync(p: string): boolean {
    if (fsState.files.has(p) || fsState.dirs.has(p)) return true
    const prefix = p.endsWith('\\') ? p : p + '\\'
    for (const f of fsState.files.keys()) if (f.startsWith(prefix)) return true
    for (const d of fsState.dirs) if (d.startsWith(prefix)) return true
    return false
  }
  function blockFor(p: string, kind: 'write' | 'stream'): { code: string } | null {
    for (const b of fsState.blocked) {
      const applies = (b.mode ?? 'all') === 'all' || (b.mode === 'stream' && kind === 'stream')
      if (!applies || !p.toLowerCase().startsWith(b.prefix.toLowerCase())) continue
      if (typeof b.afterWrites === 'number' && kind === 'write' && b.afterWrites > 0) {
        b.afterWrites--   // this write is one of the grace writes → let it through
        continue
      }
      return b
    }
    return null
  }
  function errno(code: string, p: string): NodeJS.ErrnoException {
    const err = new Error(`${code}: blocked ${p}`) as NodeJS.ErrnoException
    err.code = code
    return err
  }
  function statSync(p: string) {
    if (fsState.files.has(p)) return { isDirectory: () => false, isFile: () => true, size: fsState.files.get(p)!.length }
    if (fsState.dirs.has(p) || existsSync(p)) return { isDirectory: () => true, isFile: () => false, size: 0 }
    throw errno('ENOENT', p)
  }
  return {
    existsSync,
    statSync,
    readdirSync: (p: string) => {
      const prefix = p.endsWith('\\') ? p : p + '\\'
      const names = new Set<string>()
      for (const f of fsState.files.keys()) {
        if (f.startsWith(prefix)) {
          const rest = f.slice(prefix.length)
          if (!rest.includes('\\')) names.add(rest)
        }
      }
      return [...names]
    },
    // CFA blocks creation INSIDE a protected folder, but the dirs there already
    // exist — so mkdir "succeeds" and only writes fail (that is what made the
    // live ENOENT so confusing).
    mkdirSync: (p: string) => { fsState.dirs.add(p) },
    writeFileSync: (p: string, content: string | Uint8Array) => {
      fsState.writes.push(p)
      const b = blockFor(p, 'write')
      if (b) throw errno(b.code, p)
      fsState.files.set(p, typeof content === 'string' ? content : Buffer.from(content).toString('utf8'))
    },
    readFileSync: (p: string) => {
      if (!fsState.files.has(p)) throw errno('ENOENT', p)
      return fsState.files.get(p)!
    },
    rmSync: (p: string) => { fsState.files.delete(p); fsState.dirs.delete(p) },
    copyFileSync: (src: string, dest: string) => {
      if (!fsState.files.has(src)) throw errno('ENOENT', src)
      fsState.writes.push(dest)
      const b = blockFor(dest, 'write')
      if (b) throw errno(b.code, dest)
      fsState.files.set(dest, fsState.files.get(src)!)
    },
    // Node reports a failed stream OPEN asynchronously, on the 'error' event —
    // the fake does the same so the reopen path is exercised for real.
    createWriteStream: (p: string) => {
      fsState.streamOpens.push(p)
      const ws = new EventEmitter() as EventEmitter & { destroy(): void; write(c: string): void; end(): void }
      ws.destroy = () => {}
      ws.write = (c: string) => { fsState.files.set(p, (fsState.files.get(p) ?? '') + c) }
      ws.end = () => {}
      const b = blockFor(p, 'stream')
      queueMicrotask(() => {
        if (b) ws.emit('error', errno(b.code, p))
        else { fsState.files.set(p, ''); ws.emit('open', 1) }
      })
      return ws
    },
  }
})

type Handler = (event: unknown, payload: unknown) => unknown
const ipcState = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }))

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.0.0',
    getPath: (name: string) => ({ documents: DOCS, home: HOME, userData: USERDATA, temp: 'C:\\FakeTemp' }[name] ?? USERDATA),
  },
  ipcMain: {
    handle: (channel: string, fn: Handler) => { ipcState.handlers.set(channel, fn) },
    on: () => {},
  },
}))

// No settings file in the fake fs → loadSettings falls through to the defaults.
vi.mock('../../electron/services/settings-store', () => ({ loadSettings: () => ({}) }))
// design-audio's only heavy dependency; synthesis itself is not under test.
vi.mock('../../electron/services/piper-client', () => ({
  synthesize: async () => ({ path: 'C:\\FakeTemp\\piper-out.wav', b64: '', mime: 'audio/wav' }),
}))
vi.mock('../../electron/ipc/privacy.ipc', () => ({ getCurrentPrivacyMode: () => 'open' }))

import {
  getStorageRoot, invalidateStorageRootCache, ensureStorageDir, copyStorageFile,
  openStorageWriteStream, CFA_ERROR_TAG,
} from '../../electron/services/storage-root'
import { addDesignAsset } from '../../electron/services/design-assets'
import { importDesignAudio } from '../../electron/services/design-audio'
import { saveWavToMediaLibrary } from '../../electron/services/kokoro-tts'
import { registerNodesIpc } from '../../electron/ipc/nodes.ipc'

const DOCS_ROOT = join(DOCS, 'Tachi Studio')
const HOME_ROOT = join(HOME, 'Tachi Studio')

/** Simulate Controlled Folder Access over the whole Documents tree. */
function blockDocuments(code = 'EPERM', mode: Block['mode'] = 'all'): void {
  fsState.blocked.push({ prefix: DOCS, code, mode })
}
/** The pathological case: nothing on the machine accepts a write any more. */
function blockEverything(code = 'EPERM'): void {
  fsState.blocked.push({ prefix: 'C:\\', code })
}

beforeEach(() => {
  fsState.files.clear()
  fsState.dirs.clear()
  fsState.blocked.length = 0
  fsState.writes.length = 0
  fsState.streamOpens.length = 0
  ipcState.handlers.clear()
  invalidateStorageRootCache()
})

// ── ensureStorageDir: the mkdir-step heal ───────────────────────────────────
//
// This is what covers every writer whose bytes are produced by a process we do
// not control (sd-cli, piper, yt-dlp, ffmpeg, Remotion): by the time THEY fail
// there is nothing left to retry, so the root has to move BEFORE they start.

describe('ensureStorageDir', () => {
  it('returns the plain subfolder when the root is healthy', () => {
    expect(ensureStorageDir('media', 'sd')).toBe(join(DOCS_ROOT, 'Media', 'sd'))
  })

  it('heals to the fallback root when the cached root turned unwritable', () => {
    expect(getStorageRoot()).toBe(DOCS_ROOT) // cached at "boot"
    blockDocuments()

    expect(ensureStorageDir('media', 'sd')).toBe(join(HOME_ROOT, 'Media', 'sd'))
    // …and the healed root is now the session's root, so the NEXT writer that
    // joins onto storageDir()/getStorageRoot() follows it without probing again.
    expect(getStorageRoot()).toBe(HOME_ROOT)
  })

  it('creates the healed folder so the external process can write into it', () => {
    getStorageRoot()
    blockDocuments()
    const dir = ensureStorageDir('renders')
    expect(fsState.dirs.has(dir)).toBe(true)
  })

  it('never throws when NOTHING is writable — the caller\'s own write reports it', () => {
    getStorageRoot()
    blockEverything()
    expect(() => ensureStorageDir('media', 'piper')).not.toThrow()
  })
})

// ── copyStorageFile ─────────────────────────────────────────────────────────

describe('copyStorageFile', () => {
  beforeEach(() => { fsState.files.set('C:\\src\\clip.mp4', 'BYTES') })

  it('re-probes and retries ONCE against the healed root', () => {
    expect(getStorageRoot()).toBe(DOCS_ROOT)
    blockDocuments()
    fsState.writes.length = 0

    const dest = copyStorageFile('assets', 'clip.mp4', 'C:\\src\\clip.mp4')

    expect(dest).toBe(join(HOME_ROOT, 'Design Assets', 'clip.mp4'))
    expect(fsState.files.get(dest)).toBe('BYTES')
    expect(fsState.writes.filter(w => w.endsWith('clip.mp4'))).toHaveLength(2) // one blocked, one landed
  })

  it('reports a missing SOURCE as itself — never as Controlled Folder Access', () => {
    let err: unknown
    try { copyStorageFile('assets', 'x.mp4', 'C:\\src\\gone.mp4') } catch (e) { err = e }
    expect((err as NodeJS.ErrnoException).code).toBe('ENOENT')
    expect((err as Error).message).not.toContain(CFA_ERROR_TAG)
  })

  it('names Controlled Folder Access when nothing can be written', () => {
    getStorageRoot()
    blockEverything()
    let err: unknown
    try { copyStorageFile('assets', 'clip.mp4', 'C:\\src\\clip.mp4') } catch (e) { err = e }
    expect((err as Error).message.startsWith(CFA_ERROR_TAG)).toBe(true)
    expect((err as Error).message).toContain('Controlled Folder Access')
  })
})

// ── openStorageWriteStream ──────────────────────────────────────────────────

describe('openStorageWriteStream', () => {
  it('pre-heals: a blocked root moves the stream BEFORE the first byte', async () => {
    expect(getStorageRoot()).toBe(DOCS_ROOT)
    blockDocuments()

    const { stream, path } = await openStorageWriteStream('media', join('downloads', 'big.mp4'))
    stream.write('CHUNK')

    expect(path).toBe(join(HOME_ROOT, 'Media', 'downloads', 'big.mp4'))
    // The stream was never even opened under the blocked root.
    expect(fsState.streamOpens.filter(p => p.startsWith(DOCS))).toEqual([])
    expect(fsState.files.get(path)).toBe('CHUNK')
  })

  it('reopens ONCE on the healed root when the OPEN itself is refused', async () => {
    // The race the reopen exists for: CFA arms BETWEEN the pre-heal probe and
    // the open, so the probe passes and the open is refused anyway.
    expect(getStorageRoot()).toBe(DOCS_ROOT)
    fsState.blocked.push({ prefix: DOCS, code: 'EPERM', afterWrites: 1 })

    const { path } = await openStorageWriteStream('media', 'big.mp4')

    expect(path).toBe(join(HOME_ROOT, 'Media', 'big.mp4'))
    expect(fsState.streamOpens).toEqual([
      join(DOCS_ROOT, 'Media', 'big.mp4'),   // refused
      join(HOME_ROOT, 'Media', 'big.mp4'),   // reopened — exactly once
    ])
  })

  it('surfaces the CFA message when the reopen has nowhere to land', async () => {
    getStorageRoot()
    blockEverything()
    await expect(openStorageWriteStream('media', 'big.mp4')).rejects.toThrow(/Controlled Folder Access/)
  })

  it('rethrows a non-permission open failure untouched', async () => {
    getStorageRoot()
    fsState.blocked.push({ prefix: DOCS, code: 'ENOSPC', mode: 'stream' })
    await expect(openStorageWriteStream('media', 'big.mp4')).rejects.toThrow(/ENOSPC/)
    expect(getStorageRoot()).toBe(DOCS_ROOT) // an unrelated failure must not move data
  })
})

// ── Vertical: design assets (Design tab → attach media) ─────────────────────

describe('design assets vertical', () => {
  it('lands an attached asset under the healed root, still reporting ok', () => {
    getStorageRoot()
    blockDocuments()

    const r = addDesignAsset({ name: 'clip.mp4', bytes: new Uint8Array([1, 2, 3]) })

    expect(r).toMatchObject({ ok: true, name: 'clip.mp4', relPath: 'assets/clip.mp4' })
    expect(fsState.files.has(join(HOME_ROOT, 'Design Assets', 'clip.mp4'))).toBe(true)
  })

  it('copies a path-attached asset through the same heal', () => {
    fsState.files.set('C:\\src\\loop.gif', 'GIF')
    getStorageRoot()
    blockDocuments()

    const r = addDesignAsset({ path: 'C:\\src\\loop.gif' })

    expect(r.ok).toBe(true)
    expect(fsState.files.get(join(HOME_ROOT, 'Design Assets', 'loop.gif'))).toBe('GIF')
  })

  it('surfaces the CFA message through its OWN { ok:false, error } shape', () => {
    getStorageRoot()
    blockEverything()

    const r = addDesignAsset({ name: 'clip.mp4', bytes: new Uint8Array([1, 2, 3]) })

    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toContain('Controlled Folder Access')
  })
})

// ── Vertical: kokoro TTS takes (Media tab → save WAV) ────────────────────────

// A minimal 44-byte RIFF/WAVE header — kokoro's magic check rejects anything
// shorter, and the save path is what is under test, not the audio.
const WAV = Buffer.concat([
  Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVE'), Buffer.from('fmt '),
  Buffer.alloc(28), // rest of a canonical header
]).toString('base64')

describe('kokoro save-wav vertical', () => {
  it('saves the take under the healed root and returns THAT path', () => {
    getStorageRoot()
    blockDocuments()

    const r = saveWavToMediaLibrary({ b64: WAV, name: 'take.wav' })

    expect(r.ok).toBe(true)
    expect(r.path).toBe(join(HOME_ROOT, 'Media', 'kokoro', 'take.wav'))
    expect(fsState.files.has(r.path!)).toBe(true)
  })

  it('surfaces the CFA message through its { ok:false, error } shape', () => {
    getStorageRoot()
    blockEverything()

    const r = saveWavToMediaLibrary({ b64: WAV, name: 'take.wav' })

    expect(r.ok).toBe(false)
    expect(r.error).toContain('Controlled Folder Access')
  })
})

// ── Vertical: design audio import (Voiceover panel) ──────────────────────────

describe('design audio vertical', () => {
  it('imports into the healed audio dir and returns the path actually written', () => {
    fsState.files.set('C:\\src\\vo take.wav', 'RIFF')
    getStorageRoot()
    blockDocuments()

    const r = importDesignAudio('C:\\src\\vo take.wav')

    expect(r.path).toBe(join(HOME_ROOT, 'Audio', r.file))
    expect(fsState.files.has(r.path)).toBe(true)
  })

  it('throws the CFA-tagged error (the IPC turns it into { ok:false, error })', () => {
    fsState.files.set('C:\\src\\vo.wav', 'RIFF')
    getStorageRoot()
    blockEverything()

    expect(() => importDesignAudio('C:\\src\\vo.wav')).toThrow(/Controlled Folder Access/)
  })
})

// ── Vertical: flow rename / restore (Nodes canvas) ───────────────────────────

function call(channel: string, payload: unknown): unknown {
  const h = ipcState.handlers.get(channel)
  if (!h) throw new Error(`handler not registered: ${channel}`)
  return h(null, payload)
}

describe('flow rename/restore vertical', () => {
  beforeEach(() => {
    registerNodesIpc()
    fsState.blocked.length = 0
  })

  it('renames into the healed root and reports the new filename', () => {
    call('nodes:save-flow', { flowName: 'demo', json: '{"name":"demo"}' })
    expect(getStorageRoot()).toBe(DOCS_ROOT)
    blockDocuments()

    const r = call('nodes:rename-flow', { filename: 'demo.tachi-flow.json', newName: 'renamed' }) as
      { ok: boolean; filename?: string; error?: string }

    expect(r).toMatchObject({ ok: true, filename: 'renamed.tachi-flow.json' })
    expect(fsState.files.has(join(HOME_ROOT, 'Flows', 'renamed.tachi-flow.json'))).toBe(true)
  })

  it('restores a revision into the healed root', () => {
    call('nodes:save-flow', { flowName: 'demo', json: '{"v":1}' })
    call('nodes:save-flow', { flowName: 'demo', json: '{"v":2}' })
    const revs = (call('nodes:list-revisions', { filename: 'demo.tachi-flow.json' }) as
      { revisions: Array<{ ts: number }> }).revisions
    expect(revs.length).toBeGreaterThan(0)

    getStorageRoot()
    blockDocuments()
    const r = call('nodes:restore-revision', { filename: 'demo.tachi-flow.json', ts: revs[revs.length - 1]!.ts }) as
      { ok: boolean; json?: string }

    expect(r.ok).toBe(true)
    expect(fsState.files.has(join(HOME_ROOT, 'Flows', 'demo.tachi-flow.json'))).toBe(true)
  })

  it('surfaces the CFA message through nodes:rename-flow\'s { ok:false, error }', () => {
    call('nodes:save-flow', { flowName: 'demo', json: '{"name":"demo"}' })
    getStorageRoot()
    blockEverything()

    const r = call('nodes:rename-flow', { filename: 'demo.tachi-flow.json', newName: 'renamed' }) as
      { ok: boolean; error?: string }

    expect(r.ok).toBe(false)
    expect(r.error).toContain('Controlled Folder Access')
  })
})
