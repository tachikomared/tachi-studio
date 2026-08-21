// Design tab: version pinning, non-destructive restore, per-session brand
// preset, and the dropped-HTML / DESIGN.md helpers.
//
// Guards three real bugs:
//   • refine used latestHtml() and ignored the pinned version — pin v2, edit v5.
//   • the only way "back" was rewindTo(), which DELETES the tail with no confirm.
//   • the 10 brand presets + DESIGN.md were plumbed to the prompt but never sent.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  useDesignStore, DRAFT_PRESET_KEY,
  refineSourceHtml, refineSourceCode, latestHtml, latestCode,
  looksLikeFullHtmlDocument, extractDesignMd, DESIGN_PREVIEW_MAX_CHARS,
  type DesignMessage,
} from '../../src/store/design.store'

const reset = () => useDesignStore.setState({
  projects: [], activeProjectId: null, projectCtx: {}, sessions: [], activeId: null,
  presetBySession: {},
})

/** Build a thread: user turn + N assistant versions. Returns the messages. */
function seedThread(versions: Array<{ html?: string; code?: string }>): DesignMessage[] {
  const st = useDesignStore.getState()
  st.addUser('a landing page')
  for (const v of versions) useDesignStore.getState().addAssistant('Here is your design.', v.html, v.code)
  const s = useDesignStore.getState()
  return s.sessions.find(x => x.id === s.activeId)!.messages
}

describe('design refine source (pinning fix)', () => {
  beforeEach(reset)

  it('refines the PINNED version, not the latest', () => {
    const messages = seedThread([{ html: '<v1>' }, { html: '<v2>' }, { html: '<v3>' }])
    const v2 = messages.filter(m => m.role === 'assistant')[1]
    expect(latestHtml(messages)).toBe('<v3>')
    expect(refineSourceHtml(messages, v2.id)).toBe('<v2>')
  })

  it('falls back to the latest version when nothing is pinned', () => {
    const messages = seedThread([{ html: '<v1>' }, { html: '<v2>' }])
    expect(refineSourceHtml(messages, null)).toBe('<v2>')
    expect(refineSourceHtml(messages, undefined)).toBe('<v2>')
  })

  it('falls back to the latest when the pinned id has no document', () => {
    const messages = seedThread([{ html: '<v1>' }, { html: '<v2>' }])
    const userTurn = messages.find(m => m.role === 'user')!
    expect(refineSourceHtml(messages, userTurn.id)).toBe('<v2>')
    expect(refineSourceHtml(messages, 'nope')).toBe('<v2>')
  })

  it('does the same for animation composition source', () => {
    const messages = seedThread([{ html: '<h1>', code: 'CODE_1' }, { html: '<h2>', code: 'CODE_2' }])
    const v1 = messages.filter(m => m.role === 'assistant')[0]
    expect(latestCode(messages)).toBe('CODE_2')
    expect(refineSourceCode(messages, v1.id)).toBe('CODE_1')
    expect(refineSourceCode(messages, null)).toBe('CODE_2')
  })
})

describe('design restore-as-new (git-revert semantics)', () => {
  beforeEach(reset)

  const versions = () => {
    const s = useDesignStore.getState()
    const msgs = s.sessions.find(x => x.id === s.activeId)!.messages
    return msgs.filter(m => m.role === 'assistant' && m.html).map(m => m.html)
  }

  it('appends vN as a NEW latest version and keeps the whole tail', () => {
    const messages = seedThread([{ html: '<v1>' }, { html: '<v2>' }, { html: '<v3>' }])
    const v1 = messages.filter(m => m.role === 'assistant')[0]

    const created = useDesignStore.getState().restoreVersion(v1.id, 'Restored v1')
    expect(created?.html).toBe('<v1>')
    expect(created?.text).toBe('Restored v1')
    expect(created?.id).not.toBe(v1.id)
    // nothing deleted — v1..v3 still there, plus the restored copy as latest
    expect(versions()).toEqual(['<v1>', '<v2>', '<v3>', '<v1>'])
    const s = useDesignStore.getState()
    expect(latestHtml(s.sessions.find(x => x.id === s.activeId)!.messages)).toBe('<v1>')
  })

  it('carries the composition source across too', () => {
    const messages = seedThread([{ html: '<h1>', code: 'CODE_1' }, { html: '<h2>', code: 'CODE_2' }])
    const v1 = messages.filter(m => m.role === 'assistant')[0]
    const created = useDesignStore.getState().restoreVersion(v1.id)
    expect(created?.code).toBe('CODE_1')
    const s = useDesignStore.getState()
    expect(latestCode(s.sessions.find(x => x.id === s.activeId)!.messages)).toBe('CODE_1')
  })

  it('refuses ids that are not document turns of the active session', () => {
    const messages = seedThread([{ html: '<v1>' }])
    const userTurn = messages.find(m => m.role === 'user')!
    expect(useDesignStore.getState().restoreVersion(userTurn.id)).toBeNull()
    expect(useDesignStore.getState().restoreVersion('nope')).toBeNull()
    expect(versions()).toEqual(['<v1>'])
  })

  it('rewindTo stays available as the DESTRUCTIVE path (UI gates it behind a confirm)', () => {
    const messages = seedThread([{ html: '<v1>' }, { html: '<v2>' }])
    const userTurn = messages.find(m => m.role === 'user')!
    const text = useDesignStore.getState().rewindTo(userTurn.id)
    expect(text).toBe('a landing page')
    const s = useDesignStore.getState()
    expect(s.sessions.find(x => x.id === s.activeId)!.messages).toEqual([])
  })
})

describe('design brand preset persistence', () => {
  beforeEach(reset)

  it('parks a preset picked before the first send and carries it onto the new session', () => {
    useDesignStore.getState().setPreset('linear')
    expect(useDesignStore.getState().presetBySession[DRAFT_PRESET_KEY]).toBe('linear')

    useDesignStore.getState().addUser('a pricing page')
    const s = useDesignStore.getState()
    expect(s.presetBySession[s.activeId!]).toBe('linear')
    expect(s.presetBySession[DRAFT_PRESET_KEY]).toBeUndefined()
  })

  it('keeps the preset per session and restores it when a session is reopened', () => {
    useDesignStore.getState().addUser('session A')
    const a = useDesignStore.getState().activeId!
    useDesignStore.getState().setPreset('stripe')

    useDesignStore.getState().newSession()
    useDesignStore.getState().addUser('session B')
    const b = useDesignStore.getState().activeId!
    useDesignStore.getState().setPreset('editorial-serif')

    const s = useDesignStore.getState()
    expect(s.presetBySession[a]).toBe('stripe')
    expect(s.presetBySession[b]).toBe('editorial-serif')

    useDesignStore.getState().loadSession(a)
    const back = useDesignStore.getState()
    expect(back.presetBySession[back.activeId!]).toBe('stripe')
  })

  it('clears back to "no preset"', () => {
    useDesignStore.getState().addUser('x')
    useDesignStore.getState().setPreset('vercel')
    useDesignStore.getState().setPreset('')
    const s = useDesignStore.getState()
    expect(s.presetBySession[s.activeId!]).toBe('')
  })
})

describe('dropped-HTML detection (drop-to-open)', () => {
  it('recognises a full document by doctype or <html>', () => {
    expect(looksLikeFullHtmlDocument('<!DOCTYPE html><html><body>hi</body></html>')).toBe(true)
    expect(looksLikeFullHtmlDocument('\n\n<!doctype html>\n<html lang="en">')).toBe(true)
    expect(looksLikeFullHtmlDocument('<html>\n<head></head>\n</html>')).toBe(true)
    expect(looksLikeFullHtmlDocument('<html lang="en">')).toBe(true)
  })

  it('treats fragments and lookalike text as context, not a document', () => {
    expect(looksLikeFullHtmlDocument('<section class="hero"><h1>Hi</h1></section>')).toBe(false)
    expect(looksLikeFullHtmlDocument('Use the <htmlspecialchars> helper')).toBe(false)
    expect(looksLikeFullHtmlDocument('')).toBe(false)
  })

  it('pins the open-as-design ceiling to the design:set-preview cap (8 MB)', () => {
    expect(DESIGN_PREVIEW_MAX_CHARS).toBe(8 * 1024 * 1024)
  })
})

describe('DESIGN.md pickup from folder context', () => {
  const folderCtx = [
    '### README.md\nA project readme.',
    '### DESIGN.md\nUse a duotone teal scheme.\nRadius: none.',
    '### src/app.ts\nconsole.log(1)',
  ].join('\n\n')

  it('extracts a ROOT-level DESIGN.md block', () => {
    expect(extractDesignMd(folderCtx)).toBe('Use a duotone teal scheme.\nRadius: none.')
  })

  it('reads it when it is the last block in the context', () => {
    expect(extractDesignMd('### README.md\nhi\n\n### DESIGN.md\nInk on cream.')).toBe('Ink on cream.')
  })

  it('ignores a nested docs/DESIGN.md (root only) and empty context', () => {
    expect(extractDesignMd('### docs/DESIGN.md\nnested')).toBe('')
    expect(extractDesignMd('### README.md\nno design file here')).toBe('')
    expect(extractDesignMd('')).toBe('')
  })
})
