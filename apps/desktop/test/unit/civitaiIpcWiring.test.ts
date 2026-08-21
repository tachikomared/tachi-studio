// apps/desktop/test/unit/civitaiIpcWiring.test.ts
//
// SOURCE ASSERTIONS (node env, no electron) for the things behaviour tests
// cannot see: where a module sits in the static import graph, and whether the
// two ends of a wire agree on a channel name.
//
// THE LOAD-BEARING ONE is the first suite. electron-vite bundles electron/ into
// ONE out/main/index.js, so anything main.ts statically imports is evaluated
// before main.ts's own first statement — that is the 1317 ms prelude R8b spent
// a batch shrinking (see startupDeferredImports.test.ts). A new IPC surface must
// therefore hang off an EXISTING registrar rather than adding an import to
// main.ts. This file pins that main.ts does not name civitai.ipc, AND that the
// registrar which does actually calls it — the second half matters because
// "not imported by main.ts" is also true of a file nobody registers at all.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP = fileURLToPath(new URL('../../', import.meta.url))
const ELECTRON = join(DESKTOP, 'electron')
const MAIN = join(ELECTRON, 'main.ts')
const read = (p: string) => readFileSync(join(DESKTOP, p), 'utf8')

// ── a minimal static-import walker (same rules as startupDeferredImports) ─────

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

/** first-party files reachable from main.ts by static VALUE imports */
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

describe('the Civitai IPC is registered WITHOUT touching main.ts', () => {
  const graph = bootGraph()
  const files = [...graph.files].map(rel)

  it('walks a real graph (guards against a walker that silently finds nothing)', () => {
    expect(graph.files.size).toBeGreaterThan(200)
    expect(files).toContain('electron/ipc/model-catalog.ipc.ts')
  })

  it('main.ts does not import civitai.ipc, directly or by name', () => {
    const main = read('electron/main.ts')
    expect(staticImportsOf(main).some(s => s.includes('civitai'))).toBe(false)
    expect(main).not.toContain('registerCivitaiIpc')
    expect(main).not.toContain('civitai.ipc')
  })

  it('model-catalog.ipc.ts imports registerCivitaiIpc AND calls it', () => {
    const src = read('electron/ipc/model-catalog.ipc.ts')
    expect(src).toMatch(/import \{ registerCivitaiIpc \} from '\.\/civitai\.ipc'/)
    // The call must be INSIDE registerModelCatalogIpc, not at module scope
    // (module scope would run before app-ready and ipcMain.handle would throw).
    const body = src.slice(src.indexOf('export function registerModelCatalogIpc'))
    expect(body).toContain('registerCivitaiIpc()')
  })

  it('civitai.ipc.ts IS reachable from main.ts — registered, not orphaned', () => {
    expect(files).toContain('electron/ipc/civitai.ipc.ts')
    expect(files).toContain('electron/services/civitai-search.ts')
    expect(files).toContain('electron/services/civitai-gate.ts')
  })

  it('this batch put NO new external package on the boot path', () => {
    // The Civitai files import only electron, zod and first-party modules —
    // all of which the boot graph already carried. A new package here would
    // silently re-inflate the prelude R8b measured down by 81%.
    for (const f of ['electron/services/civitai-search.ts', 'electron/services/civitai-gate.ts', 'electron/ipc/civitai.ipc.ts']) {
      const externals = staticImportsOf(read(f)).filter(s => !s.startsWith('.'))
      for (const e of externals) {
        expect(['electron', 'zod'], `${f} imports ${e}`).toContain(e)
      }
    }
  })

  it('civitai-gate.ts imports NOTHING — the predicates cannot be reconfigured', () => {
    // Zero imports is what makes "no flag can bypass layer 0" checkable rather
    // than merely intended: there is no module it could read a setting from.
    expect(staticImportsOf(read('electron/services/civitai-gate.ts'))).toEqual([])
  })

  it('the new files use no relative require() (the bundle has no relative modules)', () => {
    for (const f of ['electron/services/civitai-search.ts', 'electron/services/civitai-gate.ts', 'electron/ipc/civitai.ipc.ts']) {
      expect(/require\(\s*['"`]\.{1,2}\//.test(read(f)), f).toBe(false)
    }
  })
})

describe('preload ↔ main agree on the channel names', () => {
  const preload = read('electron/preload.ts')
  const ipc = read('electron/ipc/civitai.ipc.ts')

  it('exposes tachi.civitai.search / .detail / .install / .adultState / .validateKey', () => {
    expect(preload).toMatch(/civitai:\s*\{/)
    expect(preload).toContain("ipcRenderer.invoke('civitai:search'")
    expect(preload).toContain("ipcRenderer.invoke('civitai:detail'")
    expect(preload).toContain("ipcRenderer.invoke('civitai:install'")
    expect(preload).toContain("ipcRenderer.invoke('civitai:adult-state'")
    expect(preload).toContain("ipcRenderer.invoke('civitai:validate-key'")
  })

  it('every channel the preload invokes is handled in main, and vice versa', () => {
    const invoked = [...preload.matchAll(/invoke\('(civitai:[a-z-]+)'/g)].map(m => m[1]!)
    const handled = [...ipc.matchAll(/ipcMain\.handle\('(civitai:[a-z-]+)'/g)].map(m => m[1]!)
    expect([...new Set(invoked)].sort()).toEqual([...new Set(handled)].sort())
    expect(handled.sort()).toEqual([
      'civitai:adult-state', 'civitai:detail', 'civitai:install', 'civitai:search',
      'civitai:validate-key',
    ])
  })

  // THE KEY IS CHECKED BEFORE IT IS STORED — the asymmetry with the HuggingFace
  // card that an audit found. HF validated on save from day one; the Civitai card
  // stored whatever was pasted, and a typo surfaced hours later as "Civitai
  // rejected the stored API key for this download (401)".
  it('the Civitai card validates the typed key BEFORE it stores it', () => {
    const page = read('src/pages/settings/SettingsPage.tsx')
    const card = page.slice(page.indexOf('function CivitaiCard'))
    const body = card.slice(0, card.indexOf('function HuggingFaceCard'))
    const ping = body.indexOf('window.tachi.civitai.validateKey(')
    const store = body.indexOf('window.tachi.settings.saveKey(CIVITAI_KEY_ID')
    expect(ping).toBeGreaterThan(-1)
    expect(store).toBeGreaterThan(-1)
    // ORDER IS THE ASSERTION: pinging after the save would report success for a
    // key already committed, which is worse than not checking at all.
    expect(ping).toBeLessThan(store)
    // …and the refusal short-circuits before the store. It keys off STORED, not
    // off the probe's `ok`: since 2026-08-01 an UNVERIFIED answer (offline, 5xx,
    // timeout) stores the key on purpose — only an affirmative rejection blocks
    // it. See validateThenStoreKey.
    expect(body).toMatch(/if \(!res\.stored\) return/)
    expect(body).not.toMatch(/if \(!res\.ok\) return/)
  })

  it('main asks /api/v1/me and nothing public — a bad key gets 200 elsewhere', () => {
    // Measured 2026-08-01: `Bearer garbage` → 200 on /models and on
    // /model-versions/mini/*, 401 only on /me (and on the auth-only filters).
    const svc = read('electron/services/civitai-search.ts')
    const after = svc.slice(svc.indexOf('export async function validateCivitaiKey'))
    const region = after.slice(0, after.indexOf('\nexport ', 1))   // up to the next export
    // COMMENTS STRIPPED, and that is load-bearing: the function's own comment
    // names `?token=` as the form it refuses, so asserting over the raw text
    // would flag the refusal as the violation.
    const fn = region.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    expect(fn).toContain('/api/v1/me')
    expect(fn).toContain('enforceProviderEgress(CIVITAI_KEY_ID)')
    expect(fn).not.toMatch(/token=/)             // never the leaky query form
    expect(fn).not.toContain('retrieveKey(')     // validates the ARGUMENT, not the keychain
  })

  // THE 18+ SURFACE IS READ-ONLY ACROSS THE BRIDGE. The unlock is two settings
  // keys written through settings:save (whose zod schema is the write-side
  // allowlist); an `civitai:unlock-adult`-shaped channel would be a second way
  // in, reachable by any renderer bug, with no schema of its own.
  it('there is NO channel that turns 18+ on — only one that reports it', () => {
    expect(ipc).not.toMatch(/ipcMain\.handle\('civitai:(unlock|set-adult|adult-set|enable-adult)/)
    expect(preload).not.toMatch(/invoke\('civitai:(unlock|set-adult|adult-set|enable-adult)/)
  })

  it('install sends { row } — the shape the handler parses', () => {
    expect(preload).toMatch(/invoke\('civitai:install',\s*\{\s*row\s*\}\)/)
    expect(ipc).toContain('row: z.object(')
  })
})

describe('the renderer type surface mirrors the row contract', () => {
  const dts = read('src/types/electron.d.ts')

  it('declares civitai on the API and the row interface', () => {
    expect(dts).toMatch(/\n {2}civitai: CivitaiAPI\r?\n/)
    expect(dts).toContain('export interface CivitaiSearchRow')
    expect(dts).toContain('export interface CivitaiAPI')
  })

  it('every field of the shared row contract is declared', () => {
    const block = dts.slice(dts.indexOf('export interface CivitaiSearchRow'))
      .slice(0, dts.slice(dts.indexOf('export interface CivitaiSearchRow')).indexOf('\n}'))
    for (const field of [
      'id', 'modelId', 'versionId', 'name', 'type', 'family', 'baseModel', 'sizeMb',
      'sha256', 'downloadUrl', 'fileName', 'format', 'fp', 'nsfwLevelModel',
      'downloads', 'likes', 'thumbnail', 'trainedWords', 'license', 'installable', 'reason',
      // Built in MAIN from the resolved mode, so the detail panel's one
      // immediately-available control is available on its first frame.
      'pageUrl',
    ]) {
      expect(block, `CivitaiSearchRow.${field}`).toMatch(new RegExp(`\\n\\s*${field}[?]?:`))
    }
  })

  it('declares the same family union as main', () => {
    // Main states the union ONCE, as `CivitaiFamily`, and the row field is
    // declared in terms of it; the .d.ts (which cannot import from electron/)
    // spells it out. The assertion is that the two agree — including `zimage`,
    // added 2026-07-31 so Z-Image ADAPTERS can be judged.
    const svc = read('electron/services/civitai-search.ts')
    expect(svc).toContain("export type CivitaiFamily = 'sd15' | 'sdxl' | 'flux' | 'zimage'")
    expect(svc).toContain('family: CivitaiFamily | null')
    expect(dts).toContain("family: 'sd15' | 'sdxl' | 'flux' | 'zimage' | null")
  })
})

describe('the keychain id is plumbed end to end', () => {
  it("settings:list-keys reports 'civitai' so the key card can say ✓ Key stored", () => {
    const src = read('electron/ipc/settings.ipc.ts')
    expect(src).toMatch(/NON_PROVIDER_KEY_IDS = \[[^\]]*'civitai'/)
  })

  it('main reads the key under the SAME id it is stored under', () => {
    const svc = read('electron/services/civitai-search.ts')
    expect(svc).toContain("export const CIVITAI_KEY_ID = 'civitai'")
    expect(svc).toContain('retrieveKey(CIVITAI_KEY_ID)')
  })
})

describe('id sanitation at the source (risk R10)', () => {
  it('the id template is civitai-<versionId> with a [a-z0-9-] scrub', () => {
    const svc = read('electron/services/civitai-search.ts')
    expect(svc).toContain('`civitai-${versionId}`')
    expect(svc).toMatch(/replace\(\/\[\^a-z0-9-\]\/g, '-'\)/)
    // A ':' anywhere in the id would break sdManagedIdPrefix's trailing-colon
    // Stop sweep, which is what makes Stop/resume find every component task.
    expect(svc).not.toContain('`civitai:${')
  })
})

describe('hf-search egress fix is present at the source too', () => {
  it('the gate is the FIRST statement of searchHuggingFace, before the URL', () => {
    const src = read('electron/services/hf-search.ts')
    const body = src.slice(src.indexOf('export async function searchHuggingFace'))
    // The id is a named constant now (HF_KEY_ID === 'huggingface'), shared with
    // the keychain read and the Settings card, so the literal moved one line up.
    expect(src).toContain("export const HF_KEY_ID = 'huggingface'")
    const gate = body.indexOf('enforceProviderEgress(HF_KEY_ID)')
    const url = body.indexOf('const url =')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(url)
  })

  it('the IPC handler gates too (the boundary the renderer can actually reach)', () => {
    const src = read('electron/ipc/model-catalog.ipc.ts')
    expect(src).toContain("enforceProviderEgress('huggingface')")
  })
})
