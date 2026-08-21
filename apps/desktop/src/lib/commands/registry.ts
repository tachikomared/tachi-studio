// apps/desktop/src/lib/commands/registry.ts
//
// SLASH-COMMAND REGISTRY — the one place that knows which "/verbs" exist, what
// they take, where they are available, and what they do.
//
// Design rules (deliberate, so this file stays testable in the node env):
//  - PURE. No React, no window, no i18n import. Everything the handlers need is
//    injected through `CommandCaps` — including `t`, which callers bind to the
//    'common' namespace (`useTranslation('common')`).
//  - A command whose backing capability is missing on the surface reports that
//    truthfully instead of pretending. There are NO stub commands here: every id
//    below is wired to machinery that already exists in the app.
//  - `passthrough` is a first-class result: the four structured harness verbs
//    (/review /plan /troubleshoot /refactor) are already parsed end-to-end by
//    `src/lib/slash-parser.ts` → `agent:send({ parsedCommand })`. Registering
//    them here makes them DISCOVERABLE in the popup without re-routing them.
//
// @module commands/registry

/** Where a command can be typed. 'chat' = Chat tab composer, 'harness' = Code tab. */
export type CommandSurface = 'chat' | 'harness'

/**
 * What running a command produced.
 * - `note`        — render this text inline, locally. Nothing is sent to a model.
 * - `handled`     — the side effect ran; nothing to display.
 * - `passthrough` — do NOT intercept: let the surface's existing send path handle
 *                   the raw text (used by the structured harness verbs).
 * - `error`       — render this text inline as a problem.
 */
export type CommandResult =
  | { kind: 'note';        text: string }
  | { kind: 'handled' }
  | { kind: 'passthrough' }
  | { kind: 'error';       text: string }

/** Minimal translator shape — `t` from react-i18next bound to the 'common' ns. */
export type CommandT = (key: string, options?: Record<string, unknown>) => string

/** Structural mirror of `MemoryFact` (packages/core) — only what /memory renders. */
export interface MemoryFactLike {
  id:      string
  text:    string
  enabled: boolean
}

/** 30-day rollup shape returned by `window.tachi.cost.summary()`. */
export interface CostSummaryLike {
  windowDays: number
  totalUsd:   number
  budgetUsd:  number
  byProvider: Record<string, { usd: number }>
}

/**
 * Everything a command handler is allowed to touch. Each field is OPTIONAL: a
 * surface wires only what it can honestly back, and a handler whose capability
 * is absent returns the "not available here" note.
 */
export interface CommandCaps {
  surface: CommandSurface
  t:       CommandT

  /** Run the surface's compaction now (chat: summarize head; harness: drop head). */
  compact?:        () => Promise<boolean>
  /** Start a fresh conversation (chat only — the app calls this "New chat"). */
  newConversation?: () => void
  /** Generate AGENTS.md / APP-MAP for the working directory (harness only). */
  initProject?:    () => Promise<{ ok: boolean; detail?: string }>
  /** Human-readable "provider · model" for the active surface. */
  describeModel?:  () => string
  /** Switch model/provider by name. `ok:false` + reason when nothing matched. */
  setModel?:       (name: string) => Promise<{ ok: boolean; label?: string; reason?: string }>
  /** Open the model/provider picker UI (used by bare `/model`). */
  openModelPicker?: () => void
  /** 30-day spend rollup from the cost ledger. */
  costSummary?:    () => Promise<CostSummaryLike>
  /** One-line "this session" usage string, or null when nothing has been used. */
  sessionSpend?:   () => string | null
  /** Saved memory facts (structured fact store). */
  listFacts?:      () => Promise<MemoryFactLike[]>
  /** Append a fact to the fact store. */
  addFact?:        (text: string) => Promise<boolean>
  /** Pull the last user message back into the composer (edit-and-rewind). */
  rewindLast?:     () => boolean
  /** Force a web-search-backed answer for `query`. */
  webSearch?:      (query: string) => Promise<{ ok: boolean; reason?: string }>
  /**
   * Whether LOOP MODE can actually run on this surface right now. Loop mode is
   * a TACHI-harness wrapper (runTachiSession → loop-controller), so a Code tab
   * pointed at OpenClaude/Codex would swallow the directive as prose.
   * Left unwired = "no opinion", and `/loop` passes through unchallenged.
   */
  loopSupported?:  () => boolean
}

/** A registered command. `run` is pure w.r.t. the injected caps. */
export interface CommandDef {
  id:       string
  aliases:  readonly string[]
  /** i18n key (common ns) for the one-line description shown in the popup. */
  descKey:  string
  /** i18n key for the argument hint, e.g. "<query>". Omitted = takes no args. */
  argsKey?: string
  surfaces: readonly CommandSurface[]
  run:      (args: string, caps: CommandCaps) => Promise<CommandResult>
}

// ── helpers ──────────────────────────────────────────────────────────────────

function unavailable(id: string, caps: CommandCaps): CommandResult {
  return { kind: 'error', text: caps.t('commands.unavailable', { name: id }) }
}

/** Two-space-padded "/id <args>" column used by the /help listing. */
function signature(def: CommandDef, caps: CommandCaps): string {
  return def.argsKey ? `/${def.id} ${caps.t(def.argsKey)}` : `/${def.id}`
}

function money(n: number): string {
  return n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(4)
}

// ── the commands ─────────────────────────────────────────────────────────────

const HELP: CommandDef = {
  id: 'help', aliases: ['?', 'commands'], descKey: 'commands.help.desc',
  surfaces: ['chat', 'harness'],
  async run(_args, caps) {
    const defs = listCommands(caps.surface)
    const width = Math.max(...defs.map(d => signature(d, caps).length))
    const lines = defs.map(d => `${signature(d, caps).padEnd(width)}  ${caps.t(d.descKey)}`)
    return {
      kind: 'note',
      text: [caps.t('commands.help.title'), ...lines, '', caps.t('commands.help.escape')].join('\n'),
    }
  },
}

const NEW: CommandDef = {
  id: 'new', aliases: ['clear'], descKey: 'commands.new.desc',
  surfaces: ['chat'],
  async run(_args, caps) {
    if (!caps.newConversation) return unavailable('new', caps)
    caps.newConversation()
    return { kind: 'handled' }
  },
}

const COMPACT: CommandDef = {
  id: 'compact', aliases: [], descKey: 'commands.compact.desc',
  surfaces: ['chat', 'harness'],
  async run(_args, caps) {
    if (!caps.compact) return unavailable('compact', caps)
    const ok = await caps.compact()
    return ok
      ? { kind: 'note',  text: caps.t('commands.compact.done') }
      : { kind: 'error', text: caps.t('commands.compact.failed') }
  },
}

const INIT: CommandDef = {
  id: 'init', aliases: [], descKey: 'commands.init.desc',
  surfaces: ['harness'],
  async run(_args, caps) {
    if (!caps.initProject) return unavailable('init', caps)
    const r = await caps.initProject()
    return r.ok
      ? { kind: 'note',  text: caps.t('commands.init.done',   { path:   r.detail ?? '' }) }
      : { kind: 'error', text: caps.t('commands.init.failed', { reason: r.detail ?? '' }) }
  },
}

const MODEL: CommandDef = {
  id: 'model', aliases: ['models'], descKey: 'commands.model.desc',
  argsKey: 'commands.model.args',
  surfaces: ['chat', 'harness'],
  async run(args, caps) {
    const current = caps.describeModel?.() ?? ''
    if (!args) {
      caps.openModelPicker?.()
      return { kind: 'note', text: caps.t('commands.model.current', { model: current }) }
    }
    if (!caps.setModel) return unavailable('model', caps)
    const r = await caps.setModel(args)
    if (r.ok) return { kind: 'note', text: caps.t('commands.model.switched', { model: r.label ?? args }) }
    caps.openModelPicker?.()
    return { kind: 'error', text: r.reason || caps.t('commands.model.noMatch', { name: args }) }
  },
}

const COST: CommandDef = {
  id: 'cost', aliases: ['spend', 'usage'], descKey: 'commands.cost.desc',
  surfaces: ['chat', 'harness'],
  async run(_args, caps) {
    if (!caps.costSummary) return unavailable('cost', caps)
    const s = await caps.costSummary()
    const lines: string[] = [caps.t('commands.cost.title')]
    const session = caps.sessionSpend?.()
    if (session) lines.push(caps.t('commands.cost.session', { value: session }))
    lines.push(caps.t('commands.cost.window', {
      days: s.windowDays, total: money(s.totalUsd), budget: money(s.budgetUsd),
    }))
    const providers = Object.entries(s.byProvider)
      .filter(([, v]) => v.usd > 0)
      .sort((a, b) => b[1].usd - a[1].usd)
      .slice(0, 5)
    if (providers.length === 0) lines.push(caps.t('commands.cost.none'))
    else for (const [p, v] of providers) {
      lines.push(caps.t('commands.cost.provider', { provider: p, usd: money(v.usd) }))
    }
    return { kind: 'note', text: lines.join('\n') }
  },
}

const MEMORY: CommandDef = {
  id: 'memory', aliases: ['facts'], descKey: 'commands.memory.desc',
  surfaces: ['chat', 'harness'],
  async run(_args, caps) {
    if (!caps.listFacts) return unavailable('memory', caps)
    const facts = await caps.listFacts()
    if (facts.length === 0) return { kind: 'note', text: caps.t('commands.memory.empty') }
    const lines = facts.map(f => `${f.enabled ? '[x]' : '[ ]'} ${f.text}`)
    return {
      kind: 'note',
      text: [caps.t('commands.memory.title', { count: facts.length }), ...lines].join('\n'),
    }
  },
}

const REMEMBER: CommandDef = {
  id: 'remember', aliases: [], descKey: 'commands.remember.desc',
  argsKey: 'commands.remember.args',
  surfaces: ['chat', 'harness'],
  async run(args, caps) {
    if (!caps.addFact) return unavailable('remember', caps)
    if (!args) return { kind: 'error', text: caps.t('commands.remember.needsText') }
    const ok = await caps.addFact(args)
    return ok
      ? { kind: 'note',  text: caps.t('commands.remember.saved', { text: args }) }
      : { kind: 'error', text: caps.t('commands.remember.failed') }
  },
}

const REWIND: CommandDef = {
  id: 'rewind', aliases: [], descKey: 'commands.rewind.desc',
  surfaces: ['chat'],
  async run(_args, caps) {
    if (!caps.rewindLast) return unavailable('rewind', caps)
    return caps.rewindLast()
      ? { kind: 'note',  text: caps.t('commands.rewind.done') }
      : { kind: 'error', text: caps.t('commands.rewind.none') }
  },
}

const SEARCH: CommandDef = {
  id: 'search', aliases: ['websearch'], descKey: 'commands.search.desc',
  argsKey: 'commands.search.args',
  surfaces: ['chat', 'harness'],
  async run(args, caps) {
    if (!caps.webSearch) return unavailable('search', caps)
    if (!args) return { kind: 'error', text: caps.t('commands.search.needsQuery') }
    const r = await caps.webSearch(args)
    return r.ok
      ? { kind: 'handled' }
      : { kind: 'error', text: r.reason || caps.t('commands.search.disabled') }
  },
}

/**
 * The four structured harness verbs. They are ALREADY wired end-to-end by
 * `slash-parser.ts` → `agent:send({ parsedCommand })` → system-prompt injection
 * → SlashCommandCard. Registering them buys discoverability in the popup; `run`
 * deliberately hands the raw text back to that existing path.
 */
function structuralHarnessVerb(id: string, descKey: string): CommandDef {
  return {
    id, aliases: [], descKey, surfaces: ['harness'],
    async run() { return { kind: 'passthrough' } },
  }
}

/**
 * `/loop [n] <goal>` — autonomous "keep working until the goal is met" mode.
 *
 * Unlike the four structured verbs above (parsed renderer-side by
 * `slash-parser.ts`), `/loop` is parsed in the MAIN process off the RAW task
 * text — `services/tachi/loop-controller.ts` → `parseLoopDirective`. So this
 * entry must hand the typed text back UNTOUCHED (`passthrough`); registering it
 * is purely what stops the composer rejecting a shipped feature as an unknown
 * command, and what puts it in the popup and in /help.
 *
 * Two guards, both about telling the truth instead of pretending a loop began:
 *  - no goal (`/loop`, `/loop 3`) → the main-process parser would return null
 *    and silently run it as an ordinary task, so we show the usage line;
 *  - a non-TACHI harness → the directive would reach OpenClaude/Codex as prose.
 */
const LOOP: CommandDef = {
  id: 'loop', aliases: [], descKey: 'commands.loop.desc',
  argsKey: 'commands.loop.args',
  surfaces: ['harness'],
  async run(args, caps) {
    if (caps.loopSupported && !caps.loopSupported()) {
      return { kind: 'error', text: caps.t('commands.loop.needsTachi') }
    }
    // Mirrors parseLoopDirective's `(\d+)?\b[:,]?\s*` cap prefix: what is left
    // after an optional leading iteration count is the goal.
    const goal = args.replace(/^\d+\b[:,]?\s*/, '').trim()
    if (!goal) return { kind: 'error', text: caps.t('commands.loop.needsGoal') }
    return { kind: 'passthrough' }
  },
}

export const COMMANDS: readonly CommandDef[] = [
  HELP,
  NEW,
  COMPACT,
  INIT,
  MODEL,
  COST,
  MEMORY,
  REMEMBER,
  REWIND,
  SEARCH,
  structuralHarnessVerb('plan',         'commands.plan.desc'),
  structuralHarnessVerb('review',       'commands.review.desc'),
  structuralHarnessVerb('troubleshoot', 'commands.troubleshoot.desc'),
  structuralHarnessVerb('refactor',     'commands.refactor.desc'),
  LOOP,
] as const

// ── lookup ───────────────────────────────────────────────────────────────────

/** Every command available on `surface`, in registration order. */
export function listCommands(surface: CommandSurface): CommandDef[] {
  return COMMANDS.filter(c => c.surfaces.includes(surface))
}

/** Find a command by id or alias across ALL surfaces (case-insensitive). */
export function findCommand(name: string): CommandDef | null {
  const n = name.toLowerCase()
  return COMMANDS.find(c => c.id === n || c.aliases.includes(n)) ?? null
}

/**
 * Autocomplete matches for a partially-typed token (the text AFTER the slash).
 * Empty query lists everything available on the surface. Ranking: exact id >
 * id-prefix > alias-prefix, registration order within each tier.
 */
export function matchCommands(query: string, surface: CommandSurface): CommandDef[] {
  const q = query.toLowerCase()
  const pool = listCommands(surface)
  if (!q) return pool
  const tier = (c: CommandDef): number => {
    if (c.id === q) return 0
    if (c.id.startsWith(q)) return 1
    if (c.aliases.some(a => a.startsWith(q))) return 2
    return 3
  }
  return pool
    .map((c, i) => ({ c, i, tier: tier(c) }))
    .filter(x => x.tier < 3)
    .sort((a, b) => a.tier - b.tier || a.i - b.i)
    .map(x => x.c)
}

/**
 * What picking a command row out of the autocomplete popup should DO.
 *
 * The distinction fixes a real UX snag: a command that takes NO arguments is
 * already complete the instant it is highlighted, so leaving "/help " sitting
 * in the composer (which the user must then Enter a second time, and which —
 * because of the trailing space — stops a following "/" from re-opening the
 * popup) is pure friction. Such commands should just RUN on pick.
 *
 * - `run`    — no `argsKey`, so execute `def` immediately; nothing is left to
 *              submit and the composer is free for the next "/".
 * - `insert` — the command expects arguments, so drop "/id " into the composer
 *              and let the user type them (the popup closes as the space lands).
 */
export type SlashPickAction =
  | { kind: 'run';    def: CommandDef }
  | { kind: 'insert'; text: string }

export function slashPick(def: CommandDef): SlashPickAction {
  return def.argsKey
    ? { kind: 'insert', text: `/${def.id} ` }
    : { kind: 'run', def }
}

// ── input parsing ────────────────────────────────────────────────────────────

/**
 * Result of inspecting composer text.
 * - `command` — a recognised command for THIS surface; run `def`.
 * - `unknown` — looks like a command but isn't one here; show a gentle hint and
 *               do NOT send. `wrongSurface` distinguishes "exists elsewhere".
 * - `text`    — send normally. `text` carries the payload (a leading `//` escape
 *               is unwrapped to a single literal slash).
 */
export interface ParsedCommandInput {
  kind:          'command' | 'unknown' | 'text'
  name?:         string
  args?:         string
  def?:          CommandDef
  wrongSurface?: boolean
  text?:         string
}

const COMMAND_TOKEN = /^\/([A-Za-z?][A-Za-z0-9_-]*)(?:[ \t]+([\s\S]*))?$/

/**
 * Classify composer text for `surface`.
 *
 * `opts.knownOther(name)` lets a surface declare other "/name" handlers it
 * already owns (the Chat tab's SKILLS: /tdd, /web, /gh …). Those fall through
 * as plain text so existing behaviour is untouched and no false "unknown
 * command" hint fires.
 *
 * @example parseCommandInput('/help', 'chat')        // → { kind:'command', def: HELP }
 * @example parseCommandInput('//help', 'chat')       // → { kind:'text', text:'/help' }
 * @example parseCommandInput('/init', 'chat')        // → { kind:'unknown', wrongSurface:true }
 * @example parseCommandInput('/tdd x', 'chat', { knownOther: n => n==='tdd' })
 *                                                    // → { kind:'text', text:'/tdd x' }
 */
export function parseCommandInput(
  raw: string,
  surface: CommandSurface,
  opts: { knownOther?: (name: string) => boolean } = {},
): ParsedCommandInput {
  if (!raw || typeof raw !== 'string') return { kind: 'text', text: raw ?? '' }
  // `//literal` — the escape hatch for sending a message that starts with a
  // slash. Exactly one slash is stripped.
  if (raw.startsWith('//')) return { kind: 'text', text: raw.slice(1) }
  if (!raw.startsWith('/'))  return { kind: 'text', text: raw }

  const m = raw.match(COMMAND_TOKEN)
  if (!m) return { kind: 'text', text: raw }

  const name = m[1].toLowerCase()
  const args = (m[2] ?? '').trim()
  const def  = findCommand(name)

  if (def && def.surfaces.includes(surface)) return { kind: 'command', name, args, def }
  if (opts.knownOther?.(name))               return { kind: 'text', text: raw }
  if (def)                                   return { kind: 'unknown', name, args, def, wrongSurface: true }
  return { kind: 'unknown', name, args }
}

/**
 * The autocomplete trigger. Returns the partial token when the composer holds
 * ONLY a slash-word (so the popup opens on `/`, `/co`, `/cost`), else null.
 * `//` never opens it — that's the literal escape.
 */
export function commandQueryFromText(text: string): string | null {
  if (typeof text !== 'string') return null
  const m = text.match(/^\/([A-Za-z0-9?_-]*)$/)
  return m ? m[1] : null
}

/** Localized "unknown command" hint, incl. the wrong-surface variant. */
export function unknownCommandHint(parsed: ParsedCommandInput, caps: CommandCaps): string {
  const name = parsed.name ?? ''
  if (parsed.wrongSurface) {
    const where = parsed.def?.surfaces.includes('harness') ? 'Harness' : 'Chat'
    return caps.t(`commands.wrongSurface${where}`, { name })
  }
  return caps.t('commands.unknown', { name })
}
