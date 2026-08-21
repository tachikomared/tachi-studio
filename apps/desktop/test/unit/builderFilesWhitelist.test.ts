// apps/desktop/test/unit/builderFilesWhitelist.test.ts
//
// A per-platform `files` block made of NOTHING BUT NEGATIONS collapses the
// whitelist, and nothing tells you.
//
// electron-builder merges the platform block into a file matcher of its own
// (app-builder-lib 26.15.3, out/fileMatcher.js — `addPatterns(config[name])`
// then `addPatterns(options.customBuildOptions[name])`). A matcher that ends up
// with no INCLUSION pattern falls back to `**/*`. So a `win.files` of two
// exclusions turned
//
//     "files": ["out/**/*", "package.json", …negations]
//
// into "everything, minus a couple of things". Measured, not deduced: the
// resulting builder-debug.yml opened with
//
//     firstOrDefaultFilePatterns:
//       - '**/*'
//
// and the produced app.asar carried `src`, `electron`, `test`, `e2e`, `scripts`
// and 3.5 GB of stale local build directories — 4.4 GB where the intent was the
// compiled output alone. The packaging size gate is what caught it, one build
// after the change that caused it.
//
// This test states the invariant so the trap cannot be re-entered quietly: if a
// platform block narrows the file set, it must ALSO carry what to include.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CONFIG = join(__dirname, '..', '..', 'electron-builder.json')
const config = JSON.parse(readFileSync(CONFIG, 'utf8')) as {
  files?: string[]
  win?: { files?: string[] }
  mac?: { files?: string[] }
  linux?: { files?: string[] }
}

const isNegation = (p: string) => p.startsWith('!')
const hasInclusion = (patterns: string[]) => patterns.some(p => !isNegation(p))

describe('electron-builder file patterns', () => {
  it('the top-level list is a whitelist, not a blacklist', () => {
    const files = config.files ?? []
    expect(files.length, 'no `files` at all means everything ships').toBeGreaterThan(0)
    expect(
      hasInclusion(files),
      'a `files` list of pure negations means "ship everything except…", which is how the source tree got into app.asar',
    ).toBe(true)
    expect(files).toContain('out/**/*')
    expect(files).toContain('package.json')
  })

  for (const platform of ['win', 'mac', 'linux'] as const) {
    it(`${platform}: a platform block, if it has \`files\`, carries inclusions too`, () => {
      const patterns = config[platform]?.files
      if (!patterns) return   // no block at all is the safe shape
      expect(
        hasInclusion(patterns),
        `${platform}.files is negations-only — electron-builder gives that matcher no ` +
        'inclusion pattern, so it defaults to `**/*` and the top-level whitelist stops ' +
        'applying. Repeat the inclusion patterns here, or put the exclusion in the ' +
        'top-level list instead.',
      ).toBe(true)
    })
  }

  it('keeps excluding the things that must never be inside the package', () => {
    const files = config.files ?? []
    // Each of these was a real incident, not a precaution.
    expect(files, 'the video encoder states its own licence forbids redistribution')
      .toContain('!**/node_modules/@remotion/compositor-*/**')
    expect(files, 'the prepared sidecar tree ships as extraResources, not inside the asar')
      .toContain('!resources/sidecars/**')
    expect(files.some(p => p.includes('release-build')), 'previous build output must not be packed into the next one')
      .toBe(true)
    expect(files.some(p => p === '!**/*.map'), 'sourcemaps have no runtime role').toBe(true)
  })
})
