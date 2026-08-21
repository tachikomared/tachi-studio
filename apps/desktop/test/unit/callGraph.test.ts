// apps/desktop/test/unit/callGraph.test.ts
//
// AST symbol-level CALLS graph (STEAL 2026-06-21 / §10 codebase-memory-mcp). The
// precise piece the regex graph can't do: call sites + their enclosing function.
// Uses the TypeScript compiler API (real AST, not regex). Powers find_callers.

import { describe, it, expect } from 'vitest'
import { extractCalls } from '../../electron/services/tachi/call-graph'

describe('extractCalls', () => {
  it('finds a call and its enclosing named function', () => {
    expect(extractCalls(`function bar() {\n  foo()\n}`)).toEqual([
      { callee: 'foo', callerFn: 'bar', line: 2 },
    ])
  })

  it('names the enclosing function from a const arrow assignment', () => {
    expect(extractCalls(`const baz = () => {\n  qux()\n}`)).toEqual([
      { callee: 'qux', callerFn: 'baz', line: 2 },
    ])
  })

  it('reports a top-level call with a null caller', () => {
    expect(extractCalls(`init()`)).toEqual([{ callee: 'init', callerFn: null, line: 1 }])
  })

  it('resolves a method call to the property name', () => {
    expect(extractCalls(`function f() { a.b() }`)).toEqual([
      { callee: 'b', callerFn: 'f', line: 1 },
    ])
  })

  it('attributes a call to the INNERMOST enclosing function', () => {
    const calls = extractCalls(`function outer() {\n  function inner() {\n    foo()\n  }\n}`)
    expect(calls).toEqual([{ callee: 'foo', callerFn: 'inner', line: 3 }])
  })

  it('returns [] when there are no calls', () => {
    expect(extractCalls(`const x = 1\ntype T = number`)).toEqual([])
  })

  it('parses TSX without choking on JSX', () => {
    const calls = extractCalls(`export function C() { return doThing() }`, 'C.tsx')
    expect(calls).toEqual([{ callee: 'doThing', callerFn: 'C', line: 1 }])
  })
})
