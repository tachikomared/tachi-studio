// packages/core/src/codegraph/__tests__/codegraph.test.ts
//
// Code-dependency graph for the harness (STEAL 2026-06-18 codesight blast_radius;
// chosen over vector RAG for code per RAG-EMBEDDER-DECISION REVISIT). Pure,
// dependency-free, regex-based import edges → reverse-BFS "what breaks if I touch
// this file". No stale vector index, exact symbols, fresh on every build.
import { describe, it, expect } from 'vitest'
import { parseImportSpecifiers, parseExportedSymbols, parseDefinitions, parseImportBindings } from '../parse.js'
import { resolveImport, buildCodeGraph, blastRadius, tracePath, summarizeArchitecture, isSourceFile } from '../graph.js'

describe('parseImportSpecifiers', () => {
  it('extracts specifiers from every common import form', () => {
    const text = [
      `import a from './a'`,
      `import { b } from "../b"`,
      `import * as c from './c.js'`,
      `import './side-effect'`,
      `export { d } from './d'`,
      `export * from './e'`,
      `const f = require('./f')`,
      `const g = await import('./g')`,
      `import pkg from 'react'`, // external — still parsed; resolve() drops it
    ].join('\n')
    expect(parseImportSpecifiers(text).sort()).toEqual(
      ['../b', './a', './c.js', './d', './e', './f', './g', './side-effect', 'react'].sort(),
    )
  })

  it('dedupes repeated specifiers and ignores import-like text in comments only loosely', () => {
    expect(parseImportSpecifiers(`import x from './x'\nimport y from './x'`)).toEqual(['./x'])
  })

  it('returns [] for text with no imports', () => {
    expect(parseImportSpecifiers('const x = 1\nfunction y() {}')).toEqual([])
  })
})

describe('resolveImport', () => {
  const files = new Set(['src/a.ts', 'src/sub/b.tsx', 'src/sub/index.ts', 'src/c.js'])

  it('resolves a relative specifier with extension inference', () => {
    expect(resolveImport('src/main.ts', './a', files)).toBe('src/a.ts')
    expect(resolveImport('src/sub/x.ts', '../c', files)).toBe('src/c.js')
    expect(resolveImport('src/main.ts', './sub/b', files)).toBe('src/sub/b.tsx')
  })

  it('resolves a directory import to its index file', () => {
    expect(resolveImport('src/a.ts', './sub', files)).toBe('src/sub/index.ts')
  })

  it('returns null for a bare (node_modules) specifier', () => {
    expect(resolveImport('src/a.ts', 'react', files)).toBeNull()
    expect(resolveImport('src/a.ts', '@scope/pkg', files)).toBeNull()
  })

  it('returns null when no workspace file matches', () => {
    expect(resolveImport('src/a.ts', './does-not-exist', files)).toBeNull()
  })

  it('maps a .js/.jsx specifier to its TS source (NodeNext: import .js, file is .ts)', () => {
    const f = new Set(['src/index.ts', 'src/codegraph/graph.ts', 'src/ui/widget.tsx'])
    expect(resolveImport('src/index.ts', './codegraph/graph.js', f)).toBe('src/codegraph/graph.ts')
    expect(resolveImport('src/index.ts', './ui/widget.jsx', f)).toBe('src/ui/widget.tsx')
  })
})

describe('buildCodeGraph + blastRadius', () => {
  const mk = (path: string, ...imports: string[]) => ({
    path,
    text: imports.map(i => `import x from '${i}'`).join('\n'),
  })

  it('reverse-BFS returns all transitive importers of a changed file', () => {
    // c is imported by b, b by a → changing c blasts a + b.
    const g = buildCodeGraph([
      mk('a.ts', './b'),
      mk('b.ts', './c'),
      mk('c.ts'),
    ])
    expect(blastRadius(g, 'c.ts')).toEqual(['a.ts', 'b.ts'])
    expect(blastRadius(g, 'b.ts')).toEqual(['a.ts'])
    expect(blastRadius(g, 'a.ts')).toEqual([]) // nothing imports the leaf importer
  })

  it('is cycle-safe (a ↔ b) and never loops forever', () => {
    const g = buildCodeGraph([mk('a.ts', './b'), mk('b.ts', './a')])
    expect(blastRadius(g, 'a.ts')).toEqual(['b.ts'])
    expect(blastRadius(g, 'b.ts')).toEqual(['a.ts'])
  })

  it('handles a diamond (a→b, a→c, b→d, c→d): changing d blasts a,b,c', () => {
    const g = buildCodeGraph([
      mk('a.ts', './b', './c'),
      mk('b.ts', './d'),
      mk('c.ts', './d'),
      mk('d.ts'),
    ])
    expect(blastRadius(g, 'd.ts')).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('honours maxDepth (direct importers only at depth 1)', () => {
    const g = buildCodeGraph([mk('a.ts', './b'), mk('b.ts', './c'), mk('c.ts')])
    expect(blastRadius(g, 'c.ts', { maxDepth: 1 })).toEqual(['b.ts'])
  })

  it('ignores external imports and self-edges', () => {
    const g = buildCodeGraph([
      { path: 'a.ts', text: `import r from 'react'\nimport b from './b'` },
      mk('b.ts'),
    ])
    expect(g.forward.get('a.ts')!.has('b.ts')).toBe(true)
    expect(g.forward.get('a.ts')!.size).toBe(1) // react dropped
  })

  it('sees NodeNext .js-extension edges so a TS package barrel is not invisible', () => {
    // packages/core style: `export * from './graph.js'` while the file is graph.ts.
    const g = buildCodeGraph([
      { path: 'index.ts', text: `export * from './graph.js'` },
      { path: 'graph.ts', text: '' },
    ])
    expect(blastRadius(g, 'graph.ts')).toEqual(['index.ts'])
  })
})

describe('tracePath', () => {
  const mk = (path: string, ...imports: string[]) => ({
    path,
    text: imports.map(i => `import x from '${i}'`).join('\n'),
  })

  it('returns the direct import edge as a 2-node path', () => {
    const g = buildCodeGraph([mk('a.ts', './b'), mk('b.ts')])
    expect(tracePath(g, 'a.ts', 'b.ts')).toEqual(['a.ts', 'b.ts'])
  })

  it('returns the transitive import chain', () => {
    const g = buildCodeGraph([mk('a.ts', './b'), mk('b.ts', './c'), mk('c.ts')])
    expect(tracePath(g, 'a.ts', 'c.ts')).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('returns null when `from` does not depend on `to`', () => {
    const g = buildCodeGraph([mk('a.ts', './b'), mk('b.ts')])
    expect(tracePath(g, 'b.ts', 'a.ts')).toBeNull() // edges are directed (b does not import a)
  })

  it('returns the lexicographically-first shortest path on a diamond', () => {
    // a→b→d and a→c→d are both length 3; sorted-neighbour BFS picks b before c.
    const g = buildCodeGraph([mk('a.ts', './b', './c'), mk('b.ts', './d'), mk('c.ts', './d'), mk('d.ts')])
    expect(tracePath(g, 'a.ts', 'd.ts')).toEqual(['a.ts', 'b.ts', 'd.ts'])
  })

  it('returns a single-node path when from === to', () => {
    const g = buildCodeGraph([mk('a.ts', './b'), mk('b.ts')])
    expect(tracePath(g, 'a.ts', 'a.ts')).toEqual(['a.ts'])
  })

  it('returns null for an unknown node', () => {
    const g = buildCodeGraph([mk('a.ts', './b'), mk('b.ts')])
    expect(tracePath(g, 'a.ts', 'nope.ts')).toBeNull()
  })
})

describe('summarizeArchitecture', () => {
  const mk = (path: string, ...imports: string[]) => ({
    path,
    text: imports.map(i => `import x from '${i}'`).join('\n'),
  })

  it('counts files and directed import edges', () => {
    const g = buildCodeGraph([mk('a.ts', './b', './c'), mk('b.ts', './d'), mk('c.ts', './d'), mk('d.ts')])
    const s = summarizeArchitecture(g)
    expect(s.fileCount).toBe(4)
    expect(s.edgeCount).toBe(4) // a→b, a→c, b→d, c→d
  })

  it('ranks hubs by how many files import them (most-depended-upon first)', () => {
    const g = buildCodeGraph([mk('a.ts', './b', './c'), mk('b.ts', './d'), mk('c.ts', './d'), mk('d.ts')])
    const s = summarizeArchitecture(g)
    expect(s.hubs[0]).toEqual({ path: 'd.ts', importedBy: 2 }) // imported by b and c
    expect(s.hubs.every(h => h.importedBy > 0)).toBe(true)     // a hub is imported by something
  })

  it('separates entry points (imported by nobody) from isolated orphans', () => {
    const g = buildCodeGraph([
      mk('a.ts', './b', './c'), mk('b.ts', './d'), mk('c.ts', './d'), mk('d.ts'),
      mk('z.ts'), // imports nothing and is imported by nobody
    ])
    const s = summarizeArchitecture(g)
    expect(s.entryPoints).toEqual(['a.ts']) // root: imports others, nobody imports it
    expect(s.orphans).toEqual(['z.ts'])     // fully isolated
  })

  it('caps the hub list to topHubs', () => {
    const g = buildCodeGraph([mk('a.ts', './b', './c', './d'), mk('b.ts'), mk('c.ts'), mk('d.ts')])
    expect(summarizeArchitecture(g, { topHubs: 2 }).hubs).toHaveLength(2)
  })
})

describe('parseExportedSymbols', () => {
  it('extracts names from every common export form', () => {
    const text = [
      `export function foo() {}`,
      `export async function bar() {}`,
      `export class Baz {}`,
      `export abstract class Qux {}`,
      `export const a = 1`,
      `export let b = 2`,
      `export interface I {}`,
      `export type T = number`,
      `export enum E {}`,
      `export const enum CE {}`,
      `export default function main() {}`,
      `export default class App {}`,
      `export { listed, other as renamed }`,
      `export { reexp } from './x'`,
    ].join('\n')
    expect(parseExportedSymbols(text).sort()).toEqual(
      ['App', 'Baz', 'CE', 'E', 'I', 'Qux', 'T', 'a', 'b', 'bar', 'foo', 'listed', 'main', 'renamed', 'reexp'].sort(),
    )
  })

  it('ignores non-exported declarations', () => {
    expect(parseExportedSymbols(`function priv() {}\nconst hidden = 1\nclass Local {}`)).toEqual([])
  })

  it('dedupes a symbol that is both declared-exported and re-listed', () => {
    expect(parseExportedSymbols(`export const a = 1\nexport { a }`)).toEqual(['a'])
  })

  it('returns [] when there are no exports', () => {
    expect(parseExportedSymbols(`import x from './y'\nconst z = 1`)).toEqual([])
  })
})

describe('parseDefinitions', () => {
  it('captures top-level (column-0) declarations with kind, line, and exported flag', () => {
    const text = [
      `export function foo() {}`,   // 1
      `function bar() {}`,          // 2
      `export class Baz {}`,        // 3
      `const qux = 1`,              // 4
      `export interface I {}`,      // 5
      `export const enum E {}`,     // 6
      `type T = number`,            // 7
      `  const local = 2`,          // 8 — indented (nested/local) → not a module-level def
    ].join('\n')
    expect(parseDefinitions(text)).toEqual([
      { name: 'foo', kind: 'function', line: 1, exported: true },
      { name: 'bar', kind: 'function', line: 2, exported: false },
      { name: 'Baz', kind: 'class', line: 3, exported: true },
      { name: 'qux', kind: 'const', line: 4, exported: false },
      { name: 'I', kind: 'interface', line: 5, exported: true },
      { name: 'E', kind: 'enum', line: 6, exported: true },
      { name: 'T', kind: 'type', line: 7, exported: false },
    ])
  })

  it('ignores usages, calls, and export lists (declaration sites only)', () => {
    expect(parseDefinitions(`foo()\nexport { a, b }\nconst x = bar()`)).toEqual([
      { name: 'x', kind: 'const', line: 3, exported: false },
    ])
  })

  it('returns [] when there are no declarations', () => {
    expect(parseDefinitions(`import x from './y'\nawait run()`)).toEqual([])
  })
})

describe('parseImportBindings', () => {
  it('parses named bindings, including renames and type-only members', () => {
    expect(parseImportBindings(`import { a, b as c, type T } from './m.js'`)).toEqual([
      { local: 'a', imported: 'a', source: './m.js' },
      { local: 'c', imported: 'b', source: './m.js' },
      { local: 'T', imported: 'T', source: './m.js' },
    ])
  })

  it('parses a default import as imported="default"', () => {
    expect(parseImportBindings(`import d from './m.js'`)).toEqual([
      { local: 'd', imported: 'default', source: './m.js' },
    ])
  })

  it('parses a namespace import as imported="*"', () => {
    expect(parseImportBindings(`import * as ns from './m.js'`)).toEqual([
      { local: 'ns', imported: '*', source: './m.js' },
    ])
  })

  it('parses a combined default + named import', () => {
    expect(parseImportBindings(`import d, { a } from './m'`)).toEqual([
      { local: 'a', imported: 'a', source: './m' },
      { local: 'd', imported: 'default', source: './m' },
    ])
  })

  it('ignores a type-only import statement keyword (no phantom "type" default)', () => {
    expect(parseImportBindings(`import type { T } from './m'`)).toEqual([
      { local: 'T', imported: 'T', source: './m' },
    ])
  })

  it('returns [] for side-effect imports and non-imports', () => {
    expect(parseImportBindings(`import './side-effect'\nconst x = 1`)).toEqual([])
  })
})

describe('isSourceFile', () => {
  it('accepts TS/JS source under the project', () => {
    expect(isSourceFile('apps/desktop/electron/services/tachi/tools.ts')).toBe(true)
    expect(isSourceFile('packages/core/src/codegraph/graph.ts')).toBe(true)
    expect(isSourceFile('a.tsx')).toBe(true)
    expect(isSourceFile('x/y.mjs')).toBe(true)
  })

  it('rejects non-source extensions', () => {
    expect(isSourceFile('README.md')).toBe(false)
    expect(isSourceFile('src/styles.css')).toBe(false)
    expect(isSourceFile('package.json')).toBe(false)
  })

  it('rejects dependency / build-output directories', () => {
    expect(isSourceFile('node_modules/react/index.js')).toBe(false)
    expect(isSourceFile('dist/bundle.js')).toBe(false)
    expect(isSourceFile('apps/desktop/out/main.js')).toBe(false)
    expect(isSourceFile('coverage/x.js')).toBe(false)
  })

  it('rejects dot-directories (the .research-tmp / .claude-worktree pollution this fixes)', () => {
    expect(isSourceFile('.research-tmp/steal-2026-06-21/repos/CodexMonitor/src/types.ts')).toBe(false)
    expect(isSourceFile('.claude/worktrees/foo/src/a.ts')).toBe(false)
    expect(isSourceFile('.git/hooks/x.js')).toBe(false)
    expect(isSourceFile('apps/.next/server/a.js')).toBe(false)
  })
})
