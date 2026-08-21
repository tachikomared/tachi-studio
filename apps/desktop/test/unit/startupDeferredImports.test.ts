// apps/desktop/test/unit/startupDeferredImports.test.ts
//
// R8b — GUARD for the deferred-import work, and for the R8a instrumentation
// that has to survive to prove its delta.
//
// THE MEASUREMENT THIS PINS (R8b baseline, installed build, 2026-07-27):
// exe → window-ready is 1793 ms, and 1317 ms of that lands BEFORE main.ts's own
// first statement — it is the hoisted import graph, evaluated by the bundler
// above `const STARTUP_T0 = performance.now()`. Of that prelude, 505 ms is 34
// hoisted external `require()`s. These ones were measured individually and are
// now loaded on first use instead of at boot:
//
//     @inngest/agent-kit                        98-101 ms
//     typescript                                   90 ms
//     @modelcontextprotocol/sdk server entries     62.6 ms
//     express                                      47.7 ms
//     systeminformation                            41.5 ms
//     electron-updater                             34.4 ms
//     yaml                                         13.8 ms
//     libsodium-wrappers                           12.4 ms
//     @modelcontextprotocol/sdk client entries      — (see below)
//
// The SDK *client* entries measured ~0.1 ms each only because mcp-server.ts had
// already paid for the shared SDK internals earlier in the bundle's load order.
// Defer the server entries alone and ~60 ms simply relocates onto the client
// ones — so they are pinned here together, deliberately.
//
// WHY A STATIC-GRAPH TEST AND NOT JUST A per-file grep: electron-vite bundles
// electron/ into ONE out/main/index.js. If ANY module still reachable from
// main.ts by a static value import pulls a package in, rollup hoists it into
// the entry chunk and the deferral silently evaporates — the code still looks
// lazy at the call site while costing exactly what it cost before. The only
// honest check is over the whole reachable graph, which is what suite 1 does.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// A CI runner spawning a real shell — under a virus scanner on windows-latest —
// routinely needs more than vitest's 5s default, and a test that times out while
// its child is still alive turns the next test's temp-directory cleanup into
// EBUSY. The allowance is per file on purpose: raising it globally was measured
// to break four sd/media suites that share real temp directories.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const DESKTOP = fileURLToPath(new URL('../../', import.meta.url))
const ELECTRON = join(DESKTOP, 'electron')
const MAIN = join(ELECTRON, 'main.ts')

// ─── static import-graph walker ───────────────────────────────────────────────

/**
 * Static `import`/`export … from` specifiers of one file, TYPE-ONLY statements
 * excluded (they are erased before the bundler sees them) and `import()` /
 * `require()` excluded (they are the thing we are asking for).
 *
 * Multiline-aware on purpose: `import {\n  createAgent,\n} from '@inngest/agent-kit'`
 * is exactly the shape that a single-line regex misses, and it was one of the
 * two real agent-kit import sites.
 */
export function staticImportsOf(src: string): string[] {
  const re = /(?:^|\n)[ \t]*(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const stmt = m[0]
    if (/^\s*(?:import|export)\s+type\s/.test(stmt)) continue
    out.push(m[1]!)
  }
  return out
}

function resolveLocal(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec)
  for (const cand of [base + '.ts', base + '.tsx', join(base, 'index.ts'), base + '.js', base]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand
  }
  return null
}

interface Graph {
  /** every first-party file reachable from main.ts by static value imports */
  files: Set<string>
  /** bare package specifier → the first-party files that statically import it */
  externals: Map<string, string[]>
}

function walkBootGraph(): Graph {
  const files = new Set<string>([MAIN])
  const externals = new Map<string, string[]>()
  const queue: string[] = [MAIN]
  while (queue.length) {
    const file = queue.shift()!
    let src: string
    try { src = readFileSync(file, 'utf8') } catch { continue }
    for (const spec of staticImportsOf(src)) {
      if (spec.startsWith('.')) {
        const r = resolveLocal(file, spec)
        if (!r || files.has(r)) continue
        files.add(r)
        queue.push(r)
      } else {
        const hits = externals.get(spec) ?? []
        hits.push(file)
        externals.set(spec, hits)
      }
    }
  }
  return { files, externals }
}

const rel = (f: string) => relative(DESKTOP, f).split(sep).join('/')

/** Package specifiers that must NOT be on the boot path any more. */
const DEFERRED = [
  '@inngest/agent-kit',
  '@inngest/ai',
  'typescript',
  'express',
  'systeminformation',
  'electron-updater',
  'yaml',
  'libsodium-wrappers',
  '@modelcontextprotocol/sdk/server/index.js',
  '@modelcontextprotocol/sdk/server/streamableHttp.js',
  '@modelcontextprotocol/sdk/types.js',
  '@modelcontextprotocol/sdk/client/index.js',
  '@modelcontextprotocol/sdk/client/stdio.js',
  '@modelcontextprotocol/sdk/client/streamableHttp.js',
] as const

describe('R8b · deferred imports are off the static boot graph', () => {
  const graph = walkBootGraph()

  it('walks a real graph (guards against a regex/resolver that silently finds nothing)', () => {
    // 260+ first-party files were reachable when this was written; a walker that
    // broke would collapse toward 1 and make every assertion below vacuous.
    expect(graph.files.size).toBeGreaterThan(200)
    expect(graph.externals.size).toBeGreaterThan(20)
    // zod is deliberately STILL static (36+ ipc modules build schemas at module
    // scope — see the follow-up note in this file's header comment). It is the
    // positive control: if the walker stops seeing zod, it has stopped working,
    // not the codebase that got faster.
    expect(graph.externals.has('zod')).toBe(true)
  })

  for (const pkg of DEFERRED) {
    it(`does not statically import ${pkg} from main.ts`, () => {
      const importers = (graph.externals.get(pkg) ?? []).map(rel)
      expect(importers, [
        '',
        `${pkg} is statically reachable from electron/main.ts again, via:`,
        ...importers.map(i => `  ${i}`),
        '',
        'electron-vite bundles electron/ into ONE out/main/index.js, so ANY static',
        'value import anywhere in the reachable graph hoists this package above',
        'STARTUP_T0 and puts its whole load cost back on every boot — even if the',
        'call site still looks lazy. Load it with `await import()` (relative) or a',
        "bare `require()` (package) at FIRST USE instead. See the measured cost",
        'table at the top of this file.',
      ].join('\n')).toEqual([])
    })
  }
})

// ─── suite 2: the lazy loader is actually present at each site ────────────────
//
// The graph test above proves the package left the boot path. These prove it
// left by being DEFERRED rather than by being deleted — a lazy load must still
// exist in the file that owns the feature.

const readEl = (p: string) => readFileSync(join(ELECTRON, p), 'utf8')

describe('R8b · each deferral kept a first-use loader', () => {
  const sites: Array<{ file: string; loader: RegExp; what: string }> = [
    { file: 'services/auto-update.ts',      loader: /require\(['"]electron-updater['"]\)/,            what: 'electron-updater' },
    { file: 'services/hardware-info.ts',    loader: /import\(['"]systeminformation['"]\)/,            what: 'systeminformation' },
    { file: 'services/sidecar-manager.ts',  loader: /import\(['"]\.\/mcp-server['"]\)/,               what: './mcp-server (express + SDK server entries)' },
    { file: 'services/mcp-manager.ts',      loader: /import\(['"]@modelcontextprotocol\/sdk\/client\/index\.js['"]\)/, what: 'SDK client' },
    { file: 'ipc/graph.ipc.ts',             loader: /import\(['"]@modelcontextprotocol\/sdk\/client\/index\.js['"]\)/, what: 'SDK client' },
    { file: 'services/design-generate.ts',  loader: /require\(['"]typescript['"]\)/,                  what: 'typescript' },
    { file: 'services/graph-to-agentkit.ts',loader: /require\(['"]@inngest\/agent-kit['"]\)/,         what: 'agent-kit factories' },
    { file: 'services/graph-tools.ts',      loader: /require\(['"]@inngest\/agent-kit['"]\)/,         what: 'agent-kit createTool' },
    { file: 'services/aeon-service.ts',     loader: /import\(['"]libsodium-wrappers['"]\)/,           what: 'libsodium' },
    { file: 'services/role-registry.ts',    loader: /require\(['"]yaml['"]\)/,                        what: 'yaml' },
    { file: 'services/provider-registry.ts',loader: /require\(['"]yaml['"]\)/,                        what: 'yaml' },
  ]

  for (const { file, loader, what } of sites) {
    it(`electron/${file} still loads ${what} on first use`, () => {
      expect(loader.test(readEl(file)), `electron/${file} lost its lazy loader for ${what}`).toBe(true)
    })
  }

  it('relative deferrals use import(), never require() — the bundle has no ./mcp-server at runtime', () => {
    // Belt-and-braces alongside noRuntimeRelativeRequire.test.ts: the ONE
    // relative module this batch deferred must not regress to a require().
    expect(/require\(\s*['"`]\.{1,2}\//.test(readEl('services/sidecar-manager.ts'))).toBe(false)
  })
})

// ─── suite 3: the R8a instrumentation survives ────────────────────────────────
//
// The whole point of deferring is to move a number that R8a prints. If the
// marks disappear, the next measured build cannot prove the delta and this
// batch becomes unfalsifiable.

describe('R8b · R8a startup instrumentation is intact', () => {
  const main = readFileSync(MAIN, 'utf8')

  it('still reads STARTUP_T0 as the first statement of main.ts body', () => {
    expect(main).toMatch(/const STARTUP_T0 = performance\.now\(\)/)
  })

  it('still emits ONE [startup] summary line, idempotently', () => {
    expect(main).toMatch(/\[startup\] .*total=\$\{total\}ms/)
    expect(main).toMatch(/if \(startupSummaryLogged\) return/)
  })

  it('reports the PRELUDE, which is the window R8b actually moved', () => {
    // `total` starts at STARTUP_T0, which the bundler places AFTER the whole
    // hoisted import graph — so it cannot see a single millisecond this batch
    // saved. `boot` (a bare performance.now(), ~13 ms after process start in
    // main) minus `total` is the prelude. Drop this and the next measured build
    // prints an unchanged number and the batch becomes unfalsifiable.
    expect(main).toMatch(/const boot = Math\.round\(performance\.now\(\)\)/)
    expect(main).toMatch(/boot=\$\{boot\}ms prelude=\$\{boot - total\}ms/)
  })

  for (const mark of [
    'module-eval-end',
    'app-ready',
    'window-construct-begin',
    'window-created',
    'ipc-registration-begin',
    'ipc-registration-end',
    'when-ready-end',
    'first-did-finish-load',
  ]) {
    it(`still marks ${mark}`, () => {
      expect(main).toContain(`startupMark('${mark}')`)
    })
  }

  it('still times the async subsystem starts it timed before', () => {
    for (const phase of ['mcp-server-start', 'api-server-start', 'create-window']) {
      expect(main).toContain(`'${phase}'`)
    }
  })
})

// ─── suite 4: first use still works, with the heavy module mocked ─────────────
//
// TWO MOCKING MECHANISMS, because this batch uses two deferral mechanisms and
// they are intercepted at different layers:
//
//   `await import('pkg')`  → vite-node's ESM resolver → `vi.mock` works.
//   `require('pkg')`       → Node's CJS loader, which vitest does NOT see.
//                            `vi.mock` is silently ignored and the REAL package
//                            loads (that is how this file was written the first
//                            time, and the real electron-updater promptly blew
//                            up on a stubbed `app`). Intercept Module._load.
//
// The require() sites are deliberate: they keep setupAutoUpdate / compileGraph /
// ct() / buildRegistry SYNCHRONOUS so no call-site signature had to change.

const loadMocks = new Map<string, unknown>()
let restoreLoad: (() => void) | null = null

/** Intercept Node's CJS loader so a runtime `require('pkg')` gets our double. */
function installCjsMock(spec: string, exports: unknown): void {
  loadMocks.set(spec, exports)
  if (restoreLoad) return
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Module = require('module') as { _load(r: string, p: unknown, m: boolean): unknown }
  const real = Module._load
  Module._load = function (request: string, parent: unknown, isMain: boolean) {
    if (loadMocks.has(request)) return loadMocks.get(request)
    return real.call(this, request, parent, isMain)
  }
  restoreLoad = () => { Module._load = real; restoreLoad = null }
}

function makeUpdaterDouble() {
  const listeners = new Map<string, Array<(arg: never) => void>>()
  return {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    logger: null as unknown,
    on(evt: string, fn: (arg: never) => void) {
      listeners.set(evt, [...(listeners.get(evt) ?? []), fn]); return this
    },
    emit(evt: string, arg: unknown) { for (const fn of listeners.get(evt) ?? []) fn(arg as never) },
    checkForUpdates: vi.fn(async () => ({ updateInfo: { version: '9.9.9' } })),
    downloadUpdate:  vi.fn(async () => []),
    quitAndInstall:  vi.fn(),
  }
}

vi.mock('systeminformation', () => ({
  graphics: vi.fn(async () => ({
    controllers: [
      { model: 'Meta Virtual Monitor', vendor: 'Meta', vram: 0 },
      { model: 'GeForce RTX 4090',     vendor: 'NVIDIA', vram: 24576 },
    ],
  })),
  cpu: vi.fn(async () => ({ cores: 32 })),
}))

vi.mock('electron', () => ({
  app: { getPath: () => DESKTOP, getAppPath: () => DESKTOP, isPackaged: false, on: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}))

// The ONE relative deferral in this batch. The factory below runs the first
// time ./mcp-server is imported by anyone — so `evaluated` is a RUNTIME probe
// for "did importing sidecar-manager pull the express + SDK tree in?", which is
// the exact question the 110 ms saving depends on.
const mcpServerProbe = vi.hoisted(() => ({ evaluated: false, stopped: 0, rotated: 0 }))
vi.mock('../../electron/services/mcp-server', () => {
  mcpServerProbe.evaluated = true
  return {
    startMcpServer: vi.fn(async () => ({
      port: 7421,
      stop: async () => { mcpServerProbe.stopped++ },
    })),
    rotateMcpToken: vi.fn(() => { mcpServerProbe.rotated++ }),
  }
})

describe('R8b · deferred modules still work at first use', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { restoreLoad?.(); loadMocks.clear() })

  it('auto-update: the whole updater surface works off ONE lazy require', async () => {
    // The double is installed BEFORE the first call, which is the point: nothing
    // in the module reached for electron-updater at import time.
    const autoUpdater = makeUpdaterDouble()
    installCjsMock('electron-updater', { autoUpdater })

    const { setupAutoUpdate, checkForUpdates, downloadUpdate, quitAndInstall } =
      await import('../../electron/services/auto-update')

    const sent: unknown[] = []
    const win = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (_c: string, p: unknown) => sent.push(p) },
    }
    setupAutoUpdate(win as never)

    // Configuration the boot-time import used to apply.
    expect(autoUpdater.autoDownload).toBe(false)
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true)
    expect(autoUpdater.logger).toBeTruthy()

    // The renderer push path is live.
    autoUpdater.emit('update-available', { version: '9.9.9' })
    expect(sent).toEqual([{ state: 'available', version: '9.9.9' }])

    // The manual routes reach the same lazily-loaded singleton.
    downloadUpdate()
    quitAndInstall()
    expect(autoUpdater.downloadUpdate).toHaveBeenCalled()
    expect(autoUpdater.quitAndInstall).toHaveBeenCalled()

    // …and classification of a feed-less build is unchanged (the C3 audit bug:
    // a packaged build must never report "up to date" when it cannot check).
    autoUpdater.checkForUpdates
      .mockRejectedValueOnce(new Error('ENOENT: no such file or directory, open app-update.yml'))
    await expect(checkForUpdates()).resolves.toEqual({ state: 'unconfigured' })
    autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('socket hang up'))
    await expect(checkForUpdates()).resolves.toEqual({ state: 'error', message: 'socket hang up' })
    await expect(checkForUpdates()).resolves.toEqual({ state: 'current' })
  })

  it('auto-update: a broken electron-updater throws at FIRST USE, not at import', async () => {
    // The behaviour contract for every deferral in this batch: importing the
    // owning module must not be what fails, and the failure must still reach the
    // caller rather than being swallowed into a silently dead feature.
    vi.resetModules()   // drop the memoized handle the previous test installed
    const mod = await import('../../electron/services/auto-update')   // must not throw
    installCjsMock('electron-updater', new Proxy({}, {
      get() { throw new Error('Cannot find module electron-updater') },
    }))
    expect(() => mod.quitAndInstall()).toThrow(/Cannot find module electron-updater/)
  })

  it('sidecar-manager: importing it does NOT pull ./mcp-server (express + SDK server) in', async () => {
    // The 110 ms claim in one assertion: main.ts reaches sidecar-manager through
    // ten different ipc modules, and none of them may cost the MCP server tree.
    expect(mcpServerProbe.evaluated).toBe(false)
    const mgr = await import('../../electron/services/sidecar-manager')
    expect(mcpServerProbe.evaluated).toBe(false)
    expect(mgr.getMcpHandle()).toBeNull()
  })

  it('sidecar-manager: startInProcessMcp loads it on demand and still yields a handle', async () => {
    const mgr = await import('../../electron/services/sidecar-manager')
    const mcpServer = await import('../../electron/services/mcp-server')

    await mgr.startInProcessMcp()
    expect(mcpServerProbe.evaluated).toBe(true)
    expect(mcpServer.startMcpServer).toHaveBeenCalledTimes(1)
    expect(mgr.getMcpHandle()).toMatchObject({ port: 7421 })

    // De-dup still holds: a second start must not re-enter the server module.
    await mgr.startInProcessMcp()
    expect(mcpServer.startMcpServer).toHaveBeenCalledTimes(1)

    // …and the rotate path reaches the same lazily-loaded module.
    await mgr.rotateInProcessMcpToken()
    expect(mcpServerProbe.rotated).toBe(1)
    expect(mgr.getMcpHandle()).toMatchObject({ port: 7421 })

    await mgr.stopInProcessMcp()
    expect(mgr.getMcpHandle()).toBeNull()
  })

  it('hardware-info: detectHardware still probes through the dynamic si import', async () => {
    const si = await import('systeminformation')
    const { detectHardware } = await import('../../electron/services/hardware-info')

    const hw = await detectHardware()
    // Ranking survived: the real card outranks the virtual monitor.
    expect(hw.gpus[0]!.model).toBe('GeForce RTX 4090')
    expect(hw.cpuCores).toBe(32)
    expect(hw.vramFreeBytes).toBe(24576 * 1024 * 1024)

    // The expensive probe is still memoized — a second call must not re-import
    // or re-probe (that cache is why the Catalog grid stopped sitting blank).
    const callsAfterFirst = (si.graphics as ReturnType<typeof vi.fn>).mock.calls.length
    await detectHardware()
    expect((si.graphics as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst)
  })

  it('graph-tools: buildAgentTools still reaches agent-kit createTool', async () => {
    const createTool = vi.fn((def: unknown) => ({ __tool: def }))
    installCjsMock('@inngest/agent-kit', { createTool })

    const { buildAgentTools } = await import('../../electron/services/graph-tools')
    const tools = buildAgentTools({
      workspaceRoot: DESKTOP,
      allowed: new Set(['read', 'glob']),
      internet: false,
    })

    expect(tools.length).toBeGreaterThan(0)
    // Every tool came back through the lazy require, not from a stale binding.
    expect(createTool.mock.calls.length).toBe(tools.length)
    for (const t of tools) expect(t).toHaveProperty('__tool')
    const names = createTool.mock.calls.map(c => (c[0] as { name: string }).name)
    expect(names).toContain('read_file')
  })

  it('graph-to-agentkit: compileGraph still reaches the agent-kit factories', async () => {
    const createAgent   = vi.fn((def: unknown) => ({ __agent: def }))
    const createNetwork = vi.fn((def: unknown) => ({ __network: def }))
    const createState   = vi.fn((data: unknown) => ({ __state: data }))
    installCjsMock('@inngest/agent-kit', {
      createAgent, createNetwork, createState, createTool: vi.fn(d => ({ __tool: d })),
    })

    const { compileGraph } = await import('../../electron/services/graph-to-agentkit')
    const compiled = compileGraph({
      name: 'lazy-load-probe',
      nodes: [{
        id: 'a1', type: 'agent', position: { x: 0, y: 0 },
        data: { label: 'Solo', harnessId: 'tachi' },
      }],
      edges: [],
    } as never)

    expect(createAgent).toHaveBeenCalledTimes(1)
    expect(createState).toHaveBeenCalledTimes(1)
    expect(createNetwork).toHaveBeenCalledTimes(1)
    expect(compiled.entryAgentId).toBe('a1')
  })

  it('graph-to-agentkit: a structurally invalid flow still throws BEFORE any load', async () => {
    // The validation order is load-bearing: compileGraph's actionable error
    // messages must not be preceded by a module-resolution failure.
    const createAgent = vi.fn()
    installCjsMock('@inngest/agent-kit', { createAgent })
    const { compileGraph } = await import('../../electron/services/graph-to-agentkit')
    expect(() => compileGraph({ name: 'broken' } as never)).toThrow(/invalid TachiFlow/)
    expect(createAgent).not.toHaveBeenCalled()
  })

  it('graph-tools: nothing granted ⇒ agent-kit is never loaded at all', async () => {
    const createTool = vi.fn((def: unknown) => ({ __tool: def }))
    installCjsMock('@inngest/agent-kit', { createTool })

    const { buildAgentTools } = await import('../../electron/services/graph-tools')
    expect(buildAgentTools({ allowed: new Set(), internet: false })).toEqual([])
    expect(createTool).not.toHaveBeenCalled()
  })

  it('yaml: the registries still parse through their lazy require', async () => {
    const { listRoles } = await import('../../electron/services/role-registry')
    const roles = listRoles()
    expect(roles.length).toBeGreaterThan(0)
    expect(roles[0]).toHaveProperty('id')
  })

  it('typescript: the deferred compiler still transpiles TSX the way the design tab needs', async () => {
    // compileComposition() is module-private, so this pins the exact contract
    // the lazy require has to satisfy: classic JSX (React.createElement, no
    // jsx-runtime import) so the output drops into the Babel-free scaffold.
    const ts = require('typescript') as typeof import('typescript')
    const out = ts.transpileModule('export const C = () => <div className="x" />', {
      compilerOptions: {
        jsx: ts.JsxEmit.React,
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
        isolatedModules: true,
      },
    }).outputText
    expect(out).toContain('React.createElement')
    expect(out).not.toContain('react/jsx-runtime')
  })
})
