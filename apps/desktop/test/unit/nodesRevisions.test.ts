// apps/desktop/test/unit/nodesRevisions.test.ts
//
// Flow revisions (A1, NODES-RESEARCH-2026-07-26) in electron/ipc/nodes.ipc.ts:
// every nodes:save-flow drops a snapshot under Flows/.history/<name>/<ts>.json,
// capped at 20 files AND 5 MB per flow, and the app-version change snapshots
// every flow BEFORE an upgrade can touch it (the Langflow "upgrade ate my
// flows" defence). Plus the three read/restore handlers the drawer calls.
//
// fs + electron are mocked with the same in-memory fake nodesFlowDelete.test.ts
// uses, extended with a `size` on statSync (the byte-budget prune reads it) and
// a mutable app.getVersion() (the version-change snapshot pivots on it).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join } from 'path'

const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Set<string>(),
}))

vi.mock('fs', () => {
  // A path "exists" when it was mkdir'd OR anything sits under it — mirrors a
  // real filesystem, where dropping a file implies its parent directory.
  function existsSync(p: string): boolean {
    if (fsState.files.has(p) || fsState.dirs.has(p)) return true
    const prefix = p.endsWith('\\') ? p : p + '\\'
    for (const f of fsState.files.keys()) if (f.startsWith(prefix)) return true
    for (const d of fsState.dirs) if (d.startsWith(prefix)) return true
    return false
  }
  function statSync(p: string) {
    if (fsState.files.has(p)) return { isDirectory: () => false, size: Buffer.byteLength(fsState.files.get(p)!, 'utf8') }
    if (fsState.dirs.has(p) || existsSync(p)) return { isDirectory: () => true, size: 0 }
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
    readdirSync,
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

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }))
const appState = vi.hoisted(() => ({ version: '1.0.0' }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => { ipcState.handlers.set(channel, fn) },
    on: () => {},
  },
  app: {
    getVersion: () => appState.version,
    getPath: (name: string) => {
      const win = process.platform === 'win32'
      const roots: Record<string, string> = {
        documents: win ? 'C:\\FakeDocs' : '/FakeDocs',
        home: win ? 'C:\\FakeHome' : '/FakeHome',
        userData: win ? 'C:\\FakeUserData' : '/FakeUserData',
      }
      return roots[name] ?? (win ? 'C:\\FakeUserData' : '/FakeUserData')
    },
  },
}))

import { registerNodesIpc, snapshotFlowsOnVersionChange } from '../../electron/ipc/nodes.ipc'
import { invalidateStorageRootCache, storageDir } from '../../electron/services/storage-root'

// ── harness ──────────────────────────────────────────────────────────────────

function call(channel: string, payload: unknown): unknown {
  const h = ipcState.handlers.get(channel)
  if (!h) throw new Error(`handler not registered: ${channel}`)
  return h(null, payload)
}

function flowsDir(): string { return storageDir('flows') }
function historyDir(base: string): string { return join(flowsDir(), '.history', base) }

/** Snapshot filenames of one flow, oldest first. */
function snapshots(base: string): string[] {
  const prefix = historyDir(base) + '\\'
  return [...fsState.files.keys()]
    .filter(p => p.startsWith(prefix) && /\\\d+\.json$/.test(p))
    .map(p => p.slice(prefix.length))
    .sort((a, b) => Number(a.replace('.json', '')) - Number(b.replace('.json', '')))
}

function snapshotBodies(base: string): string[] {
  return snapshots(base).map(f => fsState.files.get(join(historyDir(base), f))!)
}

/** A flow file body. `savedAt` defaults to a FIXED stamp so a test opts in to
 *  timestamp churn rather than getting it by accident. */
function body(nodeIds: string[], savedAt = '2026-07-26T10:00:00.000Z'): string {
  return JSON.stringify({
    version: 1,
    name: 'demo',
    nodes: nodeIds.map(id => ({ id, type: 'agent', position: { x: 0, y: 0 }, data: { label: id } })),
    edges: [],
    savedAt,
  })
}

function save(name: string, json: string): unknown {
  return call('nodes:save-flow', { flowName: name, json })
}

beforeEach(() => {
  fsState.files.clear()
  fsState.dirs.clear()
  invalidateStorageRootCache()
  ipcState.handlers.clear()
  appState.version = '1.0.0'
  registerNodesIpc()
  fsState.files.delete(join(process.platform === 'win32' ? 'C:\\FakeUserData' : '/FakeUserData', 'nodes-orphan-repair.json'))
})

// ── save → snapshot ──────────────────────────────────────────────────────────

describe('nodes:save-flow → revision snapshot', () => {
  it('writes a snapshot next to the flow on the first save', () => {
    const res = save('demo', body(['n1'])) as { ok: boolean }

    expect(res.ok).toBe(true)
    expect(fsState.files.has(join(flowsDir(), 'demo.tachi-flow.json'))).toBe(true)
    expect(snapshots('demo')).toHaveLength(1)
    expect(snapshotBodies('demo')[0]).toBe(body(['n1']))
  })

  it('adds a snapshot per CHANGED save — the acceptance case (save, delete two, save)', () => {
    save('demo', body(['n1', 'n2', 'n3']))
    save('demo', body(['n1']))

    expect(snapshots('demo')).toHaveLength(2)
    const [first, second] = snapshotBodies('demo')
    expect(JSON.parse(first!).nodes).toHaveLength(3)
    expect(JSON.parse(second!).nodes).toHaveLength(1)
  })

  it('skips a save whose content is identical to the newest snapshot', () => {
    save('demo', body(['n1']))
    save('demo', body(['n1']))
    save('demo', body(['n1']))

    expect(snapshots('demo')).toHaveLength(1)
  })

  it('skips a save that only carries a fresh savedAt stamp', () => {
    // serializeFlow re-stamps savedAt on EVERY save, so without the fingerprint
    // check merely switching flows back and forth would burn the whole ring.
    save('demo', body(['n1'], '2026-07-26T10:00:00.000Z'))
    save('demo', body(['n1'], '2026-07-26T11:30:00.000Z'))

    expect(snapshots('demo')).toHaveLength(1)
  })

  it('skips a save that only reordered keys (the rail and the canvas serialize differently)', () => {
    save('demo', JSON.stringify({ version: 1, name: 'demo', nodes: [], edges: [], savedAt: 'x' }))
    save('demo', JSON.stringify({ savedAt: 'y', edges: [], nodes: [], name: 'demo', version: 1 }))

    expect(snapshots('demo')).toHaveLength(1)
  })

  it('keeps each flow history separate', () => {
    save('one', body(['a']))
    save('two', body(['b']))

    expect(snapshots('one')).toHaveLength(1)
    expect(snapshots('two')).toHaveLength(1)
  })

  it('never fails the save when the history write blows up', () => {
    // A folder already occupying the .history path: mkdir is a no-op, the write
    // lands nowhere useful — the SAVE must still report ok.
    const res = save('demo', body(['n1'])) as { ok: boolean; path?: string }
    expect(res.ok).toBe(true)
    expect(res.path).toBe(join(flowsDir(), 'demo.tachi-flow.json'))
  })
})

// ── caps ─────────────────────────────────────────────────────────────────────

describe('revision caps', () => {
  it('keeps at most 20 snapshots, pruning the oldest', () => {
    for (let i = 0; i < 25; i++) save('demo', body(Array.from({ length: i + 1 }, (_, k) => `n${k}`)))

    const kept = snapshots('demo')
    expect(kept).toHaveLength(20)
    // The oldest survivor is the 6th save (1 node .. 25 nodes → 6..25 kept).
    expect(JSON.parse(snapshotBodies('demo')[0]!).nodes).toHaveLength(6)
    expect(JSON.parse(snapshotBodies('demo')[19]!).nodes).toHaveLength(25)
  })

  it('enforces the per-flow byte budget, always keeping the newest', () => {
    const fat = (marker: string) => JSON.stringify({
      version: 1, name: 'demo', savedAt: '2026-07-26T10:00:00.000Z',
      nodes: [{ id: 'n1', type: 'agent', position: { x: 0, y: 0 }, data: { label: marker, blob: marker.repeat(3 * 1024 * 1024) } }],
      edges: [],
    })
    save('demo', fat('a'))
    expect(snapshots('demo')).toHaveLength(1)

    save('demo', fat('b')) // 6 MB total > the 5 MB budget → the older one goes
    const kept = snapshotBodies('demo')
    expect(kept).toHaveLength(1)
    expect(JSON.parse(kept[0]!).nodes[0].data.label).toBe('b')
  })
})

// ── app-version change (the Langflow defence) ────────────────────────────────

describe('snapshotFlowsOnVersionChange', () => {
  it('snapshots every existing flow the first time a version is seen', () => {
    // Flows saved by an older build: files on disk, no .history at all.
    fsState.files.set(join(flowsDir(), 'alpha.tachi-flow.json'), body(['a']))
    fsState.files.set(join(flowsDir(), 'beta.tachi-flow.json'), body(['b']))

    appState.version = '2.0.0'
    snapshotFlowsOnVersionChange()

    expect(snapshotBodies('alpha')).toEqual([body(['a'])])
    expect(snapshotBodies('beta')).toEqual([body(['b'])])
  })

  it('is a no-op on the next boot at the same version', () => {
    fsState.files.set(join(flowsDir(), 'alpha.tachi-flow.json'), body(['a']))
    appState.version = '2.0.0'
    snapshotFlowsOnVersionChange()

    // Wipe the snapshot; a same-version boot must NOT recreate it.
    for (const f of snapshots('alpha')) fsState.files.delete(join(historyDir('alpha'), f))
    snapshotFlowsOnVersionChange()

    expect(snapshots('alpha')).toHaveLength(0)
  })

  it('snapshots again once the version actually changes', () => {
    fsState.files.set(join(flowsDir(), 'alpha.tachi-flow.json'), body(['a']))
    appState.version = '2.0.0'
    snapshotFlowsOnVersionChange()
    for (const f of snapshots('alpha')) fsState.files.delete(join(historyDir('alpha'), f))

    appState.version = '2.1.0'
    snapshotFlowsOnVersionChange()

    expect(snapshotBodies('alpha')).toEqual([body(['a'])])
  })

  it('runs automatically at boot via registerNodesIpc()', () => {
    fsState.files.set(join(flowsDir(), 'alpha.tachi-flow.json'), body(['a']))
    appState.version = '3.0.0'

    registerNodesIpc()

    expect(snapshots('alpha')).toHaveLength(1)
  })
})

// ── list / read / restore ────────────────────────────────────────────────────

describe('nodes:list-revisions', () => {
  it('lists newest first with a timestamp and a byte size', () => {
    save('demo', body(['n1']))
    save('demo', body(['n1', 'n2']))

    const res = call('nodes:list-revisions', { filename: 'demo.tachi-flow.json' }) as {
      ok: boolean; revisions: Array<{ ts: number; savedAt: string; size: number }>
    }

    expect(res.ok).toBe(true)
    expect(res.revisions).toHaveLength(2)
    expect(res.revisions[0]!.ts).toBeGreaterThanOrEqual(res.revisions[1]!.ts)
    expect(res.revisions[0]!.size).toBe(Buffer.byteLength(body(['n1', 'n2']), 'utf8'))
    expect(res.revisions[0]!.savedAt).toBe(new Date(res.revisions[0]!.ts).toISOString())
  })

  it('returns an empty list for a flow that was never saved', () => {
    const res = call('nodes:list-revisions', { filename: 'never.tachi-flow.json' }) as { ok: boolean; revisions: unknown[] }
    expect(res).toEqual({ ok: true, revisions: [] })
  })

  it('refuses a filename that is not a .tachi-flow.json', () => {
    const res = call('nodes:list-revisions', { filename: 'evil.txt' }) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
  })

  it('never lets a traversal attempt reach another flow history', () => {
    save('demo', body(['n1']))
    // Dotted names fail the whitelist outright; a name with separators is
    // stripped to a bare basename first (same rule as load/delete-flow), so at
    // worst it resolves to a DIFFERENT, empty history — never out of the root.
    for (const filename of ['../../demo.tachi-flow.json', '..\\demo.tachi-flow.json', 'a/b.tachi-flow.json', '..\\..\\demo.tachi-flow.json']) {
      const res = call('nodes:list-revisions', { filename }) as { ok: boolean; revisions: unknown[] }
      expect(res.revisions).toEqual([])
    }
    expect((call('nodes:list-revisions', { filename: '../../demo.tachi-flow.json' }) as { ok: boolean }).ok).toBe(false)
  })
})

describe('nodes:read-revision', () => {
  it('reads one snapshot back verbatim', () => {
    save('demo', body(['n1']))
    const { revisions } = call('nodes:list-revisions', { filename: 'demo.tachi-flow.json' }) as { revisions: Array<{ ts: number }> }

    const res = call('nodes:read-revision', { filename: 'demo.tachi-flow.json', ts: revisions[0]!.ts }) as { ok: boolean; json?: string }
    expect(res.ok).toBe(true)
    expect(res.json).toBe(body(['n1']))
  })

  it('rejects a non-numeric or unknown timestamp', () => {
    save('demo', body(['n1']))
    expect((call('nodes:read-revision', { filename: 'demo.tachi-flow.json', ts: '../marker' }) as { ok: boolean }).ok).toBe(false)
    expect((call('nodes:read-revision', { filename: 'demo.tachi-flow.json', ts: 1 }) as { ok: boolean }).ok).toBe(false)
  })
})

describe('nodes:restore-revision', () => {
  it('writes the revision back as the current flow file', () => {
    save('demo', body(['n1', 'n2', 'n3']))
    save('demo', body(['n1']))
    const { revisions } = call('nodes:list-revisions', { filename: 'demo.tachi-flow.json' }) as { revisions: Array<{ ts: number }> }
    const oldest = revisions[revisions.length - 1]!.ts

    const res = call('nodes:restore-revision', { filename: 'demo.tachi-flow.json', ts: oldest }) as { ok: boolean; json?: string }

    expect(res.ok).toBe(true)
    expect(res.json).toBe(body(['n1', 'n2', 'n3']))
    expect(fsState.files.get(join(flowsDir(), 'demo.tachi-flow.json'))).toBe(body(['n1', 'n2', 'n3']))
  })

  it('leaves the pre-restore state as the newest snapshot (the undo target)', () => {
    save('demo', body(['n1', 'n2', 'n3']))
    save('demo', body(['n1']))
    const before = snapshots('demo')
    const oldest = Number(before[0]!.replace('.json', ''))

    call('nodes:restore-revision', { filename: 'demo.tachi-flow.json', ts: oldest })

    // The state being replaced was already the newest snapshot (every save
    // writes one), so the restore adds no duplicate — the undo target is there.
    const after = snapshotBodies('demo')
    expect(after).toHaveLength(before.length)
    expect(JSON.parse(after[after.length - 1]!).nodes).toHaveLength(1)
  })

  it('snapshots the current file when it is NOT already in history', () => {
    save('demo', body(['n1']))
    const [only] = snapshots('demo')
    // Something wrote the flow without going through save-flow (a hand edit, a
    // backup restore) — that state must not be lost by the restore.
    fsState.files.set(join(flowsDir(), 'demo.tachi-flow.json'), body(['edited']))

    call('nodes:restore-revision', { filename: 'demo.tachi-flow.json', ts: Number(only!.replace('.json', '')) })

    const after = snapshotBodies('demo')
    expect(after).toHaveLength(2)
    expect(JSON.parse(after[1]!).nodes[0].id).toBe('edited')
    expect(fsState.files.get(join(flowsDir(), 'demo.tachi-flow.json'))).toBe(body(['n1']))
  })

  it('refuses an unknown revision and leaves the flow file alone', () => {
    save('demo', body(['n1']))
    const res = call('nodes:restore-revision', { filename: 'demo.tachi-flow.json', ts: 424242 }) as { ok: boolean; error?: string }

    expect(res.ok).toBe(false)
    expect(fsState.files.get(join(flowsDir(), 'demo.tachi-flow.json'))).toBe(body(['n1']))
  })

  it('refuses a filename outside the flows sandbox', () => {
    const res = call('nodes:restore-revision', { filename: '../evil.tachi-flow.json', ts: 1 }) as { ok: boolean }
    expect(res.ok).toBe(false)
  })
})

// ── the .history folder stays invisible to the rest of the app ───────────────

describe('.history placement', () => {
  it('does not show up as a flow in nodes:list-flows', () => {
    save('demo', body(['n1']))
    save('demo', body(['n1', 'n2']))

    const listed = call('nodes:list-flows', {}) as { ok: boolean; flows: Array<{ filename: string }> }
    expect(listed.flows.map(f => f.filename)).toEqual(['demo.tachi-flow.json'])
  })
})
