// apps/desktop/electron/services/tachi/call-graph.ts
//
// AST symbol-level call extraction (STEAL 2026-06-21 / §10 codebase-memory-mcp).
// The import graph (parse.ts, regex) answers file-level "who imports X"; this
// answers function-level "who CALLS X" — which needs a real AST. Uses the
// TypeScript compiler API, lazy-required so it never costs anything at startup
// (only when find_callers actually runs). Electron-side, NOT in @tachi/core,
// because core is deliberately dependency-free.

import type * as TS from 'typescript'

export interface CallSite {
  /** the called identifier / property name (a.b() -> "b"). */
  callee: string
  /** the innermost enclosing named function/method, or null at module top level. */
  callerFn: string | null
  /** 1-based line of the call. */
  line: number
}

let tsMod: typeof TS | null = null
function ts(): typeof TS {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  if (!tsMod) tsMod = require('typescript') as typeof TS
  return tsMod
}

function calleeName(expr: TS.Expression, t: typeof TS): string | null {
  if (t.isIdentifier(expr)) return expr.text
  if (t.isPropertyAccessExpression(expr)) return expr.name.text
  return null
}

/** Name of a function-ish node for the caller stack, or null if anonymous/unnamed. */
function fnName(node: TS.Node, t: typeof TS): string | null {
  if (t.isFunctionDeclaration(node) || t.isMethodDeclaration(node)) {
    return node.name && t.isIdentifier(node.name) ? node.name.text : null
  }
  if (t.isFunctionExpression(node) || t.isArrowFunction(node)) {
    const p = node.parent
    if (p && t.isVariableDeclaration(p) && t.isIdentifier(p.name)) return p.name.text
    if (p && t.isPropertyAssignment(p) && t.isIdentifier(p.name)) return p.name.text
    return null
  }
  return null
}

const isFnNode = (node: TS.Node, t: typeof TS): boolean =>
  t.isFunctionDeclaration(node) || t.isMethodDeclaration(node) || t.isFunctionExpression(node) || t.isArrowFunction(node)

/** Every call site in `text` with its callee and innermost enclosing function. */
export function extractCalls(text: string, fileName = 'f.ts'): CallSite[] {
  const t = ts()
  const kind = fileName.endsWith('x') ? t.ScriptKind.TSX : t.ScriptKind.TS
  const sf = t.createSourceFile(fileName, text, t.ScriptTarget.Latest, /* setParentNodes */ true, kind)
  const out: CallSite[] = []
  const stack: (string | null)[] = []

  const visit = (node: TS.Node): void => {
    const pushed = isFnNode(node, t)
    if (pushed) stack.push(fnName(node, t))
    if (t.isCallExpression(node)) {
      const callee = calleeName(node.expression, t)
      if (callee) {
        // innermost NAMED caller (skip anonymous frames)
        let caller: string | null = null
        for (let i = stack.length - 1; i >= 0; i--) { if (stack[i]) { caller = stack[i]; break } }
        out.push({ callee, callerFn: caller, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 })
      }
    }
    t.forEachChild(node, visit)
    if (pushed) stack.pop()
  }
  visit(sf)
  return out
}
