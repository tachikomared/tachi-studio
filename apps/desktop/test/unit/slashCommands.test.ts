// apps/desktop/test/unit/slashCommands.test.ts
//
// Slash-command layer: registry lookup, input parsing (aliases, args, surface
// availability, unknown commands, the `//` literal escape), the per-command
// handlers against a fake capability object, and the popup keyboard state
// machine. All pure — node env, no DOM, no electron.

import { describe, it, expect, vi } from 'vitest'
import {
  COMMANDS, listCommands, findCommand, matchCommands,
  parseCommandInput, commandQueryFromText, unknownCommandHint, slashPick,
  type CommandCaps,
} from '../../src/lib/commands/registry'
import { navigatePopup } from '../../src/lib/commands/popup-nav'
import { buildHeroCaps, HERO_SURFACE, type HeroCommandDeps } from '../../src/pages/home/heroCommands'

// A `t` that echoes the key + interpolations so assertions can see both.
const echoT = (key: string, opts?: Record<string, unknown>) =>
  opts && Object.keys(opts).length > 0 ? `${key}:${JSON.stringify(opts)}` : key

function caps(over: Partial<CommandCaps> = {}): CommandCaps {
  return { surface: 'chat', t: echoT, ...over }
}

// ── registry shape ───────────────────────────────────────────────────────────

describe('command registry', () => {
  it('every command declares at least one surface and a description key', () => {
    for (const c of COMMANDS) {
      expect(c.surfaces.length, `${c.id} surfaces`).toBeGreaterThan(0)
      expect(c.descKey, `${c.id} descKey`).toMatch(/^commands\./)
    }
  })

  it('ids and aliases are globally unique (no shadowing)', () => {
    const seen = new Set<string>()
    for (const c of COMMANDS) {
      for (const token of [c.id, ...c.aliases]) {
        expect(seen.has(token), `duplicate token /${token}`).toBe(false)
        seen.add(token)
      }
    }
  })

  it('does NOT register the chat SKILL ids for the chat surface', () => {
    // /tdd, /web, /gh … stay owned by the skills layer. Only /review /refactor
    // are shared names, and both are harness-only so chat still falls through.
    const chatIds = listCommands('chat').map(c => c.id)
    expect(chatIds).not.toContain('review')
    expect(chatIds).not.toContain('refactor')
    expect(listCommands('harness').map(c => c.id)).toContain('review')
  })

  it('resolves by id and by alias, case-insensitively', () => {
    expect(findCommand('new')?.id).toBe('new')
    expect(findCommand('clear')?.id).toBe('new')
    expect(findCommand('CLEAR')?.id).toBe('new')
    expect(findCommand('spend')?.id).toBe('cost')
    expect(findCommand('nope')).toBeNull()
  })

  it('scopes availability per surface', () => {
    expect(listCommands('chat').map(c => c.id)).toContain('rewind')
    expect(listCommands('harness').map(c => c.id)).not.toContain('rewind')
    expect(listCommands('harness').map(c => c.id)).toContain('init')
    expect(listCommands('chat').map(c => c.id)).not.toContain('init')
  })
})

// ── autocomplete matching ────────────────────────────────────────────────────

describe('matchCommands', () => {
  it('lists everything for an empty query', () => {
    expect(matchCommands('', 'chat')).toEqual(listCommands('chat'))
  })

  it('prefix-matches ids and ranks an exact id first', () => {
    const ids = matchCommands('c', 'chat').map(c => c.id)
    expect(ids).toContain('compact')
    expect(ids).toContain('cost')
    expect(ids).not.toContain('memory')                 // no 'c' prefix anywhere
    // id prefixes come before alias-only hits (/help matches via 'commands').
    expect(ids.indexOf('compact')).toBeLessThan(ids.indexOf('help'))
    expect(matchCommands('cost', 'chat')[0].id).toBe('cost')
  })

  it('matches aliases too, but ranks them after id prefixes', () => {
    const ids = matchCommands('s', 'chat').map(c => c.id)
    expect(ids[0]).toBe('search')       // id prefix
    expect(ids).toContain('cost')       // via the 'spend' alias
  })

  it('never returns a command from the other surface', () => {
    expect(matchCommands('i', 'chat').map(c => c.id)).not.toContain('init')
    expect(matchCommands('i', 'harness').map(c => c.id)).toContain('init')
  })
})

// ── input parsing ────────────────────────────────────────────────────────────

describe('parseCommandInput', () => {
  it('recognises a bare command', () => {
    const p = parseCommandInput('/help', 'chat')
    expect(p.kind).toBe('command')
    expect(p.def?.id).toBe('help')
    expect(p.args).toBe('')
  })

  it('splits args off the command token and trims them', () => {
    const p = parseCommandInput('/remember   I prefer dark mode  ', 'chat')
    expect(p.kind).toBe('command')
    expect(p.def?.id).toBe('remember')
    expect(p.args).toBe('I prefer dark mode')
  })

  it('keeps multi-line args intact', () => {
    const p = parseCommandInput('/remember line one\nline two', 'chat')
    expect(p.args).toBe('line one\nline two')
  })

  it('resolves aliases', () => {
    expect(parseCommandInput('/clear', 'chat').def?.id).toBe('new')
    expect(parseCommandInput('/?', 'chat').def?.id).toBe('help')
  })

  it('is case-insensitive on the command token', () => {
    expect(parseCommandInput('/HELP', 'chat').def?.id).toBe('help')
  })

  it('flags a command that exists only on the OTHER surface', () => {
    const p = parseCommandInput('/init', 'chat')
    expect(p.kind).toBe('unknown')
    expect(p.wrongSurface).toBe(true)
    expect(p.name).toBe('init')
  })

  it('reports a genuinely unknown command', () => {
    const p = parseCommandInput('/definitelynotacommand x', 'chat')
    expect(p.kind).toBe('unknown')
    expect(p.wrongSurface).toBeUndefined()
    expect(p.name).toBe('definitelynotacommand')
  })

  it('falls through to plain text for names the surface already owns (skills)', () => {
    const p = parseCommandInput('/tdd write a test', 'chat', { knownOther: n => n === 'tdd' })
    expect(p.kind).toBe('text')
    expect(p.text).toBe('/tdd write a test')
  })

  it('lets a wrong-surface name fall through when the surface owns it as a skill', () => {
    // /refactor is a harness command AND a chat skill — chat must keep the skill.
    const p = parseCommandInput('/refactor foo.ts', 'chat', { knownOther: n => n === 'refactor' })
    expect(p.kind).toBe('text')
    expect(p.text).toBe('/refactor foo.ts')
  })

  it('unwraps the // escape to a single literal slash', () => {
    const p = parseCommandInput('//help me', 'chat')
    expect(p.kind).toBe('text')
    expect(p.text).toBe('/help me')
  })

  it('treats ordinary prose as text', () => {
    expect(parseCommandInput('what is 2+2?', 'chat')).toEqual({ kind: 'text', text: 'what is 2+2?' })
    expect(parseCommandInput('', 'chat').kind).toBe('text')
  })

  it('does not treat a mid-sentence slash or a bare slash as a command', () => {
    expect(parseCommandInput('use a/b testing', 'chat').kind).toBe('text')
    expect(parseCommandInput('/', 'chat').kind).toBe('text')
    expect(parseCommandInput('/ help', 'chat').kind).toBe('text')
  })

  it('sends a path-like slash message as-is instead of crying "unknown"', () => {
    // The command token may not contain slashes, so "/usr/local/bin" and
    // "/etc/hosts is broken" reach the model verbatim — no escape needed.
    expect(parseCommandInput('/usr/local/bin', 'chat')).toEqual({ kind: 'text', text: '/usr/local/bin' })
    expect(parseCommandInput('/etc/hosts is broken', 'chat').kind).toBe('text')
  })

  it('offers the // escape in the unknown-command hint', () => {
    expect(unknownCommandHint(parseCommandInput('/frobnicate', 'chat'), caps())).toContain('commands.unknown')
  })
})

describe('commandQueryFromText (popup trigger)', () => {
  it('opens on a lone slash and while the verb is being typed', () => {
    expect(commandQueryFromText('/')).toBe('')
    expect(commandQueryFromText('/co')).toBe('co')
    expect(commandQueryFromText('/cost')).toBe('cost')
  })

  it('closes once args start, on the // escape, and for non-slash text', () => {
    expect(commandQueryFromText('/cost ')).toBeNull()
    expect(commandQueryFromText('//')).toBeNull()
    expect(commandQueryFromText('hello')).toBeNull()
  })
})

describe('slashPick (popup row selection)', () => {
  it('RUNS an argument-less command immediately (nothing left to submit)', () => {
    // /help, /new, /cost … are complete the instant they are picked, so the
    // composer must not be left holding a stale "/help " (whose trailing space
    // also blocks a following "/" from re-opening the popup).
    for (const id of ['help', 'new', 'cost', 'memory', 'compact', 'rewind']) {
      const action = slashPick(findCommand(id)!)
      expect(action.kind, id).toBe('run')
      expect(action.kind === 'run' && action.def.id, id).toBe(id)
    }
  })

  it('INSERTS the "/id " stub for a command that still needs arguments', () => {
    for (const id of ['remember', 'model', 'search']) {
      const def = findCommand(id)!
      expect(def.argsKey, `${id} should declare argsKey`).toBeTruthy()
      const action = slashPick(def)
      expect(action.kind, id).toBe('insert')
      expect(action.kind === 'insert' && action.text, id).toBe(`/${id} `)
    }
  })

  it('every argument-less command runs on pick, every arg-taking one inserts', () => {
    for (const c of COMMANDS) {
      expect(slashPick(c).kind, c.id).toBe(c.argsKey ? 'insert' : 'run')
    }
  })
})

// ── handlers against fake capabilities ───────────────────────────────────────

describe('command handlers', () => {
  it('/help lists exactly the surface commands and mentions the escape', async () => {
    const help = findCommand('help')!
    const res = await help.run('', caps({ surface: 'harness' }))
    expect(res.kind).toBe('note')
    const text = res.kind === 'note' ? res.text : ''
    for (const c of listCommands('harness')) expect(text).toContain(`/${c.id}`)
    expect(text).not.toContain('/rewind')      // chat-only
    expect(text).toContain('commands.help.escape')
  })

  it('reports "unavailable" instead of pretending when a capability is missing', async () => {
    const res = await findCommand('compact')!.run('', caps())   // no compact cap
    expect(res.kind).toBe('error')
    expect(res.kind === 'error' && res.text).toContain('commands.unavailable')
  })

  it('/compact reports failure when there is nothing to fold', async () => {
    const ok = await findCommand('compact')!.run('', caps({ compact: async () => true }))
    expect(ok.kind).toBe('note')
    const nope = await findCommand('compact')!.run('', caps({ compact: async () => false }))
    expect(nope.kind).toBe('error')
  })

  it('/remember refuses empty text and saves otherwise', async () => {
    const addFact = vi.fn(async () => true)
    const empty = await findCommand('remember')!.run('', caps({ addFact }))
    expect(empty.kind).toBe('error')
    expect(addFact).not.toHaveBeenCalled()

    const saved = await findCommand('remember')!.run('I use pnpm', caps({ addFact }))
    expect(saved.kind).toBe('note')
    expect(addFact).toHaveBeenCalledWith('I use pnpm')
  })

  it('/memory renders enabled/disabled facts, and an empty-state note', async () => {
    const listed = await findCommand('memory')!.run('', caps({
      listFacts: async () => [
        { id: '1', text: 'likes brutalism', enabled: true },
        { id: '2', text: 'muted fact',      enabled: false },
      ],
    }))
    const text = listed.kind === 'note' ? listed.text : ''
    expect(text).toContain('[x] likes brutalism')
    expect(text).toContain('[ ] muted fact')

    const empty = await findCommand('memory')!.run('', caps({ listFacts: async () => [] }))
    expect(empty.kind === 'note' && empty.text).toContain('commands.memory.empty')
  })

  it('/model with no args shows the current model and opens the picker', async () => {
    const openModelPicker = vi.fn()
    const res = await findCommand('model')!.run('', caps({
      describeModel: () => 'bankr · opus', openModelPicker,
    }))
    expect(openModelPicker).toHaveBeenCalled()
    expect(res.kind === 'note' && res.text).toContain('bankr · opus')
  })

  it('/model with a name switches, and falls back to the picker on no match', async () => {
    const openModelPicker = vi.fn()
    const hit = await findCommand('model')!.run('opus', caps({
      openModelPicker, setModel: async () => ({ ok: true, label: 'bankr · opus' }),
    }))
    expect(hit.kind === 'note' && hit.text).toContain('bankr · opus')
    expect(openModelPicker).not.toHaveBeenCalled()

    const miss = await findCommand('model')!.run('nope', caps({
      openModelPicker, setModel: async () => ({ ok: false }),
    }))
    expect(miss.kind).toBe('error')
    expect(openModelPicker).toHaveBeenCalled()
  })

  it('/cost lists the 30-day window plus the biggest providers', async () => {
    const res = await findCommand('cost')!.run('', caps({
      sessionSpend: () => '~1,200 tokens',
      costSummary: async () => ({
        windowDays: 30, totalUsd: 12.5, budgetUsd: 50,
        byProvider: { bankr: { usd: 10 }, venice: { usd: 2.5 }, idle: { usd: 0 } },
      }),
    }))
    const text = res.kind === 'note' ? res.text : ''
    expect(text).toContain('~1,200 tokens')
    expect(text).toContain('"total":"12.50"')
    expect(text.indexOf('bankr')).toBeLessThan(text.indexOf('venice'))  // sorted desc
    expect(text).not.toContain('idle')                                  // zero rows dropped
  })

  it('/search needs a query and surfaces the disabled reason', async () => {
    const webSearch = vi.fn(async () => ({ ok: false }))
    const empty = await findCommand('search')!.run('', caps({ webSearch }))
    expect(empty.kind).toBe('error')
    expect(webSearch).not.toHaveBeenCalled()

    const off = await findCommand('search')!.run('electron 43', caps({ webSearch }))
    expect(off.kind === 'error' && off.text).toContain('commands.search.disabled')

    const on = await findCommand('search')!.run('electron 43', caps({ webSearch: async () => ({ ok: true }) }))
    expect(on.kind).toBe('handled')
  })

  it('/rewind reports when there is nothing to rewind to', async () => {
    const yes = await findCommand('rewind')!.run('', caps({ rewindLast: () => true }))
    expect(yes.kind).toBe('note')
    const no = await findCommand('rewind')!.run('', caps({ rewindLast: () => false }))
    expect(no.kind).toBe('error')
  })

  it('the structured harness verbs pass through to the existing parsedCommand path', async () => {
    for (const id of ['plan', 'review', 'troubleshoot', 'refactor']) {
      const res = await findCommand(id)!.run('src/app.ts', caps({ surface: 'harness' }))
      expect(res.kind, id).toBe('passthrough')
    }
  })

  it('/init reports the written path or the failure reason', async () => {
    const ok = await findCommand('init')!.run('', caps({
      surface: 'harness', initProject: async () => ({ ok: true, detail: 'D:\\repo\\AGENTS.md' }),
    }))
    expect(ok.kind === 'note' && ok.text).toContain('AGENTS.md')

    const bad = await findCommand('init')!.run('', caps({
      surface: 'harness', initProject: async () => ({ ok: false, detail: 'no folder' }),
    }))
    expect(bad.kind === 'error' && bad.text).toContain('no folder')
  })
})

// ── /loop — the harness's loop mode, parsed in the MAIN process ──────────────
//
// The bug this locks down: loop mode shipped end-to-end (loop-controller's
// parseLoopDirective) but the composer rejected "/loop 2 …" as an unknown
// command, so the only way in was the `//` escape.

describe('/loop', () => {
  it('is registered on the Code surface only', () => {
    expect(listCommands('harness').map(c => c.id)).toContain('loop')
    expect(listCommands('chat').map(c => c.id)).not.toContain('loop')
  })

  it('is discoverable in the popup and advertises its [n] <goal> hint', () => {
    expect(matchCommands('lo', 'harness').map(c => c.id)).toContain('loop')
    expect(findCommand('loop')?.argsKey).toBe('commands.loop.args')
    expect(findCommand('loop')?.aliases).toEqual([])
  })

  it('is listed by /help on the Code tab', async () => {
    const res = await findCommand('help')!.run('', caps({ surface: 'harness' }))
    expect(res.kind === 'note' && res.text).toContain('/loop')
  })

  it('splits the cap off the goal but leaves the raw text for the harness', () => {
    const p = parseCommandInput('/loop 2 make every test pass', 'harness')
    expect(p.kind).toBe('command')
    expect(p.def?.id).toBe('loop')
    expect(p.args).toBe('2 make every test pass')
  })

  it('PASSES THROUGH, so agent:send receives the directive verbatim', async () => {
    for (const args of ['2 make every test pass', 'make every test pass', '20: tidy imports']) {
      const res = await findCommand('loop')!.run(args, caps({ surface: 'harness' }))
      expect(res.kind, args).toBe('passthrough')
    }
  })

  it('shows the usage line instead of starting a goal-less loop', async () => {
    // parseLoopDirective returns null for both of these, which would silently
    // run the text as an ordinary one-shot task.
    for (const args of ['', '3']) {
      const res = await findCommand('loop')!.run(args, caps({ surface: 'harness' }))
      expect(res.kind, `"${args}"`).toBe('error')
      expect(res.kind === 'error' && res.text).toContain('commands.loop.needsGoal')
    }
  })

  it('refuses on a non-TACHI harness, and stays out of the way when unwired', async () => {
    const off = await findCommand('loop')!.run('fix the tests', caps({
      surface: 'harness', loopSupported: () => false,
    }))
    expect(off.kind === 'error' && off.text).toContain('commands.loop.needsTachi')

    const on = await findCommand('loop')!.run('fix the tests', caps({
      surface: 'harness', loopSupported: () => true,
    }))
    expect(on.kind).toBe('passthrough')
  })

  it('points a Chat-tab /loop at the Code tab instead of "unknown command"', () => {
    const p = parseCommandInput('/loop 2 fix the tests', 'chat')
    expect(p.kind).toBe('unknown')
    expect(p.wrongSurface).toBe(true)
    expect(unknownCommandHint(p, caps())).toContain('commands.wrongSurfaceHarness')
  })
})

// ── HOME hero composer ───────────────────────────────────────────────────────
//
// The hero is the CHAT surface with a smaller set of wired capabilities: it has
// no open conversation, so some commands route into a new chat and the rest
// report the registry's standard "not available here" hint.

describe('home hero capabilities', () => {
  function heroDeps(over: Partial<HeroCommandDeps> = {}) {
    return {
      t: echoT,
      startNewChat:    vi.fn(),
      openChatWith:    vi.fn(),
      describeModel:   () => 'freellmapi-local · auto',
      openModelPicker: vi.fn(),
      costSummary:     async () => ({ windowDays: 30, totalUsd: 1, budgetUsd: 50, byProvider: {} }),
      listFacts:       async () => [],
      addFact:         async () => true,
      ...over,
    } satisfies HeroCommandDeps
  }

  it('speaks the chat surface, so "/" means the same thing on both screens', () => {
    expect(HERO_SURFACE).toBe('chat')
    expect(buildHeroCaps(heroDeps()).surface).toBe('chat')
  })

  it('/new opens a fresh chat', async () => {
    const deps = heroDeps()
    const res = await findCommand('new')!.run('', buildHeroCaps(deps))
    expect(res.kind).toBe('handled')
    expect(deps.startNewChat).toHaveBeenCalled()
  })

  it('/search routes the WHOLE command into a new chat (the surface that owns it)', async () => {
    const deps = heroDeps()
    const res = await findCommand('search')!.run('electron 43 release notes', buildHeroCaps(deps))
    expect(res.kind).toBe('handled')
    expect(deps.openChatWith).toHaveBeenCalledWith('/search electron 43 release notes')
  })

  it('reports the standard hint for commands that need an open conversation', async () => {
    const heroCaps = buildHeroCaps(heroDeps())
    for (const id of ['compact', 'rewind', 'model']) {
      const res = await findCommand(id)!.run(id === 'model' ? 'opus' : '', heroCaps)
      expect(res.kind, id).toBe('error')
      expect(res.kind === 'error' && res.text, id).toContain('commands.unavailable')
    }
  })

  it('/model with no args names the model the next chat will use', async () => {
    const deps = heroDeps()
    const res = await findCommand('model')!.run('', buildHeroCaps(deps))
    expect(res.kind === 'note' && res.text).toContain('freellmapi-local · auto')
    expect(deps.openModelPicker).toHaveBeenCalled()
  })

  it('runs the conversation-free commands locally', async () => {
    const deps = heroDeps()
    const heroCaps = buildHeroCaps(deps)
    expect((await findCommand('cost')!.run('', heroCaps)).kind).toBe('note')
    expect((await findCommand('memory')!.run('', heroCaps)).kind).toBe('note')
    expect((await findCommand('remember')!.run('I use pnpm', heroCaps)).kind).toBe('note')
  })

  it('/help lists exactly the chat commands, never the Code-tab ones', async () => {
    const res = await findCommand('help')!.run('', buildHeroCaps(heroDeps()))
    const text = res.kind === 'note' ? res.text : ''
    for (const c of listCommands('chat')) expect(text).toContain(`/${c.id}`)
    expect(text).not.toContain('/init')
    expect(text).not.toContain('/loop')
  })
})

describe('home hero input parsing', () => {
  // The hero owns the same chat SKILLS the Chat composer does.
  const knownOther = (n: string) => ['tdd', 'web', 'gh', 'review', 'refactor', 'brainstorm', 'explain', 'diagnose'].includes(n)
  const parse = (raw: string) => parseCommandInput(raw, HERO_SURFACE, { knownOther })

  it('recognises a chat command typed into the hero', () => {
    expect(parse('/help').kind).toBe('command')
    expect(parse('/cost').def?.id).toBe('cost')
    expect(parse('/remember I prefer dark mode').args).toBe('I prefer dark mode')
  })

  it('opens the popup while the verb is being typed', () => {
    expect(commandQueryFromText('/')).toBe('')
    expect(matchCommands('', HERO_SURFACE).length).toBe(listCommands('chat').length)
  })

  it('sends ordinary prose on to a new chat', () => {
    const p = parse('summarize https://example.com')
    expect(p.kind).toBe('text')
    expect(p.text).toBe('summarize https://example.com')
  })

  it('unwraps the // escape before the text reaches the chat', () => {
    expect(parse('//help me name this').text).toBe('/help me name this')
  })

  it('lets a chat SKILL through as text so the new chat applies it', () => {
    const p = parse('/tdd write the failing test first')
    expect(p.kind).toBe('text')
    expect(p.text).toBe('/tdd write the failing test first')
  })

  it('points the Code-tab verbs at the Code tab instead of rejecting them', () => {
    for (const raw of ['/init', '/loop 2 fix the tests']) {
      const p = parse(raw)
      expect(p.kind, raw).toBe('unknown')
      expect(p.wrongSurface, raw).toBe(true)
      expect(unknownCommandHint(p, caps()), raw).toContain('commands.wrongSurfaceHarness')
    }
  })

  it('still treats a path-like slash message as text', () => {
    expect(parse('/usr/local/bin is on PATH').kind).toBe('text')
  })
})

describe('unknownCommandHint', () => {
  it('points a wrong-surface command at the tab that owns it', () => {
    const chatHint = unknownCommandHint(parseCommandInput('/init', 'chat'), caps())
    expect(chatHint).toContain('commands.wrongSurfaceHarness')

    const harnessHint = unknownCommandHint(parseCommandInput('/rewind', 'harness'), caps({ surface: 'harness' }))
    expect(harnessHint).toContain('commands.wrongSurfaceChat')
  })
})

// ── popup keyboard state machine ─────────────────────────────────────────────

describe('navigatePopup', () => {
  it('moves down and wraps at the end', () => {
    expect(navigatePopup('ArrowDown', 0, 3)).toMatchObject({ cursor: 1, action: 'move', open: true })
    expect(navigatePopup('ArrowDown', 2, 3)).toMatchObject({ cursor: 0, action: 'move' })
  })

  it('moves up and wraps at the start', () => {
    expect(navigatePopup('ArrowUp', 1, 3)).toMatchObject({ cursor: 0, action: 'move' })
    expect(navigatePopup('ArrowUp', 0, 3)).toMatchObject({ cursor: 2, action: 'move' })
  })

  it('picks with Enter and Tab, and closes the popup on pick', () => {
    expect(navigatePopup('Enter', 1, 3)).toMatchObject({ cursor: 1, action: 'select', open: false })
    expect(navigatePopup('Tab',   2, 3)).toMatchObject({ cursor: 2, action: 'select', open: false })
  })

  it('leaves Shift+Enter alone so it stays a newline', () => {
    const r = navigatePopup('Enter', 1, 3, { shiftKey: true })
    expect(r.action).toBe('ignore')
    expect(r.preventDefault).toBe(false)
  })

  it('closes on Escape even with an empty list', () => {
    expect(navigatePopup('Escape', 0, 3)).toMatchObject({ action: 'close', open: false })
    expect(navigatePopup('Escape', 0, 0)).toMatchObject({ action: 'close', open: false })
  })

  it('ignores every other key, and all keys when nothing is listed', () => {
    expect(navigatePopup('a', 0, 3).action).toBe('ignore')
    expect(navigatePopup('ArrowDown', 0, 0).action).toBe('ignore')
    expect(navigatePopup('Enter', 0, 0).action).toBe('ignore')
  })

  it('clamps a stale cursor left over from a longer list', () => {
    expect(navigatePopup('Enter', 9, 2)).toMatchObject({ cursor: 0, action: 'select' })
    expect(navigatePopup('ArrowDown', 9, 2)).toMatchObject({ cursor: 1, action: 'move' })
  })

  it('never asks the composer to preventDefault for a plain character', () => {
    expect(navigatePopup('x', 0, 5).preventDefault).toBe(false)
  })
})
