#!/usr/bin/env node
// apps/desktop/scripts/asar-report.mjs
//
// Reads an `app.asar` header and reports what is inside it — total packed
// bytes, the heaviest directories, and any entry matching a "must not ship"
// rule. This is the audit tool behind the installer-diet batch (PLAN
// RELIABILITY+GROWTH 2026-07-26, R2/R5): sourcemaps, transformers.js download
// caches and foreign-platform ORT binaries are invisible to a filesystem walk
// once they are packed, so the packaging gate needs a header parser.
//
// Pure fs + no deps, so `afterpack-verify.cjs` can `await import()` it from the
// electron-builder hook without pulling anything into the build graph.
//
// CLI:
//   node scripts/asar-report.mjs [path/to/app.asar] [--top 20] [--json]
// Default path: release-build/win-unpacked/resources/app.asar
//
// ─── HISTORICAL: why two `files` globs carried extglob carve-outs ─────────────
// Kept as institutional memory only — those two globs are NO LONGER in
// electron-builder.json. Extglob (`!(x)`) silently breaks app-builder-lib's
// matcher (07-26 packaging gotcha #2), so both were reverted; the reasoning below
// is why they must not come back in that form if anyone re-attempts the saving.
// electron-builder.json is strict JSON and cannot hold comments, and node_modules
// filtering only honours NEGATIVE patterns (app-builder-lib
// `getNodeModuleFileMatcher` drops every non-`!` pattern), so an exception
// cannot be expressed as a later re-include. Both were found by dry-running the
// globs against the 07-26 07:08 package, not by reading:
//
//   !**/node_modules/!(nodejs-whisper)/**/{test,...,examples,docs,doc}/**
//     `nodejs-whisper` vendors the whisper.cpp source tree, and macOS has no
//     prebuilt whisper-cli (`whisper-models.ts` defaultWhisperRelease returns
//     null off win32) — it builds from source. `whisper-cli` IS
//     `examples/cli/cli.cpp`, and the root CMakeLists add_subdirectory()s both
//     `examples` and `tests`. The unqualified glob deleted 4 files under
//     examples/cli and 18 under tests/, i.e. it broke the mac build path to
//     save 8.31 MB.
//
//   !**/node_modules/**/!(LICENSE*|...|Notice*).{md,markdown,ts,tsx,flow}
//     86 of the 969 license files in the package are named `LICENSE.md`
//     (@ethersproject/* and friends). `THIRD_PARTY_NOTICES.md` is a 445-byte
//     stub of links with zero license text, so those copies are the only ones
//     shipped — and MIT/BSD/Apache-2.0 require the notice to travel with the
//     distribution. Stripping them saved 2.65 MB and created a compliance hole
//     in an MIT app that is about to go public.

import { openSync, readSync, closeSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * onnxruntime-node ships prebuilt binaries for every platform. Each build must
 * carry only its own; the others are dead weight (174.6 MB on win at
 * 2026-07-26). Keyed by electron's platform name.
 */
export const FOREIGN_ORT_PLATFORMS = {
  win32: ['darwin', 'linux'],
  darwin: ['win32', 'linux'],
  linux: ['win32', 'darwin'],
}

/**
 * Paths that must never end up in a package. Each rule is plain data
 * (id + label + RegExp over a POSIX-style path) so it is trivially
 * unit-testable and can drive BOTH the asar-header scan and the
 * filesystem walk in `afterpack-verify.cjs` from one definition.
 *
 * The numeric size budget alone would let a swap-one-for-another regression
 * through; this list is the durable half of the guard (PLAN R5.2).
 *
 * @param {'win32'|'darwin'|'linux'} electronPlatformName
 * @returns {{ id: string, label: string, pattern: RegExp }[]}
 */
export function bannedPackageRules(electronPlatformName = 'win32') {
  const rules = [
    {
      id: 'sourcemaps',
      label: '*.map — sourcemaps have no runtime role (225.8 MB at 2026-07-26)',
      pattern: /\.map$/,
    },
    {
      id: 'download-cache',
      label: '.cache/ — transformers.js download cache; makes installer size depend on whether the maintainer ran TTS (88.1 MB)',
      pattern: /(^|\/)\.cache\//,
    },
    {
      // PERMANENT REGRESSION GUARD. The Goose harness has been REMOVED from the
      // product entirely (TACHI, the first-party harness, supersedes it) — it is
      // not bundled and it is not downloaded on demand any more. Nothing
      // references it, but a dev machine that ran an older `prepare:sidecars`
      // still has a 225 MB binary sitting in `resources/sidecars/goose/`, so
      // this rule (plus the electron-builder extraResources filter) makes sure
      // that stale directory can never sneak into an installer.
      // History: the earlier narrower `goose-double-ship` rule banned only the
      // orphaned `goose-package/` copy, which hid a two-month stale-binary bug.
      id: 'goose-bundled',
      label: 'sidecars/goose/ — the Goose harness is REMOVED from the product; a stale dev copy must never ship',
      pattern: /(^|\/)sidecars\/goose\//,
    },
    {
      id: 'freellmapi-dev-db',
      label: "sidecars/freellmapi/server/data/ — the maintainer's SQLite DB (schema includes api_keys + a request log). Trust bug, not a size bug.",
      pattern: /(^|\/)sidecars\/freellmapi\/server\/data\//,
    },
    {
      // R6 — onnxruntime-web arrives as a transitive dep of
      // @huggingface/transformers and is NEVER imported by our code: RAG
      // (rag-service.ts) and Kokoro TTS (kokoro-tts.ts) both run on
      // onnxruntime-NODE. MEASURED inside the 07-26 08:56 app.asar: 7 entries,
      // 125.40 MB — four under @huggingface/transformers' nested copy, two under
      // the hoisted onnxruntime-web, one under kokoro-js's transformers 3.8.1.
      //
      // VERIFIED in transformers.node.cjs before landing this (not assumed):
      //   1. `var ONNX_NODE = __toESM(require("onnxruntime-node"))` — the node
      //      backend is a hard require, so it is the path we run.
      //   2. `dist/ort.webgpu.bundle.min.mjs` is INLINED into transformers.node.cjs
      //      at build time, so nothing ever reads onnxruntime-web's own dist JS
      //      off disk. Dropping the .wasm therefore cannot break the JS import.
      //   3. If the web backend were ever selected it sets
      //      `wasm.wasmPaths` to a cdn.jsdelivr.net URL — NOT the local dist —
      //      so it would fail on our egress/CSP policy anyway.
      // Net: the wasm files are unreachable weight, and a hypothetical web-backend
      // fallback FAILS HARD (which we want to hear about) rather than silently
      // limping along on a slow CPU wasm path.
      id: 'onnxruntime-web-wasm',
      label: 'onnxruntime-web / @huggingface/transformers dist *.wasm — browser ORT backends (measured 125.4 MB in app.asar); we run onnxruntime-node',
      pattern: /(^|\/)(onnxruntime-web|@huggingface\/transformers)\/dist\/[^/]+\.wasm$/,
    },
  ]
  const foreign = FOREIGN_ORT_PLATFORMS[electronPlatformName] ?? []
  if (foreign.length > 0) {
    rules.push({
      id: 'onnxruntime-foreign-platform',
      label: `onnxruntime-node binaries for ${foreign.join('/')} — not reachable from a ${electronPlatformName} build`,
      pattern: new RegExp(`onnxruntime-node/bin/napi-v3/(${foreign.join('|')})/`),
    })
  }
  return rules
}

/** Default (Windows) rule set — used by the CLI. */
export const BANNED_ASAR_ENTRIES = bannedPackageRules('win32')

/**
 * Parse the asar header out of the first bytes of an archive.
 *
 * Format (chromium Pickle, twice): [0,4) = 4, [4,8) = header pickle size,
 * [12,16) = JSON length, [16, 16+len) = the JSON directory tree.
 *
 * @param {Buffer} buf at least the first 16 + jsonLength bytes of the archive
 * @returns {{ header: any, jsonLength: number, baseOffset: number }}
 */
export function parseAsarHeaderBuffer(buf) {
  if (buf.length < 16) throw new Error(`asar header truncated (${buf.length} bytes, need >= 16)`)
  const headerPickleSize = buf.readUInt32LE(4)
  const jsonLength = buf.readUInt32LE(12)
  if (jsonLength <= 0 || 16 + jsonLength > buf.length) {
    throw new Error(`asar header claims ${jsonLength} JSON bytes but only ${buf.length - 16} are available`)
  }
  const json = buf.toString('utf8', 16, 16 + jsonLength)
  return { header: JSON.parse(json), jsonLength, baseOffset: 8 + headerPickleSize }
}

/** Read + parse the header of an asar file on disk. */
export function readAsarHeader(asarPath) {
  const fd = openSync(asarPath, 'r')
  try {
    const sizeBuf = Buffer.alloc(8)
    readSync(fd, sizeBuf, 0, 8, 0)
    const headerPickleSize = sizeBuf.readUInt32LE(4)
    const buf = Buffer.alloc(8 + headerPickleSize)
    readSync(fd, buf, 0, buf.length, 0)
    return parseAsarHeaderBuffer(buf)
  } finally {
    closeSync(fd)
  }
}

/**
 * Flatten an asar directory tree into a list of file entries.
 * @param {any} header the parsed header (its `files` map)
 * @returns {{ path: string, size: number, unpacked: boolean }[]}
 */
export function flattenAsarEntries(header) {
  const out = []
  const walk = (node, prefix) => {
    if (!node || !node.files) return
    for (const [name, child] of Object.entries(node.files)) {
      const p = prefix ? `${prefix}/${name}` : name
      if (child && child.files) walk(child, p)
      else out.push({ path: p, size: Number(child?.size ?? 0), unpacked: Boolean(child?.unpacked) })
    }
  }
  walk(header, '')
  return out
}

/**
 * @param {{ path: string, size: number }[]} entries
 * @param {{ id: string, label: string, pattern: RegExp }[]} rules
 * @returns {{ id: string, label: string, count: number, bytes: number, samples: string[] }[]}
 *          one row per rule that matched at least one entry
 */
export function findBannedEntries(entries, rules = BANNED_ASAR_ENTRIES) {
  const hits = []
  for (const rule of rules) {
    let count = 0
    let bytes = 0
    const samples = []
    for (const e of entries) {
      if (!rule.pattern.test(e.path)) continue
      count += 1
      bytes += e.size
      if (samples.length < 5) samples.push(e.path)
    }
    if (count > 0) hits.push({ id: rule.id, label: rule.label, count, bytes, samples })
  }
  return hits
}

/**
 * Group entries by their first `depth` path segments, heaviest first.
 * @returns {{ prefix: string, bytes: number, count: number }[]}
 */
export function summarizeByPrefix(entries, depth = 3) {
  const totals = new Map()
  for (const e of entries) {
    const prefix = e.path.split('/').slice(0, depth).join('/')
    const cur = totals.get(prefix) ?? { prefix, bytes: 0, count: 0 }
    cur.bytes += e.size
    cur.count += 1
    totals.set(prefix, cur)
  }
  return [...totals.values()].sort((a, b) => b.bytes - a.bytes)
}

export function formatMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const topIdx = args.indexOf('--top')
  const top = topIdx >= 0 ? Number(args[topIdx + 1]) : 20
  const positional = args.filter((a, i) => !a.startsWith('--') && !(topIdx >= 0 && i === topIdx + 1))
  const here = dirname(fileURLToPath(import.meta.url))
  const asarPath = positional[0] ?? join(here, '..', 'release-build', 'win-unpacked', 'resources', 'app.asar')

  if (!existsSync(asarPath)) {
    console.error(`[asar-report] no archive at ${asarPath}`)
    process.exit(2)
  }

  const { header } = readAsarHeader(asarPath)
  const entries = flattenAsarEntries(header)
  const totalBytes = entries.reduce((n, e) => n + e.size, 0)
  const banned = findBannedEntries(entries)

  if (asJson) {
    console.log(JSON.stringify({ asarPath, files: entries.length, totalBytes, banned: banned.map(b => ({ ...b })) }, null, 2))
  } else {
    console.log(`\n[asar-report] ${asarPath}`)
    console.log(`  entries: ${entries.length}   packed: ${formatMB(totalBytes)}\n`)
    console.log(`  top ${top} directories:`)
    for (const row of summarizeByPrefix(entries, 3).slice(0, top)) {
      console.log(`    ${formatMB(row.bytes).padStart(12)}  ${String(row.count).padStart(6)} files  ${row.prefix}`)
    }
    console.log(`\n  must-not-ship rules:`)
    if (banned.length === 0) {
      console.log(`    OK — none of ${BANNED_ASAR_ENTRIES.length} rules matched.`)
    } else {
      for (const b of banned) {
        console.log(`    FAIL ${b.id}: ${b.count} entries, ${formatMB(b.bytes)} — ${b.label}`)
        for (const s of b.samples) console.log(`         e.g. ${s}`)
      }
    }
    console.log('')
  }
  process.exit(banned.length > 0 ? 1 : 0)
}
