// apps/desktop/test/unit/rifeWiring.test.ts
//
// SOURCE + BEHAVIOUR ASSERTIONS for the things the other two RIFE suites cannot
// see: where these modules sit in the static import graph, whether the two ends
// of each wire agree on a channel name, and — the load-bearing one — whether
// this vertical can reach the network AT ALL.
//
// ── THE ZERO-EGRESS CLAIM IS CHECKED, NOT ASSERTED ───────────────────────────
//
// The product claim is "frame interpolation is local, so PRIVATE MODE does not
// block it". That claim is only worth making if the code CANNOT talk to the
// network, so this file proves it structurally: rife-plan and rife-runner
// import no network module and name no network API, and the IPC handler
// consults no egress gate. A module with no way to open a socket cannot leak,
// and that is a property a reviewer can re-check in one grep — unlike "we
// checked and it doesn't".
//
// The installer is the deliberate exception: downloading the sidecar IS egress,
// and it follows the normal download rules (https-only, pinned url, sha256).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP = fileURLToPath(new URL('../../', import.meta.url))
const ELECTRON = join(DESKTOP, 'electron')
const MAIN = join(ELECTRON, 'main.ts')
const read = (p: string) => readFileSync(join(DESKTOP, p), 'utf8')

// ── the same static-import walker the other wiring suites use ─────────────────

function staticImportsOf(src: string): string[] {
  const re = /(?:^|\n)[ \t]*(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    if (/^\s*(?:import|export)\s+type\s/.test(m[0])) continue
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

function bootGraph(): { files: Set<string>; externals: Set<string> } {
  const files = new Set<string>([MAIN])
  const externals = new Set<string>()
  const queue = [MAIN]
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
        externals.add(spec)
      }
    }
  }
  return { files, externals }
}

const rel = (f: string) => relative(DESKTOP, f).split(sep).join('/')

const RIFE_FILES = [
  'electron/services/rife-plan.ts',
  'electron/services/rife-paths.ts',
  'electron/services/rife-installer.ts',
  'electron/services/rife-runner.ts',
  'electron/ipc/rife.ipc.ts',
]

/** Source with comments stripped — a doc comment naming an API is not a CALL. */
function code(path: string): string {
  return read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

// ── 1. registration ───────────────────────────────────────────────────────────

describe('the RIFE IPC is registered WITHOUT touching main.ts', () => {
  const graph = bootGraph()
  const files = [...graph.files].map(rel)

  it('walks a real graph (guards against a walker that silently finds nothing)', () => {
    expect(graph.files.size).toBeGreaterThan(200)
    expect(files).toContain('electron/ipc/sd-cpp.ipc.ts')
  })

  it('main.ts does not import rife.ipc, directly or by name', () => {
    const main = read('electron/main.ts')
    expect(staticImportsOf(main).some(s => s.includes('rife'))).toBe(false)
    expect(main).not.toContain('registerRifeIpc')
    expect(main).not.toContain('rife.ipc')
  })

  it('main.ts DOES stop in-flight runs on quit — dynamically, so the rule above holds', () => {
    // The orphan the will-quit fix exists for: closing the window left
    // rife-ncnn-vulkan/ffmpeg holding the GPU and a multi-gigabyte frame
    // directory in %TEMP%. main.ts may not NAME a rife module statically (the
    // test above), so the handle is fetched with an `import()` during startup —
    // will-quit cannot await, and a handle fetched inside it would arrive one
    // microtask after the process began tearing down.
    const main = read('electron/main.ts')
    expect(main).toMatch(/import\(['"]\.\/services\/rife-runner['"]\)/)
    expect(main).toContain('m.cancelAllRifeRuns')

    const willQuit = main.slice(main.indexOf("app.on('will-quit'"))
    expect(willQuit).toContain('stopRifeRuns?.()')
    // sd-cli is the other half of the same orphan.
    expect(willQuit).toContain('cancelGeneration()')
    // Both cancels are issued BEFORE the rest of the teardown can throw.
    expect(willQuit.indexOf('cancelGeneration()')).toBeLessThan(willQuit.indexOf('destroyTray()'))
    expect(willQuit.indexOf('stopRifeRuns?.()')).toBeLessThan(willQuit.indexOf('destroyTray()'))
    // …and the quit is then held open, but ONLY when something was condemned and
    // ONLY for a bounded grace. Measured on Windows: a taskkill whose parent
    // exits immediately does not land (libuv's KILL_ON_JOB_CLOSE takes it too),
    // so issuing the kill without holding the quit would be a coin flip.
    expect(willQuit).toContain('waits.length > 0')
    expect(willQuit).toContain('e.preventDefault()')
    expect(willQuit).toContain('app.quit()')
    const cap = /QUIT_KILL_GRACE_MS = ([\d_]+)/.exec(main)
    expect(cap, 'the grace period must be a named, bounded constant').toBeTruthy()
    expect(Number(cap![1]!.replace(/_/g, ''))).toBeLessThanOrEqual(5_000)
  })

  it('sd-cpp.ipc.ts imports registerRifeIpc AND calls it inside the registrar', () => {
    const src = read('electron/ipc/sd-cpp.ipc.ts')
    expect(src).toMatch(/import \{ registerRifeIpc \} from '\.\/rife\.ipc'/)
    // Inside the function, not at module scope: ipcMain.handle before app-ready
    // throws, which is a crash on boot rather than a missing feature.
    const body = src.slice(src.indexOf('export function registerSdCppIpc'))
    expect(body).toContain('registerRifeIpc(win)')
  })

  it('every RIFE file IS reachable from main.ts — registered, not orphaned', () => {
    for (const f of RIFE_FILES) expect(files, f).toContain(f)
  })

  it('puts NO new external package on the boot path', () => {
    // The prelude R8b shrank by 81% is protected by this: a new dependency
    // reachable from main.ts is hoisted above STARTUP_T0 and costs every boot.
    for (const f of RIFE_FILES) {
      for (const e of staticImportsOf(read(f)).filter(s => !s.startsWith('.'))) {
        expect(['electron', 'zod', 'fs', 'path', 'child_process'], `${f} imports ${e}`).toContain(e)
      }
    }
  })

  it('keeps design-hf-render (and its @tachi/core graph) OFF the boot path', () => {
    // The ffmpeg resolver is reused via a dynamic import for exactly this
    // reason; a static one here would drag the Remotion/core graph into the
    // prelude for a feature most sessions never touch.
    const runner = read('electron/services/rife-runner.ts')
    expect(staticImportsOf(runner)).not.toContain('./design-hf-render')
    expect(runner).toMatch(/import\(['"]\.\/design-hf-render['"]\)/)
  })

  it('uses no relative require() (the bundle has no relative modules at runtime)', () => {
    for (const f of RIFE_FILES) {
      expect(/require\(\s*['"`]\.{1,2}\//.test(read(f)), f).toBe(false)
    }
  })
})

// ── 2. zero egress ────────────────────────────────────────────────────────────

describe('the run path CANNOT reach the network', () => {
  // Everything a RUN executes. The installer is excluded on purpose:
  // downloading the sidecar IS egress, and follows the normal download rules.
  const RUN_PATH = [
    'electron/services/rife-plan.ts',
    'electron/services/rife-paths.ts',
    'electron/services/rife-runner.ts',
  ]

  it('imports no network module, transitively, on the run path', () => {
    const banned = ['http', 'https', 'net', 'tls', 'dgram', 'node:http', 'node:https', 'node:net', 'node-fetch', 'undici', 'axios']
    const seen = new Set<string>()
    const queue = RUN_PATH.map(f => join(DESKTOP, f))
    while (queue.length) {
      const file = queue.shift()!
      if (seen.has(file)) continue
      seen.add(file)
      let src: string
      try { src = readFileSync(file, 'utf8') } catch { continue }
      for (const spec of staticImportsOf(src)) {
        if (spec.startsWith('.')) {
          const r = resolveLocal(file, spec)
          if (r) queue.push(r)
          continue
        }
        expect(banned, `${rel(file)} imports ${spec}`).not.toContain(spec)
      }
    }
    // The walk must have actually visited something beyond the seeds.
    expect(seen.size).toBeGreaterThan(RUN_PATH.length)
  })

  it('names no network API in its own source', () => {
    for (const f of RUN_PATH) {
      const src = code(f)
      expect(/\bfetch\s*\(/.test(src), `${f} calls fetch`).toBe(false)
      expect(/\bXMLHttpRequest\b/.test(src), f).toBe(false)
      expect(/httpsGet|https\.get|http\.request/.test(src), f).toBe(false)
      expect(/\bnet\.Socket\b/.test(src), f).toBe(false)
    }
  })

  it('refuses to hand ffmpeg a remote path — the one way a URL could get out', () => {
    // ffmpeg WILL open an http(s) URL. localVideoRefusal is what stands between
    // a renderer-supplied string and that behaviour, so the source must show
    // the guard being applied before anything is spawned.
    const runner = read('electron/services/rife-runner.ts')
    const guardAt = runner.indexOf('localVideoRefusal(')
    const spawnAt = runner.indexOf('spawn(')
    expect(guardAt).toBeGreaterThan(0)
    expect(guardAt).toBeLessThan(spawnAt)
  })

  it('is NOT gated by PRIVATE MODE — a local computation must keep working', () => {
    // Comments are stripped first: this file's own header EXPLAINS why there is
    // no egress gate, and a naive substring match would fail on that sentence.
    for (const f of ['electron/ipc/rife.ipc.ts', ...RUN_PATH]) {
      const src = code(f)
      expect(/checkUrlEgressSafe\s*\(/.test(src), `${f} calls checkUrlEgressSafe`).toBe(false)
      expect(src, f).not.toContain('egress-policy')
      expect(src, f).not.toContain('privacy-mode')
    }
  })

  it('the INSTALLER, which is allowed egress, still only knows the pinned https url', () => {
    const plan = read('electron/services/rife-plan.ts')
    const urls = [...plan.matchAll(/https?:\/\/[^\s'"`]+/g)].map(m => m[0])
    expect(urls.length).toBeGreaterThan(0)
    for (const u of urls) {
      expect(u.startsWith('https://github.com/nihui/rife-ncnn-vulkan/'), u).toBe(true)
    }
    // The installer must not build a URL of its own.
    expect(read('electron/services/rife-installer.ts')).not.toMatch(/https?:\/\//)
  })
})

// ── 3. preload ↔ main ─────────────────────────────────────────────────────────

describe('preload and main agree on the channel names', () => {
  const preload = read('electron/preload.ts')
  const ipc = read('electron/ipc/rife.ipc.ts')

  it('exposes tachi.rife', () => {
    expect(preload).toMatch(/\n {2}rife: \{/)
  })

  it('every channel the preload invokes is handled in main, and vice versa', () => {
    const invoked = [...preload.matchAll(/invoke\('(rife:[a-z-]+)'/g)].map(m => m[1]!)
    const handled = [...ipc.matchAll(/ipcMain\.handle\('(rife:[a-z-]+)'/g)].map(m => m[1]!)
    expect([...new Set(invoked)].sort()).toEqual([...new Set(handled)].sort())
    expect([...new Set(handled)].sort()).toEqual(
      ['rife:cancel', 'rife:install', 'rife:interpolate', 'rife:status', 'rife:uninstall'],
    )
  })

  it('subscribes to both push channels main actually sends on', () => {
    for (const ch of ['rife:install-progress', 'rife:progress']) {
      expect(preload, ch).toContain(`ipcRenderer.on('${ch}'`)
      expect(preload, ch).toContain(`ipcRenderer.off('${ch}'`)
    }
    expect(read('electron/services/rife-installer.ts')).toContain("send('rife:install-progress'")
    expect(read('electron/services/rife-runner.ts')).toContain("send('rife:progress'")
  })

  it('validates the renderer\'s payload rather than trusting it', () => {
    // `path` crosses from the renderer and becomes an argv. zod first, guard
    // second — neither alone is enough.
    expect(ipc).toContain('z.object(')
    expect(ipc).toMatch(/multiplier: z\.union\(\[z\.literal\(2\), z\.literal\(4\)\]\)/)
  })

  it('declares the surface on the renderer type side', () => {
    const dts = read('src/types/electron.d.ts')
    expect(dts).toMatch(/\n {2}rife: RifeAPI\r?\n/)
    expect(dts).toContain('export interface RifeAPI')
    expect(dts).toContain('export interface RifeStatusInfo')
  })
})

// ── 4. the activity rail ──────────────────────────────────────────────────────

describe('the rail sees both the install and the run', () => {
  it('watches the install channel under the engine\'s own name', () => {
    const bridge = read('src/components/activity/activityBridge.ts')
    expect(bridge).toMatch(/source: 'rife',\s*id: 'engine:rife'/)
    expect(bridge).toContain("label: 'rife-ncnn-vulkan'")
  })

  it('routes the RUN, and gives it a real cancel', () => {
    const bridge = read('src/components/activity/activityBridge.ts')
    expect(bridge).toContain('routeRifeRunEvent')
    expect(bridge).toMatch(/cancel: \{ kind: 'rife', jobId: ev\.jobId \}/)
    expect(read('src/store/activity.store.ts')).toContain("{ kind: 'rife'; jobId: string }")
  })

  it('the Stop button reaches a REAL kill (clause 5: no button that lies)', () => {
    const cancel = read('src/components/activity/activityCancel.ts')
    expect(cancel).toContain("cancel.kind === 'rife'")
    expect(cancel).toContain('src.rife.cancel(cancel.jobId)')
  })
})

// ── 5. the rail's routing decisions, behaviourally ────────────────────────────

describe('routeRifeRunEvent', () => {
  interface Task { id: string; kind: string; percent: number; stage: string; cancel: unknown; counts?: unknown; status?: string; error?: string }
  const opened: Task[] = []
  const settled: Array<{ id: string; status: string; error?: string }> = []
  const store = {
    progressTask: (id: string, p: Record<string, unknown>) => { opened.push({ id, ...p } as unknown as Task) },
    settleTask: (id: string, p: { status: string; error?: string }) => { settled.push({ id, ...p }) },
  }

  beforeEach(() => { opened.length = 0; settled.length = 0 })

  it('opens ONE row per source path, carrying the real frame counts', async () => {
    const { routeRifeRunEvent, normalizeRifeRunEvent } = await import('../../src/components/activity/activityBridge')
    const ev = normalizeRifeRunEvent({
      jobId: 'C:\\v\\a.mp4', stage: 'interpolating', message: 'Interpolating 4 → 8 frames',
      percent: 50, counts: { done: 4, total: 8 },
    })!
    routeRifeRunEvent(ev, store as never)
    expect(opened.length).toBe(1)
    expect(opened[0]!.id).toBe('rife:C:\\v\\a.mp4')
    expect(opened[0]!.kind).toBe('render')
    expect(opened[0]!.percent).toBe(50)
    expect(opened[0]!.counts).toEqual({ done: 4, total: 8 })
    expect(opened[0]!.cancel).toEqual({ kind: 'rife', jobId: 'C:\\v\\a.mp4' })
  })

  it('settles on every terminal stage, with the honest status', async () => {
    const { routeRifeRunEvent, normalizeRifeRunEvent } = await import('../../src/components/activity/activityBridge')
    for (const [stage, status] of [['done', 'completed'], ['error', 'failed'], ['cancelled', 'cancelled']] as const) {
      routeRifeRunEvent(normalizeRifeRunEvent({ jobId: 'j', stage, message: 'm', percent: 100, error: 'boom' })!, store as never)
    }
    expect(settled.map(s => s.status)).toEqual(['completed', 'failed', 'cancelled'])
    expect(settled[1]!.error).toBe('boom')
    expect(settled[0]!.error).toBeUndefined()
  })

  it('reports -1 for a percent nobody measured, never 0', async () => {
    const { normalizeRifeRunEvent } = await import('../../src/components/activity/activityBridge')
    expect(normalizeRifeRunEvent({ jobId: 'j', stage: 'probing', message: '', percent: -1 })!.percent).toBe(-1)
    expect(normalizeRifeRunEvent({ jobId: 'j', stage: 'probing', message: '' })!.percent).toBe(-1)
  })

  it('ignores an event with no job identity rather than opening a nameless row', async () => {
    const { normalizeRifeRunEvent } = await import('../../src/components/activity/activityBridge')
    expect(normalizeRifeRunEvent({ stage: 'probing' })).toBeNull()
    expect(normalizeRifeRunEvent({ jobId: '', stage: 'probing' })).toBeNull()
    expect(normalizeRifeRunEvent(null)).toBeNull()
    expect(normalizeRifeRunEvent('nope')).toBeNull()
  })
})

// ── 6. runActivityCancel dispatches the right wire ────────────────────────────

describe('runActivityCancel · rife', () => {
  it('calls rife.cancel with the job id and reports the outcome', async () => {
    const { runActivityCancel } = await import('../../src/components/activity/activityCancel')
    const calls: string[] = []
    const out = await runActivityCancel(
      { kind: 'rife', jobId: '/v/a.mp4' },
      { rife: { cancel: async (p: string) => { calls.push(p); return { ok: true } } } },
    )
    expect(calls).toEqual(['/v/a.mp4'])
    expect(out).toEqual({ ok: true, kind: 'rife' })
  })

  it('says WHY rather than throwing when the bridge is not there', async () => {
    const { runActivityCancel } = await import('../../src/components/activity/activityCancel')
    const out = await runActivityCancel({ kind: 'rife', jobId: '/v/a.mp4' }, {})
    expect(out.ok).toBe(false)
    expect(out.error).toContain('rife.cancel')
  })

  it('does not take the rail down when the kill itself throws', async () => {
    const { runActivityCancel } = await import('../../src/components/activity/activityCancel')
    const out = await runActivityCancel(
      { kind: 'rife', jobId: '/v/a.mp4' },
      { rife: { cancel: async () => { throw new Error('ipc gone') } } },
    )
    expect(out).toEqual({ ok: false, kind: 'rife', error: 'ipc gone' })
  })
})

// ── 7. i18n reachability ──────────────────────────────────────────────────────

describe('every key the RIFE surface asks for exists in English', () => {
  const media = JSON.parse(readFileSync(join(DESKTOP, 'src/i18n/locales/en/media.json'), 'utf8')) as Record<string, Record<string, string>>
  const common = JSON.parse(readFileSync(join(DESKTOP, 'src/i18n/locales/en/common.json'), 'utf8')) as Record<string, Record<string, Record<string, string>>>

  it('ships every media.rife.* key the component resolves', () => {
    const src = read('src/pages/media/RifeAction.tsx')
    const used = [...src.matchAll(/t\('rife\.([a-zA-Z]+)'/g)].map(m => m[1]!)
    expect(used.length).toBeGreaterThan(5)
    for (const k of new Set(used)) expect(media.rife?.[k], `media.rife.${k}`).toBeTruthy()
  })

  it('ships the rail label the bridge names', () => {
    expect(read('src/components/activity/activityBridge.ts')).toContain("labelKey: 'activity.label.rife'")
    expect(common.activity?.label?.rife).toBeTruthy()
  })

  it('the size placeholder the install label promises is really interpolated', () => {
    // "Install · {{size}}" with no size passed renders the literal braces.
    expect(media.rife!.install).toContain('{{size}}')
    expect(read('src/pages/media/RifeAction.tsx')).toMatch(/t\('rife\.install',\s*\{\s*size/)
  })
})

// ── 8. the gallery surface ────────────────────────────────────────────────────

describe('the gallery offers it only where it can actually work', () => {
  const page = read('src/pages/media/MediaPage.tsx')

  it('renders the action on a VIDEO artifact that has a local path', () => {
    expect(page).toContain("import { RifeAction } from './RifeAction'")
    expect(page).toMatch(/a\.kind === 'video' && a\.path && \(\s*\n\s*<RifeAction\s+path=\{a\.path\}/)
  })

  it('the component itself refuses to render without a path (belt and braces)', () => {
    expect(read('src/pages/media/RifeAction.tsx')).toContain('if (!path) return null')
  })

  it('fetches the engine status ONCE for the whole gallery, not once per card', () => {
    const src = read('src/pages/media/RifeAction.tsx')
    expect(src).toContain('let inFlight')
    expect(src).toContain('listeners')
  })
})

vi.mock('electron', () => ({}))
