// apps/desktop/src/store/agent.store.ts
//
// Agent session state + persistent history of past sessions.
//
// "Live" state mirrors the current/in-progress agent invocation (workingDir,
// status, streaming messages, etc). "Past sessions" is an archive of
// completed sessions persisted to localStorage so the user can scroll back
// through prior tasks. A past session can be VIEWED read-only (viewArchive) or
// CONTINUED (resumeArchive) — the latter restores its transcript + workspace
// into the editable live area so the user can pick the task back up; AgentPage
// then starts a fresh harness session in that workspace. (The model doesn't get
// a token-level resume of the old turns — the workspace itself is the context —
// but the transcript is preserved and the composer is re-enabled.)
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { AgentEvent } from '@tachi/core'
import { createEncryptedStorage } from './encryptedStorage'
// The permission QUEUE lives here rather than in AgentPage: see `permissionQueue`
// below. These are the pure ordering/dedup reducers (leaf module, type-only
// import of the card shape — no component code is pulled into the store).
import { enqueuePermission, resolvePermission, dropPermissions } from '../pages/agent/permissionQueue'
import type { PermissionRequest } from '../pages/agent/PermissionCard'
// FOLLOW-UP PROMPT QUEUE (plan A1a) — same shape of decision as the permission
// queue, so the same discipline: the reducers are a pure leaf module and only
// the slice lives here.
import {
  enqueuePrompt, dequeuePrompt, removePrompt, promptSurfaceKey, PROMPT_QUEUE_CAP,
  type QueuedPrompt, type PromptSurface,
} from '../pages/agent/promptQueue'
// PER-TURN FILE CHECKPOINTS (plan A2) — same discipline again: the binding and
// the three-way RESET decisions are a pure leaf module, the store only holds
// the state and applies them.
import { stampTurnCheckpoint, pruneTurnCheckpoints, type TurnCheckpoint } from '../pages/agent/turnReset'
export type { TurnCheckpoint } from '../pages/agent/turnReset'
// ONE resolver for "how big is this model's window" (see modelWindow.store) —
// imported, never re-derived, so the CODE surfaces and the CHAT chip answer
// from the same published fact.
import { useContextWindow } from './modelWindow.store'
import type { ResolvedContextWindow } from '@tachi/core/src/tachi/models'
import { OPENGATEWAY_AGENT_MODEL } from '@tachi/core/src/providers/agent-route'

export type AgentStatus = 'idle' | 'starting' | 'running' | 'done' | 'error'

/**
 * Harnesses a NEW run can be dispatched on.
 *
 * The Goose harness was REMOVED from the product (TACHI, the first-party
 * harness, supersedes it) — and with it 'both', which only ever meant
 * "Goose + OpenClaude". Neither can be selected or dispatched any more.
 */
export const HARNESS_IDS = ['tachi', 'openclaude', 'darksol', 'codex'] as const
export type HarnessId   = typeof HARNESS_IDS[number]

/** The default harness for a fresh install / an unrecognised persisted value. */
export const DEFAULT_HARNESS: HarnessId = 'tachi'

/**
 * Harness ids that exist ONLY in already-persisted data (localStorage
 * preference, archived sessions). Kept as a named type so the places that read
 * stored data are honest about what they may find.
 */
export type LegacyHarnessId = 'goose' | 'both'

/**
 * Coerce a stored/unknown harness id into a dispatchable one.
 *
 * GRACEFUL LEGACY DATA: an archived session or a persisted preference from
 * before the Goose removal can still say 'goose' / 'both'. Restoring one must
 * neither crash nor silently start a harness that no longer exists, so it lands
 * on the default (TACHI). Pure + exported for unit testing.
 */
export function normalizeHarness(h: unknown): HarnessId {
  return (HARNESS_IDS as readonly string[]).includes(h as string)
    ? (h as HarnessId)
    : DEFAULT_HARNESS
}
/** Plan = outline/describe before executing; Build = execute immediately */
export type AgentMode   = 'plan' | 'build'
/** Thinking depth for Anthropic extended thinking: normal = off, think = 4k budget, ultra = 32k budget */
export type ThinkingDepth = 'normal' | 'think' | 'ultra'

/** Trust preset (UX #8): safe = ask every mutation, standard = today's ladder,
 *  auto = non-destructive bash sails through too. Enforced server-side. */
export type TrustLevel = 'safe' | 'standard' | 'auto'
/**
 * Which gateway powers the harness's LLM calls:
 *   default     → key ladder: OpenGateway key → Bankr key (TACHI only) →
 *                 local freellmapi router. THE decision is
 *                 pickDefaultAgentRoute (@tachi/core agent-route.ts) — labels
 *                 derive from it, never restate it.
 *   opengateway → force gitlawb's OpenGateway on OPENGATEWAY_AGENT_MODEL
 *                 (@tachi/core agent-route.ts — verified free); no
 *                 Bankr/freellmapi fallback
 *   bankr       → llm.bankr.bot/v1 with the user's Bankr Gateway key
 *   surplus     → surplusintelligence.ai marketplace with the user's inf_* key
 *   imgnai      → kat.imgnai.com/v1 (imgnAI Katana) with the user's combined credential
 */
export type AgentProvider = 'default' | 'opengateway' | 'bankr' | 'surplus' | 'venice' | 'imgnai'

/**
 * A saved Nodes-canvas workflow bound to the Code tab. When set, the Code
 * composer RUNS this graph (compile + execute the agent-kit network) instead
 * of starting a normal single-harness session — "save a node setup, run it
 * right in the Code chat". null = normal agent mode.
 */
export interface ActiveWorkflow {
  /** Saved flow filename under userData/nodes (passed to nodes.loadFlow). */
  filename: string
  /** Display name shown in the Code tab banner + selector. */
  name: string
}

/**
 * PROVENANCE — WHO produced a transcript message.
 *
 * Parked at SEND (`setRunOrigin`, after the provider/model are resolved) and
 * stamped onto every message `appendEvent` creates. Read back from the MESSAGE
 * at render time; never derived from the live selection.
 *
 * WHY (driver-proven 2026-08-02): the transcript badge took `harness` /
 * `provider` / `*Model` as props from the CURRENT store selection, so clicking
 * the OpenClaude agent chip retroactively relabelled a finished TACHI
 * transcript `[OPENCLAUDE · VENICE · …]` — same messages, same 33 ms/10 ms tool
 * timings, different attribution. Provenance that rewrites itself is worse than
 * none. This is the exact fix chat took for its message chips on 2026-08-01
 * (4266c62): park at send, stamp on the message, delete the prop so the guess
 * cannot come back.
 *
 * PERSISTED as part of an archived session's messages. ABSENT on every message
 * written before this shipped — those render with NO badge rather than a guess.
 * `harness` is widened with LegacyHarnessId for the same reason PastAgentSession
 * is: an archive may carry an id the product no longer dispatches.
 */
export interface AgentRunOrigin {
  harness:  HarnessId | LegacyHarnessId
  provider: AgentProvider
  /** Concrete model id the run was routed to; omitted when the route is unknown. */
  model?:   string
}

export interface AgentMessage {
  id:        string
  event:     AgentEvent
  timestamp: number
  /** Who produced it — see AgentRunOrigin. Absent on pre-stamp messages. */
  origin?:   AgentRunOrigin
}

/**
 * Which surface owns a session. undefined/null = the normal Code tab;
 * 'tachiapp' = the pinned self-improvement chat (folder-free, app source).
 * Kept as a tag rather than a second store so both surfaces share ONE live
 * session + ONE archive, and each rail filters to its own sessions.
 */
export type AgentSessionTag = 'tachiapp'

/**
 * Snapshot of a completed (or interrupted) agent session. Stored in
 * pastSessions for browsing in the history rail.
 */
export interface PastAgentSession {
  id:         string
  title:      string
  workingDir: string | null
  /**
   * Recorded harness. Widened with LegacyHarnessId because sessions archived
   * before the Goose removal still carry 'goose' / 'both': the rail DISPLAYS
   * whatever is stored (unknown ids render as plain text), and continuing such
   * a session goes through normalizeHarness() so nothing dead is dispatched.
   */
  harness:    HarnessId | LegacyHarnessId
  mode:       AgentMode
  status:     AgentStatus
  error:      string | null
  messages:   AgentMessage[]
  startedAt:  number
  endedAt:    number
  /** Surface that produced it — absent for plain Code-tab sessions. */
  tag?:       AgentSessionTag
}

/**
 * Split the archive by owning surface: the Code rail lists UNTAGGED sessions
 * (everything that existed before tagging, plus every normal Code session),
 * the TACHIAPP rail lists only `tag === 'tachiapp'`. Pure — one source of
 * truth for both rails, and unit-testable without rendering.
 */
export function sessionsForTag(
  sessions: readonly PastAgentSession[],
  tag?: AgentSessionTag,
): PastAgentSession[] {
  return sessions.filter(p => (tag ? p.tag === tag : !p.tag))
}

/**
 * What a surface must do with the LIVE slot when it mounts.
 *
 * /agent and /tachiapp are two ROUTES over ONE store: the transcript, the
 * harness sessionId and the workspace all live here. Before this decision
 * existed, switching CODE → TACHIAPP left the Code session in place, so the
 * Code transcript rendered under the TACHIAPP header AND the next send there
 * reused the Code session id, the Code workspace and the Code transcript as
 * replayed history — then re-archived the merged conversation onto the Code
 * rail. Each surface therefore claims the slot on mount:
 *
 *   'own'   — the live session already belongs to this surface: do nothing.
 *   'claim' — foreign but EMPTY (nothing to keep): just stamp the tag.
 *   'park'  — foreign and non-empty: ARCHIVE it (never discard — it reappears
 *             on its own rail, continuable), THEN stamp the tag. Order matters:
 *             the snapshot must still carry the outgoing surface's tag.
 *   'busy'  — foreign and MID-RUN: touch nothing. Yanking a working session
 *             would orphan a run the user is waiting on; the surface shows a
 *             "run in progress" note and re-decides when the run ends.
 *
 * Pure so both surfaces share one rule and it is testable without rendering.
 */
export type SurfaceBind = 'own' | 'claim' | 'park' | 'busy'

export function surfaceBindDecision(input: {
  /** Tag of the MOUNTING surface — null = the Code tab. */
  surface:        AgentSessionTag | null
  /** Tag stamped on the live session (null = Code / never claimed). */
  sessionTag:     AgentSessionTag | null
  status:         AgentStatus
  hasSession:     boolean
  hasMessages:    boolean
  viewingArchive: boolean
}): SurfaceBind {
  if (input.sessionTag === input.surface) return 'own'
  // Browsing a foreign archive is not a live run — leaving the view is
  // lossless (the entry stays in pastSessions), so park it like any other.
  if (input.viewingArchive) return 'park'
  if (input.status === 'running' || input.status === 'starting') return 'busy'
  if (!input.hasSession && !input.hasMessages) return 'claim'
  return 'park'
}

// ── D4: Context window constants ─────────────────────────────────────────────
//
// THERE IS NO PER-PROVIDER CONTEXT-WINDOW TABLE HERE, AND ADDING ONE BACK IS
// THE BUG. A window is a per-MODEL fact — Venice alone spans 32k…1M behind one
// provider id — so any table keyed by provider is wrong for most of its rows by
// construction. One lived here until 2026-08-03 and told every Venice model it
// had 32,000 tokens while the picker beside it showed the real number; removing
// it took four commits because four surfaces had each grown their own reader.
// The last of those readers was this store's own `contextFillPct`, which had no
// callers left and survived purely as a working example of how to do it wrong.
//
// Ask src/store/modelWindow.store.ts → resolveContextWindow() instead. It
// answers per model, reports whether the number is KNOWN and where it came
// from, and returns null rather than inventing one.

/**
 * THE window the LIVE CODE session is running against, or null when nobody
 * published one for the routed model.
 *
 * One function so the three surfaces that draw this session's context load —
 * the CODE tab's ContextMeter, the chassis sidebar's CTX gauge and the OPUS-5
 * frame's segmented readout — divide by the SAME number. They used to divide by
 * `PROVIDER_MAX_TOKENS` / `DEFAULT_MAX_TOKENS`, i.e. by 32,000 whatever was
 * routed, and a driver read `0% of ~32,000 tokens` for a Venice model Venice
 * serves at 200,000.
 *
 * null is a real answer and every caller must honour it: show tokens with no
 * percentage, omit the row, leave the ladder dark — never substitute a number.
 * The provider ids here are the ones the model pickers RECORD under, which is
 * what makes the lookup hit.
 *
 * It returns the RESOLVED WINDOW, not just the number. It used to return
 * `win.known ? win.tokens : null`, which threw `source` away at the one place
 * two instrument faces read it — so a gauge percentage and a lit LED ladder were
 * drawn from a catalog row with no way left for either to say so. `known` is
 * permission to DIVIDE; `source` is what has to be shown next to the result.
 */
export function useAgentContextWindow(): ResolvedContextWindow | null {
  const provider     = useAgentStore(s => s.provider)
  const bankrModel   = useAgentStore(s => s.bankrModel)
  const surplusModel = useAgentStore(s => s.surplusModel)
  const veniceModel  = useAgentStore(s => s.veniceModel)
  const imgnaiModel  = useAgentStore(s => s.imgnaiModel)
  const providerId = provider === 'bankr' ? 'bankr-gateway' : provider === 'default' ? '' : provider
  const modelId =
    provider === 'bankr'         ? bankrModel
    : provider === 'surplus'     ? surplusModel
    : provider === 'venice'      ? veniceModel
    : provider === 'imgnai'      ? imgnaiModel
    : provider === 'opengateway' ? OPENGATEWAY_AGENT_MODEL
    : ''
  const win = useContextWindow(providerId, modelId)
  return win.known ? win : null
}

export type ContextZone = 'green' | 'yellow' | 'red'

export function getContextZone(pct: number): ContextZone {
  if (pct >= 0.85) return 'red'
  // Amber from 60% (UX F15): the meter should warn while there is still
  // headroom to act (compact / new session), not when it is already too late.
  if (pct >= 0.60) return 'yellow'
  return 'green'
}

interface AgentStore {
  // ── Live (in-flight) session ─────────────────────────────────────────────
  workingDir:    string | null
  /**
   * WORKSPACE MEMORY for the CODE surface — the last folder the operator chose
   * THERE (never the TACHIAPP app source).
   *
   * Claiming the live slot for Code drops an inherited workingDir on purpose:
   * the app source must never become "the folder you are working in" just
   * because you visited the self-improvement chat. The cost was that a
   * CODE → TACHIAPP → CODE round trip also threw away the folder the operator
   * had picked themselves, landing back on "Choose folder…". This remembers it
   * so the Code surface can re-resolve its own workspace on the way back.
   *
   * Persisted (a preference, like harness/provider); re-validated against disk
   * before it is ever restored — a folder that has been moved or deleted must
   * never silently come back.
   */
  lastCodeWorkingDir: string | null
  sessionId:     string | null
  status:        AgentStatus
  messages:      AgentMessage[]
  error:         string | null
  harness:       HarnessId
  mode:          AgentMode
  /** Which LLM gateway powers the harness this session. */
  provider:      AgentProvider
  /** Selected Bankr catalog model id (only used when provider === 'bankr'). */
  bankrModel:    string
  /** Selected Surplus catalog model id (only used when provider === 'surplus'). */
  surplusModel:  string
  /** Selected Venice catalog model id (only used when provider === 'venice'). */
  veniceModel:   string
  /** Selected imgnAI catalog model id (only used when provider === 'imgnai'). */
  imgnaiModel:   string
  /** Surplus smart router: auto-pick a tool-reliable model for the Code session. */
  surplusSmartRouting: boolean
  /**
   * PROVENANCE, parked. The identity the CURRENT run was dispatched with —
   * stamped onto every message `appendEvent` creates, then read back from the
   * message when the badge renders. Same park-then-stamp idiom chat uses for
   * `pendingProvider`.
   *
   * Live state, deliberately NOT persisted: it describes a run, and a run does
   * not survive a reload. What IS persisted is the stamp already on the
   * messages, which is the whole point — the fact travels with the transcript,
   * not with the picker.
   */
  runOrigin:     AgentRunOrigin | null
  /** When set, the Code composer runs this saved Nodes workflow instead of a
   *  normal harness session. null = normal agent mode. */
  activeWorkflow: ActiveWorkflow | null
  /**
   * Which surface owns the LIVE session — stamped onto the archive snapshot so
   * each rail (Code vs TACHIAPP) lists only its own history. Set by whichever
   * AgentPage instance is mounted; never persisted (it is live state).
   */
  sessionTag:    AgentSessionTag | null
  /**
   * CONNECTION RESILIENCE. Non-null while the harness is reconnecting after a
   * dropped stream — the Code status line shows "CONNECTION LOST — RETRYING
   * n/10 (next in Xs)" instead of looking frozen. Cleared the moment the
   * re-requested round streams again, and on any terminal event. Deliberately
   * NOT persisted and NOT a message: it is live status, not transcript.
   */
  reconnect:     { attempt: number; maxAttempts: number; delayMs: number; reason: string } | null
  /**
   * LOOP MODE. Non-null while a `/loop` run is cycling — the status line shows
   * a "LOOP n/cap" chip with a STOP LOOP button. Like `reconnect` this is live
   * status, not transcript: never a message, never persisted, always cleared on
   * a terminal event.
   */
  loop:          { iteration: number; cap: number; goal: string } | null
  /**
   * GAVE-UP DETECTION. Non-null when the LAST run ended via a provider `stop`
   * that the harness's end-state classifier refused to call a success — no
   * accepted completion call, nothing said, or a mutating-intent task that
   * changed nothing. The status area then shows an amber "ENDED WITHOUT
   * COMPLETING" badge with a CONTINUE affordance instead of the success badge.
   * Live status, like `reconnect`/`loop`: never persisted, cleared the moment a
   * new run starts. `nudged` records that the harness already spent its one
   * automatic continuation on this run.
   */
  endedIncomplete: { code?: string; detail?: string; nudged?: boolean } | null
  /**
   * PERMISSION QUEUE — prompts main is blocked on, oldest first.
   *
   * Lives in the STORE, not in AgentPage state. A live /loop run raised a card
   * for the derived verify check; the operator switched CODE → NODES → CODE,
   * AgentPage unmounted, and with the queue as component state the card was
   * gone FOREVER while main kept awaiting its resolver. Store state survives the
   * unmount, and the APP-LIFETIME bridge (src/store/agentEventBridge.ts) both
   * keeps FILLING it while no page is mounted and re-syncs from main at renderer
   * startup (agent:permission-pending), so even a reload gets the cards back.
   *
   * Live state: never persisted (a resolver only exists in THIS main process).
   */
  permissionQueue: PermissionRequest[]
  /**
   * REVERT AFFORDANCE — the workspace checkpoint the harness auto-takes right
   * before it first touches a file in a run (`checkpoint` event). Lives here,
   * not in AgentPage state, for the same reason the permission queue does: the
   * event that carries it is delivered to an APP-LIFETIME listener
   * (`startAgentEventBridge`), which has no component to hand it to. AgentPage
   * renders the ↺ REVERT button from this field.
   *
   * Live state — never persisted: the checkpoint is a directory in userData
   * owned by a main process that no longer exists after a restart. It is also
   * SCOPED TO THE LIVE SESSION (cleared by reset/startNewSession/resume/close):
   * as component state it used to die with the unmount, and now that it
   * survives navigation a leftover would leave ↺ REVERT pointing at the
   * PREVIOUS workspace — one click away from restoring the wrong folder.
   */
  revertCheckpoint: { id: string; root: string; label: string } | null
  /**
   * PER-TURN CODE CHECKPOINTS (plan A2) — one entry per USER TURN, newest
   * first, binding that turn's `AgentMessage.id` to the workspace snapshot main
   * took immediately before running it.
   *
   * `revertCheckpoint` above is a SINGLE slot overwritten every turn, which is
   * why the only affordance it could ever power was one global ↺ REVERT ("undo
   * whatever the agent last did"). This list is what makes the per-message
   * three-way RESET possible: RESET CODE on turn 2 of a 5-turn session restores
   * exactly the tree turn 2 started from.
   *
   * Entries with `cpId === null` are kept ON PURPOSE: they record that a turn
   * ran with NO undo (non-git root over the backup caps, or a failed snapshot)
   * so the menu can say so instead of offering a button that no-ops.
   *
   * Live state, never persisted, and scoped to the live session exactly like
   * `revertCheckpoint` — a checkpoint id is meaningless after the main process
   * that owns it exits, and a leftover from the previous workspace would point
   * RESET CODE at the wrong folder.
   */
  turnCheckpoints: TurnCheckpoint[]
  /**
   * FOLLOW-UP PROMPTS typed while a run is in flight, per SURFACE.
   *
   * Before this existed, `sendTask` hard-returned while `isRunning` — typing
   * during a run did nothing at all, so the operator had to wait, remember, and
   * retype. Enter now QUEUES, and the page drains ONE entry at the run's
   * terminal `done` (see `shouldDrainPrompt`; mid-run steering is deliberately
   * not in v1).
   *
   * Keyed by surface, not by session: the two AgentPage routes share one live
   * slot but are two conversations, and a follow-up typed on TACHIAPP must never
   * fire into a CODE run. Capped at PROMPT_QUEUE_CAP — a full queue REFUSES
   * rather than dropping the oldest, because silently losing an instruction the
   * operator watched go in is worse than saying no.
   *
   * Live state, never persisted: a queued follow-up describes a run that no
   * longer exists after a restart.
   */
  pendingPrompts: Record<PromptSurface, QueuedPrompt[]>
  /**
   * PAUSE LATCH per surface. Set when the operator presses STOP (stop means "I
   * want to intervene" — auto-firing the queue is the opposite) or when the run
   * ends in `error` (a dead session would swallow every queued prompt into a
   * fresh error). Cleared by the operator's RESUME, and by anything that starts
   * a genuinely new conversation.
   */
  promptQueuePaused: Record<PromptSurface, boolean>
  /** D6: Thinking depth — controls Anthropic extended thinking budget. */
  depth:         ThinkingDepth
  /** UX #8: SAFE/STANDARD/AUTO approval preset for the TACHI gate. */
  trust:         TrustLevel
  /**
   * Fusion-at-plan toggle for the Code tab. When ON (and the provider is one of
   * bankr/surplus/venice, where the harness exposes the fuse_plan/consult_panel
   * advisor tools), each send nudges the agent to consult the model panel and
   * synthesize its plan before executing. Off by default. */
  fusionPlan:    boolean
  startedAt:     number | null

  // ── D4: Context window tracking ──────────────────────────────────────────
  /** Cumulative input chars per conversationId (chat conversations, keyed by ID). */
  contextChars:      Record<string, number>
  /** Set of conversationIds where the red-zone handoff has already fired (no repeat). */
  redZoneTriggered:  Set<string>

  // ── Archive ──────────────────────────────────────────────────────────────
  pastSessions:    PastAgentSession[]
  /** When non-null, the messages array reflects this archive entry in read-only mode. */
  viewingArchiveId: string | null
  /**
   * AUTO-SELECT ON RETURN. Keyed by owning surface ('code' for the untagged
   * Code tab, 'tachiapp' for the pinned chat): the id of the archive entry
   * that surface's LIVE session most recently parked into, while the operator
   * was on the OTHER surface (or elsewhere) — recorded by the ownership
   * effect in AgentPage right after a genuine foreign park (never on an
   * explicit "+ New" click, and never for the lossless close-of-a-foreign-
   * archive-view park, which snapshots nothing new). The owning surface's next
   * mount reads + clears it (`takeParkedSession`) to auto-open that entry
   * instead of a blank composer, but only while it would otherwise show an
   * idle/empty state — never over a session the operator already started.
   * Live state: never persisted (an id from the last run is not worth
   * restoring across an app restart).
   */
  lastParkedSession: { code: string | null; tachiapp: string | null }

  // ── Mutators for the live session ────────────────────────────────────────
  setWorkingDir(dir: string | null): void
  setSession(sessionId: string | null): void
  setStatus(status: AgentStatus, error?: string): void
  setHarness(h: HarnessId): void
  setMode(m: AgentMode): void
  setProvider(p: AgentProvider): void
  setBankrModel(m: string): void
  setSurplusModel(m: string): void
  setVeniceModel(m: string): void
  setImgnaiModel(m: string): void
  setSurplusSmartRouting(v: boolean): void
  /**
   * Park the identity THIS run is dispatched with. Call it at SEND, after the
   * provider/model are resolved — everything appended afterwards carries it.
   */
  setRunOrigin(o: AgentRunOrigin | null): void
  setActiveWorkflow(w: ActiveWorkflow | null): void
  setSessionTag(tag: AgentSessionTag | null): void
  /** A prompt arrived from main (re-delivery of a queued id is a no-op). */
  pushPermission(req: PermissionRequest): void
  /** The user answered this one — drop its card. */
  settlePermission(id: string): void
  /** Main settled these without us (timeout / abort / answered elsewhere). */
  cancelPermissions(ids: readonly string[]): void
  /**
   * Re-sync from main's outstanding list (bridge startup). Missing requests are
   * added; the ones we already show keep their position.
   *
   * `prunable` bounds what may be REMOVED — pass the queue as it looked when the
   * IPC round-trip STARTED. A card pushed while that round-trip was in flight is
   * not in main's snapshot, and dropping it would strand the tool waiting on it:
   * exactly the hang this queue exists to prevent. Omit it only when the caller
   * knows `reqs` is authoritative (tests).
   */
  syncPermissions(reqs: readonly PermissionRequest[], prunable?: readonly string[]): void
  /** A `checkpoint` event arrived (or the user consumed the revert → null). */
  setRevertCheckpoint(cp: { id: string; root: string; label: string } | null): void
  /**
   * Bind a workspace snapshot to the LAST user turn in the transcript.
   *
   * `cpId: null` records an UNPROTECTED turn (main took no snapshot) — that is
   * information the operator needs, not an error to swallow. No-ops when the
   * transcript has no user turn to bind to.
   */
  stampTurnCheckpoint(cp: { cpId: string | null; root: string; label?: string; unavailable?: string }): void
  /** The turn checkpoint bound to `messageId`, or null. */
  turnCheckpointFor(messageId: string): TurnCheckpoint | null
  /**
   * Queue a follow-up for `surface`. Returns false when it was REFUSED (empty
   * text or the cap is full) so the composer can say so instead of pretending.
   */
  queuePrompt(surface: PromptSurface, text: string): boolean
  /** Drop one queued follow-up (the ✕ on its chip). */
  unqueuePrompt(surface: PromptSurface, id: string): void
  /** Take the oldest follow-up for `surface` — FIFO, removed as it is read. */
  takeQueuedPrompt(surface: PromptSurface): QueuedPrompt | null
  /** Forget every queued follow-up for `surface` (also clears its pause latch). */
  clearQueuedPrompts(surface: PromptSurface): void
  /** Latch / release the auto-drain pause for `surface`. */
  setPromptQueuePaused(surface: PromptSurface, paused: boolean): void
  setDepth(d: ThinkingDepth): void
  setTrust(t: TrustLevel): void
  setFusionPlan(v: boolean): void
  appendEvent(event: AgentEvent): void
  clearMessages(): void
  /** Rewind/edit: drop `messageId` and every event after it; returns the user-text. */
  rewindTo(messageId: string): string
  reset(): void

  // ── D4: Context window actions ────────────────────────────────────────────
  /** Overwrite the running char count for a conversation. */
  setContextChars(conversationId: string, chars: number): void
  /** Add deltaChars to the running char count for a conversation. */
  bumpContextChars(conversationId: string, deltaChars: number): void
  /** Record that we have fired the red-zone handoff for this conversation. */
  markRedZoneTriggered(conversationId: string): void

  // ── History actions ──────────────────────────────────────────────────────
  /** Archive the current live session (if it has any messages) then reset. */
  startNewSession(): void
  /** Load a past session into the live area for read-only browsing. */
  viewArchive(id: string): void
  /**
   * Continue a past session: restore its transcript + workspace into the
   * EDITABLE live area (composer re-enabled), remove it from the archive, and
   * leave sessionId null so AgentPage can start a fresh harness session. The
   * archive's startedAt is preserved so it re-archives to the same logical
   * session on the next terminal status.
   */
  resumeArchive(id: string): void
  /** Exit read-only mode and return to the live session state. */
  closeArchive(): void
  /** Forget a past session. */
  deleteArchive(id: string): void
  /** Rename a past session. */
  renameArchive(id: string, title: string): void
  /** Record that `id` just parked onto `tag`'s rail (see `lastParkedSession`). */
  recordParkedSession(tag: AgentSessionTag | null, id: string): void
  /** Read + clear `tag`'s parked-session marker in one step — consumed once. */
  takeParkedSession(tag: AgentSessionTag | null): string | null
}

let _seq = 0
function randomId() {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `s-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * Derive a session title from its first user-typed task. Falls back to
 * "New session" if no user-text event is present yet.
 */
function deriveTitle(messages: AgentMessage[]): string {
  const firstUser = messages.find(m =>
    m.event.type === 'user-text' && typeof (m.event as { text?: string }).text === 'string',
  )
  if (firstUser) {
    const text = ((firstUser.event as { text: string }).text || '').trim()
    if (text) return text.length > 60 ? text.slice(0, 60) + '…' : text
  }
  // Fallback: first assistant text
  const firstText = messages.find(m =>
    m.event.type === 'text' && typeof (m.event as { text?: string }).text === 'string',
  )
  if (firstText) {
    const text = ((firstText.event as { text: string }).text || '').trim()
    if (text) return text.length > 60 ? text.slice(0, 60) + '…' : text
  }
  return 'New session'
}

function snapshotLive(s: AgentStore): PastAgentSession | null {
  if (s.messages.length === 0) return null
  return {
    id:         randomId(),
    title:      deriveTitle(s.messages),
    workingDir: s.workingDir,
    // The TACHIAPP surface always runs the first-party harness regardless of
    // the Code tab's persisted `harness` preference (AgentPage forces it at
    // spawn + send), so the archive must say 'tachi' — otherwise the rail
    // labels the session with an engine that never touched it, and continuing
    // it would restart on the wrong one.
    harness:    s.sessionTag === 'tachiapp' ? 'tachi' : s.harness,
    mode:       s.mode,
    status:     s.status,
    error:      s.error,
    messages:   s.messages,
    startedAt:  s.startedAt ?? Date.now(),
    endedAt:    Date.now(),
    // Omit the key entirely for plain Code sessions so existing archives (which
    // predate tagging) and new ones compare identically.
    ...(s.sessionTag ? { tag: s.sessionTag } : {}),
  }
}

/**
 * Is the live snapshot the SAME conversation as an existing archive entry?
 *
 * `startedAt` is the archive's dedup key everywhere else, but on its own it is
 * a wall-clock millisecond: two sessions started in the same tick would read as
 * one. The first message's id settles it — ids come from a monotonic
 * per-renderer sequence, so no two sessions ever share one.
 */
function isSameSession(snap: PastAgentSession, past: PastAgentSession): boolean {
  if (snap.startedAt !== past.startedAt) return false
  const a = snap.messages[0]?.id
  const b = past.messages[0]?.id
  return a !== undefined && a === b
}

/** Current BANKR agent default — the one value the migration chain lands on. */
export const DEFAULT_BANKR_MODEL = 'claude-opus-5'

/**
 * Ordered stale-default bumps for the persisted BANKR model, oldest first.
 * Applied as a CHAIN, so a user who last ran a 4.7-era build lands on the
 * current default in one pass (4.7 → 4.8 → 5) instead of one version behind.
 *   v0 → v1  claude-opus-4.7 → claude-opus-4.8  (d233c35)
 *   v1 → v2  claude-opus-4.8 → claude-opus-5    (Bankr now serves Claude 5)
 * BANKR ONLY — surplus/venice/imgnai models are never touched.
 */
const BANKR_DEFAULT_BUMPS: ReadonlyArray<readonly [from: string, to: string]> = [
  ['claude-opus-4.7', 'claude-opus-4.8'],
  ['claude-opus-4.8', DEFAULT_BANKR_MODEL],
]

/**
 * Persist migration. Two jobs:
 *
 *  1. Bump a persisted stale BANKR default to the current coding default.
 *     Because `bankrModel` is persisted (see `partialize` below), simply
 *     changing the initial default only helps fresh installs — an existing user
 *     keeps the cached model in the picker/badge until this runs. Only the exact
 *     old-default values are touched, so a deliberate pick of any other model
 *     (gpt-5.5, a sonnet, …) is preserved.
 *
 *  2. Coerce a REMOVED harness preference ('goose' / 'both') onto the default.
 *     `harness` is persisted too, so an existing user's Code tab would otherwise
 *     rehydrate pointing at a harness that no longer exists and every send
 *     would be rejected by the main-process enum. `pastSessions[].harness` is
 *     deliberately left alone — the history rail shows what actually ran.
 *
 * Pure + exported for unit testing.
 */
export function migrateAgentPersisted(persisted: unknown): unknown {
  const s = persisted as { bankrModel?: string; harness?: string } | null | undefined
  if (!s || typeof s !== 'object') return persisted
  const patch: { bankrModel?: string; harness?: HarnessId } = {}
  if (typeof s.bankrModel === 'string') {
    let model = s.bankrModel
    for (const [from, to] of BANKR_DEFAULT_BUMPS) if (model === from) model = to
    if (model !== s.bankrModel) patch.bankrModel = model
  }
  if (typeof s.harness === 'string' && !(HARNESS_IDS as readonly string[]).includes(s.harness)) {
    patch.harness = DEFAULT_HARNESS
  }
  return Object.keys(patch).length === 0 ? persisted : { ...s, ...patch }
}

export const useAgentStore = create<AgentStore>()(
  persist(
    (set, get) => ({
      // Live
      workingDir: null,
      lastCodeWorkingDir: null,
      sessionId:  null,
      status:     'idle',
      messages:   [],
      error:      null,
      harness:    DEFAULT_HARNESS,
      mode:       'build',
      provider:   'default',
      // Default agent model on Bankr — Opus 5 for coding (matches Bankr's
      // recommendation for agentic work; user can switch in the picker).
      bankrModel: DEFAULT_BANKR_MODEL,
      surplusModel: 'claude-sonnet-4.5',
      veniceModel: 'zai-org-glm-4.7',
      imgnaiModel: 'glm-5-2',
      surplusSmartRouting: false,
      runOrigin:  null,
      activeWorkflow: null,
      sessionTag: null,
      reconnect:  null,
      loop:       null,
      endedIncomplete: null,
      permissionQueue: [],
      revertCheckpoint: null,
      turnCheckpoints:  [],
      pendingPrompts:    { code: [], tachiapp: [] },
      promptQueuePaused: { code: false, tachiapp: false },
      depth:      'normal',
      trust:      'standard',
      fusionPlan: false,
      startedAt:  null,

      // D4: context window tracking
      contextChars:     {},
      redZoneTriggered: new Set<string>(),

      // Archive
      pastSessions:     [],
      viewingArchiveId: null,
      lastParkedSession: { code: null, tachiapp: null },

      setWorkingDir(dir)       {
        set(s => ({
          workingDir: dir,
          // WORKSPACE MEMORY: remember only what the CODE surface itself bound.
          // TACHIAPP stamps its tag BEFORE binding its resolved app source
          // (activatePinnedRepo), so its path never lands here; and a clear
          // (null) is not a new choice — it must not erase the memory, which is
          // the whole point (Code clears the dir when it parks a foreign
          // session, then restores its own).
          ...(dir && s.sessionTag !== 'tachiapp' ? { lastCodeWorkingDir: dir } : {}),
        }))
      },
      setSession(sessionId)    {
        set(s => ({
          sessionId,
          // Capture session start time on the first non-null assignment so
          // archive snapshots have a meaningful startedAt.
          startedAt: sessionId && !s.startedAt ? Date.now() : s.startedAt,
        }))
      },
      setStatus(status, error) {
        // A reconnect banner (and a LOOP chip) belongs to a RUNNING stream only
        // — starting, stopping or erroring the session always clears both.
        set(s => ({
          status,
          error: error ?? null,
          reconnect: status === 'running' ? s.reconnect : null,
          loop: status === 'running' ? s.loop : null,
          // GAVE-UP DETECTION: a NEW run clears the previous run's verdict; a
          // terminal status leaves it alone (appendEvent's `done` sets it).
          endedIncomplete: status === 'running' || status === 'starting' ? null : s.endedIncomplete,
        }))
        // Auto-archive on terminal status — guarantees session survival even
        // if the user closes the app without explicitly clicking "+ New".
        if (status === 'done' || status === 'error') {
          const s = get()
          if (s.viewingArchiveId) return  // viewing mode — don't archive
          const snap = snapshotLive(s)
          if (!snap) return
          set(prev => {
            // Replace any existing entry with the same startedAt (avoids
            // duplicate archives if setStatus fires multiple times).
            const filtered = prev.pastSessions.filter(p => p.startedAt !== snap.startedAt)
            return { pastSessions: [snap, ...filtered] }
          })
        }
      },
      setHarness(h)    { set({ harness: h }) },
      setMode(m)       { set({ mode: m }) },
      setProvider(p)   { set({ provider: p }) },
      setBankrModel(m) { set({ bankrModel: m }) },
      setSurplusModel(m) { set({ surplusModel: m }) },
      setVeniceModel(m) { set({ veniceModel: m }) },
      setImgnaiModel(m) { set({ imgnaiModel: m }) },
      setSurplusSmartRouting(v) { set({ surplusSmartRouting: v }) },
      setRunOrigin(o)  { set({ runOrigin: o }) },
      setActiveWorkflow(w) { set({ activeWorkflow: w }) },
      setSessionTag(tag)   { set({ sessionTag: tag }) },
      // ── Permission queue ────────────────────────────────────────────────
      // APPEND, never replace: each request has its own resolver waiting in
      // main, so losing one hangs a run. Nothing leaves the queue except an
      // explicit decision or an explicit settle-from-main.
      pushPermission(req)      { set(s => ({ permissionQueue: enqueuePermission(s.permissionQueue, req) })) },
      settlePermission(id)     { set(s => ({ permissionQueue: resolvePermission(s.permissionQueue, id) })) },
      cancelPermissions(ids)   { set(s => ({ permissionQueue: dropPermissions(s.permissionQueue, [...ids]) })) },
      syncPermissions(reqs, prunable) {
        set(s => {
          const live = new Set(reqs.map(r => r.id))
          // Only a card that was already on screen when the round-trip started
          // may be pruned; one that arrived DURING it is newer than main's
          // snapshot and must survive (dropping it would strand its resolver).
          const mayPrune = prunable ? new Set(prunable) : null
          // Keep what main still awaits (preserving arrival order), then append
          // anything we had not seen — e.g. raised while no page was mounted.
          let next = s.permissionQueue.filter(q => live.has(q.id) || (mayPrune !== null && !mayPrune.has(q.id)))
          for (const r of reqs) next = enqueuePermission(next, r)
          const unchanged = next.length === s.permissionQueue.length
            && next.every((q, i) => q.id === s.permissionQueue[i]?.id)
          return unchanged ? {} : { permissionQueue: next }
        })
      },

      setRevertCheckpoint(cp) {
        set({ revertCheckpoint: cp })
        // …and bind the SAME snapshot to the user turn that caused it, so the
        // per-message RESET CODE has something to point at. The bridge routes
        // `checkpoint` events straight here, so this is the one place both the
        // global ↺ and the per-turn menu learn about a snapshot.
        if (cp) get().stampTurnCheckpoint({ cpId: cp.id, root: cp.root, label: cp.label })
      },

      stampTurnCheckpoint(cp) {
        const s = get()
        // Never mutate live bindings while browsing history — the visible
        // transcript is not the live one, so "the last user turn" is not ours.
        if (s.viewingArchiveId) return
        const next = stampTurnCheckpoint(s.messages, s.turnCheckpoints, {
          id: cp.cpId, root: cp.root,
          ...(cp.label ? { label: cp.label } : {}),
          ...(cp.unavailable ? { unavailable: cp.unavailable } : {}),
        })
        if (next) set({ turnCheckpoints: next })
      },

      turnCheckpointFor(messageId) {
        return get().turnCheckpoints.find(c => c.messageId === messageId) ?? null
      },

      // ── Follow-up prompt queue ──────────────────────────────────────────
      // The reducers are pure (pages/agent/promptQueue.ts); this is only the
      // per-surface plumbing. `enqueuePrompt` returns the SAME array instance
      // when it refuses, which is how the caller learns the cap was hit.
      queuePrompt(surface, text) {
        const before = get().pendingPrompts[surface] ?? []
        const after  = enqueuePrompt(before, {
          id:   randomId(),
          text,
          at:   Date.now(),
        }, PROMPT_QUEUE_CAP)
        if (after === before) return false
        set(s => ({ pendingPrompts: { ...s.pendingPrompts, [surface]: after } }))
        return true
      },
      unqueuePrompt(surface, id) {
        set(s => {
          const before = s.pendingPrompts[surface] ?? []
          const after  = removePrompt(before, id)
          return after === before ? {} : { pendingPrompts: { ...s.pendingPrompts, [surface]: after } }
        })
      },
      takeQueuedPrompt(surface) {
        const { next, rest } = dequeuePrompt(get().pendingPrompts[surface] ?? [])
        // Remove as we read: a second consumer (a StrictMode double-invoke, a
        // re-fired drain effect) must never send the same follow-up twice.
        if (next) set(s => ({ pendingPrompts: { ...s.pendingPrompts, [surface]: rest } }))
        return next
      },
      clearQueuedPrompts(surface) {
        set(s => ({
          pendingPrompts:    { ...s.pendingPrompts, [surface]: [] },
          promptQueuePaused: { ...s.promptQueuePaused, [surface]: false },
        }))
      },
      setPromptQueuePaused(surface, paused) {
        set(s => (s.promptQueuePaused[surface] === paused
          ? {}
          : { promptQueuePaused: { ...s.promptQueuePaused, [surface]: paused } }))
      },

      setDepth(d)      { set({ depth: d }) },
      setTrust(t)      { set({ trust: t }) },
      setFusionPlan(v) { set({ fusionPlan: v }) },

      // D4: context window actions
      setContextChars(conversationId, chars) {
        set(s => ({ contextChars: { ...s.contextChars, [conversationId]: chars } }))
      },
      bumpContextChars(conversationId, deltaChars) {
        set(s => ({
          contextChars: {
            ...s.contextChars,
            [conversationId]: (s.contextChars[conversationId] ?? 0) + deltaChars,
          },
        }))
      },
      markRedZoneTriggered(conversationId) {
        set(s => {
          const next = new Set(s.redZoneTriggered)
          next.add(conversationId)
          return { redZoneTriggered: next }
        })
      },
      appendEvent(event) {
        // CONNECTION RESILIENCE: reconnect events are live STATUS, not
        // transcript — they drive the status line and never enter `messages`
        // (a transcript full of "retrying 3/10" would be noise, and archiving
        // it would preserve a condition that no longer exists).
        if (event.type === 'reconnect') {
          if (!get().viewingArchiveId) {
            set({ reconnect: { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, reason: event.reason } })
          }
          return
        }
        if (event.type === 'reconnect-resolved') {
          if (!get().viewingArchiveId) set({ reconnect: null })
          return
        }
        // LOOP MODE: same rule — the chip is live status, so the cycle events
        // drive it and stay out of the transcript. The loop's own summary line
        // arrives as normal text, which IS transcript.
        if (event.type === 'loop') {
          if (!get().viewingArchiveId) set({ loop: { iteration: event.iteration, cap: event.cap, goal: event.goal } })
          return
        }
        if (event.type === 'loop-ended') {
          if (!get().viewingArchiveId) set({ loop: null })
          return
        }
        // PER-TURN CHECKPOINTS: a `checkpoint` event is workspace bookkeeping,
        // never transcript. The app-lifetime bridge already intercepts the ones
        // that carry an id; this catches the HONEST NEGATIVE — main telling us
        // it could take no snapshot for this turn — which has no id and would
        // otherwise fall through and render as a mystery row in the chat.
        {
          const ck = event as unknown as {
            type?: string
            checkpoint?: { id?: string; label?: string } | null
            workspaceRoot?: string
            unavailable?: string
          }
          if (ck.type === 'checkpoint') {
            if (ck.workspaceRoot) {
              get().stampTurnCheckpoint({
                cpId: ck.checkpoint?.id ?? null,
                root: ck.workspaceRoot,
                ...(ck.checkpoint?.label ? { label: ck.checkpoint.label } : {}),
                ...(ck.checkpoint?.id ? {} : { unavailable: ck.unavailable || 'snapshot-failed' }),
              })
            }
            return
          }
        }

        set(s => {
          // Don't mutate messages while viewing an archive — that would corrupt
          // historical state. New events during viewing are silently dropped;
          // user should switch back to live via closeArchive() to see them.
          if (s.viewingArchiveId) return {}

          const next: Partial<AgentStore> = {}

          // Coalesce consecutive streaming text chunks into one message so they
          // render as a single block. Without this, each token chunk becomes
          // its own <div> and the layout becomes vertical (one word per line).
          const last = s.messages[s.messages.length - 1]
          if (event.type === 'text' && last && last.event.type === 'text') {
            const merged: AgentMessage = {
              ...last,
              event:     { type: 'text', text: last.event.text + (event as { text: string }).text },
              timestamp: Date.now(),
            }
            next.messages = [...s.messages.slice(0, -1), merged]
          } else {
            const msg: AgentMessage = {
              id:        String(++_seq),
              event,
              timestamp: Date.now(),
              // PROVENANCE stamped HERE, at write time, from the identity parked
              // at send — the one moment it is a fact rather than a lookup.
              // Omitted (not guessed) when nothing was parked, so an unattributed
              // message stays unattributed. The coalescing branch above spreads
              // `...last`, so a streamed answer keeps the stamp of its first chunk.
              ...(s.runOrigin ? { origin: s.runOrigin } : {}),
            }
            next.messages = [...s.messages, msg]
          }

          if (event.type === 'error') {
            next.status = 'error'
            next.error  = (event as { message: string }).message
            next.reconnect = null // the run is over — no retry is pending
            next.loop = null      // …and no further loop cycle either
            // PROMPT QUEUE PAUSE: a dead session would swallow every queued
            // follow-up into a fresh error. Latch the OWNING surface only —
            // the other surface's queue has nothing to do with this failure.
            const surface = promptSurfaceKey(s.sessionTag)
            if (!s.promptQueuePaused[surface]) {
              next.promptQueuePaused = { ...s.promptQueuePaused, [surface]: true }
            }
          } else if (event.type === 'done') {
            // A harness that failed emits `error` and THEN `done reason:'error'`
            // (the TACHI loop's terminal pair, now OpenClaude's too). Writing
            // 'done' here unconditionally overwrote the 'error' status the
            // error event had just set, so the status badge went green on a run
            // whose own transcript held the failure. The reason is the fact —
            // read it instead of assuming success.
            next.status = event.reason === 'error' ? 'error' : 'done'
            next.reconnect = null
            next.loop = null
            // GAVE-UP DETECTION: `status` stays 'done' (every downstream reader
            // of it — archiving, disabled states, the composer — means "the run
            // is over", which is true). The VERDICT rides alongside it, and the
            // status area renders that instead of a success badge.
            next.endedIncomplete = event.incomplete
              ? { ...(event.incompleteCode ? { code: event.incompleteCode } : {}), ...(event.incompleteDetail ? { detail: event.incompleteDetail } : {}), ...(event.nudged ? { nudged: true } : {}) }
              : null
          }

          // Set startedAt on first message if not already set
          if (!s.startedAt) next.startedAt = Date.now()

          return next
        })

        // After updating, if the event was terminal trigger an auto-archive
        if (event.type === 'done' || event.type === 'error') {
          const s = get()
          if (s.viewingArchiveId) return
          const snap = snapshotLive(s)
          if (!snap) return
          set(prev => {
            const filtered = prev.pastSessions.filter(p => p.startedAt !== snap.startedAt)
            return { pastSessions: [snap, ...filtered] }
          })
        }
      },

      clearMessages() { set({ messages: [] }) },

      rewindTo(messageId) {
        if (get().viewingArchiveId) return ''
        let text = ''
        set(s => {
          const idx = s.messages.findIndex(m => m.id === messageId)
          if (idx < 0) return {}
          const ev = s.messages[idx].event as { type?: string; text?: string }
          if (ev.type === 'user-text' && typeof ev.text === 'string') {
            // Drop the "(+N attachments)" hint the composer appended.
            text = ev.text.replace(/\s*\(\+\d+ attachment[s]?\)\s*$/, '')
          }
          const kept = s.messages.slice(0, idx)
          // Drop bindings for turns that no longer exist — a checkpoint bound
          // to a message nobody can see is a restore nobody can reach.
          const live = new Set(kept.map(m => m.id))
          return {
            messages: kept,
            turnCheckpoints: pruneTurnCheckpoints(s.turnCheckpoints, live),
            status: 'idle' as AgentStatus,
            error: null,
          }
        })
        return text
      },

      reset() {
        // NOTE: permissionQueue is deliberately NOT cleared here. Dropping a
        // card in the renderer does not settle main's resolver — that is
        // exactly the bug this queue exists to prevent. Cards leave only when
        // the user decides, or when main says it settled them (agent:send /
        // abort / stop-session / stop-loop all cancel the scope).
        // …but the FOLLOW-UP PROMPT queue IS cleared: unlike a permission card
        // it has no resolver waiting anywhere, and firing a follow-up written
        // for the conversation we just threw away into a brand-new one is the
        // transcript-bleed class of bug, not a recovery.
        set(s => {
          const surface = promptSurfaceKey(s.sessionTag)
          return {
            sessionId: null,
            status:    'idle' as AgentStatus,
            messages:  [],
            error:     null,
            startedAt: null,
            viewingArchiveId: null,
            reconnect: null,
            loop:      null,
            endedIncomplete: null,
            revertCheckpoint: null,
            turnCheckpoints:  [],
            pendingPrompts:    { ...s.pendingPrompts, [surface]: [] },
            promptQueuePaused: { ...s.promptQueuePaused, [surface]: false },
          }
        })
      },

      startNewSession() {
        const s = get()
        if (s.viewingArchiveId) {
          // Leaving viewing mode without altering archives
          set({ viewingArchiveId: null, messages: [], status: 'idle', sessionId: null, error: null, startedAt: null, revertCheckpoint: null, turnCheckpoints: [] })
          return
        }
        const snap = snapshotLive(s)
        const surface = promptSurfaceKey(s.sessionTag)
        set(prev => ({
          // Snapshot first if there's something to keep, replacing any
          // stale duplicate of the same startedAt.
          pastSessions: snap
            ? [snap, ...prev.pastSessions.filter(p => p.startedAt !== snap.startedAt)]
            : prev.pastSessions,
          messages:  [],
          status:    'idle',
          sessionId: null,
          error:     null,
          startedAt: null,
          viewingArchiveId: null,
          endedIncomplete: null,
          // The outgoing run's pre-edit snapshot does not describe the new one.
          revertCheckpoint: null,
          turnCheckpoints:  [],
          // …and neither do the follow-ups written for it. "+ NEW" is an
          // explicit fresh start; carrying a queue across it would fire the
          // previous conversation's instructions into an empty transcript.
          pendingPrompts:    { ...prev.pendingPrompts, [surface]: [] },
          promptQueuePaused: { ...prev.promptQueuePaused, [surface]: false },
        }))
      },

      viewArchive(id) {
        const s = get()
        const past = s.pastSessions.find(p => p.id === id)
        if (!past) return
        // Snapshot live first if it has unsaved content, so toggling back
        // and forth doesn't lose work.
        const snap = !s.viewingArchiveId ? snapshotLive(s) : null
        // …EXCEPT when the live slot IS the entry being opened. A run
        // auto-archives on its terminal event but stays in the live slot, so
        // clicking the session that just finished snapshotted it a SECOND time
        // (new random id) and the re-appended original made TWO rail entries for
        // ONE conversation — both continuable, both half of the same run.
        // Same session → refresh the existing entry IN PLACE instead of
        // inserting a twin, keeping its id (viewingArchiveId points at it), its
        // title (a rename must survive) and its rail tag: those belong to the
        // entry, not to the live slot.
        const refresh: PastAgentSession | null = snap && isSameSession(snap, past)
          ? { ...past, messages: snap.messages, status: snap.status, error: snap.error, endedAt: snap.endedAt }
          : null
        const viewed = refresh ?? past
        set(prev => ({
          pastSessions: refresh
            ? prev.pastSessions.map(p => (p.id === id ? refresh : p))
            : snap
              ? [snap, ...prev.pastSessions.filter(p => p.startedAt !== snap.startedAt && p.id !== id), past]
              : prev.pastSessions,
          messages:         viewed.messages,
          status:           viewed.status,
          error:            viewed.error,
          workingDir:       viewed.workingDir,
          // Legacy archives can say 'goose'/'both' — coerce so the live slot is
          // always a harness that still exists.
          harness:          normalizeHarness(viewed.harness),
          mode:             viewed.mode,
          sessionId:        null,
          startedAt:        viewed.startedAt,
          viewingArchiveId: id,
          // The live run's verdict does not describe the archive being viewed.
          endedIncomplete:  null,
        }))
      },

      resumeArchive(id) {
        const s = get()
        const target = s.pastSessions.find(p => p.id === id)
        if (!target) return
        // Restore as a LIVE editable session: transcript visible, composer
        // enabled (viewingArchiveId null). sessionId stays null — the AgentPage
        // handler starts a fresh harness session (startSession) right after,
        // exactly like opening a folder. Remove the entry from the archive; it
        // re-archives on the next terminal status, and because startedAt is
        // preserved the dedup-by-startedAt collapses it back to one entry.
        set(prev => ({
          pastSessions:     prev.pastSessions.filter(p => p.id !== id),
          messages:         target.messages,
          workingDir:       target.workingDir,
          // Continuing a pre-Goose-removal archive must not restart on a harness
          // that no longer exists.
          harness:          normalizeHarness(target.harness),
          mode:             target.mode,
          status:           'idle',
          error:            null,
          sessionId:        null,
          startedAt:        target.startedAt,
          viewingArchiveId: null,
          // Keep the owning surface across a continue, so re-archiving lands
          // back in the same rail it was picked from.
          sessionTag:       target.tag ?? null,
          endedIncomplete:  null,
          // The continued session runs fresh — its first file edit takes a new
          // checkpoint. Any leftover belongs to the workspace we just left.
          revertCheckpoint: null,
          turnCheckpoints:  [],
        }))
      },

      closeArchive() {
        // Return to a fresh live slate. The viewed archive remains in pastSessions.
        set({
          messages:         [],
          status:           'idle',
          error:            null,
          sessionId:        null,
          startedAt:        null,
          viewingArchiveId: null,
          endedIncomplete:  null,
          revertCheckpoint: null,
          turnCheckpoints:  [],
        })
      },

      deleteArchive(id) {
        set(prev => ({
          pastSessions: prev.pastSessions.filter(p => p.id !== id),
          // If we were viewing this archive, drop back to live mode.
          ...(prev.viewingArchiveId === id ? {
            messages: [],
            status: 'idle' as AgentStatus,
            error: null,
            viewingArchiveId: null,
          } : {}),
        }))
      },

      renameArchive(id, title) {
        const trimmed = title.trim() || 'Untitled'
        set(prev => ({
          pastSessions: prev.pastSessions.map(p => p.id === id ? { ...p, title: trimmed } : p),
        }))
      },

      recordParkedSession(tag, id) {
        const key = tag ?? 'code'
        set(s => ({ lastParkedSession: { ...s.lastParkedSession, [key]: id } }))
      },
      takeParkedSession(tag) {
        const key = tag ?? 'code'
        const id = get().lastParkedSession[key]
        // Clear on read — a second consumer (StrictMode double-invoke, a
        // second mount effect pass) must never re-open the same entry twice.
        if (id) set(s => ({ lastParkedSession: { ...s.lastParkedSession, [key]: null } }))
        return id
      },
    }),
    {
      name: 'tachi-agent-v1',
      // v3: the Goose harness was removed — bumped so migrateAgentPersisted
      // actually RUNS for existing installs (zustand only calls `migrate` when
      // the stored version differs) and coerces a persisted harness:'goose'
      // preference onto the default. The bankrModel bumps are idempotent, so
      // re-running them on a v2 store is harmless.
      version: 3,
      migrate: (persisted) => migrateAgentPersisted(persisted) as AgentStore,
      storage: createJSONStorage(() => createEncryptedStorage('agent')),
      partialize: (s) => ({
        pastSessions: s.pastSessions,
        // Persist the user's harness/mode preference across reloads, but not
        // any in-flight session state (sessionId points at a dead sidecar).
        harness:      s.harness,
        mode:         s.mode,
        provider:     s.provider,
        bankrModel:   s.bankrModel,
        surplusModel: s.surplusModel,
        veniceModel:  s.veniceModel,
        imgnaiModel:  s.imgnaiModel,
        surplusSmartRouting: s.surplusSmartRouting,
        activeWorkflow: s.activeWorkflow,
        // The Code surface's own last workspace — a preference, not session
        // state (the live workingDir stays unpersisted; this is only ever
        // restored after it is re-validated against disk).
        lastCodeWorkingDir: s.lastCodeWorkingDir,
        depth:        s.depth,
        trust:        s.trust,
        fusionPlan:   s.fusionPlan,
      }),
    },
  ),
)
