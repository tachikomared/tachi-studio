// apps/desktop/test/unit/asarReport.test.ts
//
// The packaging gate (`scripts/afterpack-verify.cjs`) can only see the
// filesystem; everything packed into `app.asar` is opaque to it. That is
// exactly where 225.8 MB of sourcemaps and an 88.1 MB transformers.js download
// cache were hiding on 2026-07-26. `scripts/asar-report.mjs` parses the asar
// header so the gate can enforce must-not-ship rules INSIDE the archive too.
//
// This file covers the pure half: header parsing, tree flattening, the rule
// set, and the matcher. A regression here silently disarms the gate, so the
// parser is exercised against a hand-built archive header rather than a
// fixture file.
import { describe, it, expect } from 'vitest'
import {
  parseAsarHeaderBuffer,
  flattenAsarEntries,
  findBannedEntries,
  bannedPackageRules,
  summarizeByPrefix,
  formatMB,
  FOREIGN_ORT_PLATFORMS,
} from '../../scripts/asar-report.mjs'

/**
 * Build the first bytes of a real asar archive: two chromium Pickles.
 *   [0,4)   outer pickle payload size (always 4)
 *   [4,8)   header pickle total size  = 8 + align4(jsonLength)
 *   [8,12)  header pickle payload size
 *   [12,16) JSON byte length
 *   [16,..) the JSON directory tree, zero-padded to a 4-byte boundary
 */
function makeAsarHeaderBuffer(tree: unknown): Buffer {
  const json = JSON.stringify(tree)
  const jsonLength = Buffer.byteLength(json, 'utf8')
  const padded = Math.ceil(jsonLength / 4) * 4
  const headerPickleSize = 8 + padded
  const buf = Buffer.alloc(8 + headerPickleSize)
  buf.writeUInt32LE(4, 0)
  buf.writeUInt32LE(headerPickleSize, 4)
  buf.writeUInt32LE(headerPickleSize - 4, 8)
  buf.writeUInt32LE(jsonLength, 12)
  buf.write(json, 16, 'utf8')
  return buf
}

const TREE = {
  files: {
    'package.json': { size: 100 },
    out: { files: { main: { files: { 'index.js': { size: 2000 } } } } },
    node_modules: {
      files: {
        'onnxruntime-node': {
          files: {
            bin: {
              files: {
                'napi-v3': {
                  files: {
                    win32: { files: { x64: { files: { 'onnxruntime_binding.node': { size: 33, unpacked: true } } } } },
                    darwin: { files: { arm64: { files: { 'libonnxruntime.dylib': { size: 64, unpacked: true } } } } },
                    linux: { files: { x64: { files: { 'libonnxruntime.so': { size: 75, unpacked: true } } } } },
                  },
                },
              },
            },
            'index.js.map': { size: 7 },
          },
        },
        'kokoro-js': {
          files: {
            '.cache': { files: { 'model_quantized.onnx': { size: 88 } } },
            'index.js': { size: 11 },
          },
        },
        // R6 — the browser ORT backends that arrive via @huggingface/transformers
        // and are never reachable from a main-process (onnxruntime-node) build.
        'onnxruntime-web': {
          files: {
            dist: {
              files: {
                'ort-wasm-simd-threaded.wasm': { size: 129 },
                'ort-wasm-simd-threaded.jsep.wasm': { size: 261 },
                // the JS stays — transformers.node.cjs still references the module
                'ort.node.min.mjs': { size: 3 },
              },
            },
          },
        },
      },
    },
  },
}

describe('asar header parsing', () => {
  it('reads the directory tree out of a well-formed header', () => {
    const { header, jsonLength, baseOffset } = parseAsarHeaderBuffer(makeAsarHeaderBuffer(TREE))
    expect(header).toEqual(TREE)
    expect(jsonLength).toBe(Buffer.byteLength(JSON.stringify(TREE), 'utf8'))
    // Data starts after both pickles, on a 4-byte boundary.
    expect(baseOffset % 4).toBe(0)
    expect(baseOffset).toBeGreaterThan(16 + jsonLength - 4)
  })

  it('refuses a truncated header instead of returning a half-tree', () => {
    expect(() => parseAsarHeaderBuffer(Buffer.alloc(8))).toThrow(/truncated/)
    const short = makeAsarHeaderBuffer(TREE).subarray(0, 40)
    expect(() => parseAsarHeaderBuffer(short)).toThrow(/available/)
  })
})

describe('flattenAsarEntries', () => {
  const entries = flattenAsarEntries(parseAsarHeaderBuffer(makeAsarHeaderBuffer(TREE)).header)

  it('emits one POSIX path per file and no directories', () => {
    const paths = entries.map(e => e.path).sort()
    expect(paths).toContain('node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime_binding.node')
    expect(paths).toContain('out/main/index.js')
    expect(paths).not.toContain('node_modules')
    expect(paths.every(p => !p.includes('\\'))).toBe(true)
  })

  it('carries size and the asarUnpack flag', () => {
    const ort = entries.find(e => e.path.endsWith('win32/x64/onnxruntime_binding.node'))!
    expect(ort.size).toBe(33)
    expect(ort.unpacked).toBe(true)
    expect(entries.find(e => e.path === 'package.json')!.unpacked).toBe(false)
  })
})

describe('bannedPackageRules', () => {
  it('bans every foreign onnxruntime platform and never the target one', () => {
    for (const [platform, foreign] of Object.entries(FOREIGN_ORT_PLATFORMS)) {
      const rule = bannedPackageRules(platform).find(r => r.id === 'onnxruntime-foreign-platform')!
      expect(rule).toBeDefined()
      for (const other of foreign) {
        expect(rule.pattern.test(`node_modules/onnxruntime-node/bin/napi-v3/${other}/x64/lib.so`)).toBe(true)
      }
      expect(rule.pattern.test(`node_modules/onnxruntime-node/bin/napi-v3/${platform}/x64/lib.node`)).toBe(false)
    }
  })

  it('keeps the size-independent trust rules on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      const ids = bannedPackageRules(platform).map(r => r.id)
      expect(ids).toContain('goose-bundled')
      expect(ids).toContain('freellmapi-dev-db')
      expect(ids).toContain('sourcemaps')
      expect(ids).toContain('download-cache')
      expect(ids).toContain('onnxruntime-web-wasm')
    }
  })

  it('the goose rule bans the WHOLE sidecar dir — the harness is REMOVED, so a stale dev copy must never ship', () => {
    const rules = bannedPackageRules('win32')
    const goose = rules.find(r => r.id === 'goose-bundled')!
    // The old narrow rule only caught the orphaned second copy…
    expect(goose.pattern.test('resources/sidecars/goose/goose-package/goose.exe')).toBe(true)
    // …the binary itself is equally banned: nothing in the app references Goose
    // any more, but an old dev `prepare:sidecars` still leaves it on disk.
    expect(goose.pattern.test('resources/sidecars/goose/goose.exe')).toBe(true)
    expect(goose.pattern.test('resources/sidecars/goose/.goose-version')).toBe(true)
    // mac layout — same rule, deeper prefix
    expect(goose.pattern.test('Tachi Studio.app/Contents/Resources/sidecars/goose/goose')).toBe(true)
    // the sidecar we DO still bundle must not trip it
    expect(goose.pattern.test('resources/sidecars/freellmapi/server/dist/index.js')).toBe(false)
    // nor a userData path that merely mentions goose (rule is package-scoped)
    expect(goose.pattern.test('resources/app.asar.unpacked/node_modules/goose/index.js')).toBe(false)
  })

  it('matches the resources-relative sidecar paths a package actually has', () => {
    const db = bannedPackageRules('win32').find(r => r.id === 'freellmapi-dev-db')!
    expect(db.pattern.test('resources/sidecars/freellmapi/server/data/freeapi.db-wal')).toBe(true)
    expect(db.pattern.test('resources/sidecars/freellmapi/server/dist/index.js')).toBe(false)
  })

  it('bans ONLY the browser ORT wasm binaries, never the JS or onnxruntime-node', () => {
    const ort = bannedPackageRules('win32').find(r => r.id === 'onnxruntime-web-wasm')!
    for (const p of [
      'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
      'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm',
      'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm',
      'node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm',
      // pnpm's real on-disk shape
      'node_modules/.pnpm/onnxruntime-web@1.26.0/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
    ]) {
      expect(ort.pattern.test(p), p).toBe(true)
    }
    for (const p of [
      // the JS MUST stay — transformers.node.cjs references the web module
      'node_modules/onnxruntime-web/dist/ort.node.min.mjs',
      'node_modules/@huggingface/transformers/dist/transformers.node.cjs',
      // the backend we actually run
      'node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime_binding.node',
      // shiki's oniguruma wasm and the sqlite wasm are load-bearing
      'node_modules/shiki/dist/onig.wasm',
      'node_modules/node-sqlite3-wasm/dist/node-sqlite3-wasm.wasm',
      // a nested wasm somewhere else under onnxruntime-web is not the dist target
      'node_modules/onnxruntime-web/dist/subdir/x.wasm',
    ]) {
      expect(ort.pattern.test(p), p).toBe(false)
    }
  })

  it('does not treat a nested `.cache` filename as a cache directory', () => {
    const cache = bannedPackageRules('win32').find(r => r.id === 'download-cache')!
    expect(cache.pattern.test('node_modules/x/.cache/model.onnx')).toBe(true)
    expect(cache.pattern.test('.cache/model.onnx')).toBe(true)
    expect(cache.pattern.test('node_modules/x/dist/my.cache.js')).toBe(false)
  })
})

describe('findBannedEntries', () => {
  const entries = flattenAsarEntries(parseAsarHeaderBuffer(makeAsarHeaderBuffer(TREE)).header)

  it('reports one row per violated rule with counts, bytes and samples', () => {
    const hits = findBannedEntries(entries, bannedPackageRules('win32'))
    const byId = Object.fromEntries(hits.map(h => [h.id, h]))

    expect(byId['sourcemaps'].count).toBe(1)
    expect(byId['sourcemaps'].bytes).toBe(7)
    expect(byId['download-cache'].bytes).toBe(88)
    expect(byId['onnxruntime-foreign-platform'].count).toBe(2)
    expect(byId['onnxruntime-foreign-platform'].bytes).toBe(64 + 75)
    expect(byId['onnxruntime-foreign-platform'].samples[0]).toMatch(/(darwin|linux)/)
    // R6: both wasm binaries, and NOT the sibling .mjs
    expect(byId['onnxruntime-web-wasm'].count).toBe(2)
    expect(byId['onnxruntime-web-wasm'].bytes).toBe(129 + 261)
    // nothing shipped a bundled goose or the dev DB in this tree
    expect(byId['goose-bundled']).toBeUndefined()
    expect(byId['freellmapi-dev-db']).toBeUndefined()
  })

  it('returns an empty list for a clean tree — the gate must be passable', () => {
    const clean = entries.filter(e =>
      !e.path.endsWith('.map') && !e.path.includes('/.cache/')
      && !/napi-v3\/(darwin|linux)\//.test(e.path)
      && !/onnxruntime-web\/dist\/.*\.wasm$/.test(e.path))
    expect(findBannedEntries(clean, bannedPackageRules('win32'))).toEqual([])
  })

  it('caps samples so a 11 000-file violation does not produce a 11 000-line error', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ path: `node_modules/p/f${i}.js.map`, size: 10 }))
    const [hit] = findBannedEntries(many, bannedPackageRules('win32'))
    expect(hit.count).toBe(500)
    expect(hit.samples.length).toBe(5)
  })
})

describe('summarizeByPrefix', () => {
  it('groups by the first N segments, heaviest first', () => {
    const rows = summarizeByPrefix([
      { path: 'node_modules/big/a.js', size: 100 },
      { path: 'node_modules/big/b.js', size: 50 },
      { path: 'node_modules/small/c.js', size: 10 },
      { path: 'out/main/index.js', size: 5 },
    ], 2)
    expect(rows[0]).toEqual({ prefix: 'node_modules/big', bytes: 150, count: 2 })
    expect(rows.map(r => r.prefix)).toEqual(['node_modules/big', 'node_modules/small', 'out/main'])
  })
})

describe('formatMB', () => {
  it('renders two decimals of MB', () => {
    expect(formatMB(1024 * 1024)).toBe('1.00 MB')
    expect(formatMB(0)).toBe('0.00 MB')
  })
})
