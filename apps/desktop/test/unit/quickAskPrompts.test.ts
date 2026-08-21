// apps/desktop/test/unit/quickAskPrompts.test.ts
//
// The quick-ask QUICK-PROMPT chips (src/app/quickAskPrompts.ts): the built-in
// templates, the slice of the chat prompt library the bar can run in one click,
// and composeQuickAsk() — the one place that decides how a chip template, the
// armed clipboard/selection context and whatever the user typed become a single
// user turn. Pure module: no electron, no React, no DOM.

import { describe, it, expect } from 'vitest'
import type { PromptTemplate } from '@tachi/core/src/prompts/template'
import {
  QUICKASK_LIBRARY_CHIPS_MAX,
  builtinQuickPrompts,
  libraryQuickPrompts,
  composeQuickAsk,
  isOneClickTemplate,
  uiLanguageName,
  previewTurnText,
} from '../../src/app/quickAskPrompts'

const tpl = (over: Partial<PromptTemplate> & { id: string }): PromptTemplate => ({
  title: over.title ?? over.id,
  body: over.body ?? 'plain body with no slots',
  createdAt: over.createdAt ?? 0,
  updatedAt: over.updatedAt ?? over.createdAt ?? 0,
  ...over,
})

// ── built-ins ────────────────────────────────────────────────────────────────

describe('builtinQuickPrompts', () => {
  it('ships exactly the four built-in chips', () => {
    const ids = builtinQuickPrompts('en').map(c => c.id)
    expect(ids).toEqual(['qp-translate', 'qp-summarize', 'qp-explain', 'qp-fix'])
    expect(builtinQuickPrompts('en').every(c => c.builtin && c.template.trim().length > 0)).toBe(true)
  })

  it('TRANSLATE targets the UI language, with English as the already-in-it fallback', () => {
    const ru = builtinQuickPrompts('ru').find(c => c.id === 'qp-translate')!
    expect(ru.template).toContain('into Russian')
    expect(ru.template).toContain('already in Russian')
    expect(ru.template).toContain('into English')
  })

  it('falls back to the ORIGINAL language when the UI language is English', () => {
    const en = builtinQuickPrompts('en').find(c => c.id === 'qp-translate')!
    expect(en.template).toContain('into English')
    expect(en.template).toContain('the original language')
  })

  it('accepts region tags and unknown languages', () => {
    expect(uiLanguageName('ru-RU')).toBe('Russian')
    expect(uiLanguageName('zh_CN')).toBe('Chinese')
    expect(uiLanguageName('xx')).toBe('English')
    expect(uiLanguageName(undefined)).toBe('English')
    expect(builtinQuickPrompts('ja').find(c => c.id === 'qp-translate')!.template).toContain('into Japanese')
  })

  it('describes what each built-in does (the chip tooltip is the template)', () => {
    const byId = Object.fromEntries(builtinQuickPrompts('en').map(c => [c.id, c.template]))
    expect(byId['qp-summarize'].toLowerCase()).toContain('bullet')
    expect(byId['qp-explain'].toLowerCase()).toContain('plain language')
    expect(byId['qp-fix'].toLowerCase()).toContain('grammar')
    expect(byId['qp-fix'].toLowerCase()).toContain('preserve the meaning')
  })
})

// ── library slice ────────────────────────────────────────────────────────────

describe('libraryQuickPrompts', () => {
  it('surfaces the newest saved prompts, capped at 6', () => {
    const many = Array.from({ length: 12 }, (_, i) => tpl({ id: `t${i}`, updatedAt: i }))
    const chips = libraryQuickPrompts(many)
    expect(QUICKASK_LIBRARY_CHIPS_MAX).toBe(6)
    expect(chips).toHaveLength(6)
    expect(chips.map(c => c.id)).toEqual(['t11', 't10', 't9', 't8', 't7', 't6'])
    expect(chips.every(c => !c.builtin)).toBe(true)
  })

  it('keeps templates whose only slots are CONTENT slots the bar can fill', () => {
    const chips = libraryQuickPrompts([
      tpl({ id: 'keep-plain', body: 'Turn this into a tweet.' }),
      tpl({ id: 'keep-text', body: 'Rewrite tighter:\n\n{{text}}' }),
      tpl({ id: 'keep-code', body: 'Review this code:\n\n{{code}}' }),
    ])
    expect(chips.map(c => c.id).sort()).toEqual(['keep-code', 'keep-plain', 'keep-text'])
  })

  it('drops templates that need the chat picker form ({{bullets}}, {{language}}…)', () => {
    const chips = libraryQuickPrompts([
      tpl({ id: 'needs-form', body: 'Summarize in {{bullets}} bullets:\n\n{{text}}' }),
      tpl({ id: 'needs-lang', body: 'Translate into {{language}}:\n\n{{text}}' }),
      tpl({ id: 'ok', body: 'Explain:\n\n{{text}}' }),
    ])
    expect(chips.map(c => c.id)).toEqual(['ok'])
    expect(isOneClickTemplate('Summarize in {{bullets}} bullets')).toBe(false)
    expect(isOneClickTemplate('Explain {{text}}')).toBe(true)
  })

  it('ignores empty bodies and survives a missing/empty library', () => {
    expect(libraryQuickPrompts([tpl({ id: 'blank', body: '   ' })])).toEqual([])
    expect(libraryQuickPrompts([])).toEqual([])
    expect(libraryQuickPrompts(undefined)).toEqual([])
  })

  it('labels the chip with the template title', () => {
    const [chip] = libraryQuickPrompts([tpl({ id: 'x', title: 'Tweetify', body: 'Make it a tweet' })])
    expect(chip.label).toBe('Tweetify')
    expect(chip.template).toBe('Make it a tweet')
  })

  it('does not mutate the caller array (no in-place sort of the store state)', () => {
    const list = [tpl({ id: 'a', updatedAt: 1 }), tpl({ id: 'b', updatedAt: 9 })]
    libraryQuickPrompts(list)
    expect(list.map(x => x.id)).toEqual(['a', 'b'])
  })
})

// ── compose ──────────────────────────────────────────────────────────────────

describe('composeQuickAsk', () => {
  it('appends the armed context as a fenced block under the template', () => {
    expect(composeQuickAsk('Summarize the text.', 'hello world', '')).toBe(
      'Summarize the text.\n\n---\nhello world',
    )
  })

  it('puts typed input between the template and the context', () => {
    expect(composeQuickAsk('Summarize the text.', 'BODY', 'in Russian')).toBe(
      'Summarize the text.\n\nin Russian\n\n---\nBODY',
    )
  })

  it('substitutes a CONTENT slot instead of appending the block twice', () => {
    const out = composeQuickAsk('Rewrite tighter:\n\n{{text}}', 'BODY', '')
    expect(out).toBe('Rewrite tighter:\n\nBODY')
    expect(out).not.toContain('---')
    expect(out.match(/BODY/g)).toHaveLength(1)
  })

  it('leaves non-content slots alone and still appends the context', () => {
    const out = composeQuickAsk('Answer in {{language}}.', 'BODY', '')
    expect(out).toBe('Answer in {{language}}.\n\n---\nBODY')
  })

  it('handles Enter with no chip (typed only, plus context)', () => {
    expect(composeQuickAsk('', 'BODY', 'what is this?')).toBe('what is this?\n\n---\nBODY')
    expect(composeQuickAsk('', '', 'what is this?')).toBe('what is this?')
  })

  it('handles a chip with no context and nothing typed', () => {
    expect(composeQuickAsk('Fix the grammar.', '', '')).toBe('Fix the grammar.')
  })

  it('is empty when there is nothing to send (the caller refuses to send)', () => {
    expect(composeQuickAsk('', '', '')).toBe('')
    expect(composeQuickAsk('   ', '  ', ' ')).toBe('')
  })
})

describe('previewTurnText', () => {
  it('passes short turns through untouched', () => {
    expect(previewTurnText('short')).toBe('short')
  })

  it('shortens a big context block for display only', () => {
    const out = previewTurnText('x'.repeat(1000), 100)
    expect(out.startsWith('x'.repeat(100))).toBe(true)
    expect(out).toContain('(+900 chars)')
  })
})
