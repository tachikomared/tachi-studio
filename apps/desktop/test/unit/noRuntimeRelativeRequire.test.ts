// apps/desktop/test/unit/noRuntimeRelativeRequire.test.ts
//
// REGRESSION NET for a whole bug class, not one bug.
//
// electron-vite bundles the ENTIRE main process into a single out/main/index.js.
// Inside app.asar there is therefore no ./settings-store, no ./llama-cpp-client,
// no ../services/run-log — those files simply do not exist at runtime. A
// `require('./settings-store')` written inside a function body compiles fine,
// typechecks fine, and works in `pnpm dev` (where main runs from source) — then
// throws "Cannot find module ./settings-store" in every packaged build.
//
// That is exactly how chat died: memory-facts-service used a lazy relative
// require, chat-service called into it unconditionally before every provider
// branch, and chat.ipc swallowed the rejection. Zero chunks, zero logs, silent
// dead chat in every shipped installer.
//
// This test scans the main-process source and fails on ANY relative require in
// electron/**/*.ts. Bare-specifier requires ('electron', 'node:path', a npm
// package) are fine — those resolve from node_modules / the electron runtime.
//
// If a site is genuinely safe (e.g. a file that is NOT bundled and ships as a
// loose script), add it to ALLOWLIST with a written reason.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ELECTRON_DIR = join(fileURLToPath(new URL('../../', import.meta.url)), 'electron')

/**
 * `<posix relative path>` → why the relative require there is proven safe.
 * Empty on purpose: today every main-process .ts file is bundled.
 */
const ALLOWLIST: Record<string, string> = {}

/** Matches require('./x'), require("../x"), require(`./x`) — any whitespace. */
const RELATIVE_REQUIRE = /require\s*\(\s*['"`]\.{1,2}\//

/**
 * Strip line and block comments while PRESERVING string literals (the require's
 * argument lives in one). Quote-aware so 'http://x' is never read as a
 * comment, and escape-aware so an escaped quote does not desync the scanner.
 */
export function stripComments(src: string): string {
  let out = ''
  let i = 0
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'tick' = 'code'
  while (i < src.length) {
    const c = src[i]!
    const n = src[i + 1]
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; i += 2; continue }
      if (c === '/' && n === '*') { state = 'block'; i += 2; continue }
      if (c === "'") state = 'single'
      else if (c === '"') state = 'double'
      else if (c === '`') state = 'tick'
      out += c; i++; continue
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c }
      i++; continue
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; i += 2; continue }
      if (c === '\n') out += c // keep line numbers honest
      i++; continue
    }
    // inside a string literal
    out += c
    if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue }
    if ((state === 'single' && c === "'") || (state === 'double' && c === '"') || (state === 'tick' && c === '`')) {
      state = 'code'
    }
    i++
  }
  return out
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'out') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (name.endsWith('.ts')) acc.push(p)
  }
  return acc
}

describe('no runtime relative require() in the bundled main process', () => {
  const files = walk(ELECTRON_DIR)

  it('finds main-process source to scan (guards against a broken glob)', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it('has no relative require() anywhere under electron/', () => {
    const offenders: string[] = []
    for (const file of files) {
      const rel = relative(ELECTRON_DIR, file).split(sep).join('/')
      if (Object.hasOwn(ALLOWLIST, rel)) continue
      const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
      lines.forEach((line, idx) => {
        if (RELATIVE_REQUIRE.test(line)) offenders.push(`electron/${rel}:${idx + 1}  ${line.trim()}`)
      })
    }

    expect(offenders, [
      '',
      'Relative require() found in the bundled main process:',
      ...offenders.map(o => `  ${o}`),
      '',
      'electron-vite bundles electron/ into ONE out/main/index.js, so a relative',
      'path does not exist at runtime inside app.asar — this throws "Cannot find',
      'module" in every PACKAGED build while working perfectly in `pnpm dev`.',
      'This is the bug that silently killed chat in every shipped installer.',
      '',
      'Fix: use a top-level `import ... from \'./x\'` (hoisted, bundled, cycle-safe',
      'when the use is inside a function body), or `await import(\'./x\')` which the',
      'bundler resolves statically. If you need to keep a module out of an import',
      'graph, inject the value from the caller instead.',
      '',
      'If a site is genuinely safe, add it to ALLOWLIST in this file with a reason.',
    ].join('\n')).toEqual([])
  })
})

describe('stripComments', () => {
  it('removes line and block comments', () => {
    expect(stripComments('a // b\nc')).toBe('a \nc')
    expect(stripComments('a /* b */ c')).toBe('a  c')
  })

  it('keeps string literals — including URLs and escaped quotes', () => {
    expect(stripComments(`const u = 'http://x/y' // note`)).toBe(`const u = 'http://x/y' `)
    expect(stripComments(`const q = 'it\\'s /* not */ a comment'`)).toBe(`const q = 'it\\'s /* not */ a comment'`)
  })

  it('does not flag a relative require that only appears in a comment', () => {
    const src = `// never write require('./settings-store') here\nimport x from './settings-store'`
    expect(RELATIVE_REQUIRE.test(stripComments(src))).toBe(false)
  })

  it('DOES flag a real relative require', () => {
    const src = `function f() {\n  const { a } = require('./settings-store')\n  return a\n}`
    expect(RELATIVE_REQUIRE.test(stripComments(src))).toBe(true)
  })
})
