// packages/core/src/codegraph/parse.ts
//
// Heuristic import-specifier extraction for TS/JS. Regex (not a full parser) is
// deliberate: it's dependency-free, fast over a whole workspace, and a
// blast-radius graph tolerates the rare miss far better than a stale vector
// index tolerates an edit. Covers the common forms; resolve() later drops bare
// (node_modules) specifiers, so over-matching an external package is harmless.

const PATTERNS: RegExp[] = [
  /\bimport\s+[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g, // import x from 'spec' / import {..} from "spec" / import * as x from 'spec'
  /\bexport\s+[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g, // export {..} from 'spec' / export * from 'spec'
  /\bimport\s*['"]([^'"]+)['"]/g,                   // import 'spec'  (side-effect)
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,        // require('spec')
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,         // import('spec')  (dynamic)
]

/** Distinct module specifiers referenced by `text`, in first-seen order. */
export function parseImportSpecifiers(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const re of PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const spec = m[1]
      if (spec && !seen.has(spec)) {
        seen.add(spec)
        out.push(spec)
      }
    }
  }
  return out
}

// Named top-level export DECLARATIONS — `export [default] [async] [abstract]
// function|class|const enum|const|let|var|interface|type|enum NAME`. `const
// enum` precedes `const` so the longer keyword wins. Anonymous default exports
// (`export default () => …`, `export default {…}`) have no symbol name and are
// deliberately not reported.
const EXPORT_DECL =
  /\bexport\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|const\s+enum|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g
// Named export / re-export lists — `export { a, b as c }` and `export { d } from
// '…'`. The exported binding is the alias after `as`, else the name itself.
const EXPORT_LIST = /\bexport\s*\{([^}]*)\}/g

/**
 * Distinct symbol names exported by `text`, in first-seen order. Same regex
 * (not full-parser) philosophy as parseImportSpecifiers: covers the common
 * forms cheaply; a rare miss only thins an architectural overview, it doesn't
 * corrupt anything. Powers the `get_architecture` tool.
 */
export function parseExportedSymbols(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (name: string): void => {
    if (name && !seen.has(name)) { seen.add(name); out.push(name) }
  }

  EXPORT_DECL.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = EXPORT_DECL.exec(text)) !== null) add(m[1])

  EXPORT_LIST.lastIndex = 0
  while ((m = EXPORT_LIST.exec(text)) !== null) {
    for (const raw of m[1].split(',')) {
      const entry = raw.trim().replace(/^type\s+/, '') // `export { type Foo }`
      if (!entry) continue
      const asMatch = /\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(entry)
      add(asMatch ? asMatch[1] : entry)
    }
  }
  return out
}

export interface ImportBinding {
  /** local name in the importing file. */
  local: string
  /** original export name in the source module ('default' / '*' for namespace). */
  imported: string
  /** the module specifier it's imported from. */
  source: string
}

const IMPORT_STMT = /\bimport\s+([^'";]+?)\s+from\s*['"]([^'"]+)['"]/g

/**
 * Every import binding in `text` — what local name comes from which source
 * module under which original name. Powers the `find_references` tool ("which
 * files import symbol X"). Regex, pure; import-level only (no in-body usage).
 */
export function parseImportBindings(text: string): ImportBinding[] {
  const out: ImportBinding[] = []
  IMPORT_STMT.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = IMPORT_STMT.exec(text)) !== null) {
    const clause = m[1].trim().replace(/^type\s+/, '') // drop `import type { … }`
    const source = m[2]
    const brace = /\{([^}]*)\}/.exec(clause)
    if (brace) {
      for (const raw of brace[1].split(',')) {
        const entry = raw.trim().replace(/^type\s+/, '') // `{ type Foo }`
        if (!entry) continue
        const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(entry)
        if (asMatch) out.push({ local: asMatch[2], imported: asMatch[1], source })
        else if (/^[A-Za-z_$][\w$]*$/.test(entry)) out.push({ local: entry, imported: entry, source })
      }
    }
    // default + namespace bindings live outside the braces.
    for (const raw of clause.replace(/\{[^}]*\}/, ' ').split(',')) {
      const entry = raw.trim()
      if (!entry) continue
      const ns = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(entry)
      if (ns) { out.push({ local: ns[1], imported: '*', source }); continue }
      if (/^[A-Za-z_$][\w$]*$/.test(entry)) out.push({ local: entry, imported: 'default', source })
    }
  }
  return out
}

export interface SymbolDefinition {
  name: string
  /** function | class | const | let | var | interface | type | enum */
  kind: string
  /** 1-based line of the declaration. */
  line: number
  exported: boolean
}

// Module-level (column-0) declaration sites. Anchored at `^` (no indent) so it
// matches top-level declarations and skips nested/local ones and class members
// (which lack a declaration keyword anyway). `const enum` precedes `const`.
const DEFINITION =
  /^(export\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(function\*?|class|const\s+enum|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm

/**
 * Top-level symbol definitions in `text` (name + kind + 1-based line + whether
 * exported), in source order. Regex (not full-parser) per the file's design;
 * powers the `find_definition` tool — a cross-workspace "go to definition".
 */
export function parseDefinitions(text: string): SymbolDefinition[] {
  const out: SymbolDefinition[] = []
  DEFINITION.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = DEFINITION.exec(text)) !== null) {
    const kw = m[2]
    const kind = kw.startsWith('function') ? 'function' : /^const\s+enum$/.test(kw) ? 'enum' : kw
    const line = text.slice(0, m.index).split('\n').length
    out.push({ name: m[3], kind, line, exported: Boolean(m[1]) })
  }
  return out
}
