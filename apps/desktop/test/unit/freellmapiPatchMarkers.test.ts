// apps/desktop/test/unit/freellmapiPatchMarkers.test.ts
//
// THE TEST THAT WOULD HAVE CAUGHT IT.
//
// On 2026-08-01 an installer shipped whose bundled freellmapi relay contained
// vendor patch #1 and not vendor patch #2. Nothing was broken — `git apply
// --check` of patch #2 against the shipped tree exits 0, so it would have
// applied. `pnpm prepare:sidecars` simply was not re-run before packaging, and
// the pipeline had no way to say so: its apply step logged "already present —
// skipping" from a `catch` that fired for a successful idempotent skip AND for
// a genuine failure, and nobody ever looked at the resulting tree.
//
// The relay went out without the Kilo and OpenCode Zen keyless upstreams. The
// Free Providers card kept advertising OpenCode Zen as [FREE · NO KEY]; the
// anon key seed for `zen` was rejected by the unpatched allowlist and swallowed
// by a bare catch; the first keyless send fell through to a dead OpenRouter key
// and returned a 502.
//
// So this file asks the only question that matters before a package: does the
// tree on disk carry what every patch in the ordered manifest says it adds?
//
// It reads the SAME manifest the package-time build and the runtime installer
// read (scripts/patches/manifest.json), so a new patch is covered the moment it
// is added to the list — there is nothing to remember to update here.

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'

import {
  loadPatchManifest,
  verifyAllPatches,
  PATCH_MANIFEST,
} from '../../electron/services/freellmapi-patches'

const REPO_ROOT  = resolve(__dirname, '..', '..', '..', '..')
const PATCHES    = join(REPO_ROOT, 'scripts', 'patches')
// The tree that gets copied into the installer (electron-builder extraResources).
const SIDECAR    = join(REPO_ROOT, 'apps', 'desktop', 'resources', 'sidecars', 'freellmapi')

describe('freellmapi vendor patch manifest', () => {
  it('exists, is ordered, and every listed patch file is present', () => {
    expect(existsSync(join(PATCHES, PATCH_MANIFEST))).toBe(true)

    const entries = loadPatchManifest(PATCHES)
    expect(entries.length).toBeGreaterThan(0)

    for (const e of entries) {
      expect(existsSync(join(PATCHES, e.file)), `patch file missing: ${e.file}`).toBe(true)
      // A patch with no markers cannot be verified, which is the whole failure
      // mode this manifest exists to close.
      expect(e.markers.length, `patch ${e.file} declares no markers`).toBeGreaterThan(0)
      // And a patch with no BUILT markers can pass while the compiled relay is
      // stale — source proof alone is not proof of what runs.
      expect(e.builtMarkers?.length ?? 0, `patch ${e.file} declares no builtMarkers`).toBeGreaterThan(0)
      for (const m of [...e.markers, ...(e.builtMarkers ?? [])]) {
        expect(m.path).toBeTruthy()
        expect(m.contains).toBeTruthy()
      }
      for (const m of e.builtMarkers ?? []) {
        expect(m.path.startsWith('server/dist/'), `${e.file}: builtMarker outside dist: ${m.path}`).toBe(true)
      }
    }
  })

  it('the ordered list matches what the package-time build reads', () => {
    // scripts/download-sidecars.mjs must consume the manifest, not its own copy
    // of the list — the duplicate-list-with-a-keep-in-sync-comment shape is what
    // let the two halves of this pipeline disagree in the first place.
    const script = readFileSync(join(REPO_ROOT, 'scripts', 'download-sidecars.mjs'), 'utf8')
    expect(script).toContain('manifest.json')
    expect(script).not.toMatch(/const FREELLMAPI_PATCHES\s*=\s*\[/)
  })

  it('every marker declares a file inside the relay tree, not an absolute path', () => {
    for (const e of loadPatchManifest(PATCHES)) {
      for (const m of [...e.markers, ...(e.builtMarkers ?? [])]) {
        expect(m.path.startsWith('/'), `${e.file}: ${m.path}`).toBe(false)
        expect(/^[A-Za-z]:/.test(m.path), `${e.file}: ${m.path}`).toBe(false)
      }
    }
  })
})

describe('the apply-step classifier — three outcomes, not two', () => {
  // The bug in one line: `try { check; apply } catch { log('already present') }`.
  // A successful idempotent skip and a hard failure produced the identical,
  // reassuring message, so a patch that never ran looked exactly like one that
  // had. These are the three answers that replaced it.
  it('exit 0 means NOT YET APPLIED — the patch must be run', async () => {
    const { classifyApplyCheck } = await import('../../../../scripts/download-sidecars.mjs')
    expect(classifyApplyCheck({ code: 0, stderr: '' })).toBe('pending')
  })

  it('git\'s already-applied dialects are recognised, not treated as failure', async () => {
    const { classifyApplyCheck } = await import('../../../../scripts/download-sidecars.mjs')
    // Both are real stderr from `git apply --check` against the patched relay.
    expect(classifyApplyCheck({ code: 1, stderr: 'error: patch failed: a.ts:26\nerror: a.ts: patch does not apply' })).toBe('applied')
    expect(classifyApplyCheck({ code: 1, stderr: 'error: b.test.ts: already exists in working directory' })).toBe('applied')
    expect(classifyApplyCheck({ code: 1, stderr: 'error: patch is reversed' })).toBe('applied')
  })

  it('anything else is an ERROR the build must not swallow', async () => {
    const { classifyApplyCheck } = await import('../../../../scripts/download-sidecars.mjs')
    expect(classifyApplyCheck({ code: 128, stderr: 'fatal: not a git repository' })).toBe('error')
    expect(classifyApplyCheck({ code: 1, stderr: 'error: corrupt patch at line 12' })).toBe('error')
  })

  it('missingMarkers reports exactly what is absent, and nothing when all present', async () => {
    const { missingMarkers } = await import('../../../../scripts/download-sidecars.mjs')
    expect(missingMarkers(PATCHES, [{ path: PATCH_MANIFEST, contains: '"patches"' }])).toEqual([])
    const gone = missingMarkers(PATCHES, [
      { path: PATCH_MANIFEST, contains: 'this-string-is-not-in-the-manifest' },
      { path: 'no/such/file.ts', contains: 'x' },
    ])
    expect(gone).toHaveLength(2)
    expect(gone[1]).toContain('unreadable')
  })
})

describe('the checked-in sidecar tree carries every vendor patch', () => {
  const havePatchedTree = existsSync(join(SIDECAR, 'shared', 'types.ts'))

  // A fresh clone has no sidecar (it is gitignored and fetched by
  // `pnpm prepare:sidecars`), so there is nothing to assert about. A tree that
  // IS present must be complete — that is the state that shipped wrong.
  it.skipIf(!havePatchedTree)('no patch is missing from the bundled relay', () => {
    const verdicts = verifyAllPatches(SIDECAR, loadPatchManifest(PATCHES))

    const broken = verdicts.filter(v => !v.applied)
    const detail = broken
      .map(v => `\n  ${v.file} (${v.what})\n${v.missing.map(m => `      missing: ${m}`).join('\n')}`)
      .join('')

    expect(
      broken.length,
      `The bundled freellmapi relay at\n  ${SIDECAR}\n`
      + `is missing ${broken.length} vendor patch(es):${detail}\n\n`
      + `Run \`pnpm prepare:sidecars\` before packaging. Do NOT ship this tree — `
      + `the app advertises upstreams the relay does not have.`,
    ).toBe(0)
  })

  it.skipIf(!havePatchedTree)('the free-route markers specifically are present in the SOURCE', () => {
    // Named explicitly because these three are the ones the UI makes promises
    // about: `zen` is a platform the Free Providers card advertises, the
    // credential classifier is what keeps one dead key from taking the route
    // down, and the resolver is what makes a pinned model addressable at all.
    const types = readFileSync(join(SIDECAR, 'shared', 'types.ts'), 'utf8')
    expect(types, 'the relay does not know the `zen` platform').toContain("'zen'")

    const proxy = readFileSync(join(SIDECAR, 'server', 'src', 'routes', 'proxy.ts'), 'utf8')
    expect(proxy, 'the relay cannot fail over past a rejected credential').toContain('isCredentialError')
    expect(proxy, 'the relay cannot resolve a platform-qualified model id').toContain('resolveRequestedModel')
  })

  it.skipIf(!existsSync(join(SIDECAR, 'server', 'dist', 'index.js')))('the BUILT relay was rebuilt from the patched source', () => {
    // Separate from the source assertion on purpose. `pnpm prepare:sidecars`
    // patches AND builds; a hand-applied patch does only the first, and the
    // spawned process would still be the old relay. Source-only proof would
    // call that fixed.
    const verdicts = verifyAllPatches(SIDECAR, loadPatchManifest(PATCHES), 'built')
    const broken   = verdicts.filter(v => !v.applied)
    expect(
      broken.length,
      `server/dist is stale — patched source, old build:${broken
        .map(v => `\n  ${v.file}\n${v.missing.map(m => `      missing: ${m}`).join('\n')}`).join('')}`,
    ).toBe(0)
  })
})
