// apps/desktop/test/unit/nodesFlowDelete.test.ts
//
// nodes:delete-flow must remove a saved flow from BOTH the storage-root dir
// (Documents\Tachi Studio\Flows — where new saves land) and the legacy
// userData\nodes dir (pre-storage-root saves), tolerating either copy already
// being missing. Leaving one behind lets nodes:list-flows "resurrect" a flow
// the user just deleted, because it reads the storage root directly (the
// PRIMARY location for new saves, not merely a migration target).
//
// Also covers repairKnownOrphanFlows() — the one-time boot repair for the
// single known casualty of an earlier (fixed) version of this bug.
//
// fs + electron are mocked with a tiny in-memory fake so no real disk is
// touched; electron.app.getPath resolves to fake roots so storage-root.ts's
// directory-walk + write-probe logic runs unmodified (same shape of coverage
// as installLock.test.ts, extended with mutable state via vi.hoisted).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join } from 'path'

const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Set<string>(),
}))

vi.mock('fs', () => {
  // A directory-like path "exists" if it was explicitly mkdir'd OR it has any
  // file/dir placed under it — mirrors a real filesystem, where dropping a
  // file into a path implies its parent directory is there too (our nodes
  // ipc code never mkdir's the legacy dir — "never created; never written
  // to" — so tests that seed a legacy file directly need this to make
  // existsSync(legacyDir) true, exactly like the real userData\nodes dir
  // would be on a machine with pre-storage-root flows already on disk).
  function existsSync(p: string): boolean {
    if (fsState.files.has(p) || fsState.dirs.has(p)) return true
    const prefix = p.endsWith('\\') ? p : p + '\\'
    for (const f of fsState.files.keys()) if (f.startsWith(prefix)) return true
    for (const d of fsState.dirs) if (d.startsWith(prefix)) return true
    return false
  }
  function statSync(p: string) {
    if (fsState.dirs.has(p) || (existsSync(p) && !fsState.files.has(p))) return { isDirectory: () => true }
    if (fsState.files.has(p)) return { isDirectory: () => false }
    const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException
    err.code = 'ENOENT'
    throw err
  }
  function readdirSync(p: string) {
    const prefix = p.endsWith('\\') ? p : p + '\\'
    const names = new Set<string>()
    for (const f of fsState.files.keys()) {
      if (f.startsWith(prefix)) {
        const rest = f.slice(prefix.length)
        if (!rest.includes('\\')) names.add(rest)
      }
    }
    return [...names]
  }
  return {
    existsSync,
    statSync,
    mkdirSync: (p: string) => { fsState.dirs.add(p) },
    writeFileSync: (p: string, content: string) => { fsState.files.set(p, content) },
    readFileSync: (p: string) => {
      if (!fsState.files.has(p)) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      }
      return fsState.files.get(p)!
    },
    rmSync: (p: string) => {
      const hadFile = fsState.files.delete(p)
      const hadDir = fsState.dirs.delete(p)
      if (!hadFile && !hadDir) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      }
    },
    readdirSync,
    copyFileSync: (src: string, dest: string) => {
      if (!fsState.files.has(src)) {
        const err = new Error(`ENOENT: ${src}`) as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      }
      fsState.files.set(dest, fsState.files.get(src)!)
    },
  }
})

type Handler = (event: unknown, payload: unknown) => unknown

// ipcMain.handle is captured straight into this map by the mock below — no
// vi.fn()/mockImplementation typing gymnastics against electron's real
// Electron.IpcMain type, which the `import { ipcMain } from 'electron'`
// statement would otherwise pull in.
const ipcState = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => { ipcState.handlers.set(channel, fn) },
    on: () => {},
  },
  app: {
    getPath: (name: string) => {
      const roots: Record<string, string> = {
        documents: 'C:\\FakeDocs',
        home: 'C:\\FakeHome',
        userData: 'C:\\FakeUserData',
      }
      return roots[name] ?? 'C:\\FakeUserData'
    },
  },
}))

import { registerNodesIpc, repairKnownOrphanFlows } from '../../electron/ipc/nodes.ipc'
import { invalidateStorageRootCache, storageDir, legacyDir } from '../../electron/services/storage-root'

// ── harness ──────────────────────────────────────────────────────────────────

function call(channel: string, payload: unknown): unknown {
  const h = ipcState.handlers.get(channel)
  if (!h) throw new Error(`handler not registered: ${channel}`)
  return h(null, payload)
}

function storageFlowsDir(): string { return storageDir('flows') }
function legacyFlowsDir(): string { return legacyDir('flows') }

beforeEach(() => {
  fsState.files.clear()
  fsState.dirs.clear()
  invalidateStorageRootCache()
  ipcState.handlers.clear()
  registerNodesIpc()
  // registerNodesIpc() just ran the boot repair against an empty fsState,
  // which writes the "already repaired" marker even though nothing was
  // there to repair. Clear it so each test starts from a genuine
  // "never repaired" install and controls the marker itself when relevant.
  fsState.files.delete(join('C:\\FakeUserData', 'nodes-orphan-repair.json'))
})

// ── nodes:delete-flow — both copies ─────────────────────────────────────────

describe('nodes:delete-flow', () => {
  it('deletes the storage-root AND legacy copies when both exist', () => {
    const name = 'demo.tachi-flow.json'
    fsState.files.set(join(storageFlowsDir(), name), '{"name":"demo"}')
    fsState.files.set(join(legacyFlowsDir(), name), '{"name":"demo"}')

    const res = call('nodes:delete-flow', { filename: name })

    expect(res).toEqual({ ok: true })
    expect(fsState.files.has(join(storageFlowsDir(), name))).toBe(false)
    expect(fsState.files.has(join(legacyFlowsDir(), name))).toBe(false)
  })

  it('tolerates an already-missing storage-root copy (legacy-only flow)', () => {
    const name = 'legacy-only.tachi-flow.json'
    fsState.files.set(join(legacyFlowsDir(), name), '{"name":"legacy-only"}')

    const res = call('nodes:delete-flow', { filename: name })

    expect(res).toEqual({ ok: true })
    expect(fsState.files.has(join(legacyFlowsDir(), name))).toBe(false)
  })

  it('tolerates an already-missing legacy copy (storage-root-only flow)', () => {
    const name = 'new-only.tachi-flow.json'
    fsState.files.set(join(storageFlowsDir(), name), '{"name":"new-only"}')

    const res = call('nodes:delete-flow', { filename: name })

    expect(res).toEqual({ ok: true })
    expect(fsState.files.has(join(storageFlowsDir(), name))).toBe(false)
  })

  it('does not resurrect the deleted flow on the next nodes:list-flows call', () => {
    const name = 'gone.tachi-flow.json'
    fsState.files.set(join(storageFlowsDir(), name), '{"name":"gone"}')
    fsState.files.set(join(legacyFlowsDir(), name), '{"name":"gone"}')

    call('nodes:delete-flow', { filename: name })
    const listed = call('nodes:list-flows', {}) as { ok: true; flows: Array<{ filename: string }> }

    expect(listed.flows.find(f => f.filename === name)).toBeUndefined()
  })

  it('rejects filenames that are not .tachi-flow.json and touches nothing', () => {
    const res = call('nodes:delete-flow', { filename: 'not-a-flow.txt' }) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('.tachi-flow.json')
  })
})

// ── repairKnownOrphanFlows — one-time boot repair ───────────────────────────

describe('repairKnownOrphanFlows (boot-time)', () => {
  const orphanName = 'Brainstorm-and-decide.tachi-flow.json'

  it('removes the known orphan when it has no userData/legacy counterpart', () => {
    fsState.files.set(join(storageFlowsDir(), orphanName), '{"name":"Brainstorm and decide"}')

    repairKnownOrphanFlows()

    expect(fsState.files.has(join(storageFlowsDir(), orphanName))).toBe(false)
  })

  it('leaves it alone when a legacy/userData counterpart still exists (not an orphan)', () => {
    fsState.files.set(join(storageFlowsDir(), orphanName), '{"name":"Brainstorm and decide"}')
    fsState.files.set(join(legacyFlowsDir(), orphanName), '{"name":"Brainstorm and decide"}')

    repairKnownOrphanFlows()

    expect(fsState.files.has(join(storageFlowsDir(), orphanName))).toBe(true)
  })

  it('is a no-op on an install that never had the orphan', () => {
    expect(() => repairKnownOrphanFlows()).not.toThrow()
    expect(fsState.files.has(join(storageFlowsDir(), orphanName))).toBe(false)
  })

  it('runs at most once per install: a same-named flow saved after the repair survives a later boot', () => {
    fsState.files.set(join(storageFlowsDir(), orphanName), '{"name":"orphan"}')
    repairKnownOrphanFlows() // first boot: repairs the real orphan, writes the marker

    // The user later legitimately saves a NEW flow under the exact same
    // sanitized name. A second boot (e.g. app restart) must NOT delete it.
    fsState.files.set(join(storageFlowsDir(), orphanName), '{"name":"Brainstorm and decide"}')
    repairKnownOrphanFlows()

    expect(fsState.files.has(join(storageFlowsDir(), orphanName))).toBe(true)
  })

  it('registerNodesIpc() runs the repair automatically at boot', () => {
    fsState.files.set(join(storageFlowsDir(), orphanName), '{"name":"orphan"}')

    registerNodesIpc()

    expect(fsState.files.has(join(storageFlowsDir(), orphanName))).toBe(false)
  })
})
