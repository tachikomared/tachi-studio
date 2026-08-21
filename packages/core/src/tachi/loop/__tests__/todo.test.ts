// packages/core/src/tachi/loop/__tests__/todo.test.ts
import { describe, it, expect } from 'vitest'
import { renderTodoLedger, hasOpenTodos, openTodoCount, summarizeTodos, type TodoItem } from '../todo.js'

const t = (content: string, status: TodoItem['status']): TodoItem => ({ content, status })

describe('hasOpenTodos / openTodoCount', () => {
  it('counts pending + in_progress as open; completed/cancelled are closed', () => {
    const items: TodoItem[] = [t('a', 'pending'), t('b', 'in_progress'), t('c', 'completed'), t('d', 'cancelled')]
    expect(hasOpenTodos(items)).toBe(true)
    expect(openTodoCount(items)).toBe(2)
  })
  it('is false/zero when nothing is open', () => {
    const items: TodoItem[] = [t('c', 'completed'), t('d', 'cancelled')]
    expect(hasOpenTodos(items)).toBe(false)
    expect(openTodoCount(items)).toBe(0)
  })
  it('is false for an empty list', () => {
    expect(hasOpenTodos([])).toBe(false)
    expect(openTodoCount([])).toBe(0)
  })
})

describe('summarizeTodos', () => {
  it('reports a per-status breakdown', () => {
    const items: TodoItem[] = [t('a', 'pending'), t('b', 'pending'), t('c', 'in_progress'), t('d', 'completed')]
    expect(summarizeTodos(items)).toBe('1 in progress, 2 pending, 1 done, 0 cancelled')
  })
})

describe('renderTodoLedger', () => {
  it('returns null for an empty list (nothing to pin)', () => {
    expect(renderTodoLedger([])).toBeNull()
  })

  it('renders in-progress first, then pending, and collapses closed items to a count', () => {
    const items: TodoItem[] = [
      t('write the parser', 'completed'),
      t('wire it into the loop', 'in_progress'),
      t('add tests', 'pending'),
      t('drop the dead field', 'cancelled'),
    ]
    const out = renderTodoLedger(items)!
    expect(out).toContain('[>] wire it into the loop')
    expect(out).toContain('[ ] add tests')
    expect(out).toContain('(1 completed, 1 cancelled)')
    // in-progress appears before pending
    expect(out.indexOf('wire it into the loop')).toBeLessThan(out.indexOf('add tests'))
    // closed items are NOT rendered verbatim
    expect(out).not.toContain('write the parser')
    expect(out).not.toContain('drop the dead field')
  })

  it('clips an overlong item instead of bloating the ledger', () => {
    const long = 'x'.repeat(500)
    const out = renderTodoLedger([t(long, 'pending')])!
    expect(out).toContain('…')
    expect(out.length).toBeLessThan(400)
  })

  it('caps the number of open items rendered and notes the overflow', () => {
    const items: TodoItem[] = Array.from({ length: 40 }, (_, i) => t(`item ${i}`, 'pending'))
    const out = renderTodoLedger(items)!
    expect(out).toContain('more open item(s)')
  })
})
