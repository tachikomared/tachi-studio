// apps/desktop/src/pages/agent/AgentPage.tsx
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useNavigate } from 'react-router-dom'
import { useAgentStore, surfaceBindDecision, normalizeHarness } from '../../store/agent.store'
import { useUIStore } from '../../store/ui.store'
import type { HarnessId, AgentMode, AgentSessionTag, AgentMessage } from '../../store/agent.store'
import type { AgentEvent } from '@tachi/core'
// Subpath import keeps the Node-only @tachi/core barrel out of the renderer bundle.
import { buildAgentHistory } from '@tachi/core/src/agent/history'
// Reuse the chat markdown renderer (GFM + shiki code highlighting) so the agent's
// answers render as formatted prose/code, not raw "## Plan / **bold**" text.
import { Markdown } from '../chat/Markdown'
import { parseSlashCommand } from '../../lib/slash-parser'
import type { ParsedSlashCommand } from '../../lib/slash-parser'
import { friendlyError } from '../../lib/friendly-error'
import { DropZone } from './DropZone'
import { ModeToggle } from './ModeToggle'
import { CodexWorkerChip } from './CodexWorkerChip'
import { DiffCard, FILE_WRITE_TOOLS } from './DiffCard'
import { WorkspacePanel } from '../chat/WorkspacePanel'
import { GenerateAgentsMdButton } from './GenerateAgentsMdButton'
import { AgentHistory } from './AgentHistory'
import { BankrModelPicker } from '../chat/BankrModelPicker'
import { SurplusModelPicker } from '../chat/SurplusModelPicker'
import { VeniceModelPicker } from '../chat/VeniceModelPicker'
import { ImgnaiModelPicker } from '../chat/ImgnaiModelPicker'
import { PlaybookIndicator } from './PlaybookIndicator'
import { ToolCallBlock } from './ToolCallBlock'
import { ToolGroupSummary } from './ToolGroupSummary'
// The transcript's pure event→block transform (pairing, abort marking, grouping
// and the codex progress routing) lives in its own module so it can be tested
// without React; ToolBlock is re-exported below for existing consumers.
import { pairToolEvents, type AgentMessageItem } from './pairToolEvents'
export type { ToolBlock } from './pairToolEvents'
import { PermissionCard } from './PermissionCard'
import { ReconnectBanner } from './ReconnectBanner'
import { LoopChip } from './LoopChip'
import { IncompleteBadge } from './IncompleteBadge'
import { activePermission, queuedBehind, foreignPermissionOwner } from './permissionQueue'
import { promptSurfaceKey, normalizePromptText, shouldDrainPrompt, PROMPT_QUEUE_CAP, type QueuedPrompt } from './promptQueue'
import { resetAvailability, shouldRestoreCode, runTurnReset, type ResetChoice } from './turnReset'
import { useConfirm } from '../../components/ConfirmProvider'
import { sendGate } from './sendGate'
import type { AgentProvider, ThinkingDepth, TrustLevel, ActiveWorkflow, AgentRunOrigin } from '../../store/agent.store'
import type { PermissionDecision } from '../../types/electron'
import { SlashCommandCard } from './SlashCommandCard'
import type { SlashCardStatus, SlashCommandResult } from '../../types/slash-commands'
import { extractPlanJson } from '../../lib/extract-plan-json'
import { PreviewPanel } from './PreviewPanel'
import { FilePathChips } from './FilePathChips'
import { CodeEditor } from '../../components/CodeEditor'
import { monacoLangFromPath } from '../../lib/monaco-lang'
import { showToast } from '../../components/Toaster'
import { SplitHandle } from '../../components/SplitHandle'
import { useResizablePanel } from '../../hooks/useResizablePanel'
import { ParallelTaskGrid } from './ParallelTaskGrid'
import { useParallelAgentsStore } from '../../store/parallel-agents.store'
import { ContextMeter } from '../../components/ContextMeter'
import { WaitingIndicator } from '../../components/WaitingIndicator'
import { isTranscriptWaiting, transcriptTail } from '../../components/waitingState'
import { TabTour, useTourFirstVisit, type TourStep } from '../../components/TabTour'
import { modelDisplayName } from '../../utils/model-display'
import { ratesFor, isVerifiedFreeModel } from '@tachi/core/src/pricing'
import { providerBilling } from '@tachi/core/src/providers/registry'
// THE routing facts (same symbols main routes with — packages/core
// agent-route.ts): the opengateway model pin for the badge/hints/cost/meter,
// and the 'default' ladder pick via useDefaultAgentRoute. Derived, not copied:
// this page must never hand-write which model runs or whether it is free.
import { OPENGATEWAY_AGENT_MODEL } from '@tachi/core/src/providers/agent-route'
import { useDefaultAgentRoute } from './useDefaultAgentRoute'
// Slash-command layer — the SAME registry the Chat composer uses.
import {
  commandQueryFromText, matchCommands, parseCommandInput, unknownCommandHint,
  type CommandCaps, type CommandResult,
} from '../../lib/commands/registry'
import { navigatePopup } from '../../lib/commands/popup-nav'
import { CommandPopup, type CommandPopupItem } from '../../components/CommandPopup'
import { CommandNote, type CommandNoteData } from '../../components/CommandNote'

// ── Harness display labels ────────────────────────────────────────────────────
//
// ONE map for every place a harness id is shown. Deliberately keyed by `string`
// and Partial, so a harness id that is NOT in the active set — an archived
// session from before the Goose harness was removed still says 'goose' — falls
// back to rendering the raw id as plain text instead of blowing up or being
// mislabelled as something else.
const HARNESS_LABELS: Partial<Record<string, string>> = {
  tachi:      'TACHI',
  openclaude: 'OpenClaude',
  darksol:    'DarkSol',
  codex:      'Codex',
}

// ── F4: Per-user-text-event card state ────────────────────────────────────────
//
// Keyed by the message item `id` (the UUID assigned in agent.store when the
// user-text event is appended). Value tracks both the card status lifecycle
// and the plan content (initially a placeholder, updated when the agent emits
// the <tachi-plan> tag).

interface CardEntry {
  status: SlashCardStatus
  plan:   SlashCommandResult | null  // null until agent emits tachi-plan tag
}

// Build a stub SlashCommandResult so the card renders immediately with a
// "Generating plan…" placeholder. The stub mirrors the exact shape of the
// discriminated union so the card can safely access all fields.
function buildStubPlan(command: ParsedSlashCommand['command']): SlashCommandResult {
  const metadata = { sessionId: '', workspaceDir: '', ts: Date.now() }
  if (command === 'troubleshoot') {
    return {
      command:   'troubleshoot',
      rootCause: { summary: 'Generating plan...', confidence: 0, evidence: [] },
      solutions: [],
      risks:     [],
      metadata,
    }
  }
  if (command === 'refactor') {
    return {
      command:       'refactor',
      target:        'Generating plan...',
      changes:       [],
      estimatedDiff: { added: 0, removed: 0 },
      metadata,
    }
  }
  if (command === 'review') {
    return {
      command:  'review',
      scope:    'Generating plan...',
      findings: [],
      summary:  { errorCount: 0, warningCount: 0, infoCount: 0 },
      metadata,
    }
  }
  // plan
  return {
    command:      'plan',
    goal:         'Generating plan...',
    phases:       [],
    risks:        [],
    criticalPath: [],
    metadata,
  }
}

function buildCodeTour(t: TFunction): TourStep[] {
  return [
    { title: t('tour.intro.title'), body: t('tour.intro.body') },
    { title: t('tour.folder.title'), body: t('tour.folder.body'), selector: '[data-tour="code-folder"]' },
    { title: t('tour.controls.title'), body: t('tour.controls.body'), selector: '[data-tour="code-controls"]' },
    { title: t('tour.compose.title'), body: t('tour.compose.body'), selector: '[data-tour="code-composer"]' },
    { title: t('tour.done.title'), body: t('tour.done.body') },
  ]
}

// Section captions inside the ADVANCED drawer (UX #2) — same words the
// legend + tour use, so the app teaches exactly one vocabulary.
const advGroupLabelStyle: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--text-dim)',
  fontFamily: 'JetBrains Mono, monospace',
  marginLeft: 6,
}

/**
 * Stable empty transcript. Rendered while another surface's run still owns the
 * live session — a fresh `[]` each render would defeat PairedMessageList's memo.
 */
const EMPTY_MESSAGES: AgentMessage[] = []

/**
 * Stable empty follow-up queue, for the same reason: it is a dependency of the
 * DRAIN effect, and a fresh `[]` each render would re-run that effect on every
 * streamed token.
 */
const EMPTY_PROMPTS: QueuedPrompt[] = []

/**
 * TACHIAPP preset (`appMode`) — the SAME page, pinned to one workspace.
 *
 * The self-improvement chat is not a fork: it is this component with the
 * workspace question already answered (main resolves the app's own source
 * checkout) and every folder affordance removed — no picker, no folder tree,
 * no drag-and-drop, no parallel grid, no workflow binding. Sends still go
 * through agent:send → runTachiSession, with the same permission gate, the
 * same private-mode behaviour and the same spend caps as the Code tab.
 */
export interface AgentPageProps {
  /** true = TACHIAPP preset (pinned app-source workspace, chat-skinned). */
  appMode?: boolean
}

export function AgentPage({ appMode = false }: AgentPageProps = {}) {
  const { t } = useTranslation('agent')
  // Slash-command copy lives in the shared 'common' namespace (one set of keys
  // for both composers).
  const { t: tc } = useTranslation('common')
  const navigate = useNavigate()
  const previewPane = useResizablePanel({ storageKey: 'tachi-split:agent.preview', initial: 380, min: 260, max: 640, side: 'right', collapsible: true })
  const [tourOpen, setTourOpen] = useState(false)
  // The Code tour walks the folder picker, which TACHIAPP does not have — mark
  // the surface seen (its own key, so /agent keeps its first-visit tour) but
  // never auto-open it there.
  const openTourOnFirstVisit = useCallback((v: boolean) => { if (!appMode) setTourOpen(v) }, [appMode])
  useTourFirstVisit(appMode ? 'tachiapp' : 'code', openTourOnFirstVisit)
  const workingDir       = useAgentStore(s => s.workingDir)
  const sessionId        = useAgentStore(s => s.sessionId)
  const status           = useAgentStore(s => s.status)
  const messages         = useAgentStore(s => s.messages)
  const harness          = useAgentStore(s => s.harness)
  const mode             = useAgentStore(s => s.mode)
  const provider         = useAgentStore(s => s.provider)
  const bankrModel       = useAgentStore(s => s.bankrModel)
  const surplusModel     = useAgentStore(s => s.surplusModel)
  const veniceModel      = useAgentStore(s => s.veniceModel)
  const imgnaiModel      = useAgentStore(s => s.imgnaiModel)
  const activeWorkflow   = useAgentStore(s => s.activeWorkflow)
  const depth            = useAgentStore(s => s.depth)
  const trust            = useAgentStore(s => s.trust)
  const fusionPlan       = useAgentStore(s => s.fusionPlan)
  const viewingArchiveId = useAgentStore(s => s.viewingArchiveId)
  // GAVE-UP DETECTION: non-null when the last run STOPPED rather than finished.
  const endedIncomplete  = useAgentStore(s => s.endedIncomplete)
  // #5: agent role picker — list roles + the active selection (local; '' = none).
  // When set, agent:send primes the role persona + enforces its tool/path boundaries.
  const [roles, setRoles]   = useState<Array<{ id: string; label: string }>>([])
  const [roleId, setRoleId] = useState('')
  useEffect(() => {
    window.tachi.roles.list()
      .then(rs => setRoles(rs.map(r => ({ id: r.id, label: r.label }))))
      .catch(() => { /* roles registry optional — no picker if it fails */ })
  }, [])
  const setWorkingDir    = useAgentStore(s => s.setWorkingDir)
  const setSession       = useAgentStore(s => s.setSession)
  const setStatus        = useAgentStore(s => s.setStatus)
  const setHarness       = useAgentStore(s => s.setHarness)
  const setMode          = useAgentStore(s => s.setMode)
  const setProvider      = useAgentStore(s => s.setProvider)
  const setBankrModel    = useAgentStore(s => s.setBankrModel)
  const setSurplusModel  = useAgentStore(s => s.setSurplusModel)
  const setVeniceModel   = useAgentStore(s => s.setVeniceModel)
  const setImgnaiModel   = useAgentStore(s => s.setImgnaiModel)
  const surplusSmartRouting    = useAgentStore(s => s.surplusSmartRouting)
  const setSurplusSmartRouting = useAgentStore(s => s.setSurplusSmartRouting)
  const firstTaskRoutedRef = useRef(false)
  const setActiveWorkflow = useAgentStore(s => s.setActiveWorkflow)
  const setSessionTag    = useAgentStore(s => s.setSessionTag)
  const setDepth         = useAgentStore(s => s.setDepth)
  const setTrust         = useAgentStore(s => s.setTrust)
  const setFusionPlan    = useAgentStore(s => s.setFusionPlan)
  const appendEvent      = useAgentStore(s => s.appendEvent)
  // PROVENANCE: parked at send, stamped by appendEvent onto every message that
  // follows. See AgentRunOrigin in the store.
  const setRunOrigin     = useAgentStore(s => s.setRunOrigin)
  // Permission queue lives in the store and is FILLED by the app-lifetime
  // bridge; the page only renders it and settles the user's answer.
  const permissionQueue     = useAgentStore(s => s.permissionQueue)
  const settlePermission    = useAgentStore(s => s.settlePermission)
  // FOLLOW-UP PROMPT QUEUE (A1a): typing during a run used to be a silent
  // no-op (`if (!hasContent || isRunning) return`). Enter now queues, and the
  // drain effect below fires ONE entry at the run's terminal `done`.
  const pendingPrompts      = useAgentStore(s => s.pendingPrompts)
  const promptQueuePausedAll = useAgentStore(s => s.promptQueuePaused)
  const queuePrompt         = useAgentStore(s => s.queuePrompt)
  const unqueuePrompt       = useAgentStore(s => s.unqueuePrompt)
  const takeQueuedPrompt    = useAgentStore(s => s.takeQueuedPrompt)
  const setPromptQueuePaused = useAgentStore(s => s.setPromptQueuePaused)
  const startNewSession  = useAgentStore(s => s.startNewSession)
  const closeArchive     = useAgentStore(s => s.closeArchive)
  const resumeArchive    = useAgentStore(s => s.resumeArchive)
  const viewArchive         = useAgentStore(s => s.viewArchive)
  const recordParkedSession = useAgentStore(s => s.recordParkedSession)
  const takeParkedSession   = useAgentStore(s => s.takeParkedSession)

  const [task, setTask]           = useState('')
  // UX #2: progressive disclosure — the toolbar's second tier of controls
  // (thinking / agent / provider / workflow) lives behind one ADVANCED
  // toggle; open state survives restarts so power users keep their cockpit.
  const [advancedOpen, setAdvancedOpen] = useState(() => {
    try { return localStorage.getItem('tachi:code-advanced') === '1' } catch { return false }
  })
  const toggleAdvanced = () => setAdvancedOpen(v => {
    const next = !v
    try { localStorage.setItem('tachi:code-advanced', next ? '1' : '0') } catch { /* storage unavailable */ }
    return next
  })
  // UX F15: user-initiated context compaction — history sent on the NEXT turn
  // starts at this message index (the on-screen log is untouched; the server
  // keeps the full session log, recoverable via the expand_compacted tool).
  const [compactedUpTo, setCompactedUpTo] = useState(0)
  // A new/rewound session starts with a fresh log — stale compaction indexes
  // would silently blank the history sent on the first turns.
  useEffect(() => { setCompactedUpTo(0) }, [sessionId])
  // What the 'default' ladder would pick right now (null until keys load).
  // Drives the FREE/AUTO label, the cost hint and the context meter for the
  // 'default' provider — the same pure ladder main routes with.
  const defaultRoute = useDefaultAgentRoute()
  // One-line truth of the collapsed drawer: AGENT · PROVIDER · model · depth.
  // 'default' used to hand-write FREE here — a lie whenever the ladder had a
  // stored Bankr key to prefer (paid). FREE now renders only from the loaded
  // ladder pick's derived `free` fact; unknown/paid reads AUTO.
  const advSummary = [
    harness.toUpperCase(),
    provider === 'default' ? (defaultRoute?.free ? 'FREE' : 'AUTO') : provider.toUpperCase(),
    provider === 'bankr' ? modelDisplayName(bankrModel)
      : provider === 'surplus' ? modelDisplayName(surplusModel)
      : provider === 'venice' ? modelDisplayName(veniceModel)
      : provider === 'imgnai' ? modelDisplayName(imgnaiModel)
      : provider === 'opengateway' ? modelDisplayName(OPENGATEWAY_AGENT_MODEL)
      : provider === 'default' && defaultRoute ? modelDisplayName(defaultRoute.modelId)
      : '',
    depth !== 'normal' ? depth.toUpperCase() : '',
    fusionPlan ? '⑂FUSION' : '',
  ].filter(Boolean).join(' · ')
  const [isDragOver, setDragOver] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(true)

  // F4: Map of user-text event id → CardEntry (status + plan content).
  // Updated when the agent emits a <tachi-plan> tag or user clicks a card button.
  const [cardStates, setCardStates] = useState<Map<string, CardEntry>>(new Map())
  // Permission prompts are a QUEUE, not a slot, and it lives in the STORE, not
  // here. Two live bugs shaped this:
  //   1. the harness can emit several tool calls in one step (two bash calls
  //      10 ms apart) — a single slot dropped request #1 and main, which awaits
  //      the decision, hung the whole run;
  //   2. the queue used to be component state, so navigating CODE → NODES →
  //      CODE unmounted this page and the card vanished forever while main kept
  //      awaiting its resolver (a /loop run sat WORKING for 45 minutes).
  // Store state survives the unmount; the app-lifetime bridge keeps FILLING it
  // while this page is nowhere on screen and re-syncs from main at startup, so
  // even a renderer reload gets the outstanding cards back. One card is shown at
  // a time (oldest first) with a "+N waiting" counter.
  const pendingPermission = activePermission(permissionQueue)
  const permissionsBehind = queuedBehind(permissionQueue)

  // File attachments to be sent with the next prompt. Some harnesses don't
  // currently support binary uploads through `session/prompt` — we inline
  // the file contents (or a "[image attached]" marker for images) into the
  // task text on send. Best-effort, fits the existing string-prompt path.
  // `dataUrl` holds the base64 image so the TACHI harness can feed it to a
  // vision-capable model (real vision, not just a text marker). Non-image files
  // are still inlined as text/markers into the prompt.
  type Attachment = { name: string; kind: 'text' | 'image' | 'binary'; preview: string; dataUrl?: string }
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const onAttachFiles = React.useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const next: Attachment[] = []
    for (let i = 0; i < Math.min(files.length, 4); i++) {  // cap at 4 per click
      const f = files[i]
      const isImg = f.type.startsWith('image/')
      try {
        if (isImg) {
          const dataUrl = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error('read failed')); r.readAsDataURL(f) })
          next.push({ name: f.name, kind: 'image', preview: '[image attached]', dataUrl })
        } else if (f.size <= 64 * 1024) {
          // Small text-like file: inline its contents in the prompt.
          const text = await f.text()
          next.push({ name: f.name, kind: 'text', preview: text })
        } else {
          next.push({ name: f.name, kind: 'binary', preview: `[binary file: ${f.size} bytes]` })
        }
      } catch {
        next.push({ name: f.name, kind: 'binary', preview: `[unreadable: ${f.name}]` })
      }
    }
    setAttachments(prev => [...prev, ...next])
    // Reset the input so re-selecting the same file works.
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [])
  const logRef                    = useRef<HTMLDivElement>(null)
  const isRunning                 = status === 'running' || status === 'starting'
  const isViewingArchive          = viewingArchiveId !== null

  // ── SURFACE OWNERSHIP ─────────────────────────────────────────────────────
  //
  // TRANSCRIPT BLEED, observed live: switching CODE → TACHIAPP rendered the
  // previous Code run under the TACHIAPP header until "+ NEW" was clicked. The
  // two routes are distinct react-router elements, but they share ONE store —
  // the transcript, the harness sessionId and the workspace — and the pinned
  // keeper effect below only binds when NO session is live. So the Code session
  // simply stayed, and the bleed was never cosmetic: the next send from TACHIAPP
  // would have reused that session id, that workspace and that transcript as
  // replayed history, then re-archived the merged conversation onto the Code
  // rail (sessionTag was still Code's).
  //
  // Each surface now CLAIMS the live slot on mount — archiving, never
  // discarding: a parked session reappears on its own rail and is continuable.
  // A run that is still in flight is never yanked (`busy`): the surface renders
  // a note instead of the foreign transcript and re-decides when the run ends.
  const surfaceTag: AgentSessionTag | null = appMode ? 'tachiapp' : null
  const liveSessionTag = useAgentStore(s => s.sessionTag)
  const [surfaceBlocked, setSurfaceBlocked] = useState(false)
  // Which prompt queue is OURS. Keyed off this surface's own identity, never off
  // the live session's tag: a follow-up typed here must stay here even while the
  // other surface owns the live slot.
  const promptSurface = promptSurfaceKey(surfaceTag)
  const promptQueue   = pendingPrompts[promptSurface] ?? EMPTY_PROMPTS
  const promptPaused  = promptQueuePausedAll[promptSurface] ?? false

  /**
   * WORKSPACE RESTORE (Code surface). Claiming the live slot drops an inherited
   * workingDir — the TACHIAPP app source must never become "the folder you are
   * working in" just because you visited that chat. The cost of that correct
   * rule was that a CODE → TACHIAPP → CODE round trip ALSO threw away the
   * folder the operator had picked here, dumping them back on "Choose folder…".
   *
   * So bring back the Code surface's own last workspace instead — but only if
   * it still exists: agent:register-workspace stats the path (and authorizes it
   * as a write-gate root, which we need anyway), so a folder that has been
   * moved or deleted simply does not come back. Re-checked after the await:
   * the operator may have picked a folder, or left again, while we asked.
   *
   * Deliberately does NOT spawn a session — the composer runs on a remembered
   * folder alone (sendTask starts one lazily), so navigation costs no sidecar.
   */
  const restoreCodeWorkspace = useCallback(async () => {
    const before = useAgentStore.getState()
    const remembered = before.lastCodeWorkingDir
    // Cheap pre-check: nothing to restore, or the surface already has a
    // workspace (the operator picked one, or TACHIAPP took the slot back).
    if (!remembered || before.sessionTag !== null || before.workingDir) return
    let exists = false
    try { exists = (await window.tachi.agent.registerWorkspace(remembered)).ok } catch { /* gone → stay on the prompt */ }
    if (!exists) return
    const st = useAgentStore.getState()
    if (st.sessionTag !== null || st.workingDir || st.viewingArchiveId) return
    st.setWorkingDir(remembered)
  }, [])

  useEffect(() => {
    const st = useAgentStore.getState()
    const decision = surfaceBindDecision({
      surface:        surfaceTag,
      sessionTag:     st.sessionTag,
      status:         st.status,
      hasSession:     Boolean(st.sessionId),
      hasMessages:    st.messages.length > 0,
      viewingArchive: Boolean(st.viewingArchiveId),
    })
    setSurfaceBlocked(decision === 'busy')
    if (decision === 'own' || decision === 'busy') return
    if (decision === 'park') {
      // Archives under the OUTGOING tag (snapshotLive reads sessionTag), so the
      // session lands on the rail of the surface that produced it. When an
      // archive is open this is the lossless "close the view" path — nothing
      // new is snapshotted there, so nothing is recorded for auto-select below.
      const owningTag = st.sessionTag
      const realPark   = !st.viewingArchiveId && st.messages.length > 0
      startNewSession()
      if (realPark) {
        // startNewSession() unshifts the fresh snapshot, so it is pastSessions[0].
        // Recorded for the OWNING surface (not this, foreign, mounting one) —
        // its next mount consumes this once to auto-open the entry instead of
        // showing a blank composer (see the effect right below).
        const parkedId = useAgentStore.getState().pastSessions[0]?.id
        if (parkedId) recordParkedSession(owningTag, parkedId)
      }
    }
    // The parked workspace belonged to the other surface. TACHIAPP re-resolves
    // its own (activatePinnedRepo below); the Code tab must not inherit the app
    // source as if the user had picked it — drop it, not for a tick more.
    if (!appMode) setWorkingDir(null)
    // Claim AFTER archiving — flipping the tag first would file the outgoing
    // session under this surface's rail.
    setSessionTag(surfaceTag)
    // …then bring back the folder THIS surface last owned (validated on disk),
    // so the round trip costs the operator nothing. Async by nature; it
    // re-checks the surface state before touching anything.
    if (!appMode) void restoreCodeWorkspace()
  }, [appMode, surfaceTag, liveSessionTag, status, sessionId, viewingArchiveId,
      startNewSession, setSessionTag, setWorkingDir, restoreCodeWorkspace, recordParkedSession])

  /**
   * AUTO-SELECT ON RETURN. This surface just claimed the live slot in the
   * effect above — if it is genuinely idle (no messages, no session, not
   * already viewing an archive), and its OWN last live session parked while
   * the operator was away (recorded above, keyed by `surfaceTag`), open that
   * entry instead of leaving a blank composer. `takeParkedSession` reads AND
   * clears the marker, so this can only ever fire once per park, and it
   * never touches a session the operator has already started here — the idle
   * check re-runs on every dependency change, so the moment they type/send/
   * resume, the guard fails and any leftover marker is simply never consumed.
   */
  useEffect(() => {
    if (liveSessionTag !== surfaceTag) return
    if (status !== 'idle' || messages.length > 0 || viewingArchiveId) return
    const parkedId = takeParkedSession(surfaceTag)
    if (!parkedId) return
    // The entry may have been deleted from the rail in the meantime.
    if (useAgentStore.getState().pastSessions.some(p => p.id === parkedId)) {
      viewArchive(parkedId)
    }
  }, [liveSessionTag, surfaceTag, status, messages.length, viewingArchiveId, takeParkedSession, viewArchive])

  // GAVE-UP DETECTION: the finished run STOPPED rather than completed. Only ever
  // true for a live, finished run — an archive being viewed keeps its own status.
  const runIncomplete             = !!endedIncomplete && status === 'done' && !isViewingArchive
  // Workflow mode: a saved Nodes graph is bound to this tab. The composer runs
  // the graph instead of a normal harness session; the normal controls pause.
  // Never in TACHIAPP — that surface is one pinned harness session, always.
  const workflowMode              = !appMode && activeWorkflow !== null && !isViewingArchive
  // Live "running: <node>" hint during a workflow run (from graph:node-active).
  const [wfNodeLabel, setWfNodeLabel] = useState<string | null>(null)

  // Context meter (CODE tab): agent sessions don't feed the chat contextChars
  // store, so derive an estimate from the live message log — sum of every
  // event's text/input/output/message string length. chars / 4 ≈ tokens.
  const agentContextChars = useMemo(() => {
    let n = 0
    for (const m of messages.slice(compactedUpTo)) {
      const ev = m.event as { text?: unknown; input?: unknown; output?: unknown; message?: unknown }
      if (typeof ev.text    === 'string') n += ev.text.length
      if (typeof ev.input   === 'string') n += ev.input.length
      if (typeof ev.output  === 'string') n += ev.output.length
      if (typeof ev.message === 'string') n += ev.message.length
    }
    return n
  }, [messages, compactedUpTo])
  // ── The CTX meter's inputs: WHICH provider, WHICH model ──────────────────
  //
  // Both, because a context window is a per-MODEL fact and the provider serving
  // it is the authority (see store/modelWindow.store.ts). The provider id must
  // be the id that provider's PICKER records windows under, or the lookup
  // misses and every model reads as unknown.
  //
  // This used to be one id mapped to a per-provider constant, with venice and
  // imgnai both folded into the 'opengateway' key — which is why a driver saw
  // `0% of ~32,000 tokens (estimate)` for a Venice model Venice serves at
  // 200,000. The model id is taken from `originModelFor`, the SAME function
  // that stamps a message's origin at send, so the meter and the badge under
  // the answer can never name two different models.
  const agentCtxProviderId = provider === 'bankr' ? 'bankr-gateway'
    : provider === 'default' ? (defaultRoute?.providerId ?? '')
    : provider
  const agentCtxModelId = originModelFor(provider, {
    bankr: bankrModel, surplus: surplusModel, venice: veniceModel, imgnai: imgnaiModel,
    defaultRoute: defaultRoute?.modelId,
  })
  // UX F15: pre-flight cost estimate on the RUN button (input ≈ context+task,
  // output assumed ~1.5k tokens). Free routes show $0; unknown models show
  // an honest "billed by model" (or nothing) rather than a made-up number.
  const runCostHint = useMemo(() => {
    // "$0" is a PRICING/REGISTRY fact (billing:'free' or a verified-free
    // model), never a provider-name rule. This hint used to hardcode
    // 'default'/'opengateway' as "est $0 (free route)" — written when
    // OpenGateway was free and kept while it went pay-as-you-go. Since
    // 2026-08-01 the opengateway harness pin (OPENGATEWAY_AGENT_MODEL) and
    // the 'default' ladder pick are shared facts, so the price derives from
    // the model that actually runs; with keys not yet loaded, 'default'
    // claims NOTHING rather than $0.
    const canonicalId =
      provider === 'bankr'         ? 'bankr-gateway'
      : provider === 'surplus'     ? 'surplus'
      : provider === 'venice'      ? 'venice'
      : provider === 'imgnai'      ? 'imgnai'
      : provider === 'opengateway' ? 'opengateway'
      : provider === 'default'     ? (defaultRoute?.providerId ?? null)
      : null
    // No canonical id ⇒ nothing below is derivable. Two ways to get here: the
    // 'default' ladder has not loaded yet (a route we cannot name), or the
    // persisted `provider` is an id this build no longer knows — `provider` IS
    // persisted and, unlike `harness`, migrateAgentPersisted does not coerce
    // removed ids off it. Bail BEFORE reading the model, because the mapping
    // below answers an unrecognised provider with the DEFAULT ladder's model
    // (its switch fall-through), and pricing that model here would put a number
    // on a run that will not use it. The chain this replaced returned '' for an
    // unknown provider; this keeps that, rather than inventing a rate.
    if (!canonicalId) return ''
    // freellmapi-local: billing 'free' — the registry row
    // promises $0 for every model it serves, so $0 is honest here.
    if (providerBilling(canonicalId) === 'free') return ` · ${t('composer.estFree')}`
    // WHICH model gets priced: read it through `agentCtxModelId`, i.e. through
    // `originModelFor` — the ONE function that answers provider→model, shared
    // with the origin stamped at send and with the CTX meter just above. This
    // was a second, hand-written copy of that same chain sitting ten lines away
    // from the first, which is the drift shape this file keeps deleting: the
    // next repricing or new provider gets applied to one copy, the run uses the
    // model the stamp names, and the button quotes the price of a model that
    // never ran. There is now nothing to keep in step.
    const model = agentCtxModelId
    if (!model) {
      // A paid provider whose model is chosen in MAIN: money may move, but
      // this surface cannot know the rate — say so, never $0. (canonicalId is
      // known non-null here; the no-id case returned above.)
      return ` · ${t('composer.estBilledByModel')}`
    }
    // A VERIFIED-free model (per-model pricing fact) is known-$0 — say FREE,
    // not "<$0.01" (its all-zero rates would otherwise round to that).
    if (isVerifiedFreeModel(model)) return ` · ${t('composer.estFree')}`
    const rates = ratesFor(model)
    if (!rates) return ''
    const inTok = (agentContextChars + task.length) / 4
    const usd = (inTok / 1e6) * rates.inputPerM + (1500 / 1e6) * rates.outputPerM
    if (!isFinite(usd)) return ''
    return usd < 0.005 ? ' · est <$0.01' : ` · est ~$${usd.toFixed(2)}`
    // The four per-provider model ids are no longer read here — `agentCtxModelId`
    // is derived from them on every render, so it is the dependency now.
  }, [provider, agentCtxModelId, defaultRoute, agentContextChars, task.length, t])

  // File preview state (FolderTree click → side pane for text/image)
  const [previewPath, setPreviewPath]       = useState<string | null>(null)
  const [previewContent, setPreviewContent] = useState<{
    kind: 'text' | 'image' | 'binary'
    content?: string
    sizeBytes: number
    truncated?: boolean
  } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  // Editable code view for the preview pane: read-only until EDIT.
  const [previewEditing, setPreviewEditing] = useState(false)
  const [previewDraft,   setPreviewDraft]   = useState('')
  const [previewDirty,   setPreviewDirty]   = useState(false)
  const [previewSaving,  setPreviewSaving]  = useState(false)
  const previewSavedRef = useRef<string>('')

  // PreviewPanel state — fixed-overlay iframe preview for HTML/images from
  // Write tool events or FolderTree "Preview in Panel" context menu action.
  const [panelPreviewPath, setPanelPreviewPath] = useState<string | null>(null)

  const handleFileClick = async (absolutePath: string) => {
    if (previewPath === absolutePath) {
      // Toggle: clicking same file closes preview
      setPreviewPath(null)
      setPreviewContent(null)
      return
    }
    setPreviewPath(absolutePath)
    setPreviewContent(null)
    setPreviewLoading(true)
    setPreviewEditing(false)
    setPreviewDirty(false)
    setPreviewSaving(false)
    try {
      const result = await (window.tachi.agent as unknown as {
        readFile: (p: string) => Promise<{ kind: 'text' | 'image' | 'binary'; content?: string; sizeBytes: number; truncated?: boolean }>
      }).readFile(absolutePath)
      setPreviewContent(result)
      if (result.kind === 'text' && typeof result.content === 'string') {
        previewSavedRef.current = result.content
        setPreviewDraft(result.content)
      }
    } catch (err) {
      setPreviewContent({ kind: 'binary', sizeBytes: 0 })
    } finally {
      setPreviewLoading(false)
    }
  }

  // Persist preview-pane edits to disk via the guarded agent:write-file IPC.
  const savePreviewFile = useCallback(async () => {
    if (!previewPath || !previewDirty || previewSaving) return
    setPreviewSaving(true)
    try {
      const api = window.tachi.agent as unknown as { writeFile: (p: string, c: string) => Promise<{ ok: boolean; error?: string }> }
      const r = await api.writeFile(previewPath, previewDraft)
      if (r.ok) {
        previewSavedRef.current = previewDraft
        setPreviewDirty(false)
        setPreviewEditing(false)
        showToast({ kind: 'success', text: t('preview.saved') })
      } else {
        showToast({ kind: 'error', text: r.error ?? t('preview.saveFailed') })
      }
    } catch (e) {
      showToast({ kind: 'error', text: e instanceof Error ? e.message : t('preview.saveFailed') })
    } finally {
      setPreviewSaving(false)
    }
  }, [previewPath, previewDirty, previewSaving, previewDraft])

  // Tell main which workspace root is active so it can confine write/delete file
  // IPC to it — covers drag/drop, a typed path, or a restored session (the folder
  // dialog already registers itself main-side).
  useEffect(() => {
    if (!workingDir) return
    window.tachi.agent.registerWorkspace(workingDir).catch(() => {})
  }, [workingDir])

  // Workspace checkpoint the agent auto-takes before it edits files, offered as
  // a one-click revert in the toolbar (STEAL 2026-07-08).
  //
  // It comes off the `checkpoint` event, which the APP-LIFETIME bridge
  // (src/store/agentEventBridge.ts) intercepts — so the page READS it from the
  // store rather than owning it. There is no agent-event subscription here any
  // more: one inside this component meant leaving the tab unsubscribed the
  // whole stream and every later event was lost (run stuck on WORKING forever).
  const revertCp = useAgentStore(s => s.revertCheckpoint)
  const setRevertCp = useAgentStore(s => s.setRevertCheckpoint)
  const [reverting, setReverting] = useState(false)

  const revertAgentChanges = useCallback(async () => {
    if (!revertCp || reverting) return
    setReverting(true)
    try {
      const r = await window.tachi.checkpoints.restoreWorkspace(revertCp.root, revertCp.id)
      showToast(r.ok
        ? { kind: 'success', text: t('checkpoint.reverted') }
        : { kind: 'error', text: r.error ?? t('checkpoint.revertFailed') })
      if (r.ok) setRevertCp(null)
    } catch (e) {
      showToast({ kind: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally { setReverting(false) }
  }, [revertCp, reverting, setRevertCp, t])

  // THREE-WAY RESET on a past user turn (plan A2, Cline's vocabulary).
  //
  //   RESET CHAT — the original rewind/edit: pull the turn back into the
  //                composer and drop it + everything after, so the next send
  //                re-runs from that point (the harness re-seeds history from
  //                the truncated transcript). Files untouched.
  //   RESET CODE — restore the workspace snapshot taken immediately BEFORE that
  //                turn ran. Transcript untouched.
  //   RESET BOTH — code first, then chat.
  //
  // ORDERING IS THE SAFETY PROPERTY. On BOTH the restore runs first and the
  // transcript is truncated only if it SUCCEEDED (`shouldSliceChat`): a failed
  // restore that still wiped the transcript would leave the operator with
  // mutated files and no record of what produced them. Failures are always
  // toasted with the real error — never a silent half-restore.
  const confirmReset = useConfirm()
  useEffect(() => {
    const onReset = (e: Event) => {
      const detail = (e as CustomEvent).detail as { eventId: string; choice?: ResetChoice } | undefined
      if (!detail) return
      const choice: ResetChoice = detail.choice ?? 'chat'
      const st = useAgentStore.getState()
      if (st.status === 'running' || st.status === 'starting' || st.viewingArchiveId) return

      const finishChat = () => {
        const text = useAgentStore.getState().rewindTo(detail.eventId)
        if (text) setTask(text)
      }

      void (async () => {
        const cp = shouldRestoreCode(choice)
          ? useAgentStore.getState().turnCheckpointFor(detail.eventId)
          : null

        if (shouldRestoreCode(choice) && !cp?.cpId) {
          // Should be unreachable (the row is disabled) — but never pretend.
          showToast({ kind: 'error', text: t('reset.noCheckpoint') })
          return
        }

        const confirmed = await confirmReset({
          title:   t('reset.confirmTitle'),
          message: choice === 'both' ? t('reset.confirmBoth')
                 : choice === 'code' ? t('reset.confirmCode')
                 : t('reset.confirmChat'),
          okLabel: t(`reset.${choice}`),
          danger:  shouldRestoreCode(choice),
        })
        if (!confirmed) return

        await runTurnReset(choice, { cpId: cp?.cpId ?? null, root: cp?.root ?? null }, {
          restore:   (root, id) => window.tachi.checkpoints.restoreWorkspace(root, id),
          sliceChat: finishChat,
          onFailure: (error) => showToast({ kind: 'error', text: error || t('reset.codeFailed'), ttl: 8000 }),
          onSuccess: ({ safetyId }) => showToast({
            kind: 'success',
            text: t('reset.codeRestored'),
            ttl:  30_000,
            // UNDO THE UNDO: restoreWorkspace snapshots the CURRENT tree before
            // overwriting it and hands the id back. Without this the safety net
            // was computed and thrown away every single time.
            ...(safetyId && cp?.root ? { actions: [{
              label: t('reset.undo'),
              onClick: () => {
                void (async () => {
                  try {
                    const back = await window.tachi.checkpoints.restoreWorkspace(cp.root, safetyId)
                    showToast(back.ok
                      ? { kind: 'success', text: t('reset.undone') }
                      : { kind: 'error', text: back.error ?? t('reset.undoFailed') })
                  } catch (err) {
                    showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
                  }
                })()
              },
            }] } : {}),
          }),
        })
      })()
    }
    // 'tachi:agent-edit' is kept as an alias so any surface still dispatching
    // the old event gets the (unchanged) RESET CHAT behaviour.
    window.addEventListener('tachi:agent-reset', onReset as EventListener)
    window.addEventListener('tachi:agent-edit', onReset as EventListener)
    return () => {
      window.removeEventListener('tachi:agent-reset', onReset as EventListener)
      window.removeEventListener('tachi:agent-edit', onReset as EventListener)
    }
  }, [confirmReset, t])

  // ── Parallel tasks ─────────────────────────────────────────────────────────
  //
  // READ-ONLY here. The `parallel:event` subscription + the one-time bootstrap
  // used to live in an effect on this page, so every tile froze the moment the
  // operator left the tab (statuses, steps-watcher lines and the list refresh
  // that adds/removes tiles were all dropped, and nothing replays them). Both
  // now belong to the APP-LIFETIME bridge — src/store/agentEventBridge.ts,
  // exactly like the agent event stream it sits next to.
  const parallelTaskCount    = useParallelAgentsStore(s => s.taskOrder.length)
  const parallelFocusedId    = useParallelAgentsStore(s => s.focusedTaskId)
  const parallelTasks        = useParallelAgentsStore(s => s.tasks)

  // Grid mode is active when at least one parallel task exists. Single-session
  // legacy behaviour is preserved when no parallel tasks are present, so the
  // existing AgentPage workflow stays unchanged for callers who don't opt in.
  // TACHIAPP opts out entirely: a stray parallel task from the Code tab must
  // not hijack the pinned self-improvement transcript.
  const parallelGridMode = !appMode && parallelTaskCount >= 1
  const focusedTask = parallelFocusedId ? parallelTasks.get(parallelFocusedId) ?? null : null

  // Effective routing target for the InputBar — in grid mode this is the
  // focused tile, otherwise the legacy single-session pair from agent.store.
  // Used both for the actual send and for the disabled / placeholder UI.
  const effectiveWorkingDir = parallelGridMode ? focusedTask?.workingDir ?? null : workingDir
  const effectiveSessionId  = parallelGridMode ? focusedTask?.sessionId  ?? null : sessionId

  // "+ NEW" DEAD END (pre-existing, reproduced 2026-07-25). The rail's + NEW
  // archives the transcript and clears `sessionId` but KEEPS `workingDir` — and
  // the send handler and the button's disabled expression, written separately,
  // BOTH required a live session id. Result: the composer went permanently
  // inert and the only way out was re-picking the very same folder.
  //
  // ONE rule now (sendGate), read by both: a workspace the operator already
  // chose means the session is spawned ON DEMAND, not that sending is refused.
  const gate = sendGate({
    surfaceBlocked,
    viewingArchive:   isViewingArchive,
    workflowMode,
    parallelGridMode,
    sessionId:        effectiveSessionId,
    workingDir:       effectiveWorkingDir,
  })

  // ── Whose approval is this? ────────────────────────────────────────────────
  //
  // The permission queue is app-lifetime, so the active card renders on
  // WHICHEVER surface is mounted — including the one that does not own the run
  // (observed live: TACHIAPP showing the CODE run's bash card under its busy
  // note). The buttons deliberately stay live there — an operator parked on the
  // wrong tab must be able to unblock the run — but the card has to say which
  // run it unblocks. Main stamps the session id; the surface tag is ours.
  const parallelSessionIds = useMemo(
    () => [...parallelTasks.values()].map(tk => tk.sessionId).filter(Boolean),
    [parallelTasks],
  )
  const foreignOwner = foreignPermissionOwner(
    pendingPermission,
    { sessionId, sessionTag: liveSessionTag, parallelSessionIds },
    appMode ? 'tachiapp' : 'code',
  )
  const permissionOwnerLabel = foreignOwner === 'code'
    ? t('permission.owner.code', { defaultValue: 'CODE RUN' })
    : foreignOwner === 'tachiapp'
      ? t('permission.owner.tachiapp', { defaultValue: 'TACHIAPP RUN' })
      : undefined

  // F4: Watch text + done events to update card state with parsed plan JSON.
  //
  // Strategy: find the most-recent user-text event that has a parsedCommand and
  // does NOT yet have a non-stub plan (status === 'pending-review', plan is still
  // the stub). When a 'text' event arrives, try extractPlanJson on it. When a
  // 'done' event arrives and the card is still on the stub plan, set plan to null
  // (triggers ErrorCard in SlashCommandCard).
  useEffect(() => {
    if (messages.length === 0) return

    const lastEvent = messages[messages.length - 1]
    if (!lastEvent) return
    const ev = lastEvent.event

    // Scan backwards for the most-recent user-text event with parsedCommand
    // that has a pending card (plan is stub = summary contains 'Generating plan...')
    const pendingCardItem = [...messages].reverse().find(m => {
      if (m.event.type !== 'user-text') return false
      const userEv = m.event as AgentEvent & { type: 'user-text'; parsedCommand?: ParsedSlashCommand }
      if (!userEv.parsedCommand) return false
      const entry = cardStates.get(m.id)
      // Card state not yet registered at all (brand new) OR registered but plan
      // is still a stub (plan.rootCause?.summary === 'Generating plan...' or similar)
      if (!entry) return true
      if (entry.status !== 'pending-review') return false
      const isStub = !entry.plan ||
        (entry.plan.command === 'troubleshoot' && entry.plan.rootCause.summary === 'Generating plan...') ||
        (entry.plan.command === 'refactor'     && entry.plan.target               === 'Generating plan...') ||
        (entry.plan.command === 'review'       && entry.plan.scope                === 'Generating plan...') ||
        (entry.plan.command === 'plan'         && entry.plan.goal                 === 'Generating plan...')
      return isStub
    })

    if (!pendingCardItem) return
    const cardId = pendingCardItem.id
    const parsedCmd = (pendingCardItem.event as AgentEvent & { parsedCommand?: ParsedSlashCommand }).parsedCommand!

    if (ev.type === 'text') {
      const parsed = extractPlanJson(ev.text ?? '')
      if (parsed) {
        setCardStates(prev => {
          const next = new Map(prev)
          next.set(cardId, { status: 'pending-review', plan: parsed })
          return next
        })
      }
    }

    if (ev.type === 'done') {
      // Session done: if card is still on stub plan, the agent never emitted a
      // tachi-plan tag — switch to null so ErrorCard renders.
      const currentEntry = cardStates.get(cardId)
      const stillStub = !currentEntry || !currentEntry.plan ||
        (currentEntry.plan.command === 'troubleshoot' && currentEntry.plan.rootCause.summary === 'Generating plan...') ||
        (currentEntry.plan.command === 'refactor'     && currentEntry.plan.target               === 'Generating plan...') ||
        (currentEntry.plan.command === 'review'       && currentEntry.plan.scope                === 'Generating plan...') ||
        (currentEntry.plan.command === 'plan'         && currentEntry.plan.goal                 === 'Generating plan...')
      if (stillStub) {
        setCardStates(prev => {
          const next = new Map(prev)
          next.set(cardId, { status: 'pending-review', plan: null })
          return next
        })
      }
    }
    // Intentional: parsedCmd is used for identity but not in the dep array
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages])

  // F4: Register card entries for newly-arrived user-text events that have
  // parsedCommand but no card state yet. Runs after the messages list changes.
  //
  // Sprint F review fix (Issue 3): this loop also acts as the *reconstruction*
  // pass after AgentPage remounts (cardStates is component-local and resets on
  // unmount). For each unregistered user-text/parsedCommand event we walk the
  // subsequent events looking for assistant `text` chunks that contain a
  // `<tachi-plan>` tag — if one is found we reconstruct the parsed plan
  // immediately so the historical card renders with its real content instead
  // of a forever-stuck "Generating plan..." stub.
  //
  // We also check whether a `done` (or `error`) event followed the user-text
  // without any plan emission, in which case the reconstructed card flips
  // straight to the ErrorCard state (plan = null) so the past failure is
  // visible to the user instead of a phantom in-progress card.
  useEffect(() => {
    const newEntries: Array<[string, CardEntry]> = []
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      if (m.event.type !== 'user-text') continue
      const userEv = m.event as AgentEvent & { type: 'user-text'; parsedCommand?: ParsedSlashCommand }
      if (!userEv.parsedCommand) continue
      if (cardStates.has(m.id)) continue

      // Walk forward from this user-text to find the matching plan tag (or a
      // terminal event indicating the run finished without emitting one).
      let reconstructedPlan: SlashCommandResult | null = null
      let sawTerminal = false
      for (let j = i + 1; j < messages.length; j++) {
        const fwd = messages[j].event
        // Stop scanning when we hit the *next* user-text — that belongs to a
        // different slash-command card.
        if (fwd.type === 'user-text') break
        if (fwd.type === 'text') {
          const parsed = extractPlanJson(fwd.text ?? '')
          if (parsed) {
            reconstructedPlan = parsed
            break
          }
        }
        if (fwd.type === 'done' || fwd.type === 'error') {
          sawTerminal = true
          // Keep scanning a little in case a final text chunk with the plan
          // arrives in the same batch — but only within the immediate window.
          // In practice extractPlanJson would already have picked it up above.
        }
      }

      if (reconstructedPlan) {
        // Found a real plan in history — render the real card immediately.
        newEntries.push([m.id, { status: 'pending-review', plan: reconstructedPlan }])
      } else if (sawTerminal) {
        // Run finished without a plan tag — show ErrorCard (plan = null).
        newEntries.push([m.id, { status: 'pending-review', plan: null }])
      } else {
        // No terminal event yet — this is a live in-flight card; use the stub.
        newEntries.push([m.id, {
          status: 'pending-review',
          plan:   buildStubPlan(userEv.parsedCommand.command),
        }])
      }
    }
    if (newEntries.length > 0) {
      setCardStates(prev => {
        const next = new Map(prev)
        for (const [id, entry] of newEntries) next.set(id, entry)
        return next
      })
    }
  }, [messages]) // cardStates deliberately excluded — we only need to check missing keys

  // F4: Card action handlers
  const handleApprove = useCallback((cardId: string, plan: SlashCommandResult) => {
    setCardStates(prev => {
      const next = new Map(prev)
      const entry = prev.get(cardId)
      if (entry) next.set(cardId, { ...entry, status: 'approved' })
      return next
    })
    // Target the focused parallel tile when in grid mode, else the legacy session.
    const sid = parallelGridMode ? focusedTask?.sessionId ?? null : sessionId
    const tid = parallelGridMode ? focusedTask?.id : undefined
    if (sid) void window.tachi.agent.approvePlan(sid, plan, tid ? { taskId: tid } : undefined).catch(() => {})
  }, [sessionId, parallelGridMode, focusedTask])

  const handleApply = useCallback((cardId: string, plan: SlashCommandResult) => {
    setCardStates(prev => {
      const next = new Map(prev)
      const entry = prev.get(cardId)
      if (entry) next.set(cardId, { ...entry, status: 'applied' })
      return next
    })
    const sid = parallelGridMode ? focusedTask?.sessionId ?? null : sessionId
    const tid = parallelGridMode ? focusedTask?.id : undefined
    if (sid) void window.tachi.agent.approvePlan(sid, plan, { fix: true, ...(tid ? { taskId: tid } : {}) }).catch(() => {})
  }, [sessionId, parallelGridMode, focusedTask])

  const handleCancel = useCallback((cardId: string) => {
    setCardStates(prev => {
      const next = new Map(prev)
      const entry = prev.get(cardId)
      if (entry) next.set(cardId, { ...entry, status: 'cancelled' })
      return next
    })
  }, [])

  // NOTE — the agent:permission-request / -cancel subscriptions and the
  // permission-pending re-sync used to live here. They are app-lifetime now
  // (src/store/agentEventBridge.ts): bound to a route, an approval card raised
  // while the operator was on NODES had nowhere to land, and the tool blocked
  // on it only unblocked on the 10-minute timeout. The page just renders the
  // store's queue and answers it.

  const handlePermissionDecide = (id: string, decision: PermissionDecision) => {
    settlePermission(id)
    window.tachi.agent.permissionResponse(id, decision).catch(() => {})
  }

  // Auto-scroll log to bottom on new messages
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [messages.length])

  /**
   * Spawn a harness session in `path` on the currently selected route.
   * Returns the new session id, or null when the spawn failed (status is then
   * 'error' and the caller must not send).
   *
   * Shared by the folder picker and by the LAZY start in sendTask — the "+ NEW"
   * dead-end fix — so both spawn exactly the same session with the same
   * gateway/model/harness, and there is one place where that can drift.
   */
  const startSessionForWorkspace = async (path: string): Promise<string | null> => {
    firstTaskRoutedRef.current = false  // re-route the first task of the new session
    try {
      setStatus('starting')
      // TACHIAPP always runs the first-party harness, whatever the Code tab's
      // persisted preference happens to be.
      // normalizeHarness: a persisted preference from before the Goose removal
      // must never be dispatched (see agent.store.ts).
      const sessionHarness = appMode ? 'tachi' : normalizeHarness(harness)
      // Spawn on the picked model (or default). With smart routing ON, the FIRST
      // task re-routes the session to the difficulty-matched model (see sendTask).
      const { sessionId: sid } = await window.tachi.agent.startSession(
        path,
        sessionHarness,
        provider,
        bankrModel,
        surplusModel,
        false,
        veniceModel,
        imgnaiModel,
      )
      setSession(sid)
      setStatus('idle')
      return sid
    } catch (err) {
      setStatus('error', err instanceof Error ? err.message : String(err))
      return null
    }
  }

  const activateFolder = async (path: string) => {
    // Archive the prior session (if any) before swapping workspace.
    startNewSession()
    // …then claim it for the Code rail. Order matters: the snapshot above must
    // still carry whatever surface owned it (TACHIAPP sessions stay TACHIAPP).
    setSessionTag(null)
    setWorkingDir(path)
    await startSessionForWorkspace(path)
  }

  const pickFolder = async () => {
    const path = await window.tachi.agent.pickFolder()
    if (!path) return
    await activateFolder(path)
  }

  // ── TACHIAPP: pinned app-source workspace ─────────────────────────────────
  //
  // The whole point of the preset is that the user never chooses a folder, so
  // the workspace is RESOLVED (setting → dev walk-up → known installs, see
  // electron/services/app-repo.ts). Only when all three miss does the surface
  // ask — once — via the inline LOCATE APP SOURCE card below.
  type AppRepoState =
    | { status: 'resolving' }
    | { status: 'ready'; path: string; source: 'setting' | 'dev' | 'fallback' }
    | { status: 'missing'; error?: string }
  const [appRepo, setAppRepo] = useState<AppRepoState>({ status: 'resolving' })

  /**
   * Bind the live session to `path` WITHOUT the folder-swap dance: a live
   * session already in that directory is kept (navigating away and back must
   * not wipe the transcript); a session from ANOTHER workspace is archived
   * first, exactly like activateFolder does. `force` re-spawns even when a
   * session exists — used when the gateway/model changed under it.
   */
  const activatePinnedRepo = useCallback(async (path: string, opts?: { force?: boolean }) => {
    const st = useAgentStore.getState()
    if (!opts?.force && st.workingDir === path && st.sessionId) return  // already live here
    // Archive FIRST, then claim the surface: flipping the tag before the
    // snapshot would file the outgoing Code session under the TACHIAPP rail.
    if (st.workingDir && st.workingDir !== path) startNewSession()
    setSessionTag('tachiapp')
    setWorkingDir(path)
    firstTaskRoutedRef.current = false
    try {
      setStatus('starting')
      const { sessionId: sid } = await window.tachi.agent.startSession(
        path,
        'tachi',            // TACHIAPP is always the first-party harness
        provider,
        bankrModel,
        surplusModel,
        false,
        veniceModel,
        imgnaiModel,
      )
      setSession(sid)
      setStatus('idle')
    } catch (err) {
      setStatus('error', err instanceof Error ? err.message : String(err))
    }
  }, [provider, bankrModel, surplusModel, veniceModel, imgnaiModel,
      startNewSession, setWorkingDir, setStatus, setSession, setSessionTag])

  // Resolve the workspace once per mount. This ONLY reports where the source
  // is; binding the session is the single keeper effect below.
  useEffect(() => {
    if (!appMode) return
    let cancelled = false
    void (async () => {
      try {
        const r = await window.tachi.app.resolveAppRepo()
        if (cancelled) return
        setAppRepo(r?.path
          ? { status: 'ready', path: r.path, source: r.source }
          : { status: 'missing' })
      } catch (err) {
        if (!cancelled) setAppRepo({ status: 'missing', error: err instanceof Error ? err.message : String(err) })
      }
    })()
    return () => { cancelled = true }
  }, [appMode])

  /**
   * ONE keeper effect owns the pinned session, because two facts are captured
   * at spawn time and neither has a folder picker to re-trigger it:
   *   • the workspace  — bind whenever there is no live session (first mount,
   *     after "+ NEW" in the rail, after closing an archive);
   *   • the ROUTE      — agent:start-session applies the gateway/model override
   *     process-wide, so changing the header picker mid-chat has to re-spawn or
   *     the picker would silently lie about what is answering.
   * Re-spawning never touches the transcript. Guards: never while a run is in
   * flight or while browsing an archive, and never after an error (that would
   * be an infinite retry loop — the user re-triggers it by changing a control).
   */
  const pinnedRoute = [provider, bankrModel, surplusModel, veniceModel, imgnaiModel].join('|')
  const boundRouteRef = useRef<string | null>(null)
  useEffect(() => {
    if (!appMode || appRepo.status !== 'ready') return
    if (isViewingArchive) return
    if (status !== 'idle' && status !== 'done') return
    const needsBind  = !sessionId
    const routeMoved = boundRouteRef.current !== null && boundRouteRef.current !== pinnedRoute
    if (!needsBind && !routeMoved) return
    boundRouteRef.current = pinnedRoute
    void activatePinnedRepo(appRepo.path, { force: routeMoved })
    // activatePinnedRepo is re-created on every model change; adding it here
    // would re-enter on identity alone. The route key already covers it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appMode, appRepo, status, sessionId, pinnedRoute, isViewingArchive])

  /** One-time native pick for the LOCATE APP SOURCE card. Stored forever. */
  const [locating, setLocating] = useState(false)
  const locateAppRepo = useCallback(async () => {
    if (locating) return
    setLocating(true)
    try {
      const r = await window.tachi.app.chooseAppRepo()
      // The keeper effect above picks the new path up and binds the session.
      if (r.ok) setAppRepo({ status: 'ready', path: r.path, source: 'setting' })
      else if (!r.cancelled) setAppRepo({ status: 'missing', error: r.error })
    } catch (err) {
      setAppRepo({ status: 'missing', error: err instanceof Error ? err.message : String(err) })
    } finally {
      setLocating(false)
    }
  }, [locating])

  // Continue a past session: restore its transcript + workspace into the live
  // (editable) area, then start a fresh harness session in that workspace —
  // same start-session dance as activateFolder, so the composer is enabled and
  // the next message runs. (resumeArchive cleared viewingArchiveId + sessionId.)
  const resumeSession = async (id: string) => {
    resumeArchive(id)
    const st = useAgentStore.getState()
    if (!st.workingDir) return  // archived session had no workspace — nothing to start
    firstTaskRoutedRef.current = false
    try {
      setStatus('starting')
      // TACHIAPP archives always restart on the first-party harness, whatever
      // the Code tab's persisted preference happens to be right now.
      const sessionHarness = appMode ? 'tachi' : normalizeHarness(st.harness)
      const { sessionId: sid } = await window.tachi.agent.startSession(
        st.workingDir,
        sessionHarness,
        st.provider,
        st.bankrModel,
        st.surplusModel,
        false,
        st.veniceModel,
        st.imgnaiModel,
      )
      setSession(sid)
      setStatus('idle')
    } catch (err) {
      setStatus('error', err instanceof Error ? err.message : String(err))
    }
  }

  // ── Drag-and-drop folder ──────────────────────────────────────────────────
  // Disabled entirely in TACHIAPP: dropping a folder there would silently
  // repoint the self-improvement chat at someone else's code.
  const onDragOver = (e: React.DragEvent) => {
    if (appMode) return
    e.preventDefault()
    e.stopPropagation()
    // Only accept folders (items with kind 'file' and webkitRelativePath empty is folder in electron)
    setDragOver(true)
  }
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
  }
  const onDrop = async (e: React.DragEvent) => {
    if (appMode) return
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    // Electron exposes the real file path via the File object's path property
    const items = Array.from(e.dataTransfer.files)
    if (items.length === 0) return
    const f = items[0] as File & { path?: string }
    const droppedPath = f.path
    if (!droppedPath) return
    await activateFolder(droppedPath)
  }

  // ── Workflow mode: run the bound saved Nodes graph in the Code log ──────────
  //
  // Loads the saved flow JSON, compiles + runs it via the same graph:run IPC the
  // Nodes "Chat with flow" panel uses, and renders the result (per-agent for a
  // roundtable, or the single final answer) into the existing message log. Live
  // node activity streams in as a "running: <node>" hint via graph:node-active.
  const runActiveWorkflow = useCallback(async (message: string) => {
    if (!activeWorkflow) return
    appendEvent({ type: 'user-text', text: message } as AgentEvent)
    setStatus('running')

    let offNodeActive: (() => void) | null = null
    try {
      const loaded = await window.tachi.nodes.loadFlow(activeWorkflow.filename)
      if (!loaded.ok || !loaded.json) {
        throw new Error(loaded.error || 'Could not load the saved workflow file.')
      }
      const flow = JSON.parse(loaded.json) as {
        name?: string
        nodes?: Array<{ id: string; data?: { label?: string } }>
        edges?: unknown[]
      }
      // nodeId → label, for the live "running: X" hint.
      const labelById = new Map<string, string>()
      for (const n of flow.nodes ?? []) labelById.set(n.id, n.data?.label || n.id)
      offNodeActive = window.tachi.nodes.onNodeActive(({ nodeId }) => {
        setWfNodeLabel(nodeId ? (labelById.get(nodeId) ?? nodeId) : null)
      })

      const res = await window.tachi.nodes.runGraph(flow, message)
      if (!res.ok) throw new Error(res.error)

      // Drop any internal 'system' note agent; for a multi-agent roundtable show
      // each contribution (the final-marked agent is already the last one), else
      // just the single final answer.
      const experts = res.results.filter(r => r.agent !== 'system')
      const body = experts.length > 1
        ? experts.map(r => `■ ${r.agent}\n${r.text}`).join('\n\n')
        : (res.final || experts[0]?.text || '(no output)')
      appendEvent({ type: 'text', text: `▸ ${activeWorkflow.name}\n\n${body}` } as AgentEvent)
      appendEvent({ type: 'done' } as AgentEvent)
    } catch (err) {
      appendEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) } as AgentEvent)
    } finally {
      if (offNodeActive) offNodeActive()
      setWfNodeLabel(null)
    }
  }, [activeWorkflow, appendEvent, setStatus])

  // ── Slash commands (Code tab) ──────────────────────────────────────────────
  // Same registry as the Chat composer; the capabilities below point at the
  // harness's own machinery: F15 compaction, the AGENTS.md generator, the
  // per-provider model store, the cost ledger, the memory-fact store, and the
  // TACHI loop's deep_research tool. The four structured verbs (/plan /review
  // /troubleshoot /refactor) intentionally PASS THROUGH to the existing
  // parsedCommand path so their plan cards keep working.
  const [slashOpen, setSlashOpen]     = useState(false)
  const [slashCursor, setSlashCursor] = useState(0)
  const [cmdNote, setCmdNote]         = useState<CommandNoteData | null>(null)

  const slashQuery = commandQueryFromText(task)
  const slashRows = useMemo(() => {
    if (slashQuery === null) return []
    return matchCommands(slashQuery.toLowerCase(), 'harness').map(c => ({
      insert: `/${c.id} `,
      item: {
        key:   `cmd-${c.id}`,
        label: `/${c.id}`,
        args:  c.argsKey ? tc(c.argsKey) : undefined,
        desc:  tc(c.descKey),
        group: tc('commands.groupCommands'),
      } satisfies CommandPopupItem,
    }))
  }, [slashQuery, tc])
  useEffect(() => {
    setSlashOpen(slashQuery !== null && slashRows.length > 0)
    setSlashCursor(0)
  }, [slashQuery, slashRows.length])

  const commandCaps: CommandCaps = useMemo(() => ({
    surface: 'harness',
    t: tc,
    compact: async () => {
      const total = useAgentStore.getState().messages.length
      const keepFrom = Math.max(0, total - 12)
      if (keepFrom <= compactedUpTo) return false
      setCompactedUpTo(keepFrom)
      return true
    },
    initProject: async () => {
      const dir = effectiveWorkingDir ?? workingDir
      if (!dir) return { ok: false, detail: t('composer.placeholderNoFolder') }
      const r = await window.tachi.agent.generateAgentsMd(dir)
      return r.ok ? { ok: true, detail: r.path } : { ok: false, detail: r.reason ?? '' }
    },
    describeModel: () => {
      const m = provider === 'bankr' ? bankrModel
        : provider === 'surplus' ? surplusModel
        : provider === 'venice' ? veniceModel
        : provider === 'imgnai' ? imgnaiModel
        : ''
      return m ? `${provider} · ${modelDisplayName(m)}` : provider
    },
    setModel: async (name: string) => {
      const raw = name.trim()
      if (!/^[\w.:@/-]+$/.test(raw)) return { ok: false }
      if (provider === 'bankr')        { setBankrModel(raw);   return { ok: true, label: `bankr · ${raw}` } }
      if (provider === 'surplus')      { setSurplusModel(raw); return { ok: true, label: `surplus · ${raw}` } }
      if (provider === 'venice')       { setVeniceModel(raw);  return { ok: true, label: `venice · ${raw}` } }
      if (provider === 'imgnai')       { setImgnaiModel(raw);  return { ok: true, label: `imgnai · ${raw}` } }
      // The remaining providers have no per-session model slot to write.
      return { ok: false }
    },
    // No modal picker here — the model dropdowns live in the ADVANCED drawer,
    // so "open the picker" means revealing that drawer.
    openModelPicker: () => {
      setAdvancedOpen(true)
      try { localStorage.setItem('tachi:code-advanced', '1') } catch { /* storage unavailable */ }
    },
    costSummary: () => window.tachi.cost.summary(),
    sessionSpend: () => (agentContextChars > 0
      ? tc('commands.cost.sessionTokens', { count: Math.ceil(agentContextChars / 4).toLocaleString() })
      : null),
    listFacts: () => window.tachi.memoryFacts.list(),
    addFact: async (factText: string) => Boolean(await window.tachi.memoryFacts.add(factText, 'user')),
    webSearch: async (query: string) => {
      // deep_research (TACHI loop) is Brave/Tavily-backed — no key, no search.
      const keys = await window.tachi.settings.listKeys().catch(() => [] as string[])
      if (!keys.includes('brave-search') && !keys.includes('tavily')) return { ok: false }
      void sendTask({
        text: `Use the deep_research tool to answer this from the live web, then summarize with source URLs: ${query}`,
      })
      return { ok: true }
    },
    // Loop mode is a TACHI-harness wrapper (runTachiSession → loop-controller);
    // TACHIAPP always runs TACHI, the Code tab only when it is selected. On any
    // other harness the directive would reach the agent as prose, so /loop says
    // so instead of pretending a loop started.
    loopSupported: () => appMode || harness === 'tachi',
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sendTask reads live store state; re-binding it here would loop.
  }), [
    tc, t, compactedUpTo, effectiveWorkingDir, workingDir, provider,
    bankrModel, surplusModel, veniceModel, imgnaiModel,
    setBankrModel, setSurplusModel, setVeniceModel, setImgnaiModel, agentContextChars,
    appMode, harness,
  ])

  const runSlashCommand = useCallback(async (parsed: ReturnType<typeof parseCommandInput>) => {
    if (parsed.kind === 'unknown') {
      setCmdNote({ kind: 'error', text: unknownCommandHint(parsed, commandCaps) })
      return
    }
    if (parsed.kind !== 'command' || !parsed.def) return
    try {
      const res = await parsed.def.run(parsed.args ?? '', commandCaps)
      if (res.kind === 'note')       setCmdNote({ kind: 'note',  text: res.text })
      else if (res.kind === 'error') setCmdNote({ kind: 'error', text: res.text })
      else                           setCmdNote(null)
    } catch (err) {
      setCmdNote({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }, [commandCaps])

  const pickSlashRow = (row: { insert: string }) => {
    setTask(row.insert)
    setSlashOpen(false)
  }

  const sendTask = async (override?: { text?: string }) => {
    // SURFACE OWNERSHIP: the other surface's run still holds the live session.
    // Sending now is exactly the bleed this guard exists for — the message would
    // land in THEIR session, THEIR workspace, with THEIR transcript as history.
    if (surfaceBlocked) return
    const composedTask = (override?.text ?? task).trim()

    // Slash interception — before ANY send path (workflow or harness). A
    // passthrough verb (/plan /review /troubleshoot /refactor) falls through to
    // the existing parsedCommand machinery below; an unknown /command never
    // reaches the model. `//literal` unwraps to one leading slash.
    const commandParse = override
      ? null
      : parseCommandInput(composedTask, 'harness')
    if (commandParse && commandParse.kind === 'unknown') {
      setSlashOpen(false)
      void runSlashCommand(commandParse)
      return
    }
    if (commandParse && commandParse.kind === 'command' && commandParse.def) {
      const def = commandParse.def
      let res: CommandResult
      try {
        res = await def.run(commandParse.args ?? '', commandCaps)
      } catch (err) {
        setSlashOpen(false)
        setTask('')
        setCmdNote({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
        return
      }
      if (res.kind !== 'passthrough') {
        setSlashOpen(false)
        setTask('')
        if (res.kind === 'note')       setCmdNote({ kind: 'note',  text: res.text })
        else if (res.kind === 'error') setCmdNote({ kind: 'error', text: res.text })
        else                           setCmdNote(null)
        return
      }
      setSlashOpen(false)
    }
    const literalTask = commandParse?.kind === 'text' ? (commandParse.text ?? composedTask) : composedTask
    // `//review …` must reach the agent as literal text, NOT as the structured
    // /review verb — so an escaped message skips the F1 parser below.
    const wasEscaped = commandParse?.kind === 'text' && commandParse.text !== composedTask

    // Workflow mode: run the bound saved graph instead of a harness session.
    // (Parallel grid mode takes precedence — workflows are single-session.)
    if (workflowMode && !parallelGridMode) {
      if (!literalTask || isRunning) return
      const message = literalTask
      setTask('')
      setAttachments([])
      await runActiveWorkflow(message)
      return
    }
    const hasContent = literalTask || attachments.length > 0
    // Routing target was computed at component scope (effectiveSessionId /
    // effectiveWorkingDir) so the disabled / placeholder logic below can use
    // the same source of truth. Only the taskId is local — only sendTask uses it.
    const effectiveTaskId = parallelGridMode ? focusedTask?.id ?? null : null
    if (!hasContent || isRunning) return
    // "+ NEW" DEAD END: no live session, but a workspace the operator already
    // chose — spawn one now instead of refusing to send (same rule the button
    // renders from). On failure the status carries the error and the composer
    // keeps the text, so the run is retryable without retyping.
    let liveSessionId = effectiveSessionId
    if (!liveSessionId) {
      if (gate !== 'start-then-send' || !effectiveWorkingDir) return
      liveSessionId = await startSessionForWorkspace(effectiveWorkingDir)
      if (!liveSessionId) return
    }
    const rawMsg = literalTask

    // F1: Parse leading slash command before building the prompt.
    // parseSlashCommand returns null for free-prose input — behaviour unchanged.
    const parsed: ParsedSlashCommand | null = wasEscaped ? null : parseSlashCommand(rawMsg)

    // `/loop [n] <goal>` is parsed in the MAIN process off the RAW task text
    // (loop-controller.parseLoopDirective, which only looks past the known
    // <workspace-memory>/<reflexion>/<role> preamble). Any prefix we prepend
    // here would hide the directive and the loop would silently never start —
    // so loop mode wins over the plan/fusion framing.
    const isLoopDirective = commandParse?.kind === 'command' && commandParse.def?.id === 'loop'

    // C2: prepend a mode instruction so the agent knows whether to plan or build.
    // When a recognised slash command is detected we let the system-prompt
    // injection (F2) handle framing; the legacy plan-mode prefix is skipped.
    const modePrefix = !parsed && !isLoopDirective && mode === 'plan'
      ? '[PLAN MODE] Before making any changes, outline your approach step by step and ask for confirmation.\n\nTask: '
      : ''
    // Fusion-at-plan directive — only when the FUSION toggle is ON and the
    // provider exposes the panel tools (bankr/surplus/venice). Nudges the agent
    // to consult the model panel and synthesize its plan before executing; the
    // resulting fusion-panel events render as the FusionPanelStrip in the log.
    const fusionEligible = provider === 'bankr' || provider === 'surplus' || provider === 'venice'
    const fusionPrefix = fusionPlan && fusionEligible && !parsed && !isLoopDirective
      ? '[FUSION] Before presenting your plan or making changes, call the fuse_plan tool with a brief (the task + what you have learned so far) and base your plan on its synthesis. Use consult_panel for any hard trade-off.\n\n'
      : ''
    // D6: the thinking-depth directive (THINK/ULTRA) is now applied SERVER-SIDE
    // in the TACHI harness (runTachiLoop), so it works from ANY entry point — not
    // only this renderer. We pass the store `depth` value through the agent.send
    // IPC (trailing arg) instead of prepending a prefix here, which would
    // otherwise double-apply the directive.
    // Inline attachments after the user text (the sidecar harnesses expect a string
    // prompt today; binary uploads need a server-side change we haven't
    // shipped). Small text files get their contents inlined under a fenced
    // block; images / binaries get a marker the LLM can choose to act on.
    const attachmentBlock = attachments.length === 0
      ? ''
      : '\n\n' + attachments.map(a =>
          a.kind === 'text'
            ? `\n----- ${a.name} (inlined) -----\n${a.preview}\n----- end ${a.name} -----\n`
            : `\n[attachment: ${a.name} — ${a.preview}]\n`,
        ).join('\n')
    const msg = fusionPrefix + modePrefix + rawMsg + attachmentBlock
    // Image attachments → REAL vision input (data URLs) for the TACHI harness with a
    // vision-capable model; non-TACHI harnesses ignore them (they still get the text marker).
    const imageUrls = attachments.filter(a => a.kind === 'image' && a.dataUrl).map(a => a.dataUrl as string)
    setTask('')
    setAttachments([])
    // Echo the user's message into the log so they can see what they sent.
    // F1: attach parsedCommand so PairedMessageList can render a card placeholder
    // immediately (EventRow's 'user-text' branch reads it — wired in F3/F4).
    const userTextEvent: AgentEvent = parsed
      ? { type: 'user-text', text: rawMsg + (attachments.length ? `  (+${attachments.length} attachment${attachments.length > 1 ? 's' : ''})` : ''), parsedCommand: parsed }
      : { type: 'user-text', text: rawMsg + (attachments.length ? `  (+${attachments.length} attachment${attachments.length > 1 ? 's' : ''})` : '') }
    // Conversation continuity: replay prior turns so the harness remembers
    // context across messages (the TACHI loop is single-shot per send otherwise).
    // Built from the store BEFORE echoing this message, so it excludes it.
    const allMsgs = useAgentStore.getState().messages
    const history = buildAgentHistory(allMsgs.slice(compactedUpTo).map(m => m.event))
    if (compactedUpTo > 0) {
      history.unshift({
        role: 'user',
        content: `[Context compacted by the user: ${compactedUpTo} earlier events were dropped from this request. Call expand_compacted if you need the full earlier conversation.]`,
      })
    }
    // PROVENANCE — park BEFORE the first append, so the user's own echo and
    // every event the run produces carry the identity this send was dispatched
    // with. After this line the badge is a recorded fact; changing the picker
    // affects the NEXT send and nothing already on screen.
    const originModel = originModelFor(provider, {
      bankr: bankrModel, surplus: surplusModel, venice: veniceModel, imgnai: imgnaiModel,
      defaultRoute: defaultRoute?.modelId,
    })
    setRunOrigin({ harness, provider, ...(originModel ? { model: originModel } : {}) })
    appendEvent(userTextEvent)
    setStatus('running')

    // Surplus smart router — code FIRST-TASK routing. Classify THIS task and, if it
    // routes to a different model than the session spawned on, re-start the session
    // on the routed model. Only the FIRST task re-routes; later tasks keep the model
    // for agentic coherence. Single-session path only (skips parallel grid).
    let sendSessionId = liveSessionId
    if (!parallelGridMode && (provider === 'surplus' || provider === 'bankr') && surplusSmartRouting && !firstTaskRoutedRef.current) {
      firstTaskRoutedRef.current = true
      try {
        const r = await window.tachi.agent.routeModel(rawMsg, provider)
        const currentModel = provider === 'bankr' ? bankrModel : surplusModel
        if (r?.ok && r.model && r.model !== currentModel) {
          const sessionHarness = normalizeHarness(harness)
          // Re-spawn the session on the difficulty-matched model. The routed id
          // goes in the slot start-session reads for this provider; smart-routing
          // flag stays false so the restart doesn't re-route again.
          if (provider === 'bankr') {
            setBankrModel(r.model)
            const started = await window.tachi.agent.startSession(
              effectiveWorkingDir ?? '', sessionHarness, 'bankr', r.model, surplusModel, false,
            )
            if (started?.sessionId) { setSession(started.sessionId); sendSessionId = started.sessionId }
          } else {
            setSurplusModel(r.model)
            const started = await window.tachi.agent.startSession(
              effectiveWorkingDir ?? '', sessionHarness, 'surplus', bankrModel, r.model, false,
            )
            if (started?.sessionId) { setSession(started.sessionId); sendSessionId = started.sessionId }
          }
        }
      } catch { /* keep the current session/model on any routing failure */ }
    }

    // "@codex <task>" routes THIS message straight to the Codex worker (same
    // session → same Codex conversation thread) — the "separate chat" without
    // a separate surface: one composer, one transcript, per-message routing.
    const codexDirect = /^@codex\s+/i.test(msg)
    const effectiveMsg = codexDirect ? msg.replace(/^@codex\s+/i, '') : msg
    // TACHIAPP always runs the first-party TACHI harness (runTachiSession) —
    // the harness that knows this repo — without touching the Code tab's own
    // persisted harness preference.
    const effectiveHarness = codexDirect ? 'codex' : appMode ? 'tachi' : harness

    // F1: pass parsedCommand to main process so agent.ipc.ts can forward it
    // through to tool-loop / chat-service (picked up by F2 for system-prompt injection).
    // parallel-code: when a parallel task is focused, route through its taskId
    // so main updates the per-task abort controller + parallel-agent manager
    // status, leaving any other live tasks running.
    await window.tachi.agent.send(
      sendSessionId,
      effectiveMsg,
      effectiveHarness,
      effectiveWorkingDir ?? '',
      parsed ?? undefined,
      effectiveTaskId ?? undefined,
      roleId || undefined,
      mode,
      depth,
      history,
      imageUrls.length ? imageUrls : undefined,
      trust,
    ).catch(() => {
      // errors arrive as agent:event { type: 'error' } — store handles them
    })
  }

  // GAVE-UP DETECTION: the CONTINUE affordance on the ENDED-INCOMPLETE badge.
  // It is a normal send into the SAME session (same history replay, same
  // harness, same workspace) — so continuing costs the user one click and the
  // agent keeps everything it already learned. Ignored while a run is live or
  // while an archive is being viewed; the badge disables the button there too,
  // but the guard is the real boundary (the event is global).
  // sendTask closes over live render state, and this page re-renders on every
  // streamed token — so the listener is registered ONCE and reads the current
  // sendTask through a ref instead of being re-bound thousands of times.
  const sendTaskRef = useRef(sendTask)
  sendTaskRef.current = sendTask
  useEffect(() => {
    const onContinue = (): void => {
      const st = useAgentStore.getState()
      if (st.status === 'running' || st.status === 'starting' || st.viewingArchiveId) return
      void sendTaskRef.current({ text: t('incomplete.continueMessage', {
        defaultValue: 'Continue the task. If it is already complete, call the completion tool with a summary of what you changed and how you verified it; if you cannot proceed, say exactly why.',
      }) })
    }
    window.addEventListener('tachi:agent-continue', onContinue)
    return () => window.removeEventListener('tachi:agent-continue', onContinue)
  }, [t])

  const abort = () => {
    // parallel-code: scope the abort to the focused task when in grid mode.
    if (parallelGridMode && focusedTask) {
      window.tachi.agent.abort(focusedTask.id).catch(() => {})
    } else {
      window.tachi.agent.abort().catch(() => {})
    }
    // STOP means "I want to intervene" — auto-firing the queued follow-ups is
    // the exact opposite. Latch the pause; the chip row grows a RESUME button so
    // nothing is lost, it just stops being automatic. (Belt AND braces: STOP
    // leaves the status at 'idle', which `shouldDrainPrompt` also refuses.)
    if (promptQueue.length > 0) setPromptQueuePaused(promptSurface, true)
    setStatus('idle')
  }

  // ── FOLLOW-UP QUEUE: enqueue while running, drain at `done` ────────────────
  //
  // The COMPOSER submit decision. While a run is in flight Enter queues instead
  // of doing nothing; otherwise it sends exactly as before. Text only —
  // attachments stay in the composer (the chip tooltip says so), because a
  // queued follow-up inherits whatever is in force WHEN IT DRAINS and pretending
  // otherwise about a file the operator dropped an hour earlier is worse than
  // not queueing it.
  const submitComposer = () => {
    if (isRunning && !surfaceBlocked && !isViewingArchive && !workflowMode) {
      const text = normalizePromptText(task)
      if (!text) return
      if (queuePrompt(promptSurface, text)) {
        setTask('')
        setCmdNote(null)
      } else {
        // REFUSED, not silently dropped: a cap that discards the oldest entry
        // loses an instruction the operator watched go in.
        setCmdNote({ kind: 'error', text: t('queue.full', {
          cap: PROMPT_QUEUE_CAP,
          defaultValue: 'Queue is full ({{cap}}) — remove one of the queued messages first.',
        }) })
      }
      return
    }
    void sendTask()
  }

  // THE DRAIN. Declarative on purpose: an effect over (status, queue) also
  // recovers the case where the operator was on ANOTHER TAB when the run
  // finished — this page remounts, sees a terminal `done` with a non-empty
  // queue, and fires. An imperative "on done" callback inside the event path
  // would have needed the page mounted at that instant, which is the same
  // route-lifetime assumption that cost us the dropped-events bug.
  //
  // ONE entry per terminal `done`: `takeQueuedPrompt` removes as it reads and
  // `drainingRef` blocks a re-entry while the send is being dispatched (the send
  // sets status → 'running' before it awaits IPC, so the guard only has to cover
  // that window).
  const drainingRef = useRef(false)
  const canSendNow = gate !== 'blocked'
  useEffect(() => {
    if (!shouldDrainPrompt({
      status,
      queueLength:    promptQueue.length,
      paused:         promptPaused,
      viewingArchive: isViewingArchive,
      surfaceBlocked,
      workflowMode,
      draining:       drainingRef.current,
      canSend:        canSendNow,
    })) return
    drainingRef.current = true
    const next = takeQueuedPrompt(promptSurface)
    if (!next) { drainingRef.current = false; return }
    // NEVER SILENTLY EAT THE WORDS. The prompt is taken BEFORE the send (so a
    // re-entry cannot send it twice), which means a send that bails out — a
    // failed session spawn, a gate that closed between the check and the call —
    // would otherwise destroy it. `sendTask` echoes the user turn into the
    // transcript on every path that actually dispatches, so an unchanged
    // message count is a reliable "nothing went out": put the text back in the
    // composer, where the operator can see and retry it.
    const beforeCount = useAgentStore.getState().messages.length
    void Promise.resolve(sendTaskRef.current({ text: next.text }))
      .then(() => {
        if (useAgentStore.getState().messages.length === beforeCount) {
          setTask(prev => (prev.trim() ? prev : next.text))
        }
      })
      .finally(() => { drainingRef.current = false })
  }, [status, promptQueue, promptPaused, isViewingArchive, surfaceBlocked, workflowMode,
      canSendNow, promptSurface, takeQueuedPrompt])

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Slash autocomplete navigation — shared state machine (commands/popup-nav).
    if (slashOpen && slashRows.length > 0) {
      const nav = navigatePopup(e.key, slashCursor, slashRows.length, { shiftKey: e.shiftKey })
      if (nav.preventDefault) e.preventDefault()
      if (nav.action === 'move')   { setSlashCursor(nav.cursor); return }
      if (nav.action === 'close')  { setSlashOpen(false); return }
      if (nav.action === 'select') { pickSlashRow(slashRows[nav.cursor]); return }
    }
    // Enter SENDS when idle and QUEUES while a run is in flight (submitComposer
    // owns that decision) — it is never a no-op any more.
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitComposer() }
  }

  const agentLabel = appMode ? 'TACHI' : (HARNESS_LABELS[harness] ?? harness)

  // LANE E — "the run is alive but nothing is landing on screen". Memoized on
  // the LAST message only (not the whole array's contents) so a growing text
  // block re-derives cheaply while streaming. Rules live in waitingState.ts.
  const lastEvent = messages.length > 0 ? messages[messages.length - 1].event : null
  // `isViewingArchive` counts as blocked: an archive snapshotted mid-run keeps
  // its 'running' status, and a frozen transcript must never claim to be live.
  const transcriptWaiting = useMemo(() => isTranscriptWaiting({
    status,
    tail: transcriptTail(lastEvent),
    blocked: surfaceBlocked || isViewingArchive,
    awaitingPermission: Boolean(pendingPermission),
  }), [status, lastEvent, surfaceBlocked, isViewingArchive, pendingPermission])

  // Example chips for the first-run hero — one per thing people actually open
  // this surface for. Clicking loads the composer (never auto-sends).
  const appModeChips = [
    { key: 'feature', label: t('appMode.chips.featureLabel'), prompt: t('appMode.chips.featurePrompt') },
    { key: 'bug',     label: t('appMode.chips.bugLabel'),     prompt: t('appMode.chips.bugPrompt') },
    { key: 'explain', label: t('appMode.chips.explainLabel'), prompt: t('appMode.chips.explainPrompt') },
  ]

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <AgentHistory
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onContinue={resumeSession}
        tag={appMode ? 'tachiapp' : undefined}
      />
      <div
        style={{
          display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0,
          background: isDragOver ? 'var(--accent-muted)' : 'var(--bg-base)',
          color: 'var(--text-primary)',
          outline: isDragOver ? '3px dashed var(--accent)' : 'none',
          outlineOffset: '-3px',
          transition: 'background 0.15s, outline 0.15s',
        }}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
      {/* ── Drag overlay hint ── */}
      {isDragOver && <DropZone />}

      {/* ── Header ── */}
      <div data-tour="code-controls" style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 16px', borderBottom: 'var(--border-width) solid var(--border)',
        background: 'var(--bg-surface)', flexShrink: 0, flexWrap: 'wrap',
      }}>
        {appMode && (
          <span
            style={{
              padding: '4px 10px', border: '2px solid var(--accent)', background: 'var(--accent)',
              color: '#ffffff', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
              letterSpacing: '0.08em', textTransform: 'uppercase', flexShrink: 0,
            }}
          >{t('appMode.title')}</span>
        )}
        {!appMode && (
          <button
            onClick={() => setTourOpen(true)}
            title={t('header.howToTooltip')}
            style={{
              padding: '4px 10px', border: '2px solid var(--accent)', background: 'var(--accent)',
              color: '#ffffff', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
              letterSpacing: '0.06em', cursor: 'pointer', textTransform: 'uppercase',
            }}
          >{t('header.howTo')}</button>
        )}
        {!appMode && (
          <button
            onClick={() => { useUIStore.getState().setSidebarTab('studio'); navigate('/nodes') }}
            title={t('header.buildWorkflowTooltip')}
            style={{
              padding: '4px 10px', border: '2px solid var(--border)', background: 'var(--bg-elevated)',
              color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
              letterSpacing: '0.06em', cursor: 'pointer', textTransform: 'uppercase',
            }}
          >{t('header.buildWorkflow')}</button>
        )}
        {!historyOpen && (
          <button
            onClick={() => setHistoryOpen(true)}
            title={t('header.showSessionsTooltip')}
            aria-label={t('header.showSessionsTooltip')}
            style={{
              padding: '4px 10px',
              border: '2px solid var(--border)',
              background: 'var(--bg-elevated)',
              color: 'var(--text-muted)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.06em',
              cursor: 'pointer',
              textTransform: 'uppercase',
            }}
          >☰ {t('header.sessions')}</button>
        )}
        {/* One-click revert of the agent's file changes (git-backed checkpoint).
            Shown once the agent has snapshotted, and only when it isn't running. */}
        {revertCp && !isRunning && (
          <button
            data-testid="revert-agent-changes"
            onClick={revertAgentChanges}
            disabled={reverting}
            title={t('checkpoint.revertTooltip')}
            style={{
              padding: '4px 10px',
              border: '2px solid var(--danger)',
              background: 'var(--bg-elevated)',
              color: 'var(--danger)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.06em',
              cursor: 'pointer',
              textTransform: 'uppercase',
            }}
          >{reverting ? '…' : `↺ ${t('checkpoint.revert')}`}</button>
        )}
        {/* TACHIAPP: the workspace is resolved, not chosen — a read-only chip
            replaces the folder picker so there is no path back to a dialog. */}
        {appMode ? (
          <span
            data-testid="tachiapp-source"
            title={appRepo.status === 'ready'
              ? t('appMode.sourceTooltip', { path: appRepo.path, source: appRepo.source })
              : t('appMode.locate.resolving')}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '5px 10px', flex: 1, minWidth: 0,
              border: 'var(--border-width) solid var(--border)', background: 'var(--bg-inset)',
              fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--text-muted)',
            }}
          >
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text-dim)' }}>
              {t('appMode.sourceLabel')}
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)' }}>
              {appRepo.status === 'ready' ? appRepo.path : t('appMode.locate.resolving')}
            </span>
          </span>
        ) : (
          <button
            data-tour="code-folder"
            onClick={pickFolder}
            disabled={workflowMode}
            title={workflowMode
              ? t('header.folderTooltipWorkflow')
              : t('header.folderTooltip')}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 12px',
              border: 'var(--border-width) solid var(--border)', background: 'var(--bg-elevated)',
              color: 'var(--text-primary)', fontSize: 13,
              cursor: workflowMode ? 'default' : 'pointer',
              opacity: workflowMode ? 0.5 : 1,
            }}
          >
            {workingDir
              ? <span style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {workingDir.split(/[\\/]/).pop()}
                </span>
              : t('header.chooseFolder')}
          </button>
        )}

        {workingDir && !appMode && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {workingDir}
          </span>
        )}

        {/* GAVE-UP DETECTION: a run the harness classified ENDED-INCOMPLETE must
            not wear the success badge — the whole point is that "stop" was not
            "finished". Same slot, amber, with the CONTINUE affordance. */}
        <StatusBadge status={runIncomplete ? 'incomplete' : status} />
        {runIncomplete && (
          <IncompleteBadge
            detail={endedIncomplete?.detail}
            nudged={endedIncomplete?.nudged}
            disabled={isRunning || !effectiveSessionId}
          />
        )}
        {/* CONNECTION RESILIENCE: sits with the run status, so a dropped stream
            reads as "reconnecting", never as "frozen". Self-clearing. */}
        <ReconnectBanner />
        {/* LOOP MODE: same slot — "which cycle am I on, and how do I stop it"
            belongs next to the run status. Self-clearing. */}
        <LoopChip />
        <ContextMeter
          chars={agentContextChars}
          providerId={agentCtxProviderId}
          modelId={agentCtxModelId}
          breakdown={[{ label: compactedUpTo > 0 ? 'HISTORY (COMPACTED)' : 'HISTORY', chars: agentContextChars }]}
          note="Plus the system prompt + tool definitions (added server-side, not counted here)."
          onCompact={() => {
            // Keep roughly the last 6 turns (12 events) verbatim.
            const keepFrom = Math.max(0, messages.length - 12)
            if (keepFrom <= compactedUpTo) return
            setCompactedUpTo(keepFrom)
          }}
          compactDisabled={isRunning || messages.length - compactedUpTo <= 12}
        />
        <ModeToggle value={mode} onChange={setMode} disabled={isRunning || workflowMode} />
        <TrustToggle value={trust} onChange={setTrust} disabled={isRunning || workflowMode} />
        {/* TACHIAPP is "provider + model, nothing else" — so the gateway
            selector is promoted out of the ADVANCED drawer into the header,
            right next to the model picker it drives. */}
        {appMode && (
          <AgentProviderSelector value={provider} onChange={setProvider} disabled={isRunning} />
        )}
        {provider === 'bankr' && !workflowMode && (
          <BankrModelPicker
            value={bankrModel}
            disabled={isRunning || surplusSmartRouting}
            onChange={setBankrModel}
          />
        )}
        {provider === 'surplus' && !workflowMode && (
          <SurplusModelPicker
            value={surplusModel}
            disabled={isRunning || surplusSmartRouting}
            onChange={setSurplusModel}
          />
        )}
        {provider === 'venice' && !workflowMode && (
          <VeniceModelPicker
            value={veniceModel}
            disabled={isRunning}
            onChange={setVeniceModel}
          />
        )}
        {provider === 'imgnai' && !workflowMode && (
          <ImgnaiModelPicker
            value={imgnaiModel}
            disabled={isRunning}
            onChange={setImgnaiModel}
          />
        )}
        {/* Collapsed-state summary of everything hidden in ADVANCED — one
            chip of truth (UX #2). Click = open the drawer it summarizes. */}
        {!advancedOpen && (
          <button
            onClick={toggleAdvanced}
            title={t('advanced.summaryTooltip', { defaultValue: 'Current route — click to open ADVANCED' })}
            style={{
              padding: '3px 8px', border: 'var(--border-width) solid var(--border)',
              background: 'var(--bg-elevated)', color: 'var(--text-muted)',
              fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
              letterSpacing: '0.04em', cursor: 'pointer', whiteSpace: 'nowrap',
              maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis',
            }}
          >[{advSummary}]</button>
        )}
        <button
          onClick={toggleAdvanced}
          aria-expanded={advancedOpen}
          title={t('advanced.toggleTooltip', { defaultValue: 'Agent, provider, thinking, fusion, roles, workflow — the full cockpit' })}
          style={{
            padding: '3px 10px', border: 'var(--border-width) solid var(--border)',
            background: advancedOpen ? 'var(--accent)' : 'var(--bg-inset)',
            color: advancedOpen ? 'var(--bg-base)' : 'var(--text-muted)',
            fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
            letterSpacing: '0.06em', cursor: 'pointer', textTransform: 'uppercase',
          }}
        >{advancedOpen ? '▾' : '▸'} {t('advanced.label', { defaultValue: 'Advanced' })}</button>
      </div>

      {/* ── ADVANCED drawer ── the second-tier controls, grouped with the
          legend's own words (Thinking / Agent / Provider / Workflow) so the
          tour, the legend and the drawer teach one vocabulary. */}
      {advancedOpen && (
        <div data-testid="advanced-drawer" style={{
          display: 'flex', alignItems: 'center', gap: 10, rowGap: 8,
          padding: '8px 16px', borderBottom: 'var(--border-width) solid var(--border)',
          background: 'var(--bg-inset)', flexShrink: 0, flexWrap: 'wrap',
        }}>
          <span style={advGroupLabelStyle}>{t('legend.thinkingLabel')}</span>
          <DepthToggle value={depth} onChange={setDepth} disabled={isRunning || workflowMode} />
          <span style={advGroupLabelStyle}>{t('legend.engineLabel')}</span>
          <CodexWorkerChip disabled={isRunning || workflowMode} />
          {/* TACHIAPP pins the engine to TACHI (see effectiveHarness) — showing
              a selector that does nothing would be a lie, so it is hidden. */}
          {!appMode && (
            <HarnessSelector value={harness} onChange={setHarness} disabled={isRunning || workflowMode} />
          )}
        {roles.length > 0 && (
            <select
              value={roleId}
              onChange={e => setRoleId(e.target.value)}
              disabled={isRunning || workflowMode}
              title="Agent role — primes a persona + enforces the role's tool/path boundaries"
              style={{
                background: 'var(--bg-inset)', border: 'var(--border-width) solid var(--border)',
                color: roleId ? 'var(--accent)' : 'var(--text-muted)',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 11, padding: '2px 6px', borderRadius: 0,
              }}
            >
              <option value="">role: none</option>
              {roles.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          )}
          <span style={advGroupLabelStyle}>{t('legend.gatewayLabel')}</span>
          {/* In TACHIAPP this selector already sits in the header. */}
          {!appMode && (
            <AgentProviderSelector value={provider} onChange={setProvider} disabled={isRunning || workflowMode} />
          )}
        {(provider === 'surplus' || provider === 'bankr') && !workflowMode && (
            <button
              onClick={() => setSurplusSmartRouting(!surplusSmartRouting)}
              disabled={isRunning}
              title={surplusSmartRouting
                ? t('smartRouting.onTooltip')
                : t('smartRouting.offTooltip')}
              style={{
                height: 28, padding: '0 10px', border: '2px solid var(--border)',
                background: surplusSmartRouting ? 'var(--accent)' : 'var(--bg-inset)',
                color: surplusSmartRouting ? 'var(--bg-base)' : 'var(--text-muted)',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700,
                letterSpacing: '0.06em', cursor: isRunning ? 'default' : 'pointer', whiteSpace: 'nowrap',
              }}
            >{surplusSmartRouting ? t('smartRouting.on') : t('smartRouting.off')}</button>
          )}
        {/* Fusion-at-plan toggle — only for providers where the harness exposes
           *  the fuse_plan / consult_panel advisor tools (bankr/surplus/venice).
           *  ON nudges the agent to consult the model panel before planning. */}
          {(provider === 'bankr' || provider === 'surplus' || provider === 'venice') && (
            <button
              onClick={() => setFusionPlan(!fusionPlan)}
              disabled={isRunning || workflowMode}
              title={fusionPlan ? t('fusion.titleOn') : t('fusion.titleOff')}
              style={{
                padding: '3px 10px',
                border: 'var(--border-width) solid var(--border)',
                background: fusionPlan ? 'var(--accent)' : 'var(--bg-inset)',
                color: fusionPlan ? 'var(--bg-base)' : 'var(--text-muted)',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700,
                letterSpacing: '0.06em', textTransform: 'uppercase',
                cursor: (isRunning || workflowMode) ? 'default' : 'pointer',
                opacity: (isRunning || workflowMode) ? 0.5 : 1,
              }}
            >⑂ {fusionPlan ? t('fusion.on') : t('fusion.label')}</button>
          )}
          {/* Workflow binding is a Code-tab feature: TACHIAPP is one pinned
              harness session, never a saved graph. */}
          {!appMode && <span style={advGroupLabelStyle}>{t('advanced.workflowLabel', { defaultValue: 'Workflow' })}</span>}
          {!appMode && <WorkflowSelector value={activeWorkflow} onChange={setActiveWorkflow} disabled={isRunning} />}
          <PlaybookIndicator workingDir={workingDir ?? null} />
        </div>
      )}

      {/* ── Active-workflow banner ── */}
      {workflowMode && activeWorkflow && (
        <div style={{
          padding: '6px 14px',
          borderBottom: '2px solid var(--accent)',
          background: 'var(--accent-muted)',
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          fontFamily: 'JetBrains Mono, monospace',
        }}>
          <span className={isRunning ? 'tachi-pulse-dot' : undefined} style={{
            width: 6, height: 6, background: 'var(--accent)', flexShrink: 0,
          }} />
          <span style={{ fontSize: 11, color: 'var(--text-primary)', letterSpacing: '0.04em' }}>
            {t('workflowBanner.prefix')} <strong>{activeWorkflow.name}</strong> {t('workflowBanner.suffix')}
          </span>
          {wfNodeLabel && (
            <span style={{
              fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
              padding: '2px 6px', border: '2px solid var(--accent)', color: 'var(--accent)',
            }}>
              {t('workflowBanner.running', { node: wfNodeLabel })}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button
            onClick={() => { useUIStore.getState().setSidebarTab('studio'); navigate('/nodes') }}
            title={t('workflowBanner.editTooltip')}
            style={{
              padding: '4px 10px', border: '2px solid var(--accent)', background: 'transparent',
              color: 'var(--accent)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
              fontWeight: 700, letterSpacing: '0.06em', cursor: 'pointer', textTransform: 'uppercase',
            }}
          >▸ {t('workflowBanner.edit')}</button>
          <button
            onClick={() => setActiveWorkflow(null)}
            title={t('workflowBanner.detachTooltip')}
            style={{
              padding: '4px 10px', border: '2px solid var(--border)', background: 'var(--bg-elevated)',
              color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
              fontWeight: 700, letterSpacing: '0.06em', cursor: 'pointer', textTransform: 'uppercase',
            }}
          >✕ {t('workflowBanner.detach')}</button>
        </div>
      )}

      {/* ── Viewing-archive banner ── */}
      {isViewingArchive && (
        <div style={{
          padding: '6px 14px',
          borderBottom: '2px solid var(--warning, #f59e0b)',
          background: 'var(--bg-inset)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontFamily: 'JetBrains Mono, monospace',
        }}>
          <span style={{
            width: 6, height: 6, background: 'var(--warning, #f59e0b)', flexShrink: 0,
          }} />
          <span style={{
            flex: 1,
            fontSize: 11,
            color: 'var(--text-primary)',
            letterSpacing: '0.04em',
          }}>
            {t('archiveBanner.text')}
          </span>
          <button
            onClick={() => closeArchive()}
            title={t('archiveBanner.backTooltip')}
            style={{
              padding: '4px 10px',
              border: '2px solid var(--accent)',
              background: 'var(--accent-muted)',
              color: 'var(--accent-text)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.06em',
              cursor: 'pointer',
              textTransform: 'uppercase',
            }}
          >↶ {t('archiveBanner.back')}</button>
        </div>
      )}

      {/* ── Body: workspace panel + log + preview ── */}
      {/* parallel-code: when any parallel task exists, replace the legacy
       *  single-session body with the ParallelTaskGrid. The InputBar in the
       *  footer below stays mounted — it now targets the focused tile's
       *  sessionId + workingDir via the effective* locals in sendTask(). */}
      {parallelGridMode ? (
        <ParallelTaskGrid defaultProjectRoot={workingDir} />
      ) : (
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* WorkspacePanel — left sidebar with full FolderTree + StateSection + RecentChanges.
         *  Renders as a 32px sliver when collapsed; full 280px when open.
         *  WorkspacePanel handles its own open/collapsed state internally.
         *  Hidden in TACHIAPP: the surface is a chat, not a file browser. */}
        {!appMode && (
          <WorkspacePanel
            workspaceDir={workingDir}
            onFileClick={handleFileClick}
            selectedPath={previewPath}
            onPanelPreview={setPanelPreviewPath}
            side="left"
          />
        )}

        {/* File preview pane */}
        {previewPath && (
          <div style={{
            width: previewPane.width, flexShrink: 0,
            borderRight: '2px solid var(--border)',
            background: 'var(--bg-surface)',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
            boxShadow: '4px 0 0 0 var(--border)',
          }}>
            {/* Preview header */}
            <div style={{
              padding: '6px 10px',
              borderBottom: '2px solid var(--border)',
              fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: '0.1em', color: 'var(--text-dim)',
              display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
            }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {previewPath.split(/[\\/]/).pop()}
              </span>
              {/* EDIT / SAVE — editable text/code only (not truncated >1 MB reads) */}
              {previewContent?.kind === 'text' && !previewContent.truncated && !previewEditing && (
                <button
                  onClick={() => setPreviewEditing(true)}
                  title="Edit this file"
                  style={{ background: 'var(--bg-elevated)', border: '2px solid var(--border)', cursor: 'pointer', color: 'var(--text-primary)', fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', padding: '2px 7px', fontFamily: 'JetBrains Mono, monospace' }}
                >
                  EDIT
                </button>
              )}
              {previewContent?.kind === 'text' && !previewContent.truncated && previewEditing && (
                <button
                  onClick={savePreviewFile}
                  disabled={!previewDirty || previewSaving}
                  title="Save changes to disk"
                  style={{ background: 'var(--bg-elevated)', border: '2px solid', borderColor: previewDirty ? 'var(--accent, var(--border))' : 'var(--border)', cursor: 'pointer', color: 'var(--text-primary)', fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', padding: '2px 7px', fontFamily: 'JetBrains Mono, monospace', opacity: !previewDirty || previewSaving ? 0.5 : 1 }}
                >
                  {previewSaving ? 'SAVING…' : previewDirty ? 'SAVE *' : 'SAVED'}
                </button>
              )}
              <button
                onClick={() => { setPreviewPath(null); setPreviewContent(null) }}
                title={t('filePreview.closeTooltip')}
                style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: 'var(--text-muted)', fontSize: 12, padding: '0 2px', lineHeight: 1,
                }}
              >
                ✕
              </button>
            </div>

            {/* Preview body */}
            <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
              {previewLoading && (
                <div style={{ padding: '12px', fontSize: 11, color: 'var(--text-muted)' }}>{t('filePreview.loading')}</div>
              )}
              {!previewLoading && previewContent && (
                <>
                  {previewContent.kind === 'text' && (
                    <>
                      {previewContent.truncated && (
                        <div style={{
                          padding: '4px 10px', fontSize: 9, flexShrink: 0,
                          background: 'color-mix(in srgb, var(--warning) 13%, transparent)', borderBottom: 'var(--border-width) solid var(--warning)',
                          color: 'var(--warning)',
                        }}>
                          {t('filePreview.truncated', { total: (previewContent.sizeBytes / 1024 / 1024).toFixed(1) })} — read-only
                        </div>
                      )}
                      <div style={{ flex: 1, minHeight: 0 }}>
                        <CodeEditor
                          key={previewPath}
                          defaultValue={previewContent.content ?? ''}
                          language={monacoLangFromPath(previewPath)}
                          readOnly={!previewEditing}
                          minimap={false}
                          onChange={(v) => { setPreviewDraft(v); setPreviewDirty(v !== previewSavedRef.current) }}
                        />
                      </div>
                    </>
                  )}
                  {previewContent.kind === 'image' && previewContent.content && (
                    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12, display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}>
                      <img
                        src={previewContent.content}
                        alt={previewPath.split(/[\\/]/).pop()}
                        style={{ maxWidth: '100%', border: '2px solid var(--border)', boxShadow: '4px 4px 0 var(--border)' }}
                      />
                    </div>
                  )}
                  {previewContent.kind === 'binary' && (
                    <div style={{ padding: '16px 12px', fontSize: 12, color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
                      {t('filePreview.binary', { bytes: previewContent.sizeBytes.toLocaleString() })}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
        {previewPath && <SplitHandle panel={previewPane} side="right" dataId="agent.preview" />}

        {/* ── Log ── */}
        <div
          ref={logRef}
          style={{
            flex: 1, overflowY: 'auto',
            padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: 6,
            alignItems: 'stretch',
          }}
        >
          {/* ── SURFACE BUSY ── the OTHER surface's run still owns the live
              session. We never yank a working session, so this one owns nothing
              yet: show what is happening instead of the foreign transcript. It
              clears itself the moment that run reaches a terminal state (the
              ownership effect re-decides and parks it onto its own rail). */}
          {surfaceBlocked && (
            <div data-testid="surface-busy-note" style={{
              maxWidth: 620, margin: '40px auto 0', padding: '12px 14px',
              border: '2px solid var(--warning)', background: 'var(--bg-elevated)',
              fontFamily: 'JetBrains Mono, monospace',
            }}>
              <div style={{
                fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                textTransform: 'uppercase', color: 'var(--warning)',
              }}>{t('surfaceBusy.title', { defaultValue: 'ANOTHER RUN IS IN PROGRESS' })}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, marginTop: 6 }}>
                {appMode
                  ? t('surfaceBusy.bodyCode', { defaultValue: "A CODE run is still working. This chat opens as soon as it finishes — that transcript parks onto the CODE tab's history rail and opens there automatically." })
                  : t('surfaceBusy.bodyApp', { defaultValue: "A TACHIAPP run is still working. This tab is free as soon as it finishes — that transcript parks onto the TACHIAPP chat's history rail and opens there automatically." })}
              </div>
            </div>
          )}

          {!surfaceBlocked && workflowMode && messages.length === 0 && (
            <div style={{ color: 'var(--text-muted)', fontSize: 14, marginTop: 40, textAlign: 'center' }}>
              <div>{t('logEmpty.workflowPrefix')} <strong style={{ color: 'var(--text-primary)' }}>{activeWorkflow?.name}</strong> {t('logEmpty.workflowSuffix')}</div>
              <div style={{ marginTop: 8, fontSize: 12 }}>
                {t('logEmpty.workflowHint')}
              </div>
            </div>
          )}

          {/* ── TACHIAPP first-run hero ── shown while the transcript is empty:
              what this surface is, plus three example prompts that load the
              composer (never auto-send). */}
          {appMode && !surfaceBlocked && messages.length === 0 && (
            <div data-testid="tachiapp-hero" style={{
              maxWidth: 620, margin: '40px auto 0', textAlign: 'left',
              fontFamily: 'JetBrains Mono, monospace',
            }}>
              <div style={{
                fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
                textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: 6,
              }}>{t('appMode.title')}</div>
              <div style={{ fontSize: 15, color: 'var(--text-primary)', lineHeight: 1.5 }}>
                {t('appMode.heroTitle')}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7, marginTop: 8 }}>
                {t('appMode.heroBody')}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 18 }}>
                {appModeChips.map(chip => (
                  <button
                    key={chip.key}
                    data-testid={`tachiapp-chip-${chip.key}`}
                    onClick={() => setTask(chip.prompt)}
                    style={{
                      textAlign: 'left', padding: '10px 12px', cursor: 'pointer',
                      border: '2px solid var(--border)', background: 'var(--bg-surface)',
                      boxShadow: 'var(--shadow-hard)', color: 'var(--text-primary)',
                      fontFamily: 'JetBrains Mono, monospace',
                    }}
                  >
                    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                      {chip.label}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.45 }}>
                      {chip.prompt}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── LOCATE APP SOURCE ── the ONE time TACHIAPP ever asks: every
              automatic resolution missed. The answer is stored forever. */}
          {appMode && !surfaceBlocked && appRepo.status === 'missing' && (
            <div data-testid="tachiapp-locate" style={{
              maxWidth: 620, margin: '18px auto 0', padding: '12px 14px',
              border: '2px solid var(--warning)', background: 'var(--bg-elevated)',
              fontFamily: 'JetBrains Mono, monospace',
            }}>
              <div style={{
                fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                textTransform: 'uppercase', color: 'var(--warning)',
              }}>{t('appMode.locate.title')}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, marginTop: 6 }}>
                {t('appMode.locate.body')}
              </div>
              {appRepo.error && (
                <div style={{ fontSize: 10, color: 'var(--danger)', marginTop: 6, wordBreak: 'break-all' }}>
                  {appRepo.error}
                </div>
              )}
              <button
                onClick={() => void locateAppRepo()}
                disabled={locating}
                style={{
                  marginTop: 10, padding: '6px 12px', cursor: locating ? 'default' : 'pointer',
                  border: '2px solid var(--accent)', background: 'var(--accent)', color: '#ffffff',
                  fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
                  letterSpacing: '0.06em', textTransform: 'uppercase', opacity: locating ? 0.6 : 1,
                }}
              >{locating ? '…' : t('appMode.locate.action')}</button>
            </div>
          )}

          {!workingDir && !workflowMode && !appMode && !surfaceBlocked && (
            <div style={{ color: 'var(--text-muted)', fontSize: 14, marginTop: 40, textAlign: 'center' }}>
              <div>{t('logEmpty.chooseFolder')}</div>
              {/* First-success starter (UX #3): PLAN + read-only, so the very
                  first run needs zero approvals — pick a folder and go. */}
              <button
                data-testid="code-starter-audit"
                onClick={() => {
                  setMode('plan')
                  setTask(t('starters.auditPrompt', { defaultValue: 'Audit this codebase: map the architecture, call out the top 3 risks, and suggest 3 quick wins. Do not change anything.' }))
                  void pickFolder()
                }}
                style={{
                  display: 'block', margin: '18px auto 0', width: 300, textAlign: 'left',
                  border: '2px solid var(--accent)', background: 'var(--bg-surface)',
                  boxShadow: 'var(--shadow-hard)', padding: '10px 12px', cursor: 'pointer',
                  fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-primary)',
                }}
              >
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  {t('starters.auditLabel', { defaultValue: 'AUDIT THIS FOLDER' })}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 5, lineHeight: 1.4 }}>
                  {t('starters.auditDesc', { defaultValue: 'PLAN mode, read-only — the agent maps the code and reports. No approvals needed.' })}
                </div>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent-text)', marginTop: 5, letterSpacing: '0.08em' }}>
                  {t('starters.auditCta', { defaultValue: 'PICK A FOLDER ▸' })}
                </div>
              </button>
              <div style={{
                marginTop: 18, display: 'inline-block', textAlign: 'left',
                border: '2px solid var(--border)', background: 'var(--bg-elevated)',
                padding: '12px 16px', fontFamily: 'JetBrains Mono, monospace', fontSize: 12, lineHeight: 1.85,
              }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text-dim)', marginBottom: 6 }}>
                  {t('legend.heading')}
                </div>
                <div><strong>{t('legend.modeLabel')}</strong> — {t('legend.modeDesc')}</div>
                <div><strong>{t('legend.thinkingLabel')}</strong> — {t('legend.thinkingDesc')} <span style={{ color: 'var(--text-dim)' }}>(normal / think / ultra)</span></div>
                <div><strong>{t('legend.engineLabel')}</strong> — {t('legend.engineDesc')} <span style={{ color: 'var(--text-dim)' }}>(TACHI · OpenClaude)</span></div>
                <div><strong>{t('legend.gatewayLabel')}</strong> — {t('legend.gatewayDesc')} <span style={{ color: 'var(--text-dim)' }}>(Free · OpenGateway · Bankr · Surplus)</span></div>
                <div style={{ marginTop: 8, color: 'var(--text-dim)' }}>
                  {t('legend.newHerePrefix')}{' '}
                  <button
                    onClick={() => { useUIStore.getState().setSidebarTab('learn'); navigate('/learn') }}
                    style={{
                      border: 'none', background: 'transparent', padding: 0, cursor: 'pointer',
                      color: 'var(--accent)', fontWeight: 700, fontFamily: 'inherit', fontSize: 'inherit',
                      textDecoration: 'underline',
                    }}
                  >
                    {t('legend.learnLink')}
                  </button>{' '}
                  {t('legend.newHereSuffix')}
                </div>
              </div>
            </div>
          )}

          {/* A6: memoize the pairing pass so re-renders triggered by other
           *  state changes (status badges, drag overlay, etc.) don't redo the
           *  O(N) sweep over the entire message history. */}
          <PairedMessageList
            messages={surfaceBlocked ? EMPTY_MESSAGES : messages}
            cardStates={cardStates}
            onApprove={handleApprove}
            onApply={handleApply}
            onCancel={handleCancel}
            onPreview={setPanelPreviewPath}
            workingDir={workingDir ?? undefined}
          />

          {/* B2.1: Permission request overlay — shown when main process pauses a
            * tool. Parallel tool calls queue up: one card at a time, oldest
            * first, with a counter so the user knows more are coming. Answering
            * the visible card immediately reveals the next one. */}
          {pendingPermission && (
            <div>
              {permissionsBehind > 0 && (
                <div
                  style={{
                    padding: '3px 12px',
                    border: '2px solid var(--warning)',
                    borderBottom: 'none',
                    background: 'rgba(245,158,11,0.12)',
                    color: 'var(--warning)',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 9,
                    fontWeight: 800,
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                  }}
                >
                  {t('permission.morePending', {
                    n: permissionsBehind,
                    defaultValue: '+{{n}} more waiting — decide this one first',
                  })}
                </div>
              )}
              <PermissionCard
                key={pendingPermission.id}
                request={pendingPermission}
                onDecide={handlePermissionDecide}
                ownerLabel={permissionOwnerLabel}
                ownerHint={permissionOwnerLabel
                  ? t('permission.owner.hint', { defaultValue: 'This approval belongs to a run on the other tab. Answering it unblocks THAT run — the tool executes in that run\'s workspace, not this one.' })
                  : undefined}
              />
            </div>
          )}

          {/* LANE E — animated tail indicator. Replaces the two static italic
              lines that only ever covered "starting" and "running with an empty
              transcript": the derivation now also catches the gap between a
              tool result and the next model text, which is where a long run
              actually looks frozen. See components/waitingState.ts. */}
          {transcriptWaiting && (
            <WaitingIndicator
              label={status === 'starting' ? t('status.starting', { agent: agentLabel }) : t('status.waiting')}
            />
          )}
        </div>
      </div>
      )}

      {/* ── Footer ── */}
      <div style={{
        padding: '10px 16px', borderTop: 'var(--border-width) solid var(--border)',
        background: 'var(--bg-surface)', flexShrink: 0,
      }}>
        {/* Active-chain row — shows which models the agent is running with
         *  (per the Nodes flow OR the AgentProvider/Bankr override) and a
         *  shortcut to the Nodes editor for editing the setup. */}
        {workingDir && !workflowMode && (
          <ActiveChainRow
            harness={harness}
            provider={provider}
            bankrModel={bankrModel}
            surplusModel={surplusModel}
            veniceModel={veniceModel}
            imgnaiModel={imgnaiModel}
          />
        )}

        {/* Generate AGENTS.md button (C5) — the app repo already ships one,
            so TACHIAPP hides it rather than offering to rewrite it. */}
        {workingDir && !appMode && (
          <GenerateAgentsMdButton workingDir={workingDir} />
        )}

        {/* Attachment chips, when any */}
        {attachments.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0' }}>
            {attachments.map((a, i) => (
              <span key={i} style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '2px 6px',
                border: '2px solid var(--border)',
                background: 'var(--bg-elevated)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 10,
                color: 'var(--text-primary)',
              }}>
                {a.kind === 'image' ? 'IMG' : a.kind === 'text' ? 'TXT' : 'FILE'} {a.name}
                <button
                  onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))}
                  style={{
                    background: 'none', border: 'none',
                    color: 'var(--text-muted)', cursor: 'pointer',
                    padding: 0, lineHeight: 1, fontSize: 12,
                  }}
                >x</button>
              </span>
            ))}
          </div>
        )}

        {/* QUEUED FOLLOW-UPS (A1a) — messages typed while the run was in flight.
          * Above the composer so the operator sees WHAT will fire and can pull
          * any of it back; the oldest one auto-sends when the run reaches a
          * terminal `done`. PAUSED (STOP / error) turns the row into an explicit
          * RESUME instead of quietly firing into a stopped session. */}
        {promptQueue.length > 0 && (
          <div
            data-testid="prompt-queue-row"
            style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', margin: '6px 0' }}
          >
            <span
              title={promptPaused
                ? t('queue.pausedHint', { defaultValue: 'The run stopped or failed, so nothing fires on its own. RESUME sends the oldest queued message as the next turn.' })
                : t('queue.labelHint', { defaultValue: 'Sends automatically, one at a time, when the current run finishes. Each message inherits the settings in force at that moment. Text only — attachments are not queued.' })}
              style={{
                padding: '2px 7px',
                border: `2px solid ${promptPaused ? 'var(--warning)' : 'var(--accent)'}`,
                color: promptPaused ? 'var(--warning)' : 'var(--accent)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 9, fontWeight: 800,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
              }}
            >
              {promptPaused
                ? t('queue.paused', { n: promptQueue.length, defaultValue: 'QUEUE PAUSED · {{n}}' })
                : t('queue.label',  { n: promptQueue.length, defaultValue: 'QUEUED {{n}}' })}
            </span>
            {promptPaused && (
              <button
                onClick={() => setPromptQueuePaused(promptSurface, false)}
                title={t('queue.resumeHint', { defaultValue: 'Resume automatic sending — the oldest queued message goes out as the next turn' })}
                style={{
                  padding: '2px 8px',
                  border: '2px solid var(--accent)',
                  background: 'var(--accent)',
                  color: 'var(--bg-base)',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 9, fontWeight: 800,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  cursor: 'pointer',
                }}
              >{t('queue.resume', { defaultValue: 'RESUME' })}</button>
            )}
            {promptQueue.map((q, i) => (
              <span key={q.id} style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                maxWidth: 320,
                padding: '2px 6px',
                border: '2px solid var(--border)',
                background: 'var(--bg-elevated)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 10,
                color: 'var(--text-primary)',
              }}>
                <span style={{ color: 'var(--text-dim)', fontWeight: 700, flexShrink: 0 }}>{i + 1}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={q.text}>
                  {q.text}
                </span>
                <button
                  onClick={() => unqueuePrompt(promptSurface, q.id)}
                  title={t('queue.remove', { defaultValue: 'Remove from the queue' })}
                  aria-label={t('queue.remove', { defaultValue: 'Remove from the queue' })}
                  style={{
                    background: 'none', border: 'none',
                    color: 'var(--text-muted)', cursor: 'pointer',
                    padding: 0, lineHeight: 1, fontSize: 12, flexShrink: 0,
                  }}
                >x</button>
              </span>
            ))}
          </div>
        )}

        {/* Slash autocomplete + inline command output (LOCAL ONLY) */}
        {slashOpen && slashRows.length > 0 && (
          <CommandPopup
            items={slashRows.map(r => r.item)}
            cursor={slashCursor}
            onHover={setSlashCursor}
            onPick={(_item, i) => pickSlashRow(slashRows[i])}
          />
        )}
        <CommandNote note={cmdNote} onDismiss={() => setCmdNote(null)} />

        <div data-tour="code-composer" style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: workingDir ? 8 : 0 }}>
          {/* [+] attachment button — opens native file picker. */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={e => onAttachFiles(e.target.files)}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={surfaceBlocked || workflowMode || !effectiveWorkingDir || isViewingArchive}
            title={workflowMode ? t('composer.attachTooltipWorkflow') : t('composer.attachTooltip')}
            aria-label={t('composer.attachAria')}
            style={{
              padding: '8px 12px',
              border: '2px solid var(--border)',
              background: 'var(--bg-elevated)',
              color: 'var(--text-primary)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 14, fontWeight: 700,
              cursor: surfaceBlocked || workflowMode || !effectiveWorkingDir || isViewingArchive ? 'default' : 'pointer',
              opacity: surfaceBlocked || workflowMode || !effectiveWorkingDir || isViewingArchive ? 0.4 : 1,
              flexShrink: 0,
            }}
          >[+]</button>
          <textarea
            value={task}
            onChange={e => setTask(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              surfaceBlocked ? t('surfaceBusy.composerPlaceholder', { defaultValue: 'Waiting for the run on the other tab to finish…' })
              : isViewingArchive ? t('composer.placeholderArchive')
              : workflowMode ? t('composer.placeholderWorkflow', { name: activeWorkflow?.name })
              : parallelGridMode && !focusedTask ? t('composer.placeholderSelectTile')
              // A run in flight no longer means "you cannot type" — say what
              // Enter will actually do, or nobody discovers the queue exists.
              : isRunning ? t('queue.placeholder', { defaultValue: 'Run in progress — Enter queues your message for when it finishes' })
              : appMode ? (effectiveWorkingDir ? t('appMode.composerPlaceholder') : t('appMode.locate.resolving'))
              : effectiveWorkingDir ? t('composer.placeholderTask', { agent: agentLabel })
              : t('composer.placeholderNoFolder')
            }
            disabled={surfaceBlocked || (!workflowMode && !effectiveWorkingDir) || status === 'starting' || isViewingArchive}
            rows={2}
            style={{
              flex: 1, resize: 'none', border: 'var(--border-width) solid var(--border)', borderRadius: 0,
              padding: '10px 14px', background: 'var(--bg-elevated)', color: 'var(--text-primary)',
              fontSize: 14, lineHeight: 1.5, overflowY: 'hidden',
              opacity: surfaceBlocked || (!workflowMode && !effectiveWorkingDir) || isViewingArchive ? 0.5 : 1,
            }}
          />
          {/* STOP belongs to the surface that OWNS the run: offering it here
              would let one tab kill the other's work by surprise (and settle a
              session this surface is about to park). Blocked → inert send. */}
          {isRunning && !surfaceBlocked
            // QUEUE sits NEXT TO stop, never instead of it: the operator must
            // always be one click from killing the run, and queueing a follow-up
            // is a different intent from interrupting.
            ? <>
                {!workflowMode && (
                  <button
                    data-testid="queue-prompt-button"
                    onClick={submitComposer}
                    disabled={!task.trim()}
                    title={t('queue.buttonHint', { defaultValue: 'Queue this message — it sends automatically when the current run finishes' })}
                    aria-label={t('queue.button', { defaultValue: 'Queue' })}
                    style={{
                      padding: '8px 12px',
                      border: '2px solid var(--accent)',
                      background: 'transparent',
                      color: 'var(--accent)',
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 10, fontWeight: 800,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      cursor: task.trim() ? 'pointer' : 'default',
                      opacity: task.trim() ? 1 : 0.4,
                      flexShrink: 0,
                    }}
                  >{t('queue.button', { defaultValue: 'Queue' })}</button>
                )}
                <button onClick={abort} style={abortBtn} title={t('composer.stop')} aria-label={t('composer.stop')}>&#9632;</button>
              </>
            // …and a workspace with no session yet is NOT a dead end: the gate
            // says 'start-then-send' and sendTask spawns one.
            /* data-send-key: the same theme-structure styling hook the chat SEND
               carries (the chassis themes notch the send/run key). Cosmetic
               only — nothing reads it.
               data-pincer-send + the two data-jaw leaves: the same pair the chat
               composer publishes, so OPUS-5 dresses ONE shape in both places
               (mock option 1e). Hooks only — with no chassis sheet the top jaw
               is an unstyled span holding the glyph that used to be the button's
               only child and the bottom jaw is empty, so every other theme is
               byte-for-byte unchanged. */
            : <button data-send-key="" data-pincer-send="" onClick={() => void sendTask()} disabled={!task.trim() || gate === 'blocked'} style={sendBtn} title={`${t('composer.run')}${runCostHint}`} aria-label={t('composer.run')}><span data-jaw="t">▶</span><span data-jaw="b" /></button>
          }
        </div>
      </div>
      </div>

      {/* ── PreviewPanel overlay — HTML/image iframe preview ── */}
      {panelPreviewPath && (
        <PreviewPanel
          filePath={panelPreviewPath}
          onClose={() => setPanelPreviewPath(null)}
        />
      )}

      {!appMode && (
        <TabTour open={tourOpen} onClose={() => setTourOpen(false)} steps={buildCodeTour(t)} title={t('tour.title')} />
      )}
    </div>
  )
}

// ── AgentProviderSelector ─────────────────────────────────────────────────────
//
// Picks which LLM gateway powers the harness for the
// next session. Switching requires a session restart — the env vars are
// captured at sidecar spawn time, not per-message.
function AgentProviderSelector({
  value,
  onChange,
  disabled,
}: {
  value: AgentProvider
  onChange: (p: AgentProvider) => void
  disabled?: boolean
}) {
  const { t } = useTranslation('agent')
  // The ladder pick for 'default' (null until keys load). Its label used to be
  // a hardcoded 'Free' — wrong whenever the ladder preferred a stored Bankr
  // key (paid). 'Free' now renders only from the loaded pick's derived `free`
  // fact; unknown or paid reads 'Auto'. The hints interpolate the SAME pinned
  // model id the harness routes ({{model}}), never a hand-written one.
  const defaultRoute = useDefaultAgentRoute()
  const ogModel = modelDisplayName(OPENGATEWAY_AGENT_MODEL)
  const options: Array<{ id: AgentProvider; label: string; hint: string }> = [
    { id: 'default',     label: defaultRoute?.free ? 'Free' : 'Auto', hint: t('provider.freeHint', { model: ogModel }) },
    { id: 'opengateway', label: 'OpenGateway', hint: t('provider.openGatewayHint', { model: ogModel }) },
    { id: 'bankr',       label: 'Bankr',       hint: t('provider.bankrHint') },
    { id: 'surplus',     label: 'Surplus',     hint: t('provider.surplusHint') },
    { id: 'venice',      label: 'Venice',      hint: t('provider.veniceHint') },
    { id: 'imgnai',      label: 'imgnAI',      hint: t('provider.imgnaiHint') },
  ]
  return (
    <div style={{
      display: 'flex', gap: 4, padding: '2px',
      background: 'var(--bg-elevated)', borderRadius: 0, border: 'var(--border-width) solid var(--border)',
      opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? 'none' : undefined,
    }}>
      {options.map(o => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          title={o.hint}
          disabled={disabled}
          style={{
            padding: '3px 10px', borderRadius: 0, border: 'none',
            cursor: 'pointer', fontSize: 12, fontWeight: 600,
            background: value === o.id ? 'var(--accent)' : 'transparent',
            color:      value === o.id ? 'var(--bg-base)' : 'var(--text-muted)',
            transition: 'background 0.15s, color 0.15s',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ── WorkflowSelector ──────────────────────────────────────────────────────────
//
// Binds a saved Nodes-canvas workflow to the Code tab. When one is selected the
// composer RUNS that graph (compile + execute) instead of starting a normal
// harness session — "save a node setup, run it right here". Lists the saved
// flows from userData/nodes (nodes.listFlows). Picking "None" returns to the
// normal agent. The actual takeover lives in AgentPage (workflowMode).
function WorkflowSelector({
  value,
  onChange,
  disabled,
}: {
  value: ActiveWorkflow | null
  onChange: (w: ActiveWorkflow | null) => void
  disabled?: boolean
}) {
  const { t } = useTranslation('agent')
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [flows, setFlows] = useState<Array<{ filename: string; name: string; savedAt: string }>>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.tachi.nodes.listFlows()
      setFlows(res.ok ? res.flows : [])
    } catch {
      setFlows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (open) void refresh() }, [open, refresh])

  const itemStyle: React.CSSProperties = {
    display: 'block', width: '100%', textAlign: 'left',
    padding: '6px 10px', border: 'none', borderBottom: 'var(--border-width) solid var(--border)',
    background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer',
    fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        title={t('workflowSelector.tooltip')}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '3px 10px', borderRadius: 0,
          border: `2px solid ${value ? 'var(--accent)' : 'var(--border)'}`,
          background: value ? 'var(--accent-muted)' : 'var(--bg-elevated)',
          color: value ? 'var(--accent)' : 'var(--text-muted)',
          fontSize: 12, fontWeight: 600,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.5 : 1, maxWidth: 200,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {value ? `⛓ ${value.name}` : `⛓ ${t('workflowSelector.off')}`}
        </span>
      </button>
      {open && (
        <>
          {/* click-away backdrop */}
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 49 }}
          />
          <div style={{
            position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 50,
            minWidth: 240, maxWidth: 320,
            border: '2px solid var(--border)', background: 'var(--bg-surface)',
            boxShadow: 'var(--shadow-soft)', maxHeight: 320, overflowY: 'auto',
          }}>
            <button
              onClick={() => { onChange(null); setOpen(false) }}
              style={{ ...itemStyle, fontWeight: 700, color: value ? 'var(--text-primary)' : 'var(--accent)' }}
            >
              {value ? t('workflowSelector.none') : `✓ ${t('workflowSelector.none')}`}
            </button>
            {loading && (
              <div style={{ padding: '8px 10px', fontSize: 11, color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
                {t('workflowSelector.loading')}
              </div>
            )}
            {!loading && flows.length === 0 && (
              <div style={{ padding: '8px 10px', fontSize: 11, color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace', lineHeight: 1.5 }}>
                {t('workflowSelector.empty')}
              </div>
            )}
            {!loading && flows.map(f => {
              const selected = value?.filename === f.filename
              return (
                <button
                  key={f.filename}
                  onClick={() => { onChange({ filename: f.filename, name: f.name }); setOpen(false) }}
                  title={t('workflowSelector.savedAt', { date: new Date(f.savedAt).toLocaleString() })}
                  style={{
                    ...itemStyle,
                    background: selected ? 'var(--accent-muted)' : 'transparent',
                    color: selected ? 'var(--accent)' : 'var(--text-primary)',
                    fontWeight: selected ? 700 : 400,
                  }}
                >
                  {selected ? '✓ ' : ''}{f.name}
                </button>
              )
            })}
            <button
              onClick={() => { setOpen(false); useUIStore.getState().setSidebarTab('studio'); navigate('/nodes') }}
              style={{ ...itemStyle, borderBottom: 'none', color: 'var(--accent)', fontWeight: 700 }}
            >
              {t('workflowSelector.buildNew')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// ── HarnessSelector ───────────────────────────────────────────────────────────

function HarnessSelector({
  value,
  onChange,
  disabled,
}: {
  value: HarnessId
  onChange: (h: HarnessId) => void
  disabled?: boolean
}) {
  const { t } = useTranslation('agent')
  const options: Array<{ id: HarnessId; label: string; icon: string; hint: string }> = [
    { id: 'tachi',      label: 'TACHI',         icon: '刀', hint: t('harness.tachiHint') },
    { id: 'openclaude', label: 'OpenClaude',    icon: '◇', hint: t('harness.openClaudeHint') },
    // NOTE: Codex is deliberately NOT here — it's a WORKER of the TACHI
    // harness (the CODEX chip), not a peer engine. Direct chat = "@codex …"
    // in the composer (routed per-message below), so there's ONE chat surface
    // and one mental model instead of a confusing second engine slot.
    { id: 'darksol',    label: 'DarkSol',       icon: '◆', hint: t('harness.darkSolHint') },
  ]
  return (
    <div style={{
      display: 'flex', gap: 4, padding: '2px',
      background: 'var(--bg-elevated)', borderRadius: 0, border: 'var(--border-width) solid var(--border)',
      opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? 'none' : undefined,
    }}>
      {options.map(o => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          title={o.hint}
          disabled={disabled}
          style={{
            padding: '3px 10px', borderRadius: 0, border: 'none',
            cursor: 'pointer', fontSize: 12, fontWeight: 600,
            background: value === o.id ? 'var(--accent)' : 'transparent',
            color:      value === o.id ? 'var(--bg-base)' : 'var(--text-muted)',
            transition: 'background 0.15s, color 0.15s',
          }}
        >
          {o.icon} {o.label}
        </button>
      ))}
    </div>
  )
}

// ── DepthToggle ───────────────────────────────────────────────────────────────
//
// D6: 3-state brutalist toggle for thinking depth. Active state uses accent
// border; inactive uses muted border. No border-radius, JetBrains Mono.
//   NORMAL → no extended thinking (Anthropic `thinking` param omitted)
//   THINK  → extended thinking, 4 000 token budget
//   ULTRA  → extended thinking, 32 000 token budget
//
// For non-Anthropic providers the depth value still propagates — chat-service
// prepends a text instruction instead of the API parameter.
function DepthToggle({
  value,
  onChange,
  disabled,
}: {
  value:    ThinkingDepth
  onChange: (d: ThinkingDepth) => void
  disabled?: boolean
}) {
  const { t } = useTranslation('agent')
  const options: Array<{ id: ThinkingDepth; label: string; hint: string }> = [
    { id: 'normal', label: t('depth.normal'), hint: t('depth.normalHint') },
    { id: 'think',  label: t('depth.think'),  hint: t('depth.thinkHint') },
    { id: 'ultra',  label: t('depth.ultra'),  hint: t('depth.ultraHint') },
  ]
  return (
    <div
      style={{
        display: 'flex', gap: 0,
        border: '2px solid var(--border-default, var(--border))',
        background: 'var(--bg-elevated)',
        opacity: disabled ? 0.5 : 1,
        pointerEvents: disabled ? 'none' : undefined,
      }}
    >
      {options.map((o, i) => {
        const active = value === o.id
        return (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            title={o.hint}
            disabled={disabled}
            style={{
              padding: '3px 10px',
              border: 'none',
              borderRight: i < options.length - 1 ? 'var(--border-width) solid var(--border)' : 'none',
              cursor: 'pointer',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              background: active ? 'var(--accent)' : 'transparent',
              color:      active ? '#fff' : 'var(--text-muted)',
              outline:    active ? '2px solid var(--accent)' : '2px solid transparent',
              outlineOffset: '-2px',
              transition: 'background 0.1s, color 0.1s, outline-color 0.1s',
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

// UX #8: the SAFE/STANDARD/AUTO trust preset — same three-state chip idiom
// as NORMAL/THINK/ULTRA so the toolbar speaks one control language. Enforced
// SERVER-SIDE (checkAutoApproval ladder); this is just the selector.
function TrustToggle({
  value,
  onChange,
  disabled,
}: {
  value:    TrustLevel
  onChange: (v: TrustLevel) => void
  disabled?: boolean
}) {
  const { t } = useTranslation('agent')
  const options: Array<{ id: TrustLevel; label: string; hint: string }> = [
    { id: 'safe',     label: t('trust.safe', { defaultValue: 'Safe' }),         hint: t('trust.safeHint', { defaultValue: 'Ask before every file write, shell command and external tool' }) },
    { id: 'standard', label: t('trust.standard', { defaultValue: 'Standard' }), hint: t('trust.standardHint', { defaultValue: 'Reads and in-workspace writes run free; shell and external tools ask' }) },
    { id: 'auto',     label: t('trust.auto', { defaultValue: 'Auto' }),         hint: t('trust.autoHint', { defaultValue: 'Also runs non-destructive shell commands without asking — destructive ones still ask' }) },
  ]
  return (
    <div
      data-testid="trust-toggle"
      style={{
        display: 'flex', gap: 0,
        border: '2px solid var(--border-default, var(--border))',
        background: 'var(--bg-elevated)',
        opacity: disabled ? 0.5 : 1,
        pointerEvents: disabled ? 'none' : undefined,
      }}
    >
      {options.map((o, i) => {
        const active = value === o.id
        return (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            title={o.hint}
            disabled={disabled}
            style={{
              padding: '3px 10px',
              border: 'none',
              borderRight: i < options.length - 1 ? 'var(--border-width) solid var(--border)' : 'none',
              cursor: 'pointer',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              background: active ? (o.id === 'safe' ? 'var(--success, #16a34a)' : 'var(--accent)') : 'transparent',
              color:      active ? '#fff' : 'var(--text-muted)',
              outline:    active ? '2px solid var(--accent)' : '2px solid transparent',
              outlineOffset: '-2px',
              transition: 'background 0.1s, color 0.1s, outline-color 0.1s',
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation('agent')
  const map: Record<string, { label: string; color: string; pulse?: boolean }> = {
    idle:     { label: t('statusBadge.idle'),     color: 'var(--text-muted)' },
    starting: { label: t('statusBadge.starting'), color: 'var(--warning)', pulse: true },
    running:  { label: t('statusBadge.running'),  color: 'var(--success)', pulse: true },
    done:     { label: t('statusBadge.done'),     color: 'var(--accent)' },
    error:    { label: t('statusBadge.error'),    color: 'var(--danger)' },
    // GAVE-UP DETECTION: not a success, not an error — a run that stopped.
    incomplete: { label: t('statusBadge.incomplete', { defaultValue: 'Stopped' }), color: 'var(--warning)' },
  }
  const s = map[status] ?? map.idle
  return (
    <span style={{
      fontSize: 10, fontWeight: 700,
      padding: '3px 8px',
      border: `2px solid ${s.color}`,
      color: s.color,
      flexShrink: 0,
      fontFamily: 'JetBrains Mono, monospace',
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      background: 'var(--bg-elevated)',
      boxShadow: 'var(--shadow-soft)',
    }}>
      <span
        className={s.pulse ? 'tachi-pulse-dot' : undefined}
        style={{ width: 6, height: 6, background: s.color, display: 'inline-block' }}
      />
      {s.label}
    </span>
  )
}

/**
 * Provider → badge label. A MAP, not a ternary chain: the chain this replaces
 * fell through to 'DEFAULT' for any provider nobody remembered to add an arm
 * for (venice and imgnai both shipped mislabelled that way), and a map cannot
 * silently mislabel — an unknown id renders as itself.
 */
const PROVIDER_LABELS: Partial<Record<string, string>> = {
  default:     'DEFAULT',
  opengateway: 'OPENGATEWAY',
  bankr:       'BANKR',
  surplus:     'SURPLUS',
  venice:      'VENICE',
  imgnai:      'IMGNAI',
}

/**
 * The concrete model an origin stamp should record for a provider, at SEND.
 *
 * ONE place, so the stamp and the routing cannot drift: opengateway reads the
 * shared pin (a repricing changes one core file and this follows), the catalog
 * providers read their picked id, and 'default' records whatever the ladder
 * actually resolved to — '' while the ladder is still loading, which the badge
 * then omits rather than inventing.
 */
function originModelFor(
  provider: AgentProvider,
  models: { bankr: string; surplus: string; venice: string; imgnai: string; defaultRoute?: string | null },
): string {
  switch (provider) {
    case 'bankr':       return models.bankr
    case 'surplus':     return models.surplus
    case 'venice':      return models.venice
    case 'imgnai':      return models.imgnai
    case 'opengateway': return OPENGATEWAY_AGENT_MODEL
    default:            return models.defaultRoute ?? ''
  }
}

// ── AgentModelBadge ───────────────────────────────────────────────────────────
// Brutalist 1px-border badge rendered below each agent text response.
// Format: [HARNESS · PROVIDER · model]  e.g. [OPENCLAUDE · BANKR · gemini-3-flash]
//
// It renders ONE argument: the origin stamped on the message it sits under.
// It used to take harness/provider/*Model as props threaded down from the LIVE
// store selection, which meant a finished transcript re-labelled itself the
// moment the operator clicked a different agent chip (driver, 2026-08-02:
// a completed TACHI run became "[OPENCLAUDE · VENICE · …]", same messages, same
// tool timings). Taking only the stamp is what makes that impossible — there is
// no mutable state left in scope to read.
function AgentModelBadge({ origin }: { origin: AgentRunOrigin }) {
  // Unknown/legacy ids (a pre-Goose-removal archive) render as plain text.
  const harnessLabel = (HARNESS_LABELS[origin.harness] ?? origin.harness).toUpperCase()
  const providerLabel = PROVIDER_LABELS[origin.provider] ?? String(origin.provider).toUpperCase()
  const rawModel = origin.model ?? ''
  const modelLabel = modelDisplayName(rawModel)
  const parts = [harnessLabel, providerLabel, ...(modelLabel ? [modelLabel] : [])]
  return (
    <div title={rawModel || undefined} style={{
      marginTop: 6,
      display: 'inline-block',
      padding: '1px 5px',
      border: 'var(--border-width) solid var(--border)',
      background: 'var(--bg-elevated)',
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 10,
      color: 'var(--text-muted)',
      letterSpacing: '0.04em',
      userSelect: 'none',
    }}>
      [{parts.join(' · ')}]
    </div>
  )
}

interface EventRowProps {
  event:      AgentEvent
  eventId?:   string
  cardStates?: Map<string, CardEntry>
  onApprove?:  (cardId: string, plan: SlashCommandResult) => void
  onApply?:    (cardId: string, plan: SlashCommandResult) => void
  onCancel?:   (cardId: string) => void
  /**
   * Provenance stamped on THIS message when it was written — NOT the current
   * selection. The four live-selection props that used to sit here are gone on
   * purpose: while they existed, the badge could be re-derived from mutable
   * state, and it was.
   */
  origin?:     AgentRunOrigin
  /** Called when user clicks [PREVIEW] on a file Write event. */
  onPreview?:  (filePath: string) => void
  /** Agent working directory — used to resolve relative paths in Write events. */
  workingDir?: string
}

// File extensions that can be previewed in the PreviewPanel iframe/img.
const PREVIEWABLE_EXTS = new Set([
  'html', 'htm', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'md', 'txt', 'json', 'csv', 'ts', 'tsx', 'js', 'jsx', 'py', 'sh',
])

function isPreviewable(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return PREVIEWABLE_EXTS.has(ext)
}

// Fusion fan-out strip — renders a `fusion-panel` event so the user can SEE the
// model panel behind consult_panel / fuse_plan: which models answered (✓) vs
// failed (✗, e.g. a tripped circuit-breaker leg), each answer's size, and which
// model judged/synthesized. Theme-safe vars only.
function FusionPanelStrip({ members, judge, mode, brief, providerId }: { members: { model: string; ok: boolean; chars: number; text?: string }[]; judge: string; mode: 'plan' | 'synthesis'; brief?: string; providerId?: string }) {
  const { t } = useTranslation('agent')
  // Local copy of the panel members so a successful RE-RUN can flip a failed leg
  // to ✓ in place. Re-seeded only when the props' members actually change (a
  // stable signature avoids wiping re-run results on incidental re-renders).
  const memberSignature = useMemo(
    () => members.map(m => `${m.model}|${m.ok}|${m.chars}`).join(';'),
    [members],
  )
  const [localMembers, setLocalMembers] = useState(members)
  useEffect(() => { setLocalMembers(members) }, [memberSignature]) // eslint-disable-line react-hooks/exhaustive-deps
  const [pending, setPending] = useState<Record<number, boolean>>({})
  // Which panel member's full answer is expanded (the "fusion research" view).
  const [open, setOpen] = useState<number | null>(null)

  // RE-RUN is only possible when we know the brief + gateway and the bridge is
  // present (older persisted transcripts lack brief/providerId — hide it there).
  const canRerun = Boolean(brief && providerId && window.tachi?.fusion?.rerunMember)

  const rerun = async (index: number, model: string) => {
    if (!canRerun || pending[index]) return
    setPending(p => ({ ...p, [index]: true }))
    try {
      const res = await window.tachi.fusion.rerunMember({ providerId: providerId!, model, brief: brief! })
      if (res.ok) {
        setLocalMembers(prev => prev.map((m, i) => i === index ? { ...m, ok: true, chars: res.chars } : m))
      }
    } catch { /* keep the leg failed */ }
    finally { setPending(p => { const next = { ...p }; delete next[index]; return next }) }
  }

  const okCount = localMembers.filter(m => m.ok).length
  return (
    <div style={{
      border: '2px solid var(--accent)',
      background: 'var(--bg-elevated)',
      fontFamily: 'JetBrains Mono, monospace',
      boxShadow: 'var(--shadow-soft)',
      marginBottom: 4,
    }}>
      <div style={{
        padding: '4px 10px',
        borderBottom: 'var(--border-width) solid var(--border)',
        fontSize: 9, fontWeight: 700, color: 'var(--accent)',
        letterSpacing: '0.08em', textTransform: 'uppercase',
      }}>
        ⑂ {mode === 'plan' ? t('fusion.planPanel') : t('fusion.panel')} — {t('fusion.answered', { ok: okCount, total: localMembers.length })}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '6px 10px' }}>
        {localMembers.map((m, i) => {
          const expandable = m.ok && !!m.text
          return (
          <span
            key={`${m.model}-${i}`}
            onClick={expandable ? () => setOpen(open === i ? null : i) : undefined}
            title={expandable ? 'Show this model\'s full answer' : undefined}
            style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 8px',
            border: `2px solid ${m.ok ? 'var(--success)' : 'var(--danger)'}`,
            background: open === i ? 'var(--bg-surface)' : 'transparent',
            color: m.ok ? 'var(--text-primary)' : 'var(--text-dim)',
            fontSize: 11,
            cursor: expandable ? 'pointer' : 'default',
          }}>
            <span style={{ color: m.ok ? 'var(--success)' : 'var(--danger)' }}>{m.ok ? '✓' : '✗'}</span>
            <strong>{m.model}</strong>
            {m.ok && <span style={{ color: 'var(--text-dim)' }}>{m.chars}c</span>}
            {expandable && <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{open === i ? '▾' : '▸'}</span>}
            {!m.ok && canRerun && (
              <button
                type="button"
                onClick={() => rerun(i, m.model)}
                disabled={pending[i]}
                title={t('fusion.rerunTitle', { model: m.model })}
                style={{
                  marginLeft: 2,
                  padding: '0 5px',
                  border: '2px solid var(--danger)',
                  background: 'transparent',
                  color: 'var(--danger)',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 9, fontWeight: 700,
                  letterSpacing: '0.06em', textTransform: 'uppercase',
                  cursor: pending[i] ? 'wait' : 'pointer',
                  opacity: pending[i] ? 0.6 : 1,
                }}
              >
                {pending[i] ? '…' : `↻ ${t('fusion.rerun')}`}
              </button>
            )}
          </span>
          )
        })}
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          → {t('fusion.judge')}: <strong style={{ color: 'var(--accent)' }}>{judge}</strong>
        </span>
      </div>
      {open !== null && localMembers[open]?.text && (
        <div style={{
          borderTop: '2px solid var(--border)',
          padding: '8px 10px',
          maxHeight: 380,
          overflow: 'auto',
          background: 'var(--bg-surface)',
        }}>
          <div style={{
            fontSize: 9, fontWeight: 700, color: 'var(--accent)',
            letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span>{localMembers[open].model} · {localMembers[open].chars}c</span>
            <button
              type="button"
              onClick={() => setOpen(null)}
              style={{
                border: '2px solid var(--border)', background: 'transparent',
                color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace',
                fontSize: 9, fontWeight: 700, padding: '0 6px', cursor: 'pointer',
              }}
            >✕</button>
          </div>
          <Markdown source={localMembers[open].text!} />
        </div>
      )}
    </div>
  )
}

/**
 * The per-turn ↺ RESET menu (plan A2). Three rows in Cline's vocabulary —
 * operators already know them — over the workspace snapshot main took right
 * before this turn ran.
 *
 * HONESTY IS THE POINT: a row is never a button that silently no-ops. When
 * RESET CODE is not possible the row is disabled and says WHY (no snapshot for
 * this turn / this harness takes none / it aged out of the 50-entry index / a
 * run is in flight). The live index is read once, when the menu opens, so the
 * "aged out" claim is proven rather than assumed.
 */
function TurnResetMenu({ eventId }: { eventId: string }) {
  const { t } = useTranslation('agent')
  const [open, setOpen] = useState(false)
  const [liveIds, setLiveIds] = useState<string[] | null>(null)
  // FIXED-position anchor (live-found: an absolute dropdown inside the
  // scrolling transcript gets clipped by the pane's overflow — the top row
  // rendered above the visible edge) + Esc dismissal (live-found: only the
  // click-away closed it).
  const btnRef = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  const status           = useAgentStore(s => s.status)
  const viewingArchiveId = useAgentStore(s => s.viewingArchiveId)
  const harness          = useAgentStore(s => s.harness)
  const turnCheckpoints  = useAgentStore(s => s.turnCheckpoints)

  const avail = resetAvailability({
    status, viewingArchiveId, harness, messageId: eventId,
    turnCheckpoints, liveCheckpointIds: liveIds,
  })

  const openMenu = () => {
    // Anchor from the button's viewport rect so the FIXED menu lands under it
    // regardless of transcript scroll; flip above when the bottom would clip.
    const r = btnRef.current?.getBoundingClientRect()
    if (r) {
      const MENU_H = 150
      const below = r.bottom + 2 + MENU_H <= window.innerHeight
      setAnchor({ top: below ? r.bottom + 2 : Math.max(4, r.top - 2 - MENU_H), right: Math.max(4, window.innerWidth - r.right) })
    }
    setOpen(v => !v)
    // Prove the snapshot still exists rather than assuming it: the per-root
    // index caps at 50, so an old turn's checkpoint can legitimately be gone.
    const root = turnCheckpoints.find(c => c.messageId === eventId)?.root
    if (!root || liveIds) return
    window.tachi.checkpoints.listWorkspaceCheckpoints(root)
      .then(list => setLiveIds(list.map(c => c.id)))
      .catch(() => { /* leave null — we do not claim aged-out without evidence */ })
  }

  const fire = (choice: ResetChoice) => {
    setOpen(false)
    window.dispatchEvent(new CustomEvent('tachi:agent-reset', { detail: { eventId, choice } }))
  }

  const codeReason = avail.codeBlocker
    ? t(`reset.blocked.${avail.codeBlocker}`, { defaultValue: t('reset.blocked.not-taken') })
    : ''

  const rowStyle = (enabled: boolean): React.CSSProperties => ({
    display: 'block', width: '100%', textAlign: 'left',
    padding: '4px 8px', border: 'none', borderBottom: '1px solid var(--border)',
    background: 'transparent',
    color: enabled ? 'var(--text-primary)' : 'var(--text-dim)',
    fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 700,
    cursor: enabled ? 'pointer' : 'not-allowed',
    opacity: enabled ? 1 : 0.55,
  })

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        type="button"
        onClick={openMenu}
        title={t('reset.tooltip')}
        style={{ padding: '1px 6px', border: '2px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 700, cursor: 'pointer' }}
      >↺ {t('reset.button')}</button>
      {open && anchor && createPortal(
        <>
        {/* PORTAL to document.body — live-found twice: the transcript's
            overflow clipped an absolute menu, and after the fixed-position
            fix the row wrapper's entrance animation (`animation … both`)
            leaves a permanent identity transform, which per spec makes the
            row the containing block for position:fixed — the "viewport"
            coordinates resolved against the ROW and the menu rendered up to
            fully off-screen. Only a portal escapes both traps. */}
        {/* Click-away: a menu the operator cannot dismiss is its own bug. */}
        <div
          onClick={() => setOpen(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 19 }}
        />
        <div
          style={{
            position: 'fixed', top: anchor.top, right: anchor.right, zIndex: 20,
            minWidth: 190, border: '2px solid var(--border)',
            background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-soft)',
          }}
        >
          <button type="button" disabled={!avail.canResetChat} onClick={() => fire('chat')} style={rowStyle(avail.canResetChat)}>
            {t('reset.chat')}
            <div style={{ fontWeight: 400, color: 'var(--text-dim)', fontSize: 8 }}>{t('reset.chatHint')}</div>
          </button>
          <button type="button" disabled={!avail.canResetCode} onClick={() => fire('code')} style={rowStyle(avail.canResetCode)}>
            {t('reset.code')}
            <div style={{ fontWeight: 400, color: 'var(--text-dim)', fontSize: 8 }}>
              {avail.canResetCode ? t('reset.codeHint') : codeReason}
            </div>
          </button>
          <button type="button" disabled={!avail.canResetCode || !avail.canResetChat} onClick={() => fire('both')} style={{ ...rowStyle(avail.canResetCode && avail.canResetChat), borderBottom: 'none' }}>
            {t('reset.both')}
            <div style={{ fontWeight: 400, color: 'var(--text-dim)', fontSize: 8 }}>
              {avail.canResetCode ? t('reset.bothHint') : codeReason}
            </div>
          </button>
        </div>
        </>,
        document.body,
      )}
    </div>
  )
}

// ── Assistant prose block (CODE tab) ─────────────────────────────────────────
//
// The CHAT tab has had message-level COPY for a while; the CODE transcript only
// had per-code-block copy, so grabbing a whole answer meant dragging a
// selection across a scrolling, still-streaming log. Same visual idiom as the
// chat bubble's action bar: a 2px-bordered mono chip that flips to COPIED for a
// beat. Kept MOUNTED at opacity 0 rather than conditionally rendered, so
// revealing it on hover never reflows the transcript under the pointer.
//
// Prose only — tool cards carry their own affordances and copying a tool card's
// rendered text is almost never what the operator means.
interface AgentTextEventProps {
  text:          string
  /** Provenance stamped on THIS message at write time. Absent ⇒ no badge. */
  origin?:       AgentRunOrigin
  onPreview?:    (filePath: string) => void
  workingDir?:   string
}

function AgentTextEvent({ text, origin, onPreview, workingDir }: AgentTextEventProps) {
  const { t } = useTranslation('agent')
  const [hovered, setHovered] = useState(false)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current) }, [])

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 1400)
    } catch {
      showToast({ kind: 'error', text: t('event.copyFailed', { defaultValue: 'Copy failed' }) })
    }
  }

  return (
    <div onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <div className="tachi-agent-answer" style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--text-primary)', wordBreak: 'break-word' }}>
        <Markdown source={text} />
      </div>
      {/* "Files right in the chat" — clickable chips (+ image thumbnails)
          for produced-file paths the message mentions → PreviewPanel. */}
      {onPreview && (
        <FilePathChips text={text} workingDir={workingDir ?? null} onOpen={onPreview} />
      )}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
        {/* No stamp ⇒ NO badge. Every message written before provenance
            shipped falls here, and showing nothing is the honest fallback —
            the same one the chat fix chose for its pre-stamp bubbles. */}
        {origin && <AgentModelBadge origin={origin} />}
        <button
          type="button"
          onClick={onCopy}
          title={t('event.copyTooltip', { defaultValue: 'Copy this message' })}
          style={{
            // Same 6px top margin AgentModelBadge carries, so the two chips sit
            // on one baseline whether or not the badge is rendered.
            marginTop: 6,
            padding: '2px 8px',
            border: '2px solid var(--border)',
            background: 'var(--bg-elevated)',
            color: copied ? 'var(--accent)' : 'var(--text-muted)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            cursor: 'pointer',
            // Stay visible while COPIED is showing — otherwise the confirmation
            // vanishes the instant the pointer leaves to go read the paste.
            opacity: hovered || copied ? 1 : 0,
            pointerEvents: hovered || copied ? 'auto' : 'none',
            transition: 'opacity 120ms ease-out',
          }}
        >
          {copied ? t('event.copied', { defaultValue: 'COPIED' }) : t('event.copy', { defaultValue: 'COPY' })}
        </button>
      </div>
    </div>
  )
}

function EventRow({ event, eventId, cardStates, onApprove, onApply, onCancel, origin, onPreview, workingDir }: EventRowProps) {
  const { t } = useTranslation('agent')
  switch (event.type) {
    case 'user-text': {
      // F4: Check if this user-text event has a parsedCommand → render SlashCommandCard
      const userEv = event as AgentEvent & { type: 'user-text'; parsedCommand?: ParsedSlashCommand }
      const cardEntry = eventId && cardStates ? cardStates.get(eventId) : undefined
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          <div style={{
            alignSelf: 'flex-end',
            maxWidth: '78%',
            padding: '8px 12px',
            border: '2px solid var(--accent)',
            background: 'var(--accent-muted)',
            color: 'var(--text-primary)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 13,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            boxShadow: 'var(--shadow-soft)',
            marginBottom: 4,
          }}>
            {event.text}
          </div>
          {eventId && <TurnResetMenu eventId={eventId} />}
          {userEv.parsedCommand && cardEntry && eventId && (
            <div style={{ alignSelf: 'stretch' }}>
              <SlashCommandCard
                plan={cardEntry.plan}
                status={cardEntry.status}
                onApprove={() => {
                  if (cardEntry.plan && onApprove) onApprove(eventId, cardEntry.plan)
                }}
                onApply={() => {
                  if (cardEntry.plan && onApply) onApply(eventId, cardEntry.plan)
                }}
                onCancel={() => {
                  if (onCancel) onCancel(eventId)
                }}
              />
            </div>
          )}
        </div>
      )
    }
    case 'text':
      return (
        <AgentTextEvent
          text={event.text}
          origin={origin}
          onPreview={onPreview}
          workingDir={workingDir}
        />
      )
    case 'tool-call': {
      // Mini-terminal feel: parse Bash command from input JSON
      let displayInput = event.input
      let command: string | null = null
      try {
        const parsed = JSON.parse(event.input)
        if (parsed && typeof parsed.command === 'string') {
          command = parsed.command
        }
        if (parsed) displayInput = JSON.stringify(parsed, null, 0).slice(0, 200)
      } catch { /* keep raw */ }
      const isBash = event.name === 'Bash' || event.name.toLowerCase().includes('bash') || event.name.toLowerCase().includes('shell')
      if (isBash && command) {
        return (
          <div style={{
            border: '2px solid var(--border)',
            background: '#0a0a0a',
            fontFamily: 'JetBrains Mono, monospace',
            boxShadow: 'var(--shadow-soft)',
            marginBottom: 2,
          }}>
            <div style={{
              padding: '4px 10px',
              borderBottom: 'var(--border-width) solid var(--border)',
              background: 'var(--bg-elevated)',
              fontSize: 9, fontWeight: 700, color: 'var(--accent)',
              letterSpacing: '0.08em', textTransform: 'uppercase',
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <span>▶ {event.name}</span>
              <span style={{ color: 'var(--text-dim)', fontSize: 8 }}>{t('event.running')}</span>
            </div>
            <pre style={{
              margin: 0, padding: '6px 10px', color: '#a0e0a0',
              fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>$ {command}</pre>
          </div>
        )
      }
      return (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 8,
          padding: '6px 10px',
          background: 'var(--bg-elevated)', border: '2px solid var(--border)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 12, color: 'var(--text-muted)',
          boxShadow: 'var(--shadow-soft)',
        }}>
          <span style={{ color: 'var(--accent)' }}>▶</span>
          <span><strong style={{ color: 'var(--accent)' }}>{event.name}</strong>({displayInput})</span>
        </div>
      )
    }
    case 'tool-done': {
      const isDiff = event.output.startsWith('--- ') || event.output.startsWith('diff --git')
      const isWriteTool = FILE_WRITE_TOOLS.test(event.name)
      if (isDiff || isWriteTool) {
        // Try to extract the written file path from the tool input JSON.
        // A harness Write tool input typically has { path: '...' } or { file_path: '...' }.
        // We attempt to look at event.input (if available through the tool-call pair).
        // Since tool-done doesn't carry input, we parse the output for a path hint.
        // Fallback: render a [PREVIEW] button when file name is detectable from output.
        const writtenPath = (() => {
          // Common pattern: output contains "Wrote <path>" or "Created <path>"
          const m = event.output.match(/(?:Wrote|Created|Updated|Saved) ['"]?([^\s'"]+)['"]?/i)
          if (m?.[1]) {
            const p = m[1]
            // If relative, prefix with workingDir
            if (workingDir && !p.match(/^[a-zA-Z]:\\|^\//)) {
              return workingDir.replace(/\\/g, '/') + '/' + p
            }
            return p
          }
          return null
        })()
        const canPreview = writtenPath && isPreviewable(writtenPath)
        return (
          <div>
            <DiffCard name={event.name} diff={event.output} />
            {canPreview && onPreview && (
              <button
                onClick={() => onPreview(writtenPath)}
                title={t('event.previewTooltip', { path: writtenPath })}
                style={{
                  marginTop: 4,
                  padding: '3px 10px',
                  border: '2px solid var(--accent)',
                  background: 'transparent',
                  color: 'var(--accent)',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 10, fontWeight: 700,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  cursor: 'pointer',
                }}
              >
                {t('event.preview')}
              </button>
            )}
          </div>
        )
      }
      // Mini-terminal output for command-line tools
      return (
        <div style={{
          marginLeft: 18, marginTop: -2,
          border: '2px solid var(--border)',
          borderTop: 'none',
          background: '#0a0a0a',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11, color: '#e0e0e0',
          maxHeight: 260, overflowY: 'auto',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          padding: '6px 10px',
          boxShadow: 'var(--shadow-soft)',
          marginBottom: 4,
        }}>
          {event.output || <span style={{ color: 'var(--text-dim)' }}>{t('event.noOutput')}</span>}
        </div>
      )
    }
    case 'fusion-panel':
      return <FusionPanelStrip members={event.members} judge={event.judge} mode={event.mode} brief={event.brief} providerId={event.providerId} />
    case 'error': {
      const fe = friendlyError(t, event.message)
      return (
        <div style={{
          padding: '8px 12px', borderRadius: 0,
          background: 'color-mix(in srgb, var(--danger) 10%, transparent)', border: 'var(--border-width) solid var(--danger)',
          color: 'var(--danger)', fontSize: 13,
        }}>
          <div>{fe.title}</div>
          {fe.detail && (
            <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>{fe.detail}</div>
          )}
        </div>
      )
    }
    case 'done':
      // GAVE-UP DETECTION: the checkmark is a CLAIM, and the harness now knows
      // when that claim is false. An ENDED-INCOMPLETE run gets the amber badge
      // (+ CONTINUE) here instead — this line is the exact spot where two real
      // give-ups were rendered as "✓ Done (stop)".
      if (event.incomplete) {
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
            <IncompleteBadge detail={event.incompleteDetail} nudged={event.nudged} compact />
            {event.incompleteDetail && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{event.incompleteDetail}</div>
            )}
          </div>
        )
      }
      // …and the checkmark is equally a claim about REASON. A harness that
      // failed ends on `done reason:'error'` (TACHI has always; OpenClaude now
      // too) and a run the user stopped ends on `'abort'` — neither is a
      // success, and both used to render as "✓ Done (error)" / "✓ Done (abort)".
      // The cause is already on screen: the error card sits directly above this
      // row and names it, so this line only has to stop contradicting it.
      if (event.reason === 'error') {
        return (
          <div style={{ fontSize: 13, color: 'var(--danger)', fontStyle: 'italic' }}>
            ✗ {t('event.failed', { defaultValue: 'Run failed' })}
          </div>
        )
      }
      if (event.reason === 'abort') {
        return (
          <div style={{ fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic' }}>
            ■ {t('event.stopped', { defaultValue: 'Stopped' })}
          </div>
        )
      }
      return (
        <div style={{ fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic' }}>
          ✓ {t('event.done', { reason: event.reason })}
        </div>
      )
    default:
      return null
  }
}

// ── ActiveChainRow ────────────────────────────────────────────────────────────
//
// Brutalist "what's actually running this agent" badge row, plus a quick
// shortcut to the Nodes editor where the user can rewire the flow.
//
// Reads from agent.store (harness/provider/bankrModel) and infers the
// effective routing the sidecar will use. The full resolution lives in
// sidecar-manager.ts / tachi/provider.ts (explicit override → OpenGateway key
// → Bankr key (TACHI) → freellmapi; opengateway pins OPENGATEWAY_AGENT_MODEL)
// but here we just surface what the user *picked*; the actual runtime
// provider lands in the dev log as `[openclaude] starting with provider: …`.
function ActiveChainRow({
  harness,
  provider,
  bankrModel,
  surplusModel,
  veniceModel,
  imgnaiModel,
}: {
  harness:    HarnessId
  provider:   AgentProvider
  bankrModel: string
  surplusModel?: string
  veniceModel?: string
  imgnaiModel?: string
}) {
  const { t } = useTranslation('agent')
  const navigate = useNavigate()
  const harnessChips = ([
    { id: 'tachi' as const,      label: 'TACHI',      color: 'var(--accent)' },
    { id: 'openclaude' as const, label: 'OpenClaude', color: 'var(--warning)' },
    { id: 'darksol' as const,    label: 'DarkSol',    color: 'var(--info)' },
    { id: 'codex' as const,      label: 'Codex',      color: 'var(--info)' },
  ]).filter(h => harness === h.id)

  // Provider label — what the user explicitly chose. The real fallback
  // ladder (OpenGateway > Bankr-auto > freellmapi) lives in main; we just
  // hint at the chosen lane here. The opengateway model is derived from the
  // harnesses' shared pin, never hand-written.
  // Venice/imgnAI were MISSING from this chain and fell through to the
  // "Default (best stored key, else free local router)" arm — so a run that was
  // genuinely routed to Venice (agent.ipc.ts sets the venice override, and
  // tachi/provider.ts honours it) announced itself as the default ladder. The
  // routing was always right; only this label lied. Reported live 2026-08-02.
  const providerLabel = provider === 'bankr'
    ? `Bankr · ${modelDisplayName(bankrModel)}`
    : provider === 'surplus'
    ? `Surplus · ${modelDisplayName(surplusModel ?? 'claude-sonnet-4.5')}`
    : provider === 'venice'
    ? `Venice · ${modelDisplayName(veniceModel ?? '')}`
    : provider === 'imgnai'
    ? `imgnAI · ${modelDisplayName(imgnaiModel ?? '')}`
    : provider === 'opengateway'
    ? `OpenGateway · ${modelDisplayName(OPENGATEWAY_AGENT_MODEL)}`
    : t('chain.default')

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      marginBottom: 8,
      flexWrap: 'wrap',
    }}>
      <span style={{
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
        textTransform: 'uppercase', color: 'var(--text-dim)',
      }}>
        {/* ROUTE, not RUNNING. This row renders whenever a working directory is
            set — before a run, between runs, after a failed one — so a caption
            reading "RUNNING" claimed a live state from a component that has no
            idea whether anything is executing. The key was renamed with the
            word: a key called `running` is why eight locales translated it as
            a present-tense status. */}
        {t('chain.route')}
      </span>
      {harnessChips.map(h => (
        <span key={h.id} style={{
          padding: '2px 6px',
          border: `2px solid ${h.color}`,
          background: 'transparent',
          color: h.color,
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
          textTransform: 'uppercase',
        }}>
          {h.label}
        </span>
      ))}
      <span style={{
        padding: '2px 6px',
        border: '2px solid var(--border)',
        background: 'var(--bg-elevated)',
        color: 'var(--text-primary)',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 10,
      }}>
        {providerLabel}
      </span>
      <span style={{ flex: 1 }} />
      <button
        onClick={() => navigate('/nodes')}
        title={t('chain.editTooltip')}
        style={{
          padding: '3px 10px',
          border: '2px solid var(--accent)',
          background: 'transparent',
          color: 'var(--accent)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
          textTransform: 'uppercase',
          cursor: 'pointer',
        }}
      >
        ▸ {t('chain.edit')}
      </button>
    </div>
  )
}

const sendBtn: React.CSSProperties = {
  padding: '10px 16px', borderRadius: 0, border: 'none', cursor: 'pointer',
  background: 'var(--accent)', color: 'var(--bg-base)', fontWeight: 700, fontSize: 16,
}
const abortBtn: React.CSSProperties = {
  padding: '10px 16px', borderRadius: 0, border: 'var(--border-width) solid var(--border)', cursor: 'pointer',
  background: 'var(--bg-elevated)', color: 'var(--danger)', fontWeight: 700,
}

// ── PairedMessageList ────────────────────────────────────────────────────────
//
// A6 cont. — wraps the pairing pass + render in a memoized child so re-renders
// caused by unrelated state (status badge tick, drag overlay, etc.) don't
// re-execute the sweep over the full message history. The key invariant is
// "messages array identity" — agent.store appends immutably, so a new array
// reference is the cheapest trigger for re-computation.
//
// F4: cardStates, onApprove, onApply, onCancel threaded through to EventRow so
// slash-command cards can be rendered below user-text events without lifting the
// pairing logic or adding global state.
interface PairedMessageListProps {
  messages:   AgentMessageItem[]
  cardStates: Map<string, CardEntry>
  onApprove:  (cardId: string, plan: SlashCommandResult) => void
  onApply:    (cardId: string, plan: SlashCommandResult) => void
  onCancel:   (cardId: string) => void
  // NO session-identity props. The badge's facts ride on each message (see
  // AgentRunOrigin); threading the live selection through here is exactly how a
  // finished transcript came to re-label itself.
  /** Open PreviewPanel for a file path. */
  onPreview?:  (filePath: string) => void
  workingDir?: string
}

const PairedMessageList = React.memo(function PairedMessageList({
  messages,
  cardStates,
  onApprove,
  onApply,
  onCancel,
  onPreview,
  workingDir,
}: PairedMessageListProps) {
  const blocks = useMemo(() => pairToolEvents(messages), [messages])
  return (
    <>
      {blocks.map(block => {
        // Each block animates in once on mount (keyed, so streaming re-renders
        // don't re-trigger it) — the soft entrance modern chat UIs have.
        const inner = block.kind === 'tool'
          ? (
            <ToolCallBlock
              name={block.name}
              input={block.input}
              output={block.output}
              running={block.running}
              aborted={block.aborted}
              durationMs={block.durationMs}
              progress={block.progress}
            />
          )
          : block.kind === 'group'
            ? <ToolGroupSummary tools={block.tools} />
            : (
              <EventRow
                event={block.event}
                eventId={block.id}
                cardStates={cardStates}
                onApprove={onApprove}
                onApply={onApply}
                onCancel={onCancel}
                origin={block.origin}
                onPreview={onPreview}
                workingDir={workingDir}
              />
            )
        return <div key={block.id} className="tachi-msg-in">{inner}</div>
      })}
    </>
  )
})
