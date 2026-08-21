// apps/desktop/test/unit/quickAskWiring.test.ts
//
// Source-level guards for the quick-ask wiring that cannot be driven from a
// node-env unit test (it needs a real BrowserWindow / a live SSE router):
// the blur gate, the streaming request, the chunk channel and the Ctrl+J
// handoff send. These assertions exist so a future edit cannot quietly
// re-introduce "hide on blur mid-answer" or drop the handoff payload.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const service = readFileSync(join(root, 'electron/services/quick-ask-service.ts'), 'utf8')
const renderer = readFileSync(join(root, 'src/app/QuickAskWindow.tsx'), 'utf8')
const preload = readFileSync(join(root, 'electron/preload.ts'), 'utf8')
const shell = readFileSync(join(root, 'src/components/layout/AppShell.tsx'), 'utf8')

describe('blur gate', () => {
  it('never hides unconditionally on blur', () => {
    expect(service).not.toContain("on('blur', () => hideQuickAsk())")
  })

  it('bails out of the blur handler while pinned or while a run is in flight', () => {
    const handler = service.slice(service.indexOf("on('blur'"), service.indexOf("on('resize'"))
    expect(handler).toContain('isQuickAskPinned()')
    expect(handler).toContain('if (inflight) return')
    expect(handler).toContain('hideQuickAsk()')
  })
})

describe('streaming', () => {
  it('asks the router with stream:true and parses SSE deltas', () => {
    expect(service).toContain('stream: true')
    expect(service).not.toContain('stream: false')
    expect(service).toContain("data === '[DONE]'")
    expect(service).toContain('choices?.[0]?.delta?.content')
  })

  it('pushes batched deltas over a quickask:chunk channel', () => {
    expect(service).toContain("send('quickask:chunk'")
    expect(service).toContain('QUICKASK_CHUNK_FLUSH_MS')
    expect(preload).toContain("ipcRenderer.on('quickask:chunk'")
    expect(renderer).toContain('quickask.onChunk')
  })

  it('exposes an abort route for Esc that reuses the inflight controller', () => {
    expect(service).toContain("ipcMain.handle('quickask:abort'")
    expect(service).toContain('inflight?.abort()')
    expect(preload).toContain("invoke('quickask:abort')")
    expect(renderer).toContain('quickask.abort')
  })

  it('carries the whole thread (not just the newest prompt) into the request', () => {
    expect(service).toContain('askStream(getTurns()')
    expect(service).toContain('...msgs')
  })

  it('keeps the partial answer when a run is aborted', () => {
    expect(service).toContain("return { ok: false, error: 'aborted', text: full.trim() }")
    expect(service).toContain("(r.ok || r.error === 'aborted') && r.text")
  })

  it('leaves NON-bar callers (audio overview) on the old one-shot contract', () => {
    expect(service).toContain('const fromBar =')
    expect(service).toContain('if (!fromBar) {')
    expect(service).toContain("askStream([{ role: 'user', content: q }]")
  })
})

describe('shown payload replay', () => {
  it('sends the thread with quickask:shown instead of a bare ping', () => {
    expect(service).toContain("send('quickask:shown', buildShownPayload())")
    expect(renderer).toContain('payload?.turns')
  })
})

describe('Ctrl+J handoff', () => {
  it('sends the turns to the main window (overlay-service send pattern)', () => {
    expect(service).toContain("ipcMain.handle('quickask:handoff'")
    expect(service).toContain("mainWindowRef.webContents.send('quickask:handoff', payload)")
    expect(service).toContain('hideQuickAsk()')
  })

  it('is subscribable from preload and seeds a persisted chat in the shell', () => {
    expect(preload).toContain("ipcRenderer.on('quickask:handoff'")
    expect(shell).toContain('quickask.onHandoff')
    expect(shell).toContain('newConversation()')
    expect(shell).toContain('addUserMessage')
    expect(shell).toContain('appendAssistantMedia')
    expect(shell).toContain('saveConversation')      // lands in history/FTS
  })

  it('is bound to Ctrl+J in the bar', () => {
    expect(renderer).toContain("e.key === 'j'")
    expect(renderer).toContain('quickask.handoff')
  })
})

describe('selection auto-capture (SendKeys guard rails)', () => {
  const gate = service.slice(service.indexOf('function shouldAutoCapture'), service.indexOf('function synthesizeCopyKeystroke'))

  it('runs ONLY on Windows, ONLY when the setting is on, NEVER over our own window', () => {
    expect(gate).toContain("process.platform !== 'win32'")
    expect(gate).toContain('!isAutoCaptureEnabled()')
    expect(gate).toContain('BrowserWindow.getFocusedWindow()')
  })

  it('is the only path to the synthetic keystroke', () => {
    // Exactly one invocation, and it sits behind the gate.
    expect(service.match(/await synthesizeCopyKeystroke\(\)/g) ?? []).toHaveLength(1)
    const capture = service.slice(service.indexOf('async function refreshContext'))
    expect(capture).toContain('if (shouldAutoCapture()) {')
    expect(capture.indexOf('shouldAutoCapture()')).toBeLessThan(capture.indexOf('synthesizeCopyKeystroke()'))
  })

  it('timeboxes the child process and kills it', () => {
    const spawnBlock = service.slice(service.indexOf('function synthesizeCopyKeystroke'), service.indexOf('const delay ='))
    expect(spawnBlock).toContain("[System.Windows.Forms.SendKeys]::SendWait('^c')")
    expect(spawnBlock).toContain('detached: true')
    expect(spawnBlock).toContain('windowsHide: true')
    expect(spawnBlock).toContain('QUICKASK_CAPTURE_TIMEOUT_MS')
    expect(spawnBlock).toContain('child.kill()')
    expect(spawnBlock).toContain("child.once('error'")
  })

  it('documents the automation-vs-feature tradeoff next to the spawn', () => {
    expect(service).toContain('TRADEOFF')
    expect(service).toContain('PowerToys Advanced Paste')
  })

  it('captures BEFORE the window steals focus', () => {
    const show = service.slice(service.indexOf('async function showQuickAsk'), service.indexOf('function toggleQuickAsk'))
    expect(show).toContain('await refreshContext()')
    expect(show.indexOf('await refreshContext()')).toBeLessThan(show.indexOf('.show()'))
  })

  it('gives the user their clipboard back after borrowing it', () => {
    const capture = service.slice(service.indexOf('async function refreshContext'))
    expect(capture).toContain('if (restoreClipboard)')
    expect(capture).toContain('clipboard.writeText(before)')
    expect(capture).toContain('clipboard.clear()')
  })
})

describe('context privacy', () => {
  it('never persists captured text — only the size and the toggle are written', () => {
    const writes = service.match(/saveSettings\(\{[^}]*/g) ?? []
    expect(writes).toHaveLength(2)
    expect(writes.join('|')).toContain('quickAskBounds')
    expect(writes.join('|')).toContain('quickAskAutoCapture')
    expect(service).not.toContain('saveSettings({ quickAskContext')
  })

  it('skips the auto-capture write in private mode', () => {
    const setter = service.slice(service.indexOf('export function setAutoCaptureEnabled'), service.indexOf('function shouldAutoCapture'))
    expect(setter).toContain("getCurrentPrivacyMode() === 'private'")
  })
})

describe('quick-prompt chips', () => {
  it('reuses the CHAT prompt library instead of building a second one', () => {
    expect(renderer).toContain("from '../store/prompts.store'")
    expect(renderer).toContain('libraryQuickPrompts(templates)')
    // No second store / second storage key behind the bar's back.
    expect(renderer).not.toContain('createJSONStorage')
    expect(renderer).not.toContain('tachi-prompts')
  })

  it('offers the four built-ins with the template as the tooltip', () => {
    expect(renderer).toContain('builtinQuickPrompts(')
    const chipButton = renderer.slice(renderer.indexOf('{chips.map(chip =>'), renderer.indexOf('</button>', renderer.indexOf('{chips.map(chip =>')))
    expect(chipButton).toContain('chip.template')
    expect(chipButton).toContain('onClick={() => runChip(chip)}')
  })

  it('NEVER auto-sends: every send comes from a click or Enter', () => {
    // Exactly two call sites: the chip click (runChip) and Enter (askNow).
    expect(service).toContain("ipcMain.handle('quickask:ask'")
    expect(renderer.match(/sendText\(/g) ?? []).toHaveLength(2)
    expect(renderer).toContain('onClick={() => runChip(chip)}')
    expect(renderer).toContain("if (e.key === 'Enter') { void askNow(); return }")
  })

  it('composes template + context + typed into ONE turn', () => {
    expect(renderer).toContain('composeQuickAsk(chip.template, armedContext, typed)')
    expect(renderer).toContain("composeQuickAsk('', armedContext, typed)")
  })

  it('arms/disarms the context chip from the payload, Esc and the X', () => {
    expect(service).toContain('context: currentContext')
    expect(preload).toContain("invoke('quickask:set-auto-capture'")
    expect(renderer).toContain('armedRef.current')
    expect(renderer).toContain('armed: false')
  })
})

describe('geometry', () => {
  it('opens on the display under the cursor and is resizable with a min size', () => {
    expect(service).toContain('getDisplayNearestPoint(screen.getCursorScreenPoint())')
    expect(service).toContain('resizable: true')
    expect(service).toContain('minWidth: MIN_W')
    expect(service).toContain('quickAskBounds')
  })

  it('skips the size write in private mode (nothing persists from this surface)', () => {
    const persist = service.slice(service.indexOf('function persistSize'), service.indexOf('function cursorWorkArea'))
    expect(persist).toContain("getCurrentPrivacyMode() === 'private'")
  })
})
