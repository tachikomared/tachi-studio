// apps/desktop/test/unit/toolCallRow.test.ts
//
// Pure-formatter contract for <ToolCallRow>. These are the bits that are easy
// to get subtly wrong (rounding boundaries, truncation, non-finite guards) and
// that must stay byte-identical to what TraceTab / ToolCallBlock rendered
// before the two rows were unified onto the shared component.
import { describe, it, expect } from 'vitest'
import {
  formatToolDuration,
  formatArgsPreview,
  formatTokenCount,
  toolCallStatusColor,
} from '../../src/components/toolCallRow.format'

describe('formatToolDuration', () => {
  it('renders sub-second durations as integer milliseconds', () => {
    expect(formatToolDuration(0)).toBe('0ms')
    expect(formatToolDuration(1)).toBe('1ms')
    expect(formatToolDuration(500)).toBe('500ms')
    expect(formatToolDuration(999)).toBe('999ms')
  })

  it('rounds fractional milliseconds', () => {
    expect(formatToolDuration(820.6)).toBe('821ms')
    expect(formatToolDuration(12.4)).toBe('12ms')
  })

  it('renders one-second-and-over as seconds to one decimal', () => {
    expect(formatToolDuration(1000)).toBe('1.0s')
    expect(formatToolDuration(1500)).toBe('1.5s')
    expect(formatToolDuration(12_345)).toBe('12.3s')
    expect(formatToolDuration(60_000)).toBe('60.0s')
  })

  it('returns empty string for non-finite / negative input', () => {
    expect(formatToolDuration(-1)).toBe('')
    expect(formatToolDuration(NaN)).toBe('')
    expect(formatToolDuration(Infinity)).toBe('')
  })
})

describe('formatArgsPreview', () => {
  it('passes a short string through unchanged', () => {
    expect(formatArgsPreview('/etc/hosts')).toBe('/etc/hosts')
    expect(formatArgsPreview('')).toBe('')
  })

  it('returns empty string for null / undefined', () => {
    expect(formatArgsPreview(null)).toBe('')
    expect(formatArgsPreview(undefined)).toBe('')
  })

  it('JSON-stringifies non-string values', () => {
    expect(formatArgsPreview({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}')
    expect(formatArgsPreview([1, 2, 3])).toBe('[1,2,3]')
    expect(formatArgsPreview(42)).toBe('42')
    expect(formatArgsPreview(true)).toBe('true')
  })

  it('collapses internal whitespace and newlines to single spaces', () => {
    expect(formatArgsPreview('a\n  b\t c')).toBe('a b c')
    expect(formatArgsPreview('  leading and trailing  ')).toBe('leading and trailing')
  })

  it('truncates past the max length with an ellipsis', () => {
    const out = formatArgsPreview('x'.repeat(100))
    expect(out).toHaveLength(61) // 60 chars + '…'
    expect(out.endsWith('…')).toBe(true)
    expect(out.startsWith('x'.repeat(60))).toBe(true)
  })

  it('honors a custom max length', () => {
    expect(formatArgsPreview('abcdef', 3)).toBe('abc…')
    expect(formatArgsPreview('abc', 3)).toBe('abc')
  })

  it('falls back to String() when JSON.stringify throws (circular)', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(formatArgsPreview(circular)).toBe('[object Object]')
  })
})

describe('formatTokenCount', () => {
  it('renders raw counts under 1k', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(512)).toBe('512')
    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(12.7)).toBe('13')
  })

  it('renders thousands and millions compactly', () => {
    expect(formatTokenCount(1000)).toBe('1.0k')
    expect(formatTokenCount(1234)).toBe('1.2k')
    expect(formatTokenCount(1_500_000)).toBe('1.5M')
  })

  it('returns empty string for non-finite / negative input', () => {
    expect(formatTokenCount(-5)).toBe('')
    expect(formatTokenCount(NaN)).toBe('')
    expect(formatTokenCount(Infinity)).toBe('')
  })
})

describe('toolCallStatusColor', () => {
  it('maps each status to its themed CSS var', () => {
    expect(toolCallStatusColor('running')).toBe('var(--accent)')
    expect(toolCallStatusColor('ok')).toBe('var(--success)')
    expect(toolCallStatusColor('error')).toBe('var(--danger, #ff5252)')
  })
})
