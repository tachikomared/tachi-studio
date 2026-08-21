// apps/desktop/test/unit/chatFilePathChips.test.ts
//
// FILE-PATH CHIPS ON THE CHAT SURFACE (batch34 lane A).
//
// The CODE tab has had clickable file chips for a while; chat never did, for
// exactly one reason: a chat message has no working directory, and
// extractFilePaths returns [] without one. This file pins the seam that closes
// that gap:
//
//   • the PURE resolvers — which dir a send captures, which dir a rendered
//     message resolves against, when chips are allowed to render at all, and
//     the degraded absolute-path extraction used when there is no dir;
//   • the WIRING those resolvers live in (store stamp → composer capture →
//     bubble render), which cannot be driven in this repo's node-only test
//     setup and is therefore asserted against the source.
//
// House idiom: pure helpers exercised for real, wiring guarded by source
// assertions (same convention as codexCardWiring.test.ts).

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  resolveSendWorkingDir,
  resolveMessageWorkingDir,
  shouldRenderFileChips,
  driveRootsIn,
  absoluteFilePathsFallback,
} from '../../src/pages/chat/messageWorkingDir'
import { extractFilePaths } from '../../src/pages/agent/FilePathChips'

const APP = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(APP, rel), 'utf8')
const CHAT = 'src/pages/chat'

/** Drop comments so an assertion about CODE is never satisfied by prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

// ── The gap this closes ───────────────────────────────────────────────────────

describe('the gap: a chat message has no working dir', () => {
  it('extractFilePaths yields NOTHING without a working dir (the reason chat had no chips)', () => {
    expect(extractFilePaths('I wrote D:\\projects\\x\\diagram.png', null)).toEqual([])
  })

  it('…and yields the path once a dir is threaded through', () => {
    expect(extractFilePaths('I wrote D:\\projects\\x\\diagram.png', 'D:\\projects\\x'))
      .toEqual(['D:\\projects\\x\\diagram.png'])
  })
})

// ── resolveSendWorkingDir — what the composer captures ────────────────────────

describe('resolveSendWorkingDir', () => {
  it('prefers the explicit conversation workspace over the attached folder', () => {
    expect(resolveSendWorkingDir({ workspaceDir: 'D:\\ws', attachedFolder: 'D:\\notes' }))
      .toBe('D:\\ws')
  })

  it('falls back to the attached knowledge folder (the common chat case)', () => {
    expect(resolveSendWorkingDir({ workspaceDir: null, attachedFolder: 'D:\\notes' }))
      .toBe('D:\\notes')
  })

  it('is null when the chat has neither', () => {
    expect(resolveSendWorkingDir({})).toBeNull()
    expect(resolveSendWorkingDir(null)).toBeNull()
  })

  it('treats blank / whitespace-only values as absent', () => {
    expect(resolveSendWorkingDir({ workspaceDir: '   ', attachedFolder: 'D:\\notes' })).toBe('D:\\notes')
    expect(resolveSendWorkingDir({ workspaceDir: '', attachedFolder: '' })).toBeNull()
  })

  it('trims a padded path instead of storing the padding', () => {
    expect(resolveSendWorkingDir({ attachedFolder: '  D:\\notes  ' })).toBe('D:\\notes')
  })
})

// ── resolveMessageWorkingDir — what a rendered message resolves against ───────

describe('resolveMessageWorkingDir', () => {
  const conv = { workspaceDir: 'D:\\ws', ragFolder: 'D:\\notes' }

  it('the per-message SEND-TIME stamp wins over the conversation dirs', () => {
    // The whole point of capturing at send time: re-pointing the workspace
    // later must NOT change which paths an old answer resolves.
    expect(resolveMessageWorkingDir({ workingDir: 'D:\\old-run' }, conv)).toBe('D:\\old-run')
  })

  it('a stamped message keeps resolving after the folder is detached', () => {
    expect(resolveMessageWorkingDir({ workingDir: 'D:\\old-run' }, { workspaceDir: null, ragFolder: null }))
      .toBe('D:\\old-run')
  })

  it('an UNSTAMPED (pre-feature) message falls back to the conversation workspace', () => {
    expect(resolveMessageWorkingDir({}, conv)).toBe('D:\\ws')
  })

  it('…then to the conversation attached folder', () => {
    expect(resolveMessageWorkingDir({}, { ragFolder: 'D:\\notes' })).toBe('D:\\notes')
  })

  it('is null when nothing is available — the degraded, absolute-paths-only mode', () => {
    expect(resolveMessageWorkingDir({}, {})).toBeNull()
    expect(resolveMessageWorkingDir({}, null)).toBeNull()
    expect(resolveMessageWorkingDir(null, null)).toBeNull()
  })
})

// ── shouldRenderFileChips — the render gate ───────────────────────────────────

describe('shouldRenderFileChips', () => {
  it('allows a finished assistant reply', () => {
    expect(shouldRenderFileChips({ role: 'assistant' })).toBe(true)
    expect(shouldRenderFileChips({ role: 'assistant', streaming: false })).toBe(true)
  })

  it('blocks a STREAMING reply (a half-arrived path is not a file)', () => {
    expect(shouldRenderFileChips({ role: 'assistant', streaming: true })).toBe(false)
  })

  it('blocks an errored reply', () => {
    expect(shouldRenderFileChips({ role: 'assistant', error: 'boom' })).toBe(false)
  })

  it('blocks user turns', () => {
    expect(shouldRenderFileChips({ role: 'user' })).toBe(false)
    expect(shouldRenderFileChips(null)).toBe(false)
  })
})

// ── The no-working-dir fallback ───────────────────────────────────────────────

describe('driveRootsIn', () => {
  it('finds the drive root of a bare path', () => {
    expect(driveRootsIn('see D:\\a\\b.png')).toEqual(['D:\\'])
  })

  it('finds a quoted path\'s drive', () => {
    expect(driveRootsIn('saved to "C:\\my docs\\a.md"')).toEqual(['C:\\'])
  })

  it('tolerates forward slashes', () => {
    expect(driveRootsIn('open D:/a/b.html')).toEqual(['D:\\'])
  })

  it('dedupes case-insensitively and preserves first-seen order', () => {
    expect(driveRootsIn('D:\\a.png and c:\\b.md and d:/c.txt')).toEqual(['D:\\', 'C:\\'])
  })

  it('is empty for text with no absolute paths', () => {
    expect(driveRootsIn('just some prose about png files')).toEqual([])
    expect(driveRootsIn('')).toEqual([])
  })

  it('does not read a drive letter out of the middle of a word', () => {
    // "…abcD:\…" is not a path start; the char before the letter must be a
    // non-alphanumeric (or the string start).
    expect(driveRootsIn('httpsD:\\a.png')).toEqual([])
  })
})

describe('absoluteFilePathsFallback', () => {
  it('returns absolute previewable paths with NO working dir', () => {
    expect(absoluteFilePathsFallback('I wrote D:\\projects\\x\\diagram.png for you'))
      .toEqual(['D:\\projects\\x\\diagram.png'])
  })

  it('spans several drives, deduped, order preserved', () => {
    const out = absoluteFilePathsFallback('D:\\a\\one.png then C:\\b\\two.md then D:\\a\\one.png again')
    expect(out).toEqual(['D:\\a\\one.png', 'C:\\b\\two.md'])
  })

  it('inherits the extractor\'s extension filter (no chip for an unpreviewable file)', () => {
    expect(absoluteFilePathsFallback('the installer is at D:\\out\\setup.exe')).toEqual([])
  })

  it('inherits trailing-punctuation stripping and quoting', () => {
    expect(absoluteFilePathsFallback('written to "D:\\my docs\\a report.md".'))
      .toEqual(['D:\\my docs\\a report.md'])
  })

  it('caps the chip count', () => {
    const text = Array.from({ length: 12 }, (_, i) => `D:\\a\\f${i}.md`).join(' ')
    expect(absoluteFilePathsFallback(text)).toHaveLength(8)
    expect(absoluteFilePathsFallback(text, 3)).toHaveLength(3)
  })

  it('is empty for prose', () => {
    expect(absoluteFilePathsFallback('no files here')).toEqual([])
    expect(absoluteFilePathsFallback('')).toEqual([])
  })
})

// ── Wiring: the store stamps the send-time dir onto the reply ─────────────────

describe('chat.store: workingDir is captured at send time and persisted', () => {
  const src = () => read('src/store/chat.store.ts')

  it('ChatMessage carries an optional workingDir', () => {
    expect(src()).toContain('workingDir?: string')
  })

  it('parks the dir per conversation with the same idiom as pendingCitations', () => {
    const s = src()
    expect(s).toContain('pendingWorkingDir: Record<string, string>')
    expect(s).toContain('setPendingWorkingDir: (conversationId: string, dir: string | null) => void')
    expect(s).toContain('setPendingWorkingDir(conversationId, dir) {')
  })

  it("appendChunk('start') stamps the parked dir onto the new assistant message and consumes it", () => {
    const s = src()
    expect(s).toContain('const wdir = get().pendingWorkingDir?.[tcid]')
    expect(s).toContain('...(wdir ? { workingDir: wdir } : {})')
    expect(s).toContain('if (wdir) delete nextWorkingDir[tcid]')
  })

  it('drops a parked dir on error and on done so it cannot leak onto a later reply', () => {
    const s = src()
    // Three sites clone-and-clear the map: start (consume), error, done.
    expect((s.match(/const nextWorkingDir = \{ \.\.\.s\.pendingWorkingDir \}/g) ?? []).length).toBe(3)
    expect((s.match(/delete nextWorkingDir\[tcid\]/g) ?? []).length).toBe(3)
    // The two unconditional deletes are the error/done cleanups; start's is
    // guarded by `if (wdir)` because there may be nothing parked.
    expect((s.match(/\n\s+delete nextWorkingDir\[tcid\]/g) ?? []).length).toBe(2)
  })

  it('the parked map is transient — reset on rehydrate, absent from partialize', () => {
    const s = src()
    expect(s).toContain('state.pendingWorkingDir = {}')
    const partialize = s.slice(s.indexOf('partialize:'), s.indexOf('onRehydrateStorage'))
    expect(partialize).not.toContain('pendingWorkingDir')
  })

  it('PERSISTENCE SHAPE: the stamp rides inside `conversations`, which is persisted whole', () => {
    const s = src()
    const partialize = s.slice(s.indexOf('partialize:'), s.indexOf('onRehydrateStorage'))
    expect(partialize).toContain('conversations: s.conversations')
    // …and the on-disk JSON mirror stringifies the conversation object as-is.
    expect(read('electron/ipc/chat.ipc.ts')).toContain('JSON.stringify(parsed, null, 2)')
  })
})

describe('InputBar: the composer captures the ACTIVE dir on send and on regenerate', () => {
  const src = () => read(`${CHAT}/InputBar.tsx`)

  it('imports the resolver rather than inlining the precedence', () => {
    expect(src()).toContain("import { resolveSendWorkingDir } from './messageWorkingDir'")
  })

  it('parks the dir for a normal send, from the workspace + the folder it just resolved', () => {
    const s = src()
    expect(s).toContain('resolveSendWorkingDir({ workspaceDir: conv.workspaceDir, attachedFolder })')
  })

  it('parks the dir for a REGENERATE too (it mints a new assistant message)', () => {
    const s = src()
    expect(s).toContain('resolveSendWorkingDir({ workspaceDir: conv.workspaceDir, attachedFolder: regenAttachedFolder })')
    expect((s.match(/setPendingWorkingDir\(/g) ?? []).length).toBe(2)
  })
})

describe('MessageBubble / MessageList: where the chips render', () => {
  it('MessageBubble renders the chips right after SourceChips, behind the gate', () => {
    const s = read(`${CHAT}/MessageBubble.tsx`)
    expect(s).toContain("import { ChatFilePathChips } from './ChatFilePathChips'")
    expect(s).toContain("import { shouldRenderFileChips } from './messageWorkingDir'")
    const afterSources = s.slice(s.indexOf('<SourceChips citations={message.citations} />'))
    expect(afterSources).toContain('{shouldRenderFileChips(message) && (')
    expect(afterSources).toContain('<ChatFilePathChips text={contentText} workingDir={workingDir ?? null} />')
  })

  it('MessageList resolves the per-message dir and threads it in', () => {
    const s = read(`${CHAT}/MessageList.tsx`)
    expect(s).toContain("import { resolveMessageWorkingDir } from './messageWorkingDir'")
    expect(s).toContain('workingDir={resolveMessageWorkingDir(m, conv)}')
  })
})

describe('ChatFilePathChips: the adapter REUSES the agent component, never forks it', () => {
  const src = () => read(`${CHAT}/ChatFilePathChips.tsx`)

  it('imports FilePathChips and its pure helpers from the agent page', () => {
    expect(src()).toContain("import { FilePathChips, extractFilePaths, isImagePath } from '../agent/FilePathChips'")
    expect(src()).toContain('<FilePathChips text={text} workingDir={workingDir} onOpen={onOpen} />')
  })

  it('does NOT re-implement the workspace-registration / thumbnail-retry contract', () => {
    // Comments are stripped: the header EXPLAINS the contract it defers to, and
    // that prose must not be mistaken for a second implementation of it.
    const code = stripComments(src())
    for (const forked of ['registerWorkspace', 'MAX_THUMB_READ_ATTEMPTS', 'canRetryRead', 'readFile', 'readRetryDelayMs', 'setTimeout']) {
      expect(code).not.toContain(forked)
    }
  })

  it("confines the agent component's lazy 'agent' namespace to a local Suspense boundary", () => {
    // Namespaces load lazily with suspense ON and the only boundary is the app
    // root — without this the whole app would blank on the first chip render.
    expect(src()).toContain('<React.Suspense fallback={null}>')
  })

  it('opens a chip by REVEALING it (chat has no PreviewPanel)', () => {
    expect(src()).toContain('window.tachi.shell.revealInFolder(path)')
  })

  it('falls back to plain absolute-path chips when there is no working dir', () => {
    const s = src()
    expect(s).toContain("import { absoluteFilePathsFallback } from './messageWorkingDir'")
    expect(s).toContain('absoluteFilePathsFallback(text)')
    // …and renders nothing at all when neither mode found a path.
    expect((s.match(/return null/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('the agent component still exports exactly the contract the adapter borrows', () => {
    // Read-only reuse: the chat lane leaves FilePathChips.tsx alone, so these
    // three exports (and the no-workingDir → no-chips rule the fallback exists
    // to work around) are the interface this adapter is pinned to.
    const agent = read('src/pages/agent/FilePathChips.tsx')
    expect(agent).toContain('export function extractFilePaths(text: string, workingDir: string | null): string[]')
    expect(agent).toContain('export function isImagePath(path: string): boolean')
    expect(agent).toContain('export function FilePathChips({ text, workingDir, onOpen }: FilePathChipsProps)')
    expect(agent).toContain('if (!text || !workingDir) return []')
  })
})
