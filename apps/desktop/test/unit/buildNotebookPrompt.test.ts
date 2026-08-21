// apps/desktop/test/unit/buildNotebookPrompt.test.ts
//
// Notebook surface v1 (STEAL 2026-06-21 #7, open-notebook — CAG-first, not
// vector RAG). The grounded-prompt assembly is the testable core: the page hands
// this to the existing chat via setPendingMessage, so streaming/provider reuse
// the proven path.

import { describe, it, expect } from 'vitest'
import { buildNotebookPrompt } from '../../src/pages/notebook/buildNotebookPrompt'

describe('buildNotebookPrompt', () => {
  it('renders each non-empty source and appends the question with a grounding instruction', () => {
    const p = buildNotebookPrompt(
      [
        { title: 'Spec', text: 'The widget must be blue.' },
        { title: 'Notes', text: 'Shipping in Q3.' },
      ],
      'What colour is the widget?',
    )
    expect(p).toContain('Spec')
    expect(p).toContain('The widget must be blue.')
    expect(p).toContain('Notes')
    expect(p).toContain('Shipping in Q3.')
    expect(p).toContain('What colour is the widget?')
    expect(p.toLowerCase()).toContain('only') // grounding: answer ONLY from the sources
  })

  it('skips sources with no (or whitespace-only) text', () => {
    const p = buildNotebookPrompt(
      [
        { title: 'Real', text: 'content here' },
        { title: 'Empty', text: '   ' },
      ],
      'q?',
    )
    expect(p).toContain('Real')
    expect(p).not.toContain('Empty')
  })

  it('still includes the question when there are no usable sources', () => {
    expect(buildNotebookPrompt([], 'why is the sky blue?')).toContain('why is the sky blue?')
  })
})
