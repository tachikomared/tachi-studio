// apps/desktop/test/unit/chatA11y.test.ts
//
// CHAT-SURFACE ACCESSIBILITY, WAVE 1 (batch34 lane A).
//
// The chat surface is four files — MessageList (the transcript), MessageBubble
// (every message shape), InputBar (the composer) and the two chip rows under a
// reply. None of it can be driven in this repo's node-only test setup, so the
// contract is pinned against the source, the same way codexCardWiring.test.ts
// pins wiring that is otherwise only ever verified by clicking.
//
// What is pinned here:
//   • transcript semantics — role="feed" (NOT log: see the note in MessageList)
//     with a label and a busy flag;
//   • one labelled article per message, named by AUTHOR;
//   • every composer control reachable and named — textarea, send, stop,
//     attach, folder, prompts, mic, and the per-attachment remove;
//   • chips (sources + files) are real <button>s, so tab + Enter already work;
//   • FOCUS IS NOT STOLEN by a stream: no focus() call anywhere in the render
//     path, and the auto-scroll fires on message COUNT, not on token text;
//   • every a11y string goes through t() and exists in all 8 locales.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const APP = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(APP, rel), 'utf8')
const CHAT = 'src/pages/chat'
const LOCALES = path.join(APP, 'src/i18n/locales')
const LANGS = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const

function chatNs(lang: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES, lang, 'chat.json'), 'utf8')) as Record<string, unknown>
}

/** Drop comments so an assertion about CODE is never satisfied by prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function lookup(obj: Record<string, unknown>, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>(
    (acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined),
    obj,
  )
}

// ── Transcript semantics ──────────────────────────────────────────────────────

describe('MessageList: the transcript is a labelled feed', () => {
  const src = () => read(`${CHAT}/MessageList.tsx`)

  it('is role="feed" — deliberately not role="log"', () => {
    const s = src()
    expect(s).toContain('role="feed"')
    // role="log" carries an implicit aria-live=polite: on a token stream that is
    // one announcement per frame. Comments are stripped so the rationale note
    // (which names the rejected role) doesn't satisfy the check for us.
    expect(stripComments(s)).not.toContain('role="log"')
    // …and the rationale must stay next to the code.
    expect(s).toContain('deliberately not `log`')
  })

  it('names the transcript and flags the streaming turn as busy', () => {
    const s = src()
    expect(s).toContain("aria-label={t('a11y.transcript'")
    expect(s).toContain('aria-busy={streamingConversationId === conv.id}')
  })

  it('the version stepper buttons are typed and labelled, glyphs hidden', () => {
    const s = src()
    expect((s.match(/type="button"/g) ?? []).length).toBe(2)
    expect(s).toContain("aria-label={t('versions.prev', 'Previous version')}")
    expect(s).toContain("aria-label={t('versions.next', 'Next version')}")
    expect(s).toContain('<span aria-hidden="true">◀</span>')
    expect(s).toContain('<span aria-hidden="true">▶</span>')
  })
})

// ── Per-message semantics ─────────────────────────────────────────────────────

describe('MessageBubble: one labelled article per message shape', () => {
  const src = () => read(`${CHAT}/MessageBubble.tsx`)

  it('labels every rendered message by author / kind', () => {
    const s = src()
    // user · assistant · error · tool-use — the four shapes that render a turn.
    expect((s.match(/role="article"/g) ?? []).length).toBe(4)
    expect(s).toContain("aria-label={t('a11y.userMessage'")
    expect(s).toContain("aria-label={t('a11y.assistantMessage'")
    expect(s).toContain("aria-label={t('a11y.errorMessage'")
    expect(s).toContain("aria-label={t('a11y.toolMessage'")
  })

  it('the thinking placeholder is a labelled status, not an unnamed div', () => {
    const s = src()
    expect(s).toContain('role="status"')
    expect(s).toContain("aria-label={t('a11y.thinking'")
  })

  it('hides purely decorative glyphs from the accessibility tree', () => {
    const s = src()
    // The accent square, the "···" thinking dots and the tool "▶" carry no
    // information a screen reader can use.
    expect(s).toContain('<div aria-hidden="true" style={{\n          width: 7,')
    expect(s).toContain('<span aria-hidden="true" style={{ color: \'var(--accent)\', letterSpacing: 2, fontSize: 14 }}>···</span>')
    expect(s).toContain('<span aria-hidden="true">▶ </span>')
  })

  it('FOCUS reveals the hover-only action rows (they are tabbable either way)', () => {
    const s = src()
    // Both the user row (fork / edit) and the assistant row (copy / regen /
    // fork) render at opacity 0 until hovered — but stay in the tab order, so
    // keyboard focus must reveal them or they are invisible-but-focusable.
    expect((s.match(/onFocus=\{\(\) => setHovered\(true\)\}/g) ?? []).length).toBe(2)
    expect((s.match(/onBlur=\{\(\) => setHovered\(false\)\}/g) ?? []).length).toBe(2)
  })
})

// ── Composer ──────────────────────────────────────────────────────────────────

describe('InputBar: every composer control is named', () => {
  const src = () => read(`${CHAT}/InputBar.tsx`)

  it('the textarea has a stable accessible name (a placeholder is not one)', () => {
    const s = src()
    expect(s).toContain("aria-label={t('composer.inputAria'")
    // The name must not be the placeholder — that one changes per media mode.
    const textarea = s.slice(s.indexOf('<textarea'), s.indexOf('</textarea>') >= 0 ? s.indexOf('</textarea>') : s.indexOf('<textarea') + 2000)
    expect(textarea).toContain('aria-label=')
  })

  it('send and stop are labelled', () => {
    const s = src()
    expect(s).toContain("aria-label={t('composer.sendAria')}")
    expect(s).toContain("aria-label={t('composer.stopTitle')}")
  })

  it('the attachment / folder / prompt / mic controls are labelled', () => {
    const s = src()
    expect(s).toContain("aria-label={t('composer.promptsLabel'")
    expect(s).toContain("aria-label={t('composer.attachFolderLabel'")
    expect(s).toContain("aria-label={t('composer.attachLabel'")
    expect(s).toContain("aria-label={voiceProcessing ? t('composer.transcribing')")
  })

  it('the attached-folder chip is a named group and its glyph is hidden', () => {
    const s = src()
    expect(s).toContain("aria-label={t('composer.folderChipAria'")
    expect(s).toContain('<span aria-hidden="true" style={{ color: \'var(--accent)\', fontWeight: 700 }}>[/]</span>')
    expect(s).toContain("aria-label={t('composer.folderDetach')}")
  })

  it('attachment pills form a named group and each REMOVE names its file', () => {
    const s = src()
    expect(s).toContain("aria-label={t('composer.attachmentsAria'")
    expect(s).toContain("aria-label={t('attachments.removeNamed'")
  })
})

// ── Chips are keyboard-reachable ──────────────────────────────────────────────

describe('chips: tab + Enter work because they are real buttons', () => {
  it('SourceChips renders <button type="button"> with an expanded state', () => {
    const s = read(`${CHAT}/SourceChips.tsx`)
    expect(s).toContain('type="button"')
    expect(s).toContain('aria-expanded={openIndex === i}')
    // No div-with-onClick pseudo-buttons.
    expect(s).not.toMatch(/<div[^>]*onClick=/)
  })

  it('ChatFilePathChips renders <button type="button"> with a per-path label', () => {
    const s = read(`${CHAT}/ChatFilePathChips.tsx`)
    expect(s).toContain('type="button"')
    expect(s).toContain("aria-label={t('fileChips.revealAria'")
    expect(s).toContain('role="group"')
    expect(s).not.toMatch(/<div[^>]*onClick=/)
  })
})

// ── Focus is never stolen ─────────────────────────────────────────────────────

describe('a stream never steals focus', () => {
  it('no render path in the transcript calls focus()', () => {
    for (const f of ['MessageList.tsx', 'MessageBubble.tsx', 'SourceChips.tsx', 'ChatFilePathChips.tsx']) {
      expect(read(`${CHAT}/${f}`)).not.toContain('.focus(')
    }
  })

  it('the auto-scroll fires on message COUNT, not on streamed text', () => {
    const s = read(`${CHAT}/MessageList.tsx`)
    expect(s).toContain('const msgCount = conv?.messages.length ?? 0')
    expect(s).toContain('}, [msgCount, conv?.id])')
    // If the effect ever depended on the message text it would re-scroll on
    // every token, yanking a reading user back to the bottom.
    expect(s).not.toContain('}, [contentText')
  })
})

describe('IME composition never sends the message', () => {
  it('Enter-to-send is guarded by isComposing AND keyCode 229', () => {
    // On ja/zh/ko IMEs, Enter COMMITS the candidate; unguarded, that same
    // Enter also fired send(). keyCode 229 covers the legacy-IME events some
    // Windows IMEs still deliver after compositionend.
    const s = read(`${CHAT}/InputBar.tsx`)
    const sendLine = s.split('\n').find(l => l.includes("e.key === 'Enter'") && l.includes('void send()'))
    expect(sendLine).toBeTruthy()
    expect(sendLine).toContain('!e.nativeEvent.isComposing')
    expect(sendLine).toContain('e.keyCode !== 229')
  })
})

// ── i18n parity for the new a11y strings ──────────────────────────────────────

describe('the a11y strings ship in all 8 locales', () => {
  const KEYS = [
    'a11y.transcript',
    'a11y.userMessage',
    'a11y.assistantMessage',
    'a11y.errorMessage',
    'a11y.toolMessage',
    'a11y.thinking',
    'fileChips.label',
    'fileChips.revealAria',
    'composer.inputAria',
    'composer.folderChipAria',
    'composer.attachmentsAria',
    'attachments.removeNamed',
  ]

  for (const lang of LANGS) {
    it(`${lang}/chat.json carries every new key, non-empty`, () => {
      const ns = chatNs(lang)
      for (const key of KEYS) {
        const value = lookup(ns, key)
        expect(typeof value, `${lang} ${key}`).toBe('string')
        expect((value as string).trim().length, `${lang} ${key}`).toBeGreaterThan(0)
      }
    })
  }

  it('keeps the interpolation placeholders in every locale', () => {
    const withVars: Array<[string, string]> = [
      ['a11y.toolMessage', '{{tool}}'],
      ['fileChips.revealAria', '{{name}}'],
      ['composer.folderChipAria', '{{folder}}'],
      ['composer.attachmentsAria', '{{count}}'],
      ['attachments.removeNamed', '{{name}}'],
    ]
    for (const lang of LANGS) {
      const ns = chatNs(lang)
      for (const [key, token] of withVars) {
        expect(String(lookup(ns, key)), `${lang} ${key}`).toContain(token)
      }
    }
  })
})
