// apps/desktop/src/pages/home/HomePage.tsx
//
// The app's start surface (reachable via the sidebar brand mark). Zoned like
// the reference pro tools (Blender splash / VS Code welcome / Figma home):
//   1. hero + one big "ask anything" input
//   2. START — five verbs, one per major surface
//   3. quick-start prompt chips
//   4. STATUS — real 30-day spend (cost ledger) + local API + loaded model
//   5. RECENTS — unified across chats, design sessions and node flows
//
// The hero input carries the SAME slash layer as the Chat composer (users type
// "/" here first): one registry, one popup, one keyboard state machine — see
// `heroCommands.ts` for what Home can honestly back.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useChatStore, contentToText } from '../../store/chat.store'
import { useDesignStore } from '../../store/design.store'
import { listSkills } from '../../skills/skills'
import {
  commandQueryFromText, matchCommands, parseCommandInput, unknownCommandHint,
  slashPick, type CommandDef, type CommandResult,
} from '../../lib/commands/registry'
import { navigatePopup } from '../../lib/commands/popup-nav'
import { CommandPopup, type CommandPopupItem } from '../../components/CommandPopup'
import { CommandNote, type CommandNoteData } from '../../components/CommandNote'
import { buildHeroCaps, HERO_SURFACE } from './heroCommands'

// Text-first cards (no emoji/icons — matches the app's type-led design language).
const QUICK_STARTS: { key: string; prompt: string }[] = [
  { key: 'url',        prompt: 'Please summarize this URL for me: ' },
  { key: 'code',       prompt: 'Please explain this code:\n\n```\n\n```' },
  { key: 'tweet',      prompt: 'Write a tweet about: ' },
  { key: 'translate',  prompt: 'Translate the following to English: ' },
  { key: 'brainstorm', prompt: 'Help me brainstorm ideas for: ' },
]

type RecentItem = {
  key: string
  type: 'chat' | 'design' | 'flow'
  title: string
  updatedAt: number
  open: () => void
}

export function HomePage() {
  const [input, setInput] = useState('')
  const [hoveredRecent, setHoveredRecent] = useState<string | null>(null)
  const { t } = useTranslation('home')
  // Slash-command strings live in the shared 'common' namespace — the Home,
  // Chat and Code composers all read the same keys.
  const { t: tc } = useTranslation('common')
  const navigate = useNavigate()
  const conversations     = useChatStore(s => s.conversations)
  const newConversation   = useChatStore(s => s.newConversation)
  const setActive         = useChatStore(s => s.setActive)
  const setPendingMessage = useChatStore(s => s.setPendingMessage)
  const designSessions    = useDesignStore(s => s.sessions)

  // Status strip data — cheap IPCs, best-effort (segments hide on failure).
  const [spend, setSpend] = useState<{ totalUsd: number; budgetUsd: number } | null>(null)
  const [api, setApi]     = useState<{ running: boolean; port?: number } | null>(null)
  const [flows, setFlows] = useState<{ filename: string; name: string; savedAt: string }[]>([])
  useEffect(() => {
    window.tachi.cost?.summary().then(r => setSpend({ totalUsd: r.totalUsd, budgetUsd: r.budgetUsd })).catch(() => {})
    window.tachi.apiServer?.status().then(r => setApi({ running: !!r.running, port: r.port ?? undefined })).catch(() => {})
    window.tachi.nodes?.listFlows().then(r => { if (r.ok && Array.isArray(r.flows)) setFlows(r.flows) }).catch(() => {})
  }, [])

  const startChat = (prompt: string) => {
    const finalPrompt = prompt || input.trim()
    if (!finalPrompt) return
    setPendingMessage(finalPrompt)
    newConversation()
    navigate('/chat')
  }

  // ── Slash layer ────────────────────────────────────────────────────────────
  // Reuses the Chat/Code machinery wholesale: the same registry, the same
  // CommandPopup, the same navigatePopup keyboard contract. Nothing here is
  // Home-specific except WHICH capabilities are wired (see heroCommands.ts).
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [slashOpen, setSlashOpen]     = useState(false)
  const [slashCursor, setSlashCursor] = useState(0)
  // Local-only output strip for /help, /cost, /memory and the unknown-command
  // hint. Nothing in here is ever sent to a model.
  const [cmdNote, setCmdNote]         = useState<CommandNoteData | null>(null)
  const allSkills = listSkills()

  const slashQuery = commandQueryFromText(input)
  const slashRows = useMemo(() => {
    if (slashQuery === null) return []
    const q = slashQuery.toLowerCase()
    const cmds = matchCommands(q, HERO_SURFACE).map(c => ({
      insert: `/${c.id} `,
      def:    c,
      item: {
        key:   `cmd-${c.id}`,
        label: `/${c.id}`,
        args:  c.argsKey ? tc(c.argsKey) : undefined,
        desc:  tc(c.descKey),
        group: tc('commands.groupCommands'),
      } satisfies CommandPopupItem,
    }))
    // Chat SKILLS (/tdd, /web, /gh …) are listed too: they are plain text to
    // the parser, so picking one just seeds the new chat with that prefix.
    const skills = allSkills
      .filter(s => s.id.toLowerCase().startsWith(q))
      .map(s => ({
        insert: `/${s.id} `,
        def:    undefined as CommandDef | undefined,
        item: {
          key:   `skill-${s.id}`,
          label: `/${s.id}`,
          desc:  s.hint,
          group: tc('commands.groupSkills'),
        } satisfies CommandPopupItem,
      }))
    return [...cmds, ...skills]
  }, [slashQuery, allSkills, tc])
  useEffect(() => {
    setSlashOpen(slashQuery !== null && slashRows.length > 0)
    setSlashCursor(0)
  }, [slashQuery, slashRows.length])

  const commandCaps = useMemo(() => buildHeroCaps({
    t: tc,
    startNewChat: () => { newConversation(); navigate('/chat') },
    openChatWith: (text: string) => { setPendingMessage(text); newConversation(); navigate('/chat') },
    describeModel: () => {
      const st = useChatStore.getState()
      const conv = st.conversations.find(c => c.id === st.activeConversationId)
      // No open chat yet → the provider/model the next one would start on.
      return conv
        ? `${conv.providerId} · ${conv.model}`
        : `${st.autoFallback.providerId} · ${st.autoFallback.model}`
    },
    openModelPicker: () => window.dispatchEvent(new CustomEvent('tachi:toggle-palette')),
    costSummary: () => window.tachi.cost.summary(),
    listFacts:   () => window.tachi.memoryFacts.list(),
    addFact:     async (text: string) => Boolean(await window.tachi.memoryFacts.add(text, 'user')),
  }), [tc, navigate, newConversation, setPendingMessage])

  // Run one command against the hero caps and render its result LOCALLY. A
  // command that only "passes through" belongs in a chat, so route it there.
  const runHeroCommand = async (def: CommandDef, args: string, raw: string) => {
    // Clear + close SYNCHRONOUSLY, before the (possibly async) handler: the
    // stale "/id" query must not linger, and we must never overwrite text the
    // user types while a slow handler's IPC is still in flight. Focus returns to
    // the composer so the next "/" works even when the row was clicked.
    setInput('')
    setSlashOpen(false)
    requestAnimationFrame(() => textareaRef.current?.focus())
    try {
      const res: CommandResult = await def.run(args, commandCaps)
      if (res.kind === 'passthrough') { startChat(raw); return }
      if (res.kind === 'note')       setCmdNote({ kind: 'note',  text: res.text })
      else if (res.kind === 'error') setCmdNote({ kind: 'error', text: res.text })
      else                           setCmdNote(null)
    } catch (err) {
      setCmdNote({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  // Picking a row: a no-argument command is already complete, so RUN it (no
  // stale "/help " left in the box to block the next "/"); one that takes args
  // gets its "/id " stub dropped in for the user to finish.
  const pickSlashRow = (row: { insert: string; def?: CommandDef }) => {
    const action = row.def ? slashPick(row.def) : { kind: 'insert' as const, text: row.insert }
    if (action.kind === 'run') { void runHeroCommand(action.def, '', `/${action.def.id}`); return }
    setInput(action.text)
    setSlashOpen(false)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  // Enter / → : a recognised command runs here (or routes into a chat); an
  // unknown one never leaves the page. `//literal` unwraps to one leading
  // slash, and skills fall through as text so the new chat applies them.
  const submitHero = async () => {
    const composed = input.trim()
    const parsed = parseCommandInput(composed, HERO_SURFACE, {
      knownOther: n => allSkills.some(s => s.id === n),
    })
    if (parsed.kind === 'unknown') {
      setSlashOpen(false)
      setCmdNote({ kind: 'error', text: unknownCommandHint(parsed, commandCaps) })
      return
    }
    if (parsed.kind === 'command' && parsed.def) {
      await runHeroCommand(parsed.def, parsed.args ?? '', composed)
      return
    }
    startChat(parsed.text ?? composed)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Slash autocomplete navigation — shared state machine (commands/popup-nav).
    if (slashOpen && slashRows.length > 0) {
      const nav = navigatePopup(e.key, slashCursor, slashRows.length, { shiftKey: e.shiftKey })
      if (nav.preventDefault) e.preventDefault()
      if (nav.action === 'move')   { setSlashCursor(nav.cursor); return }
      if (nav.action === 'close')  { setSlashOpen(false); return }
      if (nav.action === 'select') { pickSlashRow(slashRows[nav.cursor]); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submitHero()
    }
  }

  // START verbs — one per major surface.
  const ACTIONS: { key: string; go: () => void }[] = [
    { key: 'chat',   go: () => { newConversation(); navigate('/chat') } },
    { key: 'code',   go: () => navigate('/agent') },
    { key: 'design', go: () => navigate('/design') },
    { key: 'nodes',  go: () => navigate('/nodes') },
    { key: 'models', go: () => navigate('/catalog') },
  ]

  // Unified recents: chats + design sessions + node flows, newest first.
  const recents: RecentItem[] = [
    ...conversations.map((c): RecentItem => ({
      key: `chat:${c.id}`, type: 'chat',
      title: c.messages[0] ? contentToText(c.messages[0].content).slice(0, 60) || c.title : c.title,
      updatedAt: Date.parse(c.updatedAt) || 0,
      open: () => { setActive(c.id); navigate('/chat') },
    })),
    ...designSessions.map((s): RecentItem => ({
      key: `design:${s.id}`, type: 'design',
      title: s.title,
      updatedAt: s.updatedAt ?? s.createdAt ?? 0,
      open: () => { useDesignStore.getState().loadSession(s.id); navigate('/design') },
    })),
    ...flows.map((f): RecentItem => ({
      key: `flow:${f.filename}`, type: 'flow',
      title: f.name,
      updatedAt: Date.parse(f.savedAt) || 0,
      open: () => navigate('/nodes'),
    })),
  ].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8)

  const typeColor: Record<RecentItem['type'], string> = {
    chat: 'var(--accent)', design: 'var(--ok, #0f9e8e)', flow: 'var(--warn, #b7791f)',
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '48px 32px 40px', minHeight: '100%',
      background: 'var(--bg-base)', color: 'var(--text-primary)',
      overflowY: 'auto',
    }}>
      {/* Hero heading */}
      <h1 style={{ fontSize: 32, fontWeight: 800, marginBottom: 8, color: 'var(--text-primary)' }}>
        {t('heading')}
      </h1>
      <p style={{ color: 'var(--text-muted)', fontSize: 15, marginBottom: 28 }}>
        {t('subtitle')}
      </p>

      {/* Big input */}
      <div style={{ width: '100%', maxWidth: 640, marginBottom: 20 }}>
        {/* Inline command output — LOCAL ONLY, never sent to a model */}
        <CommandNote note={cmdNote} onDismiss={() => setCmdNote(null)} />

        {/* Slash autocomplete — registry commands + chat skills, one popup */}
        {slashOpen && slashRows.length > 0 && (
          <CommandPopup
            items={slashRows.map(r => r.item)}
            cursor={slashCursor}
            onHover={setSlashCursor}
            onPick={(_item, i) => pickSlashRow(slashRows[i])}
          />
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder={t('placeholder')}
            style={{
              flex: 1, resize: 'none', border: 'var(--border-width) solid var(--border)', borderRadius: 0,
              padding: '14px 18px', background: 'var(--bg-surface)',
              color: 'var(--text-primary)', fontSize: 15, lineHeight: 1.5, outline: 'none',
            }}
          />
          <button
            onClick={() => void submitHero()}
            disabled={!input.trim()}
            aria-label={t('startChat')}
            style={{
              padding: '14px 20px', borderRadius: 0, border: 'none',
              background: 'var(--accent)', color: 'var(--bg-base)',
              fontWeight: 700, fontSize: 18, cursor: 'pointer', alignSelf: 'stretch',
            }}
          >
            →
          </button>
        </div>
        {/* Discoverability: the slash layer is invisible until someone types it */}
        <div style={{
          marginTop: 6,
          fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
          letterSpacing: '0.08em', textTransform: 'uppercase',
          color: 'var(--text-dim)',
        }}>
          {t('slashHint')}
        </div>
      </div>

      {/* START — one verb per major surface */}
      <div style={{
        width: '100%', maxWidth: 640,
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8,
        marginBottom: 14,
      }}>
        {ACTIONS.map(a => (
          <button
            key={a.key}
            onClick={a.go}
            style={{
              padding: '10px 12px', borderRadius: 0,
              border: 'var(--border-width) solid var(--border)', background: 'var(--bg-elevated)',
              color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace',
              fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
              cursor: 'pointer', textAlign: 'center',
            }}
          >
            {t(`actions.${a.key}`)}
          </button>
        ))}
      </div>

      {/* Quick-start prompt chips */}
      <div style={{
        width: '100%', maxWidth: 640,
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10,
        marginBottom: 28,
      }}>
        {QUICK_STARTS.map(qs => (
          <button
            key={qs.key}
            onClick={() => startChat(qs.prompt)}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
              gap: 4, padding: '12px 16px', borderRadius: 0,
              border: 'var(--border-width) solid var(--border)', background: 'var(--bg-surface)',
              color: 'var(--text-primary)',
              fontSize: 13, fontWeight: 600, textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            {t(`quickStarts.${qs.key}`)}
          </button>
        ))}
      </div>

      {/* STATUS strip — real numbers, each segment deep-links to Dashboard */}
      <button
        onClick={() => navigate('/studio')}
        title={t('health.open')}
        style={{
          width: '100%', maxWidth: 640,
          background: 'var(--bg-surface)', borderRadius: 0,
          border: 'var(--border-width) solid var(--border)', padding: '10px 16px',
          fontSize: 12, color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace',
          display: 'flex', alignItems: 'center', gap: 16, marginBottom: 28,
          cursor: 'pointer', textAlign: 'left',
        }}
      >
        {spend && (
          <span>
            <span style={{ color: 'var(--accent)', fontWeight: 700 }}>${spend.totalUsd.toFixed(2)}</span>
            {spend.budgetUsd > 0 ? ` / $${spend.budgetUsd.toFixed(0)}` : ''} · {t('health.spent')}
          </span>
        )}
        {api && (
          <span style={{ color: api.running ? 'var(--ok, #0f9e8e)' : 'var(--text-dim)' }}>
            ● {api.running ? t('health.apiUp', { port: api.port }) : t('health.apiDown')}
          </span>
        )}
        <span style={{ marginLeft: 'auto', color: 'var(--text-dim)' }}>{t('health.open')} →</span>
      </button>

      {/* RECENTS — unified across chats, designs, flows */}
      {recents.length > 0 && (
        <div style={{ width: '100%', maxWidth: 640 }}>
          <h2 style={{
            fontSize: 13, fontWeight: 700, color: 'var(--text-muted)',
            textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10,
          }}>
            {t('recent')}
          </h2>
          {recents.map(item => (
            <button
              key={item.key}
              onClick={item.open}
              style={{
                display: 'flex', width: '100%', textAlign: 'left',
                padding: '10px 14px', borderRadius: 0, border: 'none',
                background: hoveredRecent === item.key ? 'var(--bg-surface)' : 'transparent',
                color: 'var(--text-primary)',
                fontSize: 13, cursor: 'pointer', marginBottom: 2, alignItems: 'center', gap: 10,
              }}
              onMouseEnter={() => setHoveredRecent(item.key)}
              onMouseLeave={() => setHoveredRecent(null)}
            >
              <span style={{
                flexShrink: 0, fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
                fontFamily: 'JetBrains Mono, monospace', textTransform: 'uppercase',
                color: typeColor[item.type],
                border: `1px solid ${typeColor[item.type]}`,
                padding: '1px 6px',
              }}>
                {t(`recentTypes.${item.type}`)}
              </span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.title}
              </span>
              <span style={{ color: 'var(--text-muted)', fontSize: 11, flexShrink: 0, marginLeft: 8 }}>
                {item.updatedAt ? new Date(item.updatedAt).toLocaleDateString() : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
