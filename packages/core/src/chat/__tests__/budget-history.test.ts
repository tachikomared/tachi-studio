import { describe, it, expect } from 'vitest'
import { budgetHistory, type HistoryTurn } from '../budget-history'

const turn = (role: 'user' | 'assistant', content: string): HistoryTurn => ({ role, content })

describe('budgetHistory', () => {
  it('returns history unchanged when within budget', () => {
    const h = [turn('user', 'hi'), turn('assistant', 'hello')]
    expect(budgetHistory(h, { maxChars: 1000 })).toEqual(h)
  })

  it('returns empty for empty history', () => {
    expect(budgetHistory([], { maxChars: 1000 })).toEqual([])
  })

  it('drops oldest turns and prepends a notice when over budget', () => {
    const h = [
      turn('user', 'A'.repeat(100)),       // oldest — dropped
      turn('assistant', 'B'.repeat(100)),  // dropped
      turn('user', 'C'.repeat(40)),        // kept
      turn('assistant', 'D'.repeat(40)),   // kept
    ]
    const out = budgetHistory(h, { maxChars: 100 })
    expect(out[0].role).toBe('user')
    expect(out[0].content).toMatch(/2 older turn\(s\) omitted/)
    // The two newest turns survive, the two oldest are gone.
    expect(out.map(t => t.content)).toContain('C'.repeat(40))
    expect(out.map(t => t.content)).toContain('D'.repeat(40))
    expect(out.map(t => t.content)).not.toContain('A'.repeat(100))
  })

  it('always keeps the most-recent turn even if it alone exceeds the budget', () => {
    const h = [turn('user', 'old'), turn('assistant', 'Z'.repeat(5000))]
    const out = budgetHistory(h, { maxChars: 100 })
    expect(out.some(t => t.content === 'Z'.repeat(5000))).toBe(true)
    expect(out[0].content).toMatch(/omitted/)
  })

  it('keeps the newest turns within budget, dropping just enough', () => {
    const h = Array.from({ length: 10 }, (_, i) => turn(i % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(30)))
    const out = budgetHistory(h, { maxChars: 90 }) // ~3 turns fit
    const kept = out.filter(t => !t.content.includes('omitted'))
    expect(kept.length).toBeLessThanOrEqual(3)
    expect(kept.length).toBeGreaterThan(0)
    // newest kept
    expect(kept[kept.length - 1]).toEqual(h[h.length - 1])
  })

  it('supports a custom notice template', () => {
    const h = [turn('user', 'a'.repeat(50)), turn('user', 'b'.repeat(50))]
    const out = budgetHistory(h, { maxChars: 50, noticeTemplate: 'trimmed {n}' })
    expect(out[0].content).toBe('trimmed 1')
  })
})
