import type { AppSettings, ChatChunk, ChatContentPart, ModelInfo, HealthStatus, RuntimeCardUpdate, LogEvent, AgentCommandEvent, FreeProviderConfig, Profile, Workspace, AgentEvent, ParsedSlashCommand } from '@tachi/core'
import type { HardwareProfile, CatalogEntry, InstalledModel } from '@tachi/core'
import type { MemoryFact } from '@tachi/core'
// Sprint C1: router types imported to anchor future inferRouterAPI usage.
// All three migrated namespaces (shell, bankr, playbook) keep manual TachiAPI
// type stanzas here to preserve existing renderer call signatures.

// ── Sprint C2: agent-runtime types ────────────────────────────────────────────

export type AgentRuntimeStatus   = 'idle' | 'starting' | 'running' | 'done' | 'error'
export type AgentRuntimeHarness  = 'openclaude' | 'darksol' | 'tachi' | 'codex'
export type AgentRuntimeProvider = 'default' | 'opengateway' | 'bankr' | 'surplus' | 'venice' | 'imgnai'

export interface AgentRuntimeSnapshot {
  sessionId:  string | null
  workingDir: string | null
  status:     AgentRuntimeStatus
  harness:    AgentRuntimeHarness
  provider:   AgentRuntimeProvider
  bankrModel: string
}

export interface AgentRuntimeAPI {
  getState(input: Record<string, never>): Promise<AgentRuntimeSnapshot>
  setStatus(input: { status: AgentRuntimeStatus }): Promise<AgentRuntimeSnapshot>
  setHarness(input: { harness: AgentRuntimeHarness }): Promise<AgentRuntimeSnapshot>
  setProvider(input: { provider: AgentRuntimeProvider; bankrModel?: string }): Promise<AgentRuntimeSnapshot>
  /** Subscribe to push broadcasts from the main store. Returns an unsubscribe fn. */
  onStateChanged(cb: (snapshot: AgentRuntimeSnapshot) => void): () => void
}

export interface MCPServerConfig {
  name:    string
  command: string
  args:    string[]
  env?:    Record<string, string>
  /** Env var name → value; routed to the encrypted keychain, never persisted in plaintext. */
  secrets?: Record<string, string>
}

export type MCPServerStatus = 'stopped' | 'starting' | 'running' | 'error'

export interface MCPServerInfo {
  name:       string
  status:     MCPServerStatus
  pid?:       number
  toolCount:  number
  lastError?: string
  /** User wants this server connected; reconnected lazily at session start. */
  enabled:    boolean
  /** Marketplace entry it was installed from (absent for hand-added servers). */
  catalogId?: string
  /** Reaches the public internet → refused while PRIVATE MODE is on. */
  requiresNetwork: boolean
  command:    string
  args:       string[]
  /** Env var NAMES only — values never cross IPC. */
  envKeys:    string[]
  secretEnvKeys: string[]
}

export interface MCPTool {
  name:        string
  description: string
  inputSchema: Record<string, unknown>
}

// ── MCP marketplace catalog (mirrors electron/services/mcp-catalog.ts) ────────

export interface McpCatalogSlot {
  token:    string
  label:    string
  kind:     'path' | 'text'
  required: boolean
  default?: string
}

export interface McpCatalogEnvVar {
  key:      string
  label:    string
  required: boolean
  secret:   boolean
}

export interface McpCatalogEntry {
  id:              string
  name:            string
  description:     string
  packageName:     string
  runner:          'npx' | 'uvx'
  command:         string
  args:            readonly string[]
  slots?:          readonly McpCatalogSlot[]
  env?:            readonly McpCatalogEnvVar[]
  tags:            readonly string[]
  requiresNetwork: boolean
  homepage:        string
}

export interface McpInstallRequest {
  catalogId: string
  name?:     string
  slots?:    Record<string, string>
  env?:      Record<string, string>
  enable?:   boolean
}

// Aeon types (mirrored from aeon-service.ts to avoid cross-boundary imports in renderer)
export interface AeonGhStatus {
  installed: boolean
  authenticated: boolean
  username?: string
  ghVersion?: string
}

export interface AeonForkStatus {
  forked: boolean
  owner?: string
  cloneUrl?: string
  localPath?: string
  defaultBranch?: string
}

export interface AeonWorkflowSummary {
  id: number
  name: string
  path: string
  state: 'active' | 'disabled_inactivity' | 'disabled_manually'
}

export interface AeonRunSummary {
  id: number
  name: string
  status: 'queued' | 'in_progress' | 'completed' | string
  conclusion?: 'success' | 'failure' | 'cancelled' | null
  created_at: string
  updated_at: string
  html_url: string
  workflow_id: number
}

export interface AeonJobStep {
  name:          string
  status:        'queued' | 'in_progress' | 'completed'
  conclusion?:   'success' | 'failure' | 'cancelled' | 'skipped' | 'neutral' | 'timed_out' | null
  number:        number
  started_at?:   string | null
  completed_at?: string | null
}

export interface AeonJobSummary {
  id:           number
  name:         string
  status:       'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested' | 'pending'
  conclusion?:  'success' | 'failure' | 'cancelled' | 'skipped' | 'neutral' | 'timed_out' | null
  started_at?:  string | null
  completed_at?: string | null
  html_url?:    string | null
  steps:        AeonJobStep[]
}

export interface AeonDashboardOutput {
  filename:  string
  skill:     string
  timestamp: string
  size:      number
  htmlUrl:   string
  apiUrl:    string
}

export interface AeonSkillHealth {
  skill:         string
  lastAnalyzed?: string
  qualityScore?: number
  avgScore?:     number
  assessment?:   string
  flags?:        string[]
  history?:      Array<{ date: string; score: number }>
}

export type AeonCronState = Record<string, {
  last_status?:           'success' | 'failed'
  last_success?:          string
  last_failed?:           string
  total_runs?:            number
  total_successes?:       number
  total_failures?:        number
  consecutive_failures?:  number
  success_rate?:          number
  last_error?:            string
  last_quality_score?:    number
}>

// E2: fork-behind indicator
export interface AeonSyncStatus {
  hasChanges:   boolean
  changedFiles: string[]
  behind:       number
}

// E4: memory search entry returned by /api/memory/search
export interface AeonMemoryEntry {
  id:      string
  title:   string
  snippet: string
  ts:      number
  [key: string]: unknown
}

export interface AeonSkillAnalyticsEntry {
  successRate:    number
  streak:         number
  avgDurationMin: number
}

export type AeonSkillAnalyticsMap = Record<string, AeonSkillAnalyticsEntry>

export type AeonWorkflowInputType = 'string' | 'choice' | 'boolean' | 'environment' | 'number'

export interface AeonWorkflowInputSpec {
  name:         string
  type:         AeonWorkflowInputType
  description?: string
  required?:    boolean
  default?:     string
  options?:     string[]
}

type ProfileInput = Omit<Profile, 'id' | 'createdAt' | 'updatedAt'>

export interface SidecarInfo {
  id:        'freellmapi' | 'openclaude' | 'freeclaudecode' | 'claude-code-router'
  state:     'stopped' | 'starting' | 'running' | 'error'
  port?:     number
  pid?:      number
  uptimeMs?: number
  error?:    string
}

// ── nookplot integration view types (mirror electron/services/nook-service.ts) ──
export interface NookStatus {
  connected:     boolean
  connecting:    boolean
  online:        boolean
  address:       string | null
  name:          string | null
  credits:       number | null
  reputation:    number | null
  hasApiKey:     boolean
  hasPrivateKey: boolean
  registered:    boolean | null
  error:         string | null
}

export interface NookWalletInfo {
  address:    string
  privateKey: string
  mnemonic?:  string
}

export interface DarksolMcpStatus {
  registered: boolean
  walletReady: boolean
  darksolReady: boolean
  status?: 'stopped' | 'starting' | 'running' | 'error'
  toolCount?: number
  lastError?: string
}

export interface WalletInfoView { address: string | null; hasKey: boolean; chain: string }
export interface WalletBalances {
  address: string
  native:  { symbol: 'ETH'; amount: string }
  tokens:  { symbol: string; amount: string }[]
}

// darksol foundation — multi-wallet / multi-chain / multi-token + agent limits.
export type WalletKind = 'app' | 'agent'
export interface WalletListEntry { id: { kind: WalletKind; name?: string }; label: string; address: string | null; active: boolean }
export interface AggregatedToken { symbol: string; total: string; byChain: { chainId: number; amount: string }[] }
export interface AgentLimits { maxPerTradeEth: string; dailyLimitEth: string; dryRun: boolean; allowlist: string[] }
export interface NetworkDef { id: number; key: string; name: string; nativeSymbol: string; explorer: string; color: string }
// Persistent audit trail of real (broadcast) wallet transactions (audit 2026-06-12).
export interface WalletTxEntry {
  ts: number; kind: 'native' | 'token'; walletKind: WalletKind; walletName?: string
  chainId: number; symbol: string; to: string; amount: string; hash: string
}

export interface NookProfileView {
  address:    string | null
  name:       string | null
  reputation: number | null
  credits:    number | null
}

export interface NookBountyView {
  id:               string
  title:            string
  description:      string
  community:        string
  rewardDisplay:    string
  rewardToken:      string
  status:           string
  statusCode:       number
  deadline:         number
  applicationCount: number
  claimer:          string | null
  raw:              Record<string, unknown>
}

export interface NookListingView {
  id:           string
  title:        string
  description:  string
  priceDisplay: string
  domains:      string[]
  provider:     string
  raw:          Record<string, unknown>
}

export interface NookPostView {
  id: string
  title: string
  author: string
  community: string
  preview: string
  tags: string[]
  score: number
  upvotes: number
  downvotes: number
  comments: number
  timestamp: number
  cid: string
}
export interface NookPostDetail extends NookPostView { body: string }
export interface NookTrackStat { track: string; openCount: number; avgRewardNook: number; successRate: number }
export interface NookMiningChallengeView { id: string; track: string; title: string; description: string; difficulty: string; domainTags: string[]; rewardNook: string; submissionCount: number; maxSubmissions: number; closesAt: string }
export interface NookMiningRewardsView { pendingNook: number | null; claimableNook: number | null; epoch: number | null }
export interface NookMiningStats { running: boolean; ticks: number; attempted: number; submitted: number; skipped: number; errors: number; creditsSpent: number }
export interface NookLeaderEntryView {
  rank: number
  address: string
  name: string | null
  score: number
  challengesSolved: number
  velocityMultiplier: number
}
export interface NookAgentView {
  address: string
  name: string
  snippet: string
  relevance: number
}

export interface NookDMView {
  id: string; from: string; fromName: string | null; to: string
  content: string; messageType: string; unread: boolean; createdAt: string
  raw: Record<string, unknown>
}
export interface NookChannelView {
  id: string; slug: string; name: string; description: string | null
  channelType: string; isPublic: boolean; memberCount: number | null
  isMember: boolean; createdAt: string; raw: Record<string, unknown>
}
export interface NookChannelMessageView {
  id: string; from: string; fromName: string | null; content: string
  messageType: string; createdAt: string; raw: Record<string, unknown>
}
export interface NookChannelMemberView {
  address: string; displayName: string | null; role: string | null
  raw: Record<string, unknown>
}

export interface SystemInfo {
  platform:        string
  arch:            string
  osRelease:       string
  hostname:        string
  cpuModel:        string
  cpuCount:        number
  totalMemMB:      number
  freeMemMB:       number
  appMemMB:        number
  appUptimeSec:    number
  nodeVersion:     string
  chromeVersion:   string
  electronVersion: string
  appVersion:      string
  userDataPath:    string
  diskFreeGB:      number | null
  diskTotalGB:     number | null
  ipv4:            string | null
}

export interface InstallProgressEvent {
  step:    'checking' | 'clone' | 'install' | 'build' | 'done' | 'error'
  message: string
  percent: number
}

export interface OpenClaudeInstallProgress {
  step:    'checking' | 'init' | 'install' | 'done' | 'error'
  message: string
  percent: number
}

export interface AnthropicOAuthResult {
  accessToken:  string
  refreshToken?: string
  expiresIn?:   number
}

export interface OpenRouterOAuthResult {
  ok:     boolean
  key?:   string
  error?: string
}

export interface ConnectorStatus {
  id: string
  name: string
  description: string
  authStatus: 'connected' | 'disconnected' | 'error'
  connectedAs?: string
}

export type NetworkAuditCategory =
  | 'anthropic'
  | 'openai'
  | 'github'
  | 'openrouter'
  | 'opengateway'
  | 'bankr'
  | 'venice'
  | 'surplus'
  | 'ollama'
  | 'other'

export interface NetworkAuditEntry {
  id:         number
  url:        string
  host:       string
  method:     string
  status:     number | null
  durationMs: number
  bytesIn:    number
  bytesOut:   number
  startedAt:  string
  category:   NetworkAuditCategory
  /** Tokens written to the Anthropic prompt cache on this request. */
  cacheCreateTokens?: number
  /** Tokens served from the Anthropic prompt cache on this request. */
  cacheReadTokens?:   number
}

export interface TachiSafeStorageAPI {
  isAvailable(): Promise<{ available: boolean }>
  encrypt(plaintext: string): Promise<{ encrypted: string }>
  decrypt(encrypted: string): Promise<{ plaintext: string }>
}

// ── B2.1 Permission types ──────────────────────────────────────────────────────

export type PermissionDecision =
  | 'allow'
  | 'deny'
  | 'always_allow_tool'
  | 'always_allow_server'
  /** 30-min TTL session grant (UX #8) — expires silently, then re-prompts. */
  | 'allow_30m'

// ── PRIVATE MODE Tier 4: capability inbox payload ─────────────────────────────
// Mirrors the main-side CapabilityRequest in
// apps/desktop/electron/services/capability-service.ts. Lifecycle status
// fields are owned by the renderer store (capability.store.ts) and are not
// included in the IPC payload.
export interface CapabilityRequestPayload {
  id: string
  toolName: string
  toolInput: unknown
  reason: string
  recommendedDecision: 'allow' | 'deny'
  sessionId: string
  workingDir: string
  pushedAt: number
}

// ── Whisper / local STT types ──────────────────────────────────────────────────

export type WhisperModelName =
  | 'tiny.en' | 'base.en' | 'small.en' | 'medium.en'
  | 'large-v3-turbo-q5_0'   // R10 — multilingual (and smaller than medium.en)

export interface WhisperModelInfo {
  name:      WhisperModelName
  sizeLabel: string
  ready:     boolean
}

export interface WhisperProgressEvent {
  stage:    'checking' | 'downloading' | 'building' | 'done' | 'error'
  message:  string
  percent?: number
}

export interface WhisperTranscribeResult {
  text:        string
  duration_ms: number
}

export interface OllamaModelInfo {
  name:        string
  size:        number
  modified_at: string
  digest:      string
  details?: {
    family?:             string
    parameter_size?:     string
    quantization_level?: string
  }
}

export interface PlaybookMeta {
  workspaceHash: string
  workspacePath: string
  updatedAt:     string
  sizeBytes:     number
}

// ── Sprint C4: Workspace-panel types ─────────────────────────────────────────

export interface WorkspacePanelChange {
  tool:   string   // 'Edit', 'Write', 'Bash', etc.
  target: string   // file path or command (trimmed to 60 chars)
  ts:     number   // epoch ms
}

export interface WorkspacePanelAPI {
  /** Return the last 20 relevant tool-call turns from a session's checkpoint. */
  listRecentChanges(input: { sessionId: string }): Promise<{ changes: WorkspacePanelChange[] }>
  /**
   * Stub — always returns null workspaceDir for now.
   * TODO(C4-cross-window): plumb via main-side conversation registry.
   */
  getWorkspaceForConversation(input: { conversationId: string }): Promise<{ workspaceDir: string | null }>
}

// ── Sprint C3: Checkpoint types ───────────────────────────────────────────────

export interface CheckpointTurn {
  role:     'user' | 'assistant' | 'tool-call' | 'tool-result'
  content:  string
  name?:    string
  ts:       number
}

export interface CheckpointMeta {
  sessionId:  string
  sizeBytes:  number
  updatedAt:  string
}

export interface WorkspaceCheckpoint {
  id: string
  commit: string
  label: string
  createdAt: string
}

export interface CheckpointsAPI {
  /** Load all turns for a session. Returns [] if no checkpoint exists. */
  loadCheckpoint(sessionId: string):  Promise<CheckpointTurn[]>
  /** List all checkpoint files, newest first. */
  listCheckpoints():                  Promise<CheckpointMeta[]>
  /** Delete the checkpoint (and its .old rotation) for a session. */
  deleteCheckpoint(sessionId: string): Promise<{ deleted: boolean }>
  // Git-backed WORKSPACE checkpoints — one-click undo of the agent's file changes.
  /** Snapshot the workspace's full working tree. checkpoint is null outside a git repo. */
  snapshotWorkspace(root: string, label?: string): Promise<{ ok: boolean; checkpoint: WorkspaceCheckpoint | null }>
  /** List workspace checkpoints for a root, newest first. */
  listWorkspaceCheckpoints(root: string): Promise<WorkspaceCheckpoint[]>
  /** Force the working tree back to a checkpoint (auto-snapshots current state first). */
  restoreWorkspace(root: string, id: string): Promise<{ ok: boolean; error?: string; safetyId?: string }>
  /** Delete a workspace checkpoint. */
  deleteWorkspaceCheckpoint(root: string, id: string): Promise<{ deleted: boolean }>
}

// ── agent-session-memory: cross-run session summaries (ECC pattern) ───────────
// Keyed by workspace PATH (distinct from checkpoints, which are per-sessionId).
export interface SessionSummary {
  workspacePath: string
  lastTask:      string
  keyDecisions:  string[]
  filesChanged:  string[]
  timestamp:     string
  notes?:        string
}
export interface SessionSummaryMeta {
  workspacePath: string
  lastTask:      string
  timestamp:     string
}

// ── Sprint D5: Role types ─────────────────────────────────────────────────────

export interface RoleTriggers {
  keywords: string[]
  paths:    string[]
}

export interface RoleExample {
  user:       string
  commentary: string
}

export interface RoleBoundaries {
  denyWritePaths:   string[]
  denyToolPatterns: string[]
}

export interface RoleInfo {
  id:           string
  label:        string
  description:  string
  triggers:     RoleTriggers
  examples:     RoleExample[]
  boundaries:   RoleBoundaries
  allowedTools: string[]
}

export interface RoleSuggestResult {
  id:    string
  score: number
}

// ── gnap (multi-agent coordination via git) ─────────────────────────────────
// Mirrors the public types from electron/services/gnap-client.ts so the
// renderer never imports across the main/renderer boundary. Keep in sync.

export type GnapAgentStatus = 'active' | 'paused' | 'stopped'
export type GnapAgentKind   = 'ai' | 'human'

export interface GnapAgent {
  id:            string
  name:          string
  role:          string
  type:          GnapAgentKind
  runtime?:      string
  reports_to?:   string
  capabilities?: string[]
  heartbeat_sec?: number
  status:        GnapAgentStatus
}

export type GnapTaskState =
  | 'backlog'
  | 'ready'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'blocked'
  | 'cancelled'

export interface GnapTaskClaim {
  agent:       string
  at:          string
  expires_at:  string
}

export interface GnapTaskComment {
  author: string
  at:     string
  text:   string
}

export interface GnapTask {
  id:           string
  title:        string
  assigned_to:  string[]
  state:        GnapTaskState
  created_by:   string
  created_at:   string
  parent?:      string
  desc?:        string
  priority?:    number
  due?:         string
  blocked?:     string
  reviewer?:    string
  claim?:       GnapTaskClaim
  comments?:    GnapTaskComment[]
}

export type GnapRunState = 'running' | 'completed' | 'failed' | 'cancelled'

export interface GnapRun {
  id:           string
  task:         string
  agent:        string
  state:        GnapRunState
  started_at:   string
  attempt:      number
  finished_at?: string
  tokens?:      number
  cost_usd?:    number
  result?:      unknown
  error?:       string
  commits:      string[]
  artifacts:    string[]
}

export interface GnapMessage {
  id:        string
  from:      string
  to:        string[]
  at:        string
  text:      string
  type?:     string
  channel?:  string
  thread?:   string
  read_by?:  string[]
}

/** Event surfaced by gnap.watch() — one per new HEAD commit. */
export interface GnapWatchEvent {
  sha:           string
  subject:       string
  touchedFiles:  string[]
}

/** Mutating-route envelope. `ok: true` carries no extra payload. */
export type GnapMutResult =
  | { ok: true }
  | { ok: false; error: string }

export interface GnapAPI {
  initSwarm(repoPath: string, opts?: { protocolVersion?: string }): Promise<GnapMutResult>
  listAgents(repoPath: string):
    Promise<{ ok: true; agents: GnapAgent[] } | { ok: false; error: string; agents: GnapAgent[] }>
  registerAgent(repoPath: string, agent: GnapAgent): Promise<GnapMutResult>
  updateAgentStatus(repoPath: string, agentId: string, status: GnapAgentStatus): Promise<GnapMutResult>
  listTasks(
    repoPath: string,
    filter?: { state?: GnapTaskState; assignedTo?: string },
  ): Promise<{ ok: true; tasks: GnapTask[] } | { ok: false; error: string; tasks: GnapTask[] }>
  createTask(repoPath: string, task: GnapTask): Promise<GnapMutResult>
  updateTaskState(repoPath: string, taskId: string, state: GnapTaskState, by: string): Promise<GnapMutResult>
  /** Returns the raw gnap claim result so callers can distinguish a peer-held claim from an IPC failure. */
  claimTask(
    repoPath: string,
    taskId: string,
    agentId: string,
    ttlSec?: number,
  ): Promise<{ ok: true } | { ok: false; reason?: string }>
  /** Claim a task AND run it (worktree + harness + run state). */
  claimAndRun(
    repoPath: string,
    taskId: string,
    agentId: string,
    harness?: 'tachi',
  ): Promise<{ ok: boolean; runId?: string; reason?: string; commits?: string[] }>
  startRun(
    repoPath: string,
    run: Omit<GnapRun, 'commits' | 'artifacts'> & { commits?: string[]; artifacts?: string[] },
  ): Promise<GnapMutResult>
  completeRun(repoPath: string, runId: string, patch: Partial<GnapRun>): Promise<GnapMutResult>
  listRuns(
    repoPath: string,
    taskId?: string,
  ): Promise<{ ok: true; runs: GnapRun[] } | { ok: false; error: string; runs: GnapRun[] }>
  postMessage(repoPath: string, msg: GnapMessage): Promise<GnapMutResult>
  listMessages(
    repoPath: string,
    filter?: { to?: string; unreadBy?: string },
  ): Promise<{ ok: true; messages: GnapMessage[] } | { ok: false; error: string; messages: GnapMessage[] }>
  markRead(repoPath: string, msgId: string, agentId: string): Promise<GnapMutResult>
  /** Subscribe to new-commit events for a swarm repo. Returns an unsubscribe fn. */
  watch(repoPath: string, onEvent: (info: GnapWatchEvent) => void): () => void
}

export interface BankrModelInfo {
  id:      string
  label:   string
  family?: string
  live:    boolean
  /** The window the gateway published for this model, absent when it published
   *  none. bankr-service has carried it since 2026-08-02; the renderer type did
   *  not declare it, so the picker could not print or forward it. */
  contextTokens?: number
}

export interface BankrModelsResult {
  ok:     boolean
  models: BankrModelInfo[]
  stale?: boolean
  error?: string
}

export interface VeniceModelInfo {
  id:      string
  label:   string
  family?: string
  live:    boolean
  /** Model accepts image input (vision) — required to feed a Reference-Image into a Prompt node. */
  vision?: boolean
  /** Short capability tags for display: vision · reasoning · tools · web · code. */
  caps?: string[]
  /** Venice's own window (`model_spec.availableContextTokens`), absent when the
   *  catalog omitted it. venice-service has carried it since 2026-08-02. */
  contextTokens?: number
  /**
   * Venice's own $/M rates from `model_spec.pricing`, present only on a LIVE row
   * whose input AND output both parsed.
   *
   * ALREADY IN $/M — Venice publishes per-million, where OpenRouter and
   * OpenGateway publish per-token strings. The service deliberately does not
   * multiply by 1e6; a surface that "corrects" for the sibling convention would
   * over-count a Venice run a millionfold.
   */
  rates?: { inputPerM: number; outputPerM: number; cacheReadPerM?: number; cacheWritePerM?: number }
}

export interface VeniceModelsResult {
  ok:     boolean
  models: VeniceModelInfo[]
  stale?: boolean
  error?: string
}

export interface OpenRouterModelInfo {
  id:    string
  label: string
  contextTokens?: number
  /**
   * LIVE per-model free signal — the catalog's pricing.prompt AND
   * pricing.completion are exactly 0. Never derived from a `:free` id suffix.
   */
  free:  boolean
  live:  boolean
  /**
   * LIVE per-model $/M rates, from the same `pricing` object `free` is derived
   * from (openrouter-service.ts). Present only on `live` rows whose prompt AND
   * completion prices parsed — this is what gives the paid rows a price band
   * instead of the blank the static table's keyword fallback is not allowed to
   * fill.
   */
  rates?: {
    inputPerM: number
    outputPerM: number
    cacheReadPerM?: number
    cacheWritePerM?: number
  }
}

export interface OpenRouterModelsResult {
  ok:     boolean
  models: OpenRouterModelInfo[]
  stale?: boolean
  error?: string
}

export interface SurplusModelInfo {
  id:      string
  label:   string
  family?: string
  live:    boolean
  /** The window the gateway published for this model, absent when it published
   *  none. surplus-service has carried it since 2026-08-02. */
  contextTokens?: number
}

export interface SurplusModelsResult {
  ok:     boolean
  models: SurplusModelInfo[]
  stale?: boolean
  error?: string
}

// ── Surplus MEDIA engine (Layer A contract for Layers B & C) ──────────────────
// Image / TTS / STT / video / music / embeddings via Surplus's OpenAI-compatible
// media endpoints. Wired through the typed router namespace "surplusMedia".

export type SurplusMediaModality = 'text' | 'image' | 'video' | 'music' | 'tts' | 'stt' | 'embedding'

export interface SurplusMediaModelInfo {
  id:       string
  label:    string
  modality: SurplusMediaModality
  family?:  string
  live:     boolean
  /** Param names the live model advertises (drives modelParams intersection). */
  supportedParameters?: string[]
}

/**
 * Control kind the schema-driven media UI renders per param:
 *   string→single-line text, text→multiline, int/number→number/slider (min/max/step),
 *   enum→dropdown, boolean→toggle, image/audio→file upload.
 */
export type ParamKind = 'string' | 'text' | 'int' | 'number' | 'enum' | 'boolean' | 'image' | 'audio'

/**
 * One generation parameter for a (modality, model). The UI renders one control
 * per spec and sends the collected values as the `params` field on generate*.
 * Adding a param is a DATA change in the engine's curated schema — no UI code.
 */
export interface ParamSpec {
  name:         string
  label:        string
  kind:         ParamKind
  default?:     unknown
  min?:         number
  max?:         number
  step?:        number
  enum?:        string[]
  description?: string
  required?:    boolean
  advanced?:    boolean
  /**
   * `duration` only: the frame rate the seconds on this slider mean.
   *
   * The composer's length control is SECONDS and the engine's is FRAMES, so
   * something has to carry the rate between them — and it cannot be a constant,
   * because Wan 2.1 generates at 16 fps and Wan 2.2 TI2V-5B at 24. It rides on
   * the SPEC rather than on a widened IPC payload because both local surfaces
   * (the media tab and the canvas media node) already hand this exact spec to
   * resolveLocalWanFrames as its bound — so the rate reaches both of them
   * without either call site changing, which is the only way one surface does
   * not silently keep the old number.
   *
   * Absent on every CLOUD schema, where duration is a wire value and no frame
   * count is ever derived from it.
   */
  fps?:         number
  /**
   * `duration` only: the checkpoint's TEMPORAL grid — `--video-frames` must be
   * `frameGrid * n + 1`. Wan is 4; LTX-AV is 8, and the engine floors with
   * integer division, so a 45-frame request on LTX renders 41 silently.
   *
   * Rides on the spec beside `fps` for the same reason and reaches the same two
   * surfaces. Absent on every CLOUD schema; absent ⇒ 4.
   */
  frameGrid?:   number
}

export interface SurplusMediaModelsResult {
  ok:     boolean
  models: SurplusMediaModelInfo[]
  stale?: boolean
  error?: string
}

/**
 * A produced media artifact. Binary artifacts (image/audio/video) are written
 * to userData/media/<jobId>/<index>.<ext> and surfaced via `path`. Small images
 * may also carry inline base64 (`b64`, no data: prefix) for instant preview.
 * STT transcripts carry `text`.
 */
export interface Artifact {
  kind:     'image' | 'audio' | 'video' | 'text'
  mimeType: string
  path?:    string
  b64?:     string
  text?:    string
  /** The seed the LOCAL engine actually rendered with — set only when it
   *  reported a real one (never -1). For a .webm this is the ONLY provenance
   *  (no tEXt chunk), so the canvas gallery capture stamps it into the entry
   *  params via stampLocalSeed, exactly as the Media tab does. */
  seed?:    number
}

/**
 * One inbound webhook alert delivered to a canvas trigger node (BATCH35 lane B).
 * Mirrors services/webhook-hooks.ts WebhookAlert. `text` is what the node emits
 * as its output — a TradingView alert body is either JSON (pretty-printed here,
 * with the parse in `json`) or the plain sentence the user typed.
 */
export interface WebhookAlertPayload {
  hookId:     string
  source:     string
  /** Epoch ms the alert was accepted. */
  receivedAt: number
  text:       string
  json?:      unknown
  contentType?: string
  bytes:      number
}

/**
 * Per-media-node result from a full graph run (graph:run Phase 2), surfaced on
 * the run result's `media` array. Mirrors graph-to-agentkit's MediaNodeResult.
 */
export interface MediaNodeRunResult {
  nodeId:    string
  label:     string
  modality:  Exclude<SurplusMediaModality, 'text' | 'embedding'>
  /** The prompt actually used (resolved tokens / plug output / typed field). */
  prompt:    string
  ok:        boolean
  artifacts: Artifact[]
  /** STT transcript (no artifact). */
  text?:     string
  error?:    string
}

export type SurplusMediaJobStatus = 'queued' | 'processing' | 'succeeded' | 'failed' | 'unknown'

export interface SurplusMediaJobResult {
  jobId:      string
  status:     SurplusMediaJobStatus
  /** 0..1 when the gateway reports it; omitted otherwise. */
  progress?:  number
  artifacts?: Artifact[]
  error?:     string
}

export interface SurplusMediaAPI {
  /** Classified catalog; optionally filtered to a single modality. */
  listModels(input: { modality?: SurplusMediaModality; force?: boolean; provider?: 'surplus' | 'venice' }): Promise<SurplusMediaModelsResult>
  /**
   * Schema-driven controls for a (modality, model): the ParamSpec[] the UI
   * renders. Intersected with the model's advertised supported_parameters when
   * the live catalog exposes them; else the full curated schema.
   */
  modelParams(input: { modality: SurplusMediaModality; modelId: string }): Promise<{ params: ParamSpec[] }>
  /** Sync image generation → { artifacts }. `params` carries schema-driven extras. */
  generateImage(input: {
    model:        string
    prompt:       string
    size?:        string
    n?:           number
    autoSaveDir?: string
    provider?:    'surplus' | 'venice'
    params?:      Record<string, unknown>
  }): Promise<{ artifacts: Artifact[] }>
  /** Sync text-to-speech (binary audio) → { artifacts } (one audio artifact). */
  generateSpeech(input: {
    model:        string
    input:        string
    voice?:       string
    format?:      string
    speed?:       number
    autoSaveDir?: string
    provider?:    'surplus' | 'venice'
    params?:      Record<string, unknown>
  }): Promise<{ artifacts: Artifact[] }>
  /** Sync speech-to-text (multipart upload). Provide audioPath OR audioBytes. */
  transcribe(input: {
    model:       string
    audioPath?:  string
    audioBytes?: Uint8Array
    fileName?:   string
    language?:   string
    prompt?:     string
    provider?:   'surplus' | 'venice'
    params?:     Record<string, unknown>
  }): Promise<{ text: string }>
  /** Async video submit → { jobId }; poll with pollJob. */
  submitVideo(input: {
    model:       string
    prompt:      string
    duration?:   number
    resolution?: string
    params?:     Record<string, unknown>
  }): Promise<{ jobId: string }>
  /** Async music submit → { jobId }; poll with pollJob. */
  submitMusic(input: {
    model:       string
    prompt:      string
    lyrics?:     string
    duration?:   number
    resolution?: string
    params?:     Record<string, unknown>
  }): Promise<{ jobId: string }>
  /** Poll an async (video/music) job once. Caller loops until status settles. */
  pollJob(input: { jobId: string }): Promise<SurplusMediaJobResult>
  /** Copy a produced artifact into a user-chosen folder → { path }. */
  saveArtifact(input: {
    jobId:    string
    index:    number
    destDir:  string
    srcPath?: string
  }): Promise<{ path: string }>
}

// Claude Code Router (musistudio/claude-code-router) config — the real schema:
// Providers[] (name/api_base_url/api_key/models) + Router scenario→"name,model".
export interface RouterProvider {
  name:          string
  api_base_url:  string
  api_key:       string
  models?:       string[]
  transformer?:  Record<string, unknown>
}
export interface RouterRoutes {
  default?:               string
  background?:            string
  think?:                 string
  longContext?:           string
  longContextThreshold?:  number
  webSearch?:             string
  image?:                 string
  [key: string]: string | number | undefined
}
export interface RouterConfig {
  PORT?:           number
  HOST?:           string
  APIKEY?:         string
  API_TIMEOUT_MS?: number
  Providers?:      RouterProvider[]
  Router?:         RouterRoutes
  [key: string]:   unknown
}

/** One turn of the quick-ask bar's short in-memory thread. */
export interface QuickAskTurn {
  role: 'user' | 'assistant'
  content: string
}
/** The last completed quick-ask exchange, replayed on re-summon. */
export interface QuickAskExchange {
  prompt: string
  answer: string
  ts: number
}
/** Clipboard (or auto-captured selection) offered as context on summon. */
export interface QuickAskContext {
  kind: 'clipboard' | 'selection'
  /** Full text appended to the next send (capped in main at 8000 chars). */
  text: string
  /** Short single-line preview for the chip. */
  preview: string
  chars: number
  /** Armed = goes out with the next send unless dismissed. */
  armed: boolean
}

// ── Key-probe verdicts ────────────────────────────────────────────────────────
//
// Mirrors electron/services/provider-key-probe.ts, which is the authority. Every
// "is this pasted credential live?" channel in the app — civitai, huggingface,
// bankr, imgnai, venice, surplus — answers with either a success shape or this.
//
//   'rejected'   the provider answered, about the CREDENTIAL: do not store it.
//   'unverified' we learned nothing (offline, timeout, 5xx, a 402 payment
//                challenge, an unparseable answer). The card STORES the key and
//                tells the user it could not be checked — hard-blocking here
//                strands a working key on a network blip.
//
export type KeyProbeVerdict = 'rejected' | 'unverified'
export type KeyProbeFailure = { ok: false; verdict: KeyProbeVerdict; status?: number }

export interface TachiAPI {
  ollama: {
    status():        Promise<{ running: boolean }>
    ensureRunning(): Promise<{ ok: boolean; error?: string }>
    listModels():    Promise<{ ok: boolean; error?: string; models: OllamaModelInfo[] }>
    pull(name: string): Promise<{ ok: boolean; error?: string }>
    delete(name: string): Promise<{ ok: boolean; error?: string }>
    onPullProgress(cb: (e: { name: string; status: string; completed?: number; total?: number }) => void): () => void
  }
  // Sprint D5: roles — typed bridge for role registry.
  roles: {
    list(): Promise<RoleInfo[]>
    get(id: string): Promise<RoleInfo | null>
    suggest(workspaceFiles: string[], recentUserText: string): Promise<RoleSuggestResult[]>
  }
  // Sprint C1: bankr — migrated to typed router on the wire; type kept manual here
  // to preserve the optional-arg call-site (listModels() with no args) used in ProviderNode.
  bankr: {
    listModels(opts?: { force?: boolean }): Promise<BankrModelsResult>
  }
  // Surplus Intelligence — crypto-native OpenAI-compatible LLM marketplace.
  surplus: {
    listModels(opts?: { force?: boolean }): Promise<SurplusModelsResult>
  }
  // Venice — STANDALONE privacy-first OpenAI-compatible provider (NOT Surplus).
  // Text catalog for pickers + Venice's own media engine (image/tts/stt/video/music).
  venice: {
    listModels(opts?: { force?: boolean }): Promise<VeniceModelsResult>
    listMediaModels(input: { modality: 'image' | 'tts' | 'stt' | 'video' | 'music'; force?: boolean }): Promise<{
      ok: boolean
      models: Array<{ id: string; label: string; modality: 'image' | 'tts' | 'stt' | 'video' | 'music'; live: boolean }>
      error?: string
    }>
    generateImage(input: { model: string; prompt: string; size?: string; n?: number; params?: Record<string, unknown> }): Promise<{ artifacts: Artifact[] }>
    generateSpeech(input: { model: string; input: string; voice?: string; format?: string; speed?: number; params?: Record<string, unknown> }): Promise<{ artifacts: Artifact[] }>
    transcribe(input: { model: string; audioBytes?: Uint8Array; audioPath?: string; fileName?: string; language?: string; prompt?: string }): Promise<{ text: string }>
    generateVideo(input: { model: string; prompt: string; negativePrompt?: string; duration?: string; params?: Record<string, unknown> }): Promise<{ artifacts: Artifact[] }>
    generateMusic(input: { model: string; prompt: string; lyrics?: string; durationSeconds?: number; params?: Record<string, unknown> }): Promise<{ artifacts: Artifact[] }>
  }
  // OpenRouter — live model catalog with the per-model FREE signal (pricing 0/0).
  openrouter: {
    listModels(opts?: { force?: boolean }): Promise<OpenRouterModelsResult>
  }
  // Surplus MEDIA engine — image / TTS / STT / video / music / embeddings.
  surplusMedia: SurplusMediaAPI
  // imgnAI Katana media engine — image + video (kat.imgnai.com). The generate
  // calls submit + poll in MAIN and resolve with downloaded-on-disk artifacts;
  // live ticks arrive via onGenProgress ('imgnai:gen-progress' push channel).
  imgnaiMedia: {
    listModels(input: { modality: 'image' | 'video' }): Promise<{
      ok: boolean
      models: Array<{ id: string; label: string; modality: 'image' | 'video'; live: boolean; durationSeconds?: number }>
      error?: string
    }>
    generateImage(input: {
      model:         string
      prompt:        string
      aspectRatio?:  string
      outputFormat?: string
      imageUrls?:    string[]
      isUhd?:        boolean
      isFast?:       boolean
      autoSaveDir?:  string
    }): Promise<{ artifacts: Artifact[] }>
    generateVideo(input: {
      model:               string
      prompt:              string
      durationSeconds?:    number
      aspectRatio?:        string
      firstFrameImageUrl?: string
      autoSaveDir?:        string
    }): Promise<{ artifacts: Artifact[] }>
    onGenProgress(cb: (p: { requestId: string; kind: 'image' | 'video'; status: string; elapsedSec: number }) => void): () => void
  }
  // Pollinations KEYLESS image engine (image.pollinations.ai) — cloud GET with
  // the prompt in the path, no key, no account. MAIN paces requests (their
  // anonymous limit is 1 / 15 s), fetches (~45 s) and saves to disk; the
  // resolved `seed` is the one that ACTUALLY ran (a -1 is rolled in main so
  // their prompt cache cannot replay an old image). Live 'queued'/'generating'
  // ticks arrive via onGenProgress ('pollinations:gen-progress' push channel).
  pollinationsMedia: {
    listModels(input: Record<string, never>): Promise<{
      ok: boolean
      models: Array<{ id: string; label: string; modality: 'image'; live: boolean }>
      error?: string
    }>
    generateImage(input: {
      model:        string
      prompt:       string
      size?:        string
      seed?:        number
      autoSaveDir?: string
    }): Promise<{ artifacts: Artifact[]; seed: number; completedAfterPrivate: boolean }>
    // completedAfterPrivate: true only when PRIVATE MODE was engaged while this
    // fetch was already in flight — the artifact is still written (the prompt
    // had already left the machine; discarding it would restore nothing), but
    // the flag lets the gallery say so instead of looking like the queued-
    // request bug (blocked before any bytes move).
    onGenProgress(cb: (p: { requestId: string; kind: 'image'; status: string; elapsedSec: number; completedAfterPrivate?: boolean }) => void): () => void
  }
  // Fusion panel RE-RUN — retry a single failed panel member (model) over the
  // same gateway, returning whether the leg produced a usable answer + its size.
  fusion: {
    rerunMember(input: { providerId: string; model: string; brief: string }): Promise<{ ok: boolean; chars: number; error?: string }>
  }
  // Claude Code Router (musistudio) — local proxy for @anthropic-ai/claude-code.
  claudeCodeRouter: {
    checkInstalled(): Promise<{ installed: boolean }>
    install(): Promise<void>
    start(): Promise<void>
    stop(): Promise<void>
    readConfig(): Promise<RouterConfig | null>
    writeConfig(cfg: RouterConfig): Promise<void>
    seedConfig(): Promise<RouterConfig>
    onInstallProgress(cb: (e: { step: string; message: string; percent: number }) => void): () => void
  }
  safeStorage: TachiSafeStorageAPI
  networkAudit: {
    list(limit?: number): Promise<NetworkAuditEntry[]>
    clear(): Promise<{ ok: boolean }>
  }
  connectors: {
    list(): Promise<ConnectorStatus[]>
    disconnect(id: string): Promise<{ ok: boolean }>
  }
  settings: {
    load(): Promise<AppSettings>
    save(settings: Partial<AppSettings>): Promise<void>
    saveKey(providerId: string, key: string): Promise<void>
    deleteKey(providerId: string): Promise<void>
    listKeys(): Promise<string[]>
  }
  provider: {
    listModels(providerId: string): Promise<ModelInfo[]>
    /** Last-good catalog from the 12h auto-refresher's disk cache (null = never fetched). */
    cachedModels(providerId: string): Promise<{ fetchedAt: string; models: Array<{ id: string; label?: string }> } | null>
    healthCheck(providerId: string): Promise<HealthStatus>
    testKey(providerId: string, key: string): Promise<HealthStatus>
    /**
     * Validate a TYPED Bankr key before the Settings card stores it.
     * `balanceUsd` is the wallet's effective credit (documented at
     * docs.bankr.bot/llm-gateway/api-reference), formatted to 2dp, or '' when
     * the 200 body could not be read. A 401 is `rejected`; anything else is
     * `unverified`.
     */
    validateBankrKey(key: string): Promise<{ ok: true; balanceUsd: string } | KeyProbeFailure>
    /**
     * Validate a TYPED imgnAI key + secret PAIR (the balance read is the only
     * free endpoint that judges both halves). `credits` is imgnAI's own decimal
     * string. A missing half answers `unverified` with no request — the card
     * saves that case unvalidated rather than pretending it was checked.
     */
    validateImgnaiCredential(key: string, secret: string): Promise<{ ok: true; credits: string } | KeyProbeFailure>
    /**
     * Validate a TYPED Venice key against GET /api/v1/api_keys/rate_limits.
     * `limited: true` is the documented 403 — a real key without the rights to
     * read account metadata, accepted with no balance claimed. Venice NEVER
     * answers `rejected`: its 401 is ambiguous (inference-only keys and lapsed
     * Pro subscriptions both produce one), so it comes back `unverified` with
     * status 401 and the card warns instead of accusing. Full argument in
     * electron/services/provider-key-probe.ts.
     */
    validateVeniceKey(key: string): Promise<
      { ok: true; limited: boolean; accessPermitted?: boolean; tier?: string; usd?: string; diem?: string } | KeyProbeFailure
    >
    /**
     * Validate a TYPED Surplus buyer key (inf_…) against
     * POST /anthropic/v1/messages/count_tokens — it reads the key and runs no
     * inference, so nothing is spent. `tokens` is the estimate it returned.
     * 401 is `rejected`; anything else is `unverified`.
     */
    validateSurplusKey(key: string): Promise<{ ok: true; tokens: number } | KeyProbeFailure>
    /** Two-gate admission probe: text + tool-call; flags chat-only models. */
    probeModel(args: { baseUrl: string; model: string; providerId?: string }): Promise<{ textOk: boolean; toolsOk: boolean; verdict: 'full' | 'chat-only' | 'unusable'; detail?: string }>
    /** Custom endpoint (T17) TEST button: GET <baseUrl>/models, 5s timeout. */
    testCustomEndpoint(baseUrl: string, key?: string): Promise<{ ok: boolean; models: string[]; error?: string }>
    /** Custom endpoint (T17) live model list for the chat picker (60s cache). */
    listCustomModels(providerId: string, force?: boolean): Promise<{ ok: boolean; models: string[]; error?: string }>
  }
  chat: {
    send(payload: {
      conversationId: string
      message: string | ChatContentPart[]
      model?: string
      providerId?: string
      profileId?: string
      workspaceRoot?: string
      systemMessage?: string
      /** Attached knowledge folder — chat RAG over the local per-folder index. */
      ragFolder?: string
      githubToolsEnabled?: boolean
      /** D6: Thinking depth — propagates Anthropic `thinking` param when applicable. */
      depth?: 'normal' | 'think' | 'ultra'
      /** Surplus smart router: route by difficulty when true (+ Surplus + auto model). */
      surplusSmartRouting?: boolean
      /** Allow a hard + agentic task to escalate to the agent-kit workflow (opt-in). */
      allowWorkflowEscalation?: boolean
      /** Fusion (bankr/venice/surplus): panel of models answer in parallel + judge synthesis. */
      fusionMode?: boolean
      /** Fusion panel preset: 'budget' (cheap cross-family) or 'frontier' (top models). */
      fusionPreset?: 'budget' | 'frontier'
      /** Fusion arbiter: how to combine the panel (synthesize / best_of_n / majority). */
      fusionArbiter?: 'synthesize' | 'best_of_n' | 'majority' | 'compare'
      /** Optional custom Fusion panel model ids; omitted = the preset default. */
      fusionPanel?: string[]
      /** Optional Fusion judge/synthesizer model id; omitted = the preset default. */
      fusionJudge?: string
      /** Per-chat sampler (T19): resolved temperature/top_p; omitted = provider defaults (BALANCED). */
      sampler?: { temperature?: number; top_p?: number }
      /**
       * The context window the routed model's provider published (from the
       * renderer's catalog cache — modelWindow.store). Main budgets the
       * red-zone against it. OMIT when nobody published one: absent means
       * unknown, and main then resolves per-model instead of guessing.
       */
      contextTokens?: number
      /** Prior turns of this conversation, so the provider has memory of the chat. */
      history?: Array<{ role: 'user' | 'assistant'; content: string }>
    }): Promise<void>
    abort(conversationId: string): Promise<void>
    onChunk(cb: (chunk: ChatChunk) => void): () => void
    saveConversation(conv: unknown): Promise<void>
    /** Remove the mirrored JSON file for a deleted conversation (privacy: keep disk in sync with the store). */
    deleteConversation(id: string): Promise<{ ok: boolean }>
    /** D4: Subscribe to context-chars updates emitted after each completed turn. */
    onContextCharsUpdated(cb: (payload: { conversationId: string; deltaChars: number }) => void): () => void
    /** D4: Subscribe to red-zone-entered events (fired once per conversation). */
    onRedZoneEntered(cb: (payload: { conversationId: string }) => void): () => void
  }
  runtime: {
    scanAll(): Promise<void>
    scanOne(runtimeId: string): Promise<RuntimeCardUpdate>
    onUpdate(cb: (update: RuntimeCardUpdate) => void): () => void
  }
  terminal: {
    create(id: string): Promise<void>
    write(id: string, data: string): Promise<void>
    resize(id: string, cols: number, rows: number): Promise<void>
    kill(id: string): Promise<void>
    onData(cb: (id: string, data: string) => void): () => void
    onExit(cb: (id: string) => void): () => void
  }
  logs: {
    onEvent(cb: (event: LogEvent) => void): () => void
  }
  commands: {
    onEvent(cb: (event: AgentCommandEvent) => void): () => void
  }
  profiles: {
    list():    Promise<Profile[]>
    get(id: string): Promise<Profile | null>
    create(input: ProfileInput): Promise<Profile>
    update(id: string, patch: Partial<ProfileInput>): Promise<Profile>
    delete(id: string): Promise<{ deleted: boolean; activeFallback?: string }>
    duplicate(id: string): Promise<Profile>
    getActive(): Promise<string | null>
    setActive(id: string | null): Promise<void>
  }
  workspace: {
    open(path: string): Promise<Workspace>
    current(): Promise<Workspace | null>
    clear(): Promise<void>
    initAgentsMd(): Promise<{ ok: boolean; path: string; reason?: string }>
  }
  sidecar: {
    list():                                                    Promise<SidecarInfo[]>
    start(id: SidecarInfo['id'], workingDir?: string): Promise<SidecarInfo>
    stop(id: SidecarInfo['id']):                       Promise<SidecarInfo>
    health(id: SidecarInfo['id']):                     Promise<boolean>
    logs(id: SidecarInfo['id'], lines?: number):       Promise<{ available: boolean; lines: string[]; path?: string }>
    checkInstalled():                                          Promise<{ installed: boolean }>
    install():                                                 Promise<void>
    onInstallProgress(cb: (e: InstallProgressEvent) => void): () => void
  }
  agent: {
    pickFolder(): Promise<string | null>
    startSession(
      workingDir: string,
      harness?: AgentRuntimeHarness,
      provider?: 'default' | 'opengateway' | 'bankr' | 'surplus' | 'venice' | 'imgnai',
      bankrModel?: string,
      surplusModel?: string,
      surplusSmartRouting?: boolean,
      veniceModel?: string,
      imgnaiModel?: string,
    ): Promise<{ sessionId: string }>
    /** Smart router: classify a task → the model id it routes to (code first-task routing). Provider-agnostic — scores against the given provider's catalog. */
    routeModel(message: string, provider?: 'surplus' | 'bankr'): Promise<{ ok: boolean; model?: string; tier?: string; modelSet?: string; reasoning?: string; error?: string }>
    /**
     * Send a task to an active agent session.
     * F1: `parsedCommand` is present when the user typed a recognised slash
     * command; forwarded to main process for F2 system-prompt injection.
     */
    send(
      sessionId:      string,
      task:           string,
      harness:        AgentRuntimeHarness,
      workingDir:     string,
      parsedCommand?: ParsedSlashCommand,
      /** parallel-code: optional per-task runtime selector. Defaults to single-session 'default'. */
      taskId?:        string,
      /** #5: active role id — primes the persona + enforces the role's tool/path boundaries. */
      roleId?:        string,
      /** PLAN/BUILD toggle — 'plan' enforces a fail-closed read-only tool gate (TACHI harness). */
      mode?:          'plan' | 'build',
      /**
       * Thinking-depth toggle (NORMAL/THINK/ULTRA). Trailing optional positional
       * arg AFTER `mode` so existing callers keep working. Applied SERVER-SIDE in
       * the TACHI harness so depth works from any entry point; defaults to 'normal'.
       */
      depth?:         'normal' | 'think' | 'ultra',
      /**
       * Prior conversation turns (this session). Trailing optional positional arg
       * so existing callers keep working. The TACHI harness replays these so the
       * agent remembers context across messages instead of starting fresh each send.
       */
      history?:       Array<{ role: 'user' | 'assistant'; content: string }>,
      /**
       * Reference images (data: URLs) attached to this turn. Trailing optional
       * positional arg. The TACHI harness feeds them to the first user message for
       * vision-capable models (ignored, with a notice, otherwise).
       */
      images?:        string[],
      /**
       * Trust preset (SAFE/STANDARD/AUTO, UX #8). Trailing optional positional
       * arg; enforced SERVER-SIDE in the tachiGate approval ladder. Defaults
       * to 'standard' (today's exact behavior).
       */
      trust?:         'safe' | 'standard' | 'auto',
    ): Promise<void>
    /** parallel-code: when taskId is omitted, aborts the legacy single-session runtime. */
    abort(taskId?: string): Promise<void>
    /**
     * LOOP MODE: ask the loop driving this session to stop after the current
     * iteration (graceful; `abort` is the hard stop). Resolves `{ok:false}`
     * when no loop with that session id is live.
     */
    stopLoop(sessionId: string): Promise<{ ok: boolean }>
    /**
     * Stop a session. parallel-code: optional `taskId` lets callers stop a
     * specific parallel task without tracking sessionIds — when supplied AND
     * registered with the parallel manager, the task's current sessionId
     * overrides the `sessionId` argument. Omitting `taskId` preserves the
     * legacy single-session behaviour exactly.
     */
    stopSession(sessionId: string, taskId?: string): Promise<void>
    onEvent(cb: (event: AgentEvent) => void): () => void
    listDir(dir: string): Promise<Array<{ name: string; isDir: boolean; children?: Array<{ name: string; isDir: boolean }> }>>
    generateAgentsMd(workingDir: string): Promise<{ ok: boolean; path: string; reason?: string }>
    readFile(path: string): Promise<{ kind: 'text' | 'image' | 'binary'; content?: string; sizeBytes: number; truncated?: boolean }>
    writeFile(path: string, content: string): Promise<{ ok: true; path: string } | { ok: false; error: string; path: string }>
    /** Copy a produced artifact into <storage root>\Media\Artifacts (PreviewPanel SAVE COPY). */
    saveArtifactCopy(path: string): Promise<{ ok: true; path: string } | { ok: false; error: string; path: string }>
    registerWorkspace(dir: string): Promise<{ ok: true } | { ok: false; error: string }>
    createFile(dir: string, name: string):   Promise<{ ok: true; path: string } | { ok: false; error: string; path: string }>
    createFolder(dir: string, name: string): Promise<{ ok: true; path: string } | { ok: false; error: string; path: string }>
    renameEntry(path: string, newName: string): Promise<{ ok: true; path: string } | { ok: false; error: string; path: string }>
    deleteEntry(path: string):                  Promise<{ ok: true; path: string } | { ok: false; error: string; path: string }>
    /** B2.1: Send permission decision to main process. */
    permissionResponse(id: string, decision: PermissionDecision): Promise<void>
    /**
     * Permission prompts main is still awaiting, oldest first. The app-lifetime
     * agent event bridge calls this ONCE at renderer startup to re-sync the
     * queue: the queue lives in the agent store and its push channel is bound
     * for the whole renderer's life, so the only remaining gap this covers is a
     * card raised before a full renderer reload.
     */
    permissionPending(): Promise<Array<{
      id: string
      toolName: string
      toolInput: unknown
      reason: string
      recommendedDecision: 'allow' | 'deny'
      /** Harness session the blocked call belongs to (owner labelling). */
      sessionId?: string
    }>>
    /** B2.1: Subscribe to permission requests pushed by main process. */
    onPermissionRequest(cb: (req: {
      id: string
      toolName: string
      toolInput: unknown
      reason: string
      recommendedDecision: 'allow' | 'deny'
      /**
       * Harness session the blocked call belongs to. The approval queue is
       * app-lifetime, so a card can render on a surface that does not own the
       * run — the renderer maps this id to the owning surface and labels the
       * card with it.
       */
      sessionId?: string
    }) => void): () => void
    /**
     * Permission requests main already settled without the user: 'timeout' (no
     * answer within 10 minutes), 'cancelled' (run aborted/stopped) or
     * 'answered-elsewhere' (a remote surface like Telegram answered first).
     * The renderer must drop these cards from its queue.
     */
    onPermissionCancel(cb: (payload: {
      ids: string[]
      reason: 'timeout' | 'cancelled' | 'answered-elsewhere'
    }) => void): () => void
    /**
     * F4: Approve a slash-command plan and send a follow-up directive to the agent.
     * The full plan JSON is included in the directive so the agent has the artifact
     * in conversation history and does not rely on its own prior emission.
     *
     * @param sessionId    - Active agent session ID. May be ignored if `opts.taskId`
     *                       resolves to a parallel task with its own sessionId.
     * @param plan         - The SlashCommandResult that was approved.
     * @param opts.fix     - If true, execute with --fix semantics (no further confirmation).
     * @param opts.taskId  - parallel-code: when set and registered with the parallel
     *                       manager, the task's current sessionId is used instead of
     *                       the `sessionId` argument. Lets callers approve plans for
     *                       a specific parallel task without tracking sessionIds.
     */
    approvePlan(sessionId: string, plan: unknown, opts?: { fix?: boolean; taskId?: string }): Promise<void>
  }
  openclaude: {
    checkInstalled(): Promise<{ installed: boolean }>
    install(): Promise<void>
    start(): Promise<void>
    stop(): Promise<void>
    onInstallProgress(cb: (e: OpenClaudeInstallProgress) => void): () => void
  }
  /** Telegram remote channel into the TACHI agent (Settings → TELEGRAM).
   *  Token stays in main (status only reports hasToken). */
  telegram: {
    status(): Promise<{ enabled: boolean; running: boolean; hasToken: boolean; paired: boolean; chatId: string; pairingCode: string | null; workspace: string; lastError: string }>
    setToken(token: string): Promise<{ enabled: boolean; running: boolean; hasToken: boolean; paired: boolean; chatId: string; pairingCode: string | null; workspace: string; lastError: string }>
    setEnabled(enabled: boolean): Promise<{ enabled: boolean; running: boolean; hasToken: boolean; paired: boolean; chatId: string; pairingCode: string | null; workspace: string; lastError: string }>
    unpair(): Promise<{ enabled: boolean; running: boolean; hasToken: boolean; paired: boolean; chatId: string; pairingCode: string | null; workspace: string; lastError: string }>
    chooseWorkspace(): Promise<{ enabled: boolean; running: boolean; hasToken: boolean; paired: boolean; chatId: string; pairingCode: string | null; workspace: string; lastError: string }>
  }
  /** Codex worker sidecar (OpenAI Codex CLI): install once, log in once — the
   *  TACHI harness then gains the gated codex_worker delegation tool. */
  codex: {
    status(): Promise<{ installed: boolean; version: string; loggedIn: boolean; detail: string; enabled: boolean }>
    setEnabled(enabled: boolean): Promise<{ ok: boolean; enabled: boolean }>
    install(): Promise<{ ok: boolean; error?: string }>
    login(): Promise<{ ok: boolean; detail: string }>
    /** `codex logout` + auth.json removal — the fix for a consumed refresh token. */
    logout(): Promise<{ ok: boolean; detail: string }>
    /** Copy a login found in the NON-active codex home into the active one (troubleshooting). */
    adoptAuth(): Promise<{ ok: boolean; detail: string }>
    onInstallProgress(cb: (p: { step: string; message: string; percent: number }) => void): () => void
    onLoginProgress(cb: (p: { line: string }) => void): () => void
    /** Console dock CODEX tab: run-journal snapshot + live line pushes. */
    getLog(): Promise<Array<{ at: number; runId: string; kind: 'start' | 'progress' | 'answer' | 'error' | 'exit'; text: string }>>
    onLogEvent(cb: (line: { at: number; runId: string; kind: 'start' | 'progress' | 'answer' | 'error' | 'exit'; text: string }) => void): () => void
  }
  /** User-visible storage root (Documents\Tachi Studio by default) — where the
   *  app saves user content (media/designs/renders/flows). */
  storage: {
    info(): Promise<{ root: string; defaultRoot: string; exists: boolean }>
    choose(): Promise<{ ok: boolean; root: string | null }>
    open(): Promise<{ ok: boolean; error?: string }>
    reset(): Promise<{ ok: boolean; root: string }>
  }
  /** Model-weight storage dashboard + relocation (Settings → Model Weights):
   *  per-engine disk usage, one-click remove, and "Move models to storage root". */
  modelStorage: {
    usage(force?: boolean): Promise<ModelStorageUsage>
    remove(engine: string, id: string): Promise<{ ok: boolean; error?: string }>
    migrate(engine?: string): Promise<{ ok: boolean; results: ModelMigrateResult[] }>
    abort(engine?: string): Promise<{ ok: boolean }>
    isMigrating(engine?: string): Promise<{ migrating: boolean }>
    onMigrateProgress(cb: (event: ModelMigrateProgress) => void): () => void
    /** Leftover download staging the usage walk cannot see — it counts model
     *  ITEMS, and an interrupted transfer is not a model. Never cached. */
    staging(): Promise<StagingInventory>
    /** Delete named staging files. The paths are a request: main re-scans and
     *  refuses anything a fresh offer does not contain. */
    reclaimStaging(paths: string[]): Promise<StagingReclaimResult>
  }
  /** Local scheduler (Settings → Scheduled): run a saved flow or a prompt on a
   *  timer, surviving app restarts and PC sleep. Fully offline. */
  scheduler: {
    list(): Promise<{ ok: boolean; jobs: ScheduledJob[]; busy: boolean; error?: string }>
    save(job: ScheduledJobInput): Promise<{ ok: true; job: ScheduledJob } | { ok: false; error: string }>
    remove(id: string): Promise<{ ok: boolean; error?: string }>
    setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; job?: ScheduledJob; error?: string }>
    runNow(id: string): Promise<{ ok: boolean; status?: ScheduledJobRunStatus; detail?: string; error?: string }>
    onChanged(cb: (payload: { jobs: ScheduledJob[] }) => void): () => void
  }
  app: {
    getDataPath():     Promise<string>
    deleteAllData():   Promise<void>
    resetOnboarding(): Promise<void>
    openDevTools():    Promise<void>
    checkForUpdates(): Promise<
      | { state: 'available'; version: string }
      | { state: 'current' }
      | { state: 'unconfigured' }
      | { state: 'error'; message: string }
    >
    downloadUpdate():  Promise<void>
    quitAndInstall():  Promise<void>
    /** TACHIAPP: resolve this app's own source checkout (null = ask the user). */
    resolveAppRepo(): Promise<{ path: string; source: 'setting' | 'dev' | 'fallback' } | null>
    /** TACHIAPP: one-time native pick of the app source folder; stored forever. */
    chooseAppRepo(): Promise<
      | { ok: true; path: string }
      | { ok: false; cancelled?: boolean; error?: string }
    >
    onUpdateStatus(cb: (status: { state: string; version?: string }) => void): () => void
  }
  notification: {
    show(payload: { title: string; body?: string; silent?: boolean }): Promise<void>
  }
  tray: {
    onNewChat(cb: () => void): () => void
    onOpenAgent(cb: () => void): () => void
  }
  system: {
    info(): Promise<SystemInfo>
  }
  oauth: {
    anthropicStart():             Promise<{ authorizeUrl: string }>
    anthropicComplete(code: string): Promise<AnthropicOAuthResult>
    openrouterStart():            Promise<OpenRouterOAuthResult>
    openrouterCancel():           Promise<void>
  }
  cost: {
    /** 30-day per-provider spend rollup + the configured budget (cost ledger). */
    summary(): Promise<{
      windowDays: number
      totalUsd: number
      budgetUsd: number
      byProvider: Record<string, { usd: number; promptTokens: number; completionTokens: number; events: number; unpricedEvents: number }>
      byTaskType: Record<string, { usd: number; promptTokens: number; completionTokens: number; events: number }>
    }>
    /** Recent per-task agent runs (run log), newest first. */
    recentRuns(n?: number): Promise<Array<{
      ts: number
      task: string
      harness: string
      workingDir: string
      outcome: 'done' | 'error' | 'abort'
      durationMs: number
      error?: string
    }>>
  }
  /** Media URL-import via yt-dlp (YouTube/IG/X → local file). Personal use only. */
  ytdlp: {
    installed(): Promise<{ installed: boolean }>
    info(url: string): Promise<{
      ok: boolean
      info?: { title: string; thumbnail?: string; durationSec?: number; extractor?: string; formats: Array<{ id: string; label: string; height: number }> }
      error?: string
    }>
    download(url: string, formatId?: string, audioOnly?: boolean): Promise<{ ok: boolean; path?: string; mediaUrl?: string; error?: string }>
    onDownloadProgress(cb: (p: { url: string; percent: number; speed?: string; eta?: string; total?: string }) => void): () => void
    onInstallProgress(cb: (p: { stage: string; message: string; percent: number }) => void): () => void
  }
  /**
   * RIFE frame interpolation (rife-ncnn-vulkan sidecar). Fully LOCAL — it reads
   * a file already on disk and writes "<name>-rife2x.mp4" next to it, so it is
   * not gated by PRIVATE MODE. Downloading the sidecar itself is normal egress.
   */
  rife: RifeAPI
  mcp: {
    list():                                          Promise<MCPServerInfo[]>
    add(config: MCPServerConfig):                    Promise<MCPServerInfo[]>
    remove(name: string):                            Promise<MCPServerInfo[]>
    start(name: string):                             Promise<MCPServerInfo | undefined>
    stop(name: string):                              Promise<MCPServerInfo | undefined>
    listTools(name: string):                         Promise<MCPTool[]>
    // One-click marketplace: curated static catalog → install → enable.
    catalog():                                       Promise<{ entries: McpCatalogEntry[]; tags: string[] }>
    install(req: McpInstallRequest):                 Promise<MCPServerInfo[]>
    setServerEnabled(name: string, enabled: boolean): Promise<MCPServerInfo[]>
    // In-process MCP server (Clauge-style auto-start).
    status():           Promise<{ running: boolean; enabled: boolean; url: string | null; port: number | null }>
    revealToken():      Promise<string | null>
    rotateToken():      Promise<{ running: boolean; url: string | null; port: number | null }>
    setEnabled(enabled: boolean): Promise<{ running: boolean; enabled: boolean; url: string | null; port: number | null }>
    copyClientConfig(): Promise<{ claudeDesktop: { mcpServers: Record<string, { url: string; headers: Record<string, string> }> } } | null>
  }
  // Local OpenAI-compatible API server (127.0.0.1:11435/v1 — FreeLLM + llama.cpp
  // behind one Bearer-gated loopback endpoint for external tools).
  apiServer: {
    status():           Promise<{ running: boolean; enabled: boolean; baseUrl: string | null; port: number | null }>
    revealToken():      Promise<string | null>
    rotateToken():      Promise<{ running: boolean; enabled: boolean; baseUrl: string | null; port: number | null }>
    setEnabled(enabled: boolean): Promise<{ running: boolean; enabled: boolean; baseUrl: string | null; port: number | null }>
    copySnippet():      Promise<{ baseUrl: string; curl: string; python: string } | null>
  }
  // Sprint C1: shell — renderer calls openExternal(url: string); the preload
  // wraps the string into { url } before invoking the typed router channel.
  // Bug 3: revealInFolder added — calls shell.showItemInFolder on the main process.
  shell: {
    openExternal(url: string):     Promise<{ ok: true }>
    revealInFolder(path: string):  Promise<{ ok: true }>
  }
  // App-wide Base wallet — shared signer for nookplot, x402, and other integrations.
  wallet: {
    getInfo(): Promise<WalletInfoView>
    getBalances(): Promise<WalletBalances>
    create(): Promise<{ address: string; privateKey: string; mnemonic?: string }>
    importRaw(privateKey: string): Promise<WalletInfoView>
    importKeystore(json: string, password: string): Promise<WalletInfoView>
    exportKeystore(password: string): Promise<{ keystore: string }>
    forget(): Promise<WalletInfoView>
    signMessage(message: string): Promise<{ signature: string }>
    sendTransaction(tx: { to: string; value?: string; data?: string; amountEth?: string }): Promise<{ hash: string }>
    // darksol foundation — multi-wallet / multi-chain / multi-token + agent limits.
    listWallets(): Promise<WalletListEntry[]>
    setActiveAgentWallet(name: string): Promise<WalletListEntry[]>
    createAgentWallet(name: string): Promise<{ address: string; privateKey: string; mnemonic?: string }>
    importAgentWallet(name: string, privateKey: string): Promise<WalletListEntry[]>
    forgetAgentWallet(name: string): Promise<WalletListEntry[]>
    walletBalances(args: { kind: WalletKind; name?: string; chainId?: number }): Promise<{ address: string | null; tokens: AggregatedToken[] }>
    sendToken(args: { kind: WalletKind; name?: string; chainId: number; tokenSymbol: string; to: string; amount: string }): Promise<{ hash: string }>
    fundAgentWallet(args: { toAgent: string; chainId: number; amountEth: string }): Promise<{ hash: string }>
    getAgentLimits(name: string): Promise<AgentLimits>
    setAgentLimits(args: { name: string; limits: AgentLimits }): Promise<AgentLimits>
    listNetworks(): Promise<NetworkDef[]>
    listTx(limit?: number): Promise<WalletTxEntry[]>
    /** Verify the tx journal's SHA-256 hash chain (tamper-evidence). */
    verifyTxLog(): Promise<{ ok: boolean; sealed: number; unsigned: number; firstBadLine?: number; reason?: string }>
    onChanged(cb: (info: WalletInfoView) => void): () => void
    // S6: real-tx confirmation gate (main asks renderer to confirm before broadcast).
    onConfirmRequest(cb: (req: { id: number; summary: { kind: string; to: string; amount: string; symbol: string; chainId?: number } }) => void): () => void
    confirmRespond(id: number, approved: boolean): void
  }
  // nookplot — first-class integration backed by @nookplot/runtime in main.
  nook: {
    /** Generic public gateway GET proxy (no connection needed). */
    get(path: string, apiKey?: string): Promise<{ ok: boolean; status: number; body: unknown }>
    getStatus(): Promise<NookStatus>
    configure(input: { apiKey?: string; privateKey?: string }): Promise<NookStatus>
    clearCredentials(): Promise<NookStatus>
    /** Create a brand-new agent wallet; persists the key to the OS keychain and returns it once for backup. */
    generateWallet(): Promise<NookWalletInfo>
    /** Register this wallet as an on-chain agent (gasless, signed locally). */
    register(input: { name?: string; description?: string }): Promise<NookStatus>
    /** One-tap in-app registration: POST /v1/agents → prepare/register → relay. Works from a fresh wallet (no prior session). */
    registerInApp(input: { name: string; description?: string; model?: { provider: string; name: string }; capabilities?: string[] }): Promise<NookStatus>
    /** Export the agent key as a password-encrypted keystore JSON (Web3 Secret Storage). */
    exportKeystore(password: string): Promise<{ keystore: string }>
    /** Import a password-encrypted keystore, replace the stored key, and reconnect. */
    importKeystore(json: string, password: string): Promise<NookStatus>
    connect(): Promise<NookStatus>
    disconnect(): Promise<NookStatus>
    getProfile(): Promise<NookProfileView>
    listBounties(opts?: { limit?: number; community?: string }): Promise<NookBountyView[]>
    claimBounty(id: string): Promise<{ ok: true }>
    submitWork(id: string, description: string, deliverables: string[]): Promise<{ ok: true }>
    listListings(opts?: { query?: string; limit?: number }): Promise<NookListingView[]>
    goOnline(provider?: string, model?: string): Promise<NookStatus>
    setBrain(provider: string, model?: string): Promise<{ provider: string; model: string }>
    listBrainProviders(): Promise<{ id: string; label: string; available: boolean; reason?: string; defaultModel: string }[]>
    goOffline(): Promise<NookStatus>
    getApprovals(): Promise<unknown[]>
    approveAction(id: string): Promise<{ ok: true }>
    rejectAction(id: string): Promise<{ ok: true }>
    getActivity(limit?: number): Promise<unknown[]>
    /** MCP sidecar: give the app's LLM agents the full nookplot toolset. */
    mcpStatus(): Promise<{ registered: boolean; credentialsReady: boolean; status?: string; toolCount?: number }>
    mcpEnable(): Promise<{ registered: boolean; credentialsReady: boolean; status?: string; toolCount?: number }>
    mcpDisable(): Promise<{ registered: boolean; credentialsReady: boolean; status?: string; toolCount?: number }>
    /** darksol MCP shim: give the app's agents + Nodes workflows the darksol harness toolset. */
    darksolMcpStatus():  Promise<DarksolMcpStatus>
    darksolMcpEnable():  Promise<DarksolMcpStatus>
    darksolMcpDisable(): Promise<DarksolMcpStatus>
    /** Live status pushes (connect/disconnect/online changes). Returns unsubscribe. */
    onStatus(cb: (status: NookStatus) => void): () => void
    /** Live network event feed from the gateway WebSocket. Returns unsubscribe. */
    onEvent(cb: (event: { type: string; data: unknown; at: number }) => void): () => void
  }
  // nookplot write-actions (electron/services/nook-actions-service.ts).
  nookActions: {
    postBounty(i: { title: string; description: string; community: string; token: string; amount: string; deadline: number }): Promise<{ txHash: string; bountyId: number | null }>
    applyBounty(i: { id: string; message: string }): Promise<{ ok: true }>
    submitWork(i: { id: string; description: string; deliverables?: string[] }): Promise<{ ok: true; txHash: string }>
    hireService(i: { listingId: string; terms: string; deadline: number; token?: string; amount?: string }): Promise<{ ok: true; txHash: string }>
  }
  // nookplot network/knowledge (electron/services/nook-network-service.ts).
  nookNetwork: {
    getFeed(opts?: { limit?: number; community?: string; sort?: 'hot' | 'new' | 'top' | 'reputation' }): Promise<NookPostView[]>
    getPost(cid: string): Promise<NookPostDetail>
    publishPost(input: { title: string; body: string; community: string; tags?: string[] }): Promise<{ cid: string; txHash?: string }>
    listCommunities(opts?: { limit?: number }): Promise<{ slug: string; totalPosts: number }[]>
    getLeaderboard(opts?: { limit?: number }): Promise<NookLeaderEntryView[]>
    searchAgents(query: string, limit?: number): Promise<NookAgentView[]>
    follow(address: string): Promise<{ ok: true; txHash: string }>
  }
  // nookplot mining — real discover/solve/rewards via the runtime MiningManager.
  nookMining: {
    getTrackStats(): Promise<NookTrackStat[]>
    listChallenges(opts?: { limit?: number }): Promise<NookMiningChallengeView[]>
    getRewards(): Promise<NookMiningRewardsView>
    solveOnce(): Promise<NookMiningStats>
    startLoop(opts?: { maxCredits?: number }): Promise<{ running: boolean }>
    stopLoop(): Promise<{ running: boolean }>
    stats(): Promise<NookMiningStats>
  }
  // nookplot messaging — inbox DMs + group channels (electron/services/nook-messaging-service.ts).
  nookMessaging: {
    inboxList(opts?: { unreadOnly?: boolean; from?: string; limit?: number }): Promise<NookDMView[]>
    unreadCount(): Promise<number>
    sendDM(toAddress: string, content: string): Promise<{ id: string; createdAt: string }>
    markRead(messageId: string): Promise<{ ok: true }>
    listChannels(opts?: { limit?: number; isPublic?: boolean; channelType?: string }): Promise<NookChannelView[]>
    channelMessages(channelId: string, limit?: number, before?: string): Promise<NookChannelMessageView[]>
    channelMembers(channelId: string): Promise<NookChannelMemberView[]>
    sendChannel(channelId: string, content: string): Promise<{ id: string; createdAt: string }>
    joinChannel(channelId: string): Promise<{ ok: true }>
    leaveChannel(channelId: string): Promise<{ ok: true }>
  }
  theme: {
    apply(theme: string): Promise<void>
  }
  appControl: {
    onExec(cb: (p: { id: string; action: string; args: Record<string, unknown> }) => void): () => void
    result(payload: { id: string; ok: boolean; result?: unknown; error?: string }): void
  }
  window: {
    minimize():       Promise<void>
    maximizeToggle(): Promise<void>
    close():          Promise<void>
    getState():       Promise<{ maximized: boolean; transparent: boolean }>
    onStateChanged(cb: (s: { maximized: boolean }) => void): () => void
  }
  overlay: {
    getSourceId(): Promise<{ sourceId: string; displaySize: { width: number; height: number }; scaleFactor: number }>
    reportCapture(dataUrl: string): Promise<void>
    captureRegion(rect: { x: number; y: number; w: number; h: number }): Promise<{ dataUrl: string }>
    cancel(): Promise<void>
    onCaptureDone(cb: (data: { dataUrl: string }) => void): () => void
  }
  aeon: {
    ghStatus(): Promise<AeonGhStatus>
    loginStart(): Promise<void>
    loginCancel(): Promise<void>
    onLoginCode(cb: (d: { code: string; verificationUri: string }) => void): () => void
    onLoginDone(cb: (d: { ok: boolean; error?: string }) => void): () => void
    detectFork(): Promise<AeonForkStatus>
    fork(): Promise<AeonForkStatus>
    listWorkflows(owner: string): Promise<AeonWorkflowSummary[]>
    listRuns(owner: string, limit?: number): Promise<AeonRunSummary[]>
    trigger(owner: string, workflowPath: string, ref?: string, inputs?: Record<string, string>): Promise<void>
    setSecret(owner: string, name: string, value: string): Promise<void>
    pushLocalProviderSecret(
      owner: string,
      provider: 'opengateway' | 'bankr-gateway' | 'anthropic-oauth' | 'anthropic',
    ): Promise<{ ok: boolean; provider: string; owner: string; secretName: string }>
    enableActions(owner: string): Promise<void>
    actionsStatus(owner: string): Promise<{ enabled: boolean; allowed_actions?: 'all' | 'local_only' | 'selected' }>
    syncFork(owner: string, branch?: string): Promise<{ message: string; merge_type: 'merge' | 'fast-forward' | 'none'; base_branch: string }>
    runLogs(owner: string, runId: number): Promise<string>
    patchWorkflowForOpenGateway(owner: string): Promise<{ patched: boolean; alreadyPatched?: boolean }>
    unpatchWorkflowForOpenGateway(owner: string): Promise<{ unpatched: boolean }>
    workflowPatchStatus(owner: string): Promise<boolean>
    getGateway(owner: string): Promise<'direct' | 'bankr' | 'opengateway'>
    setGateway(owner: string, provider: 'direct' | 'bankr' | 'opengateway'): Promise<{ changed: boolean }>
    listDashboardOutputs(owner: string): Promise<AeonDashboardOutput[]>
    getDashboardOutput(owner: string, filename: string): Promise<unknown | null>
    cronState(owner: string): Promise<AeonCronState>
    skillHealth(owner: string): Promise<AeonSkillHealth[]>
    probeDashboard(port?: number): Promise<{ running: boolean; port: number }>
    dashboardPrereqs(): Promise<{ node: { found: boolean; version?: string }; npm: { found: boolean; version?: string }; ok: boolean }>
    dashboardStatus(): Promise<{ state: 'idle' | 'downloading' | 'extracting' | 'installing-deps' | 'starting' | 'ready' | 'error'; port: number | null; message?: string }>
    dashboardInstallAndLaunch(owner: string): Promise<{ port: number }>
    dashboardStop(): Promise<{ ok: boolean }>
    dashboardReset(): Promise<{ ok: boolean }>
    onDashboardProgress(cb: (event: { stage: string; bytes?: number; total?: number; port?: number; message?: string }) => void): () => void
    deleteRun(owner: string, runId: number): Promise<void>
    rerunRun(owner: string, runId: number): Promise<void>
    listJobs(owner: string, runId: number): Promise<AeonJobSummary[]>
    jobLogs(owner: string, jobId: number): Promise<string>
    workflowInputs(owner: string, workflowPath: string): Promise<AeonWorkflowInputSpec[]>
    listSkillDirs(owner: string): Promise<string[]>
    getSkillAnalytics(owner: string): Promise<AeonSkillAnalyticsMap>
    // E2: fork-behind indicator
    getSyncStatus(): Promise<AeonSyncStatus>
    // E4: memory search
    searchMemory(query: string): Promise<AeonMemoryEntry[]>
  }
  whisper: {
    checkInstalled(): Promise<{ built: boolean; modelsReady: boolean; models: WhisperModelInfo[]; canInstall?: boolean; cliInstalled?: boolean }>
    listModels():     Promise<WhisperModelInfo[]>
    downloadModel(modelName?: WhisperModelName): Promise<{ ok: boolean; models: WhisperModelInfo[] }>
    /**
     * STOP an in-flight model download. PAUSE semantics — the `.part` bytes
     * stay on disk and a re-download (or the DOWNLOADS strip) resumes from that
     * offset. `cancelled:false` means nothing was pausable (not downloading, or
     * already verifying) — do NOT report that as a successful stop.
     */
    cancelDownload(modelName: WhisperModelName): Promise<{ ok: true; cancelled: boolean } | { ok: false; error: string }>
    /** Delete one downloaded ggml weight from disk. The CLI binary is untouched. */
    removeModel(modelName: WhisperModelName): Promise<{ ok: boolean; error?: string }>
    /** `lang` = i18n locale hint (`en`, `ru`, `zh-Hans`, …); omit for auto-detect. */
    transcribe(audioBase64: string, modelName?: WhisperModelName, lang?: string): Promise<WhisperTranscribeResult>
    onProgress(cb: (event: WhisperProgressEvent) => void): () => void
    /** Install the prebuilt whisper-cli engine (audit H3, Windows). */
    install(): Promise<{ ok: boolean; error?: string }>
    onInstallProgress(cb: (event: { stage: string; message: string; percent: number }) => void): () => void
  }
  hotkeys: {
    load(): Promise<Record<string, string>>
    save(hotkeys: Record<string, string>): Promise<void>
    /** Per-action global-shortcut binding results — ok:false = accelerator taken. */
    registrations(): Promise<Array<{ id: string; accel: string; ok: boolean }>>
    onFired(cb: (payload: { id: string }) => void): () => void
  }
  /** Skills — installed SKILL.md list, workspace suggestions, hash-pinned registry install. */
  skills: {
    list(): Promise<{
      workspaceRoot: string | null
      skills: Array<{ name: string; description: string; layer: 'bundled' | 'workspace' | 'project'; dir: string }>
    }>
    suggest(): Promise<{
      workspaceRoot: string | null
      suggestions: Array<{ skillId: string; title: string; reason: string; layer: 'suggested'; installed: boolean }>
    }>
    registry(): Promise<Array<{ id: string; title: string; description: string; url: string; sha256: string; installed: boolean }>>
    install(id: string): Promise<{ ok: boolean; skillId: string; path?: string; error?: string }>
  }
  // Sprint C1: playbook — renderer calls with plain string args; preload wraps into objects.
  // Sprint D3: loadEntries returns structured block-tree PlaybookEntry objects.
  playbook: {
    list(): Promise<PlaybookMeta[]>
    load(workspacePath: string): Promise<string | null>
    delete(workspacePath: string): Promise<{ deleted: boolean }>
    /** Sprint D3: load all structured PlaybookEntry objects for a workspace path. */
    loadEntries(workspacePath: string): Promise<unknown[]>
  }
  // Sprint C2: main-process agent-runtime store bridge.
  agentRuntime: AgentRuntimeAPI
  // Sprint C3: checkpoint read/list/delete bridge.
  checkpoints: CheckpointsAPI
  // agent-session-memory — session memory between agent runs (ECC pattern).
  // Keyed by workspace PATH. save() on agent stop; load()/buildContext() on
  // agent start to inject "HISTORICAL REFERENCE ONLY — NOT LIVE INSTRUCTIONS".
  sessionMemory: {
    save(input: { workspacePath: string; lastTask: string; keyDecisions?: string[]; filesChanged?: string[]; notes?: string }): Promise<SessionSummary>
    load(workspacePath: string): Promise<SessionSummary | null>
    buildContext(workspacePath: string): Promise<{ context: string }>
    list(): Promise<SessionSummaryMeta[]>
    delete(workspacePath: string): Promise<{ deleted: boolean }>
  }
  // Structured persistent-memory fact store (T16). Managed, per-item memory:
  // enabled facts are joined and injected into every chat (replacing the old
  // free-form userMemory blob, which is kept as a one-time migration backup).
  memoryFacts: {
    list(): Promise<MemoryFact[]>
    add(text: string, source?: 'user' | 'auto'): Promise<MemoryFact | null>
    edit(id: string, text: string): Promise<MemoryFact | null>
    delete(id: string): Promise<{ deleted: boolean }>
    toggle(id: string, enabled: boolean): Promise<MemoryFact | null>
    preview(): Promise<{ text: string; chars: number; overBudget: boolean; limit: number }>
  }
  // Sprint C4: workspace-panel — list recent tool-call changes for a session.
  workspacePanel: WorkspacePanelAPI
  // Nodes canvas — save/list/load flows, plus run (compile + execute) a graph.
  nodes: {
    /** Persist a Reference-Image node's picked image to disk (userData/media/refs).
     *  Returns the absolute path (fed to the run engine) and a tachi-media:// url
     *  (for the <img> preview). */
    saveRefImage(dataUrl: string, fileName?: string): Promise<{ ok: boolean; path?: string; url?: string; error?: string }>
    saveFlow(flowName: string, json: string): Promise<{ ok: boolean; path?: string; filename?: string; error?: string }>
    listFlows(): Promise<{ ok: boolean; flows: Array<{ filename: string; name: string; savedAt: string }>; error?: string }>
    loadFlow(filename: string): Promise<{ ok: boolean; json?: string; error?: string }>
    deleteFlow(filename: string): Promise<{ ok: boolean; error?: string }>
    renameFlow(filename: string, newName: string): Promise<{ ok: boolean; filename?: string; name?: string; error?: string }>
    /**
     * Flow revisions (A1, NODES-RESEARCH-2026-07-26): every save snapshots the
     * flow under `Flows/.history/<name>/<ts>.json` (20 files / 5 MB per flow).
     * `listRevisions` is newest-first; the change counts shown next to each
     * entry are computed in the renderer from `readRevision` + flowDiff.ts.
     * `restoreRevision` snapshots the state it replaces, so restore is undoable.
     */
    listRevisions(filename: string): Promise<{ ok: boolean; revisions: Array<{ ts: number; savedAt: string; size: number }>; error?: string }>
    readRevision(filename: string, ts: number): Promise<{ ok: boolean; json?: string; error?: string }>
    restoreRevision(filename: string, ts: number): Promise<{ ok: boolean; json?: string; error?: string }>
    /**
     * Read-only folder existence probe for the self-healing flow-doctor
     * (NODES-RESEARCH #4). Given the absolute folder paths a loaded flow
     * references, reports which are existing directories on this machine.
     */
    pathsExist(paths: string[]): Promise<{ existing: Record<string, boolean> }>
    /**
     * Compile the visual graph into an @inngest/agent-kit Network and run it.
     * `flow` is a TachiFlow (typed as unknown here to keep the renderer's flow
     * types out of the global API surface). `input` is the initial message.
     */
    runGraph(flow: unknown, input: string): Promise<
      | { ok: true; results: Array<{ agent: string; text: string }>; final: string; media?: MediaNodeRunResult[] }
      | { ok: false; error: string }
    >
    /**
     * Run JUST one node ("execute step"). `flow` is the full TachiFlow with
     * `lastOutput` stamped onto upstream nodes so this node's prompt/tokens
     * resolve against PINNED outputs without re-running upstream. Media → returns
     * artifacts (+ text for STT); agent → returns text.
     *
     * `runSeed` — the Run-all invocation's entropy. A seedless LOCAL media node
     * gets `deriveStageSeed(runSeed, nodeId)` instead of sd.cpp's fixed default
     * 42, so the stages of one sequential Run-all decorrelate exactly as the
     * one-network mode's do. Omit it for a single node's RUN button.
     */
    runNode(flow: unknown, nodeId: string, runSeed?: string): Promise<
      | { ok: true; text?: string; artifacts?: Artifact[] }
      | { ok: false; error: string }
    >
    /** Subscribe to live execution: fires {nodeId} as each node runs, {nodeId:null} at end. Returns an unsubscribe fn. */
    onNodeActive(cb: (p: { nodeId: string | null }) => void): () => void
    /**
     * BATCH35 lane B — inbound WEBHOOK TRIGGERS for the canvas (TradingView).
     * A trigger node arms a hook; while armed, the local API server answers
     * `POST /webhooks/<source>/<hookId>?token=<secret>` and the body arrives
     * here as that node's output. The route is default-closed, carries its own
     * per-hook 32-byte secret (never the /v1 bearer), and is size-capped +
     * rate-limited. INBOUND SIGNAL ONLY — an alert becomes text, never an order.
     */
    webhooks: {
      /** Is the local API server up, and what is armed right now? */
      status(): Promise<{
        serverRunning: boolean
        serverEnabled: boolean
        origin: string | null
        hooks: Array<{ hookId: string; source: string; armedAt: number; hits: number; lastAt: number | null }>
      }>
      /** Bring a hook on the air. Re-arming an id keeps its existing secret. */
      arm(hookId: string, source: string): Promise<
        | { ok: true; hookId: string; source: string; token: string | null; url: string | null; serverRunning: boolean; serverEnabled: boolean }
        | { ok: false; code?: string; error: string }
      >
      /** Take the route off the air; the secret is kept so a re-arm reuses the URL. */
      disarm(hookId: string): Promise<{ ok: boolean; wasArmed?: boolean; error?: string }>
      /** Disarm AND drop the stored secret — the next arm mints a fresh URL. */
      forget(hookId: string): Promise<{ ok: boolean; error?: string }>
      /** New secret for an armed hook. The previously copied URL stops working. */
      rotate(hookId: string, source: string): Promise<
        | { ok: true; hookId: string; source: string; token: string | null; url: string | null; serverRunning: boolean; serverEnabled: boolean }
        | { ok: false; error: string }
      >
      /** Alerts accepted since arming, newest first (ring-buffered). */
      recent(hookId: string): Promise<{ alerts: WebhookAlertPayload[] }>
      /** Subscribe to live alerts. Returns an unsubscribe fn. */
      onAlert(cb: (a: WebhookAlertPayload) => void): () => void
    }
  }
  // Resolve a dropped/picked File's absolute disk path (Electron 32+ removed
  // File.path; this is the webUtils.getPathForFile bridge). '' when synthetic.
  files: {
    pathFor(file: File): string
  }
  // Design tab — stream a self-contained HTML design from a prompt + brand preset.
  design: {
    /**
     * THE VIDEO ENCODER — Remotion's platform compositor (its Rust renderer plus
     * ffmpeg/ffprobe), fetched from the official npm package on an explicit
     * click and NEVER bundled.
     *
     * Why it is a download and not a dependency: that FFmpeg build reports
     * `libavcodec license: nonfree and unredistributable`, so putting it in the
     * installer would make this project the distributor of something that states
     * it may not be distributed. Fetching it changes who hands the bytes to the
     * user, which is the part that matters.
     *
     * `fromDevTree` is true when a contributor's node_modules already has it and
     * nothing was downloaded. `approxBytes` is what the UI quotes BEFORE asking.
     */
    encoderState(): Promise<{
      installed: boolean
      dir: string | null
      fromDevTree: boolean
      version: string
      packageName: string
      approxBytes: number | null
    }>
    /** Only ever called from a user action. Resolves { ok:false, error } — never rejects. */
    installEncoder(): Promise<{ ok: boolean; dir?: string; error?: string }>
    /** Drops the fetched copy. A contributor's node_modules is never touched. */
    removeEncoder(): Promise<{ ok: boolean; error?: string }>
    onEncoderProgress(cb: (p: { stage: string; message: string; percent: number; bytes?: number; totalBytes?: number }) => void): () => void
    generate(payload: {
      requestId?: string
      providerId: string
      model: string
      prompt: string
      presetId?: string
      designMd?: string
      currentHtml?: string
      refImage?: string
      context?: string
      mode?: 'page' | 'animate'
      engine?: 'remotion' | 'hyperframes'
      history?: Array<{ role: 'user' | 'assistant'; text: string }>
    }): Promise<
      | { ok: true; html: string; raw: string; code?: string }
      | { ok: false; error: string; aborted?: boolean }
    >
    /** Discovery pass — return a few clarifying questions to answer before the build. */
    clarify(payload: {
      providerId: string
      model: string
      prompt: string
      presetId?: string
      designMd?: string
      refImage?: string
      context?: string
      mode?: 'page' | 'animate'
    }): Promise<{
      ok: boolean
      questions?: string
      /** Structured interview questions (option chips) when the model honored the JSON contract. */
      structured?: Array<{ q: string; options: string[]; default?: string }> | null
      error?: string
    }>
    /** Brand-from-URL — harvest a site's real design tokens into a markdown direction. */
    extractBrand(url: string): Promise<{ ok: boolean; brand?: { url: string; siteName: string; colors: string[]; fonts: string[]; logo?: string; copy: string[] }; markdown?: string; error?: string }>
    abort(requestId: string): Promise<{ ok: boolean }>
    /** Pick a folder → budgeted text-file context describing what to design for. */
    pickFolder(): Promise<{ ok: boolean; folder?: string; context?: string; fileCount?: number; error?: string }>
    /** Read a folder by path (dropped onto the composer) → same budgeted context, no dialog. */
    readFolder(folder: string): Promise<{ ok: boolean; folder?: string; context?: string; fileCount?: number; error?: string }>
    /** Save a generated design to its project folder under <userData>/TACHI Design/. */
    saveFile(payload: { project?: string; name?: string; content: string }): Promise<{ ok: boolean; path?: string; error?: string }>
    /** Attach a media file (video/audio/gif) as a design asset (assets/<name>). */
    addAsset(payload: { path?: string; name?: string; bytes?: ArrayBuffer }): Promise<{ ok: true; name: string; relPath: string; bytes: number } | { ok: false; error: string }>
    /** Stash preview HTML for the tachi-preview:// scheme (own CSP → inline scripts run). */
    setPreview(id: string, html: string): Promise<{ ok: boolean }>
    /** Open a project's on-disk folder (or the base folder) in the OS file manager. */
    reveal(project?: string): Promise<{ ok: boolean; path?: string; error?: string }>
    /** Read the base folder where designs are saved. */
    getBase(): Promise<{ baseDir: string }>
    /** Pick a new base folder (persisted). */
    setBase(): Promise<{ ok: boolean; baseDir?: string; error?: string }>
    /** Export an animation composition to a real H.264 MP4 (managed Chromium + Remotion renderer). */
    renderMp4(payload: { code: string; name?: string; targetHeight?: number }): Promise<{ ok: boolean; path?: string; error?: string }>
    /** Synthesize a voiceover line (piper TTS) into the design-audio dir; reference the returned file via staticFile(file) in a composition. */
    synthesizeVo(payload: { voiceId: string; text: string; name?: string }): Promise<{ ok: boolean; file?: string; path?: string; error?: string }>
    /** Servable audio files currently in design-audio (newest first). */
    listAudio(): Promise<{ ok: boolean; files: Array<{ name: string; size: number; mtimeMs: number }> }>
    /** Copy an existing audio artifact into design-audio (Nodes/Media bridge). */
    importAudio(path: string): Promise<{ ok: boolean; file?: string; error?: string }>
    /** Export a page design to PNG or PDF via a hidden BrowserWindow capture (free, no Chromium). */
    exportImage(payload: { html: string; name?: string; format: 'png' | 'pdf' }): Promise<{ ok: boolean; path?: string; error?: string }>
    /** Subscribe to streamed text chunks: { requestId, chunk }. Returns an unsubscribe fn. */
    onDelta(cb: (p: { requestId: string; chunk: string }) => void): () => void
    /** Subscribe to MP4 export progress: { stage, percent, message } (incl. first-run Chromium download). Returns an unsubscribe fn. */
    onRenderProgress(cb: (p: { stage: string; percent: number; message: string }) => void): () => void
  }
  // freellmapi model list + fallback sort control.
  freellmapi: {
    listFallbackModels(): Promise<{
      ok: boolean
      models: Array<{ platform: string; modelId: string; name: string; keyCount: number; priority: number; enabled: boolean }>
      error?: string
    }>
    /**
     * The relay's OWN platform list — one row per platform it actually carries.
     * The Free Providers card renders from this instead of asserting a
     * hardcoded expectation (which is how it advertised a platform the shipped
     * relay had never heard of).
     */
    listPlatforms(): Promise<{
      ok: boolean
      platforms: Array<{
        platform: string
        modelCount: number
        keyCount: number
        healthyKeys: number
        invalidKeys: number
        hasProvider: boolean
      }>
      error?: string
    }>
    setSortMode(mode: 'intelligence' | 'speed' | 'budget'): Promise<{ ok: boolean; error?: string }>
  }
  // Smart-router telemetry (read-only): per-tier routed counts + top bandit arms.
  routerStats: {
    get(): Promise<{
      routes: { SIMPLE: number; MID: number; TOP: number }
      arms: Array<{ bucket: string; model: string; ok: number; err: number; mean: number }>
      // Compactor savings (headroom-inspired) — rides the same observability channel.
      compaction?: { charsSaved: number; tokensSaved: number; reductions: number }
      // Provider prompt-cache hits (CACHE-ALIGN 2026-07-21) — reported:false → UI "--".
      cache?: { cachedInputTokens: number; totalInputTokens: number; hitRatio: number | null; samples: number; reported: boolean }
    }>
  }
  // llama.cpp — truly-local LLM sidecar (Vitalik-aligned, SHA-verified).
  llamaCpp: LlamaCppAPI
  // Resumable download manager (UX #11) — pause/resume/cancel + live queue
  // for the persistent DownloadStrip in the bottom console dock.
  downloads: DownloadsAPI
  // stable-diffusion.cpp — LOCAL image gen sidecar (zero-terminal install).
  sdCpp: {
    /** `files[].sharedWith` = the OTHER curated/user rows declaring the exact
     *  same bytes (sha-identical). The download panel subtracts a file whose
     *  twin row is installed, so the button quotes what will really transfer
     *  instead of the full multi-GB total. Optional: an older main build sends
     *  none, and the renderer then falls back to the pessimistic number.
     *
     *  `files[].onDiskMb` = MiB of THAT component already here, whether it
     *  landed complete or is a resumable `.part`. It is what lets an
     *  interrupted download render as RESUME instead of as one that was never
     *  started — the only evidence of a failure that outlives the tab which
     *  was subscribed to the progress event. Optional for the same reason.
     *
     *  `licenseName` / `licenseUrl` = the licence the weights land under, as a
     *  NAME a person reads and a LINK to its text. The download panel prints
     *  them under the row, so a button that pulls 20.8 GB under a non-OSI
     *  licence with a revenue ceiling says so before it is pressed. Optional:
     *  undefined for a row whose source licence has not been read, and the
     *  panel then renders nothing rather than a guess.
     *
     *  `minVramGb` / `minRamGb` = what the row's OWN notes say the machine needs,
     *  as numbers a card can print ("needs ~12 GB VRAM"). Optional in the strong
     *  sense: a row whose notes state no figure sends none, and a surface must
     *  render its prose rather than compute a substitute — the size-times-1.2
     *  estimate this replaces called Flux too big for the 12 GB card that runs it.
     *  `minRamGb` appears where SYSTEM memory is the binding constraint (weights
     *  held in RAM), which no VRAM number can express. */
    catalog(): Promise<{ ok: boolean; models: Array<{ id: string; name: string; kind: 'image' | 'video'; family: string; sizeMbTotal: number; notes: string; licenseName?: string; licenseUrl?: string; minVramGb?: number; minRamGb?: number; files: { role: string; sizeMb: number; sharedWith?: string[]; onDiskMb?: number }[] }>;
      /** CURATED SPEED PACKS: one row's 4-step distill LoRAs. `installed`
       *  rides along because a pack appears in NEITHER status() list — it is
       *  not a checkpoint and not a user adapter. Optional: an older main
       *  build sends none and the panel simply shows no speed row. */
      speedAdapters?: Array<{ id: string; modelId: string; name: string; license: string; source: string; sizeMbTotal: number; installed: boolean; notes: string; files: { slug: string; sizeMb: number; sharedWith: string[] }[] }>
      /** Rows we LOOKED FOR a speed pack for and will not ship one for, with
       *  the licence reason — so an absent toggle reads as a verdict, not a bug. */
      blockedSpeedAdapters?: Array<{ modelId: string; blocked: string }>
      /** CURATED UPSCALERS (ESRGAN weights for `-M upscale`). `installed` rides
       *  along for the same reason a speed pack's does — an upscaler is in
       *  NEITHER status() list — and it is what lets a gallery tile decide
       *  between the verb and the install affordance without one IPC per tile.
       *  `scale` is the factor the weights were trained at and the only one they
       *  produce; the output file name and the provenance line both quote it.
       *  Optional: an older main build sends none and no UPSCALE button renders. */
      upscalers?: Array<{ id: string; name: string; scale: number; license: string; source: string; licenseName?: string; licenseUrl?: string; sizeMbTotal: number; installed: boolean; notes: string; files: { slug: string; sizeMb: number; sharedWith: string[] }[] }>
      /** THE REFERENCE-IMAGE WEIGHTS (IP-Adapter), one row per checkpoint family.
       *  `installed` rides along for the same reason a speed pack's does — these
       *  are in NEITHER status() list. `files[].sharedWith` spans the MODEL rows
       *  as well as the sibling row, because the 1.2 GB CLIP-Vision encoder IS the
       *  Wan 2.1 i2v component: quoting the full total to someone who already has
       *  those bytes is the over-count that field prevents. Optional: an older
       *  main build sends none and no reference-image affordance renders. */
      ipAdapters?: Array<{ id: string; name: string; family: string; license: string; source: string; licenseName?: string; licenseUrl?: string; sizeMbTotal: number; installed: boolean; notes: string; files: { slug: string; sizeMb: number; sharedWith: string[] }[] }>
      /** modelId → why that checkpoint has no reference-image option even though
       *  its DECLARED family has a row. SD-Turbo is declared sd15 and the engine
       *  reports SD 2.x on every load; the 1.5 weights fail against it (measured).
       *  Absent on an older main build ⇒ no verdict is shown, only the absence. */
      blockedIpAdapters?: Record<string, string>
      releases: unknown[] }>
    /** `name` = the row's display name (the dropdown used to render raw ids);
     *  `family` = the row's DECLARED family ('sd15'|'sdxl'|'flux'|'wan'), which
     *  the composer's preset/grid logic reads instead of guessing from the id. */
    status(): Promise<{
      installed: boolean
      /** `steps` / `cfgScale` / `samplingMethod` are the ROW's own recipe: the
       *  preset picker needs them to decide which tiers are honest for it
       *  (a 1-step distilled checkpoint can offer none), and the schema's
       *  narrowed sliders default to them. */
      models: { id: string; name: string; kind: 'image' | 'video'; family: string; steps: number; cfgScale: number; samplingMethod: string }[]
      /** INSTALLED adapters. `family` is the compat gate (an SD 1.5 LoRA on an
       *  SDXL checkpoint is a shape mismatch the engine silently no-ops);
       *  `slug` is the token inside `<lora:slug:weight>`. */
      adapters: { id: string; kind: 'lora' | 'embedding' | 'vae'; name: string; slug: string; family: string; triggerWords: string[]; defaultWeight?: number; notes?: string }[]
      /** Which engine BUILD is on disk versus the one the app pins. `installed`
       *  alone could not tell them apart, which is why a bumped
       *  SD_CPP_VERSION used to reach new users only. `updateAvailable` is true
       *  only when both commits are known and differ. */
      engine: { installed: string | null; pinned: string; updateAvailable: boolean }
      /** Every name a `<lora:…>` tag in the prompt can resolve to — the SAME list
       *  the arg builder resolves against, which is why it is sent instead of
       *  being derived from `adapters` here. It also holds files the user placed
       *  in the folder by hand, which have no registry row but which the engine
       *  finds anyway. Optional: an older main build sends none, and the composer
       *  then says nothing about a typed tag rather than guessing wrong. */
      loraNames?: { name: string; slug: string }[]
    }>
    install(): Promise<{ ok: boolean; error?: string }>
    /** Swap an EXISTING sd-cli onto the pinned release — `install` short-circuits
     *  when a binary exists. Offer it on `status().engine.updateAvailable`. */
    updateEngine(): Promise<{ ok: true; from: string | null; to: string } | { ok: false; error: string }>
    downloadModel(id: string): Promise<{ ok: boolean; error?: string }>
    /** Download one adapter's weights (managed path: resume, SHA, strip row). */
    downloadAdapter(id: string): Promise<{ ok: boolean; error?: string }>
    /** Remove an adapter's weights AND its registry row (both, or the picker
     *  keeps offering a tag that names a file which is gone). */
    removeAdapter(id: string): Promise<{ ok: boolean; error?: string }>
    /** Download one curated SPEED PACK — every distill LoRA of a video row, in
     *  one call. Partial is not a state the engine can use: a two-expert row
     *  with one LoRA applied renders at 4 steps with half the model
     *  un-adapted, which is the "the distill looks broken" misdiagnosis. */
    downloadSpeedAdapter(id: string): Promise<{ ok: boolean; error?: string }>
    /** Download one curated UPSCALER (a single ~64 MB ESRGAN file). */
    downloadUpscaler(id: string): Promise<{ ok: boolean; error?: string }>
    /** Download one REFERENCE-IMAGE row: the IP-Adapter weights plus the
     *  CLIP-Vision encoder the engine requires beside them. The encoder is
     *  hard-linked rather than fetched when a Wan 2.1 i2v install already holds
     *  those exact bytes. */
    downloadIpAdapter(id: string): Promise<{ ok: boolean; error?: string }>
    /**
     * Make an image on disk bigger — `sd-cli -M upscale`, which loads NO
     * diffusion model and takes no prompt. `path` must be a LOCAL file (a cloud
     * artifact has no bytes here); the run writes `<stem>-upscaled-x<N>.png`
     * beside it and resolves with that path.
     *
     * NO `b64` and NO `seed`, both deliberately: a 4096x4096 PNG is ~26 MB and
     * the gallery serves it from its path, and there IS no seed — the engine
     * stamps its own `parameters` chunk on the output with sd-cli's DEFAULTS
     * ("Steps: 20, Seed: 42, mode: img_gen") describing a run that never
     * happened, so nothing here reads that chunk back as truth.
     *
     * Progress rides the shared `onGenProgress` channel; `cancelGeneration()`
     * stops it like any other run.
     */
    upscale(input: { path: string; upscalerId?: string; repeats?: number; tileSize?: number }): Promise<{
      ok: boolean; error?: string
      path?: string; mime?: 'image/png'; scale?: number; upscalerId?: string; elapsedMs?: number
    }>
    /** STOP an in-flight model download. PAUSE semantics: every component .part
     *  is KEPT, so a re-click resumes from the bytes already on disk.
     *  `cancelled:false` = nothing was pausable for that id. */
    cancelDownload(id: string): Promise<{ ok: boolean; cancelled?: boolean; error?: string }>
    removeModel(id: string): Promise<{ ok: boolean; error?: string }>
    /** `initImage` = the composer's INIT FRAME as the renderer holds it (a `data:`
     *  URL from the file picker, or an on-disk path). MAIN writes it out and
     *  passes sd-cli the `-i <path>` it needs; the renderer has no path to give. */
    /** `loras` are emitted as `<lora:slug:weight>` IN THE PROMPT (sd.cpp has no
     *  `--lora` flag) alongside `--lora-model-dir`; `vaeAdapterId` is the
     *  single-file `--vae` swap. */
    /** `batchCount` = the composer's `n`, emitted as sd-cli `-b`: N images from
     *  ONE model load, each at its own seed (the engine counts up from the
     *  first). The run then returns `images` — read THAT, not just the flat
     *  `path`/`b64`/`seed`, which are `images[0]` and exist only so callers
     *  written before batching kept working. `hires`/`hiresScale` are the
     *  single-invocation latent two-pass (`--hires` / `--hires-scale`).
     *
     *  `strength` is the img2img distance from the init frame, and it is only read
     *  when a frame is attached. It has ONE default now (the composer's spec
     *  supplies it, `0.6`): the arg builder used to carry a private `?? 0.6` while
     *  the default-less slider showed `0`, so two runs went out at 0.6 with "0 =
     *  keep init" on screen. `effective.strength` is what really ran.
     *
     *  `clipSkip` = `--clip-skip` (0/absent leaves it to the engine); the five
     *  memory fields are the low-VRAM ladder — `vaeTiling`, `vaeConvDirect`,
     *  `maxVramGb` (a GiB budget, or -1 for "the free VRAM the driver reports,
     *  sparing 1 GiB"), `streamLayers` and `autoFit` (the engine places the
     *  modules itself, overriding the app's own placement). All absent ⇒ the
     *  command line is byte-identical to every run before they existed.
     *
     *  `streamLayers` NEEDS TWO THINGS, and the app supplies the second: a VRAM
     *  budget (no budget ⇒ the graph-cut segmenter it rides on is never
     *  attempted) AND the diffusion params backend on CPU, which `--offload-to-cpu`
     *  supplies and which the arg builder now emits alongside it. `autoFit`
     *  overwrites that placement, so the two are mutually exclusive: with
     *  `autoFit` on, `streamLayers` is neither emitted nor recorded. The engine
     *  logs "--stream-layers has no effect unless diffusion params backend is
     *  cpu; ignoring" for exactly the command line we used to send. */
    generate(input: { modelId: string; prompt: string; negative?: string; width?: number; height?: number; steps?: number; cfgScale?: number; seed?: number; samplingMethod?: string; initImage?: string; initImagePath?: string; strength?: number; scheduler?: string; flowShift?: number; loras?: Array<{ slug: string; weight?: number }>; vaeAdapterId?: string; batchCount?: number; hires?: boolean; hiresScale?: number; clipSkip?: number; /** A REFERENCE IMAGE (IP-Adapter): its subject and style are carried into the render alongside the words. NOT an init image — the picture is never redrawn. `ipAdapterImage` is a `data:` URL or a path and main materialises it, exactly as `initImage` becomes `initImagePath`. The flags only go out when compatible weights are installed; without them the run is unchanged. */ ipAdapterImage?: string; ipAdapterImagePath?: string; ipAdapterStrength?: number; vaeTiling?: boolean; vaeConvDirect?: boolean; maxVramGb?: number; streamLayers?: boolean; autoFit?: boolean }): Promise<{ ok: boolean; path?: string; b64?: string; mime?: string; /** The seed the ENGINE used (read back from sd.cpp's own `parameters` chunk / run log), never the -1 request. */ seed?: number; /** EVERY image the run produced (length >= 1), each with the seed read back from ITS OWN file. A batch of 4 is 4 entries here and one flat `path` above. */ images?: Array<{ path: string; b64: string; mime: string; seed: number }>; /** The recipe the engine was actually given — the speed pack out-votes the composer, so this is what a Remix must restore. */ effective?: { steps: number; cfgScale: number; samplingMethod: string; scheduler?: string; flowShift?: number; /** `--hires` ran, at this `--hires-scale` — the reason the file is bigger than the size that was requested. */ hires?: boolean; hiresScale?: number; /** `-i` was on the command line (this was img2img), at this `--strength`. The gallery entry has to record BOTH: the reference frame is a `data:` URL that never survives localStorage, so an img2img entry was indistinguishable from a text→image one. */ initImage?: boolean; strength?: number; clipSkip?: number; /** A reference image steered this render, at this strength. A BOOLEAN, like `initImage` and for the same reason: the path is a temp this process deletes when the run ends, so an entry holding it would name a file that is gone. */ ipAdapterImage?: boolean; ipAdapterStrength?: number; /** The memory flags that were REALLY in play (an ignored `--stream-layers` is not one; `offloadToCpu` is the precondition it brings with it). */ memory?: { vaeTiling?: boolean; vaeConvDirect?: boolean; autoFit?: boolean; streamLayers?: boolean; offloadToCpu?: boolean; maxVramGb?: number } }; error?: string }>
    generateVideo(input: { modelId: string; prompt: string; negative?: string; width?: number; height?: number; frames?: number; steps?: number; cfgScale?: number; seed?: number; samplingMethod?: string; initImage?: string; initImagePath?: string; scheduler?: string; flowShift?: number; loras?: Array<{ slug: string; weight?: number; highNoise?: boolean }>; vaeAdapterId?: string; /** Use this row's curated speed pack (4-step distill). Absent = use it when installed; `false` = explicit opt-out. */ speed?: boolean; /** The same low-VRAM ladder as `generate` — this is the path whose VAE decode actually gets reaped. No `strength` (`-M vid_gen` has none) and no `clipSkip` (Wan/LTX condition on umt5/Gemma, not CLIP). */ vaeTiling?: boolean; vaeConvDirect?: boolean; maxVramGb?: number; streamLayers?: boolean; autoFit?: boolean }): Promise<{ ok: boolean; path?: string; b64?: string; mime?: string; /** The seed the ENGINE used, from the run log — a .webm has no chunk to carry it. */ seed?: number; /** The recipe the engine was actually given — the speed pack out-votes the composer, so this is what a Remix must restore. */ effective?: { steps: number; cfgScale: number; samplingMethod: string; scheduler?: string; flowShift?: number; memory?: { vaeTiling?: boolean; vaeConvDirect?: boolean; autoFit?: boolean; streamLayers?: boolean; offloadToCpu?: boolean; maxVramGb?: number } }; error?: string }>
    /** STOP the running render (image or video). Kills the sd-cli process tree;
     *  the run then reports itself as stopped through the normal failure path.
     *  `cancelled:false` = nothing was running (it just finished). */
    cancelGeneration(): Promise<{ ok: boolean; cancelled: boolean; pid?: number }>
    onInstallProgress(cb: (p: { stage: string; message: string; percent: number; bytes?: number; totalBytes?: number; speedBytesPerSec?: number; etaSec?: number }) => void): () => void
    /** Live render ticks. `phase` says what the numbers are ABOUT (a loading
     *  fraction is not render progress); `stage` is the run's LAST WORD — main
     *  sends exactly one `done`/`error` per run on this channel, on both the
     *  success and the failure path, so a listener that is not the awaiting
     *  caller still learns the render ended. `kind`/`elapsedMs` ride the
     *  terminal event only. */
    onGenProgress(cb: (p: { step: number | null; total: number | null; percent: number; message: string; heartbeat: boolean; phase?: 'starting' | 'loading' | 'sampling' | 'decoding'; stage?: 'done' | 'error'; kind?: 'image' | 'video'; elapsedMs?: number; preview?: string }) => void): () => void
  }
  // Bulk export / backup — file IO only; the renderer shapes the data.
  backup: {
    /** Write the backup JSON. Omit `path` to show a save dialog. */
    save(json: string, path?: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
    /** Read a backup JSON. Omit `path` to show an open dialog. */
    load(path?: string): Promise<{ ok: boolean; json?: string; path?: string; canceled?: boolean; error?: string }>
    /** Write per-chat Markdown files into a folder. Omit `dir` for a picker. */
    exportMd(files: Array<{ name: string; content: string }>, dir?: string): Promise<{ ok: boolean; dir?: string; written?: number; canceled?: boolean; error?: string }>
  }
  // Local folder RAG — MiniLM embeddings fully in-process; index in userData.
  rag: {
    /** Build (or reuse) the semantic index for a folder. First ever call downloads the ~25MB model (blocked in PRIVATE MODE until cached). */
    index(root: string, force?: boolean): Promise<{ ok: boolean; files?: number; chunks?: number; ms?: number; reused?: boolean; error?: string }>
    /** Top-k chunks by meaning. Ensures the index first (builds when stale). */
    search(root: string, query: string, k?: number): Promise<{ ok: boolean; hits?: Array<{ path: string; startLine: number; endLine: number; score: number; text: string }>; indexed?: { files: number; chunks: number; reused: boolean }; error?: string }>
    status(root: string): Promise<{ ok: boolean; indexed?: boolean; modelCached?: boolean; error?: string }>
  }
  // App-wide sidecar health check: executes every external binary (piper,
  // sd.cpp, yt-dlp, whisper, llama.cpp, managed Chromium) + the FreeLLM router
  // with a probe arg and classifies the result.
  doctor: {
    run(): Promise<{ ok: boolean; entries?: Array<{ id: string; label: string; status: 'ok' | 'missing' | 'broken' | 'timeout' | 'error'; path?: string; detail: string; ms: number }>; error?: string }>
  }
  // Full-text chat search — SQLite FTS5 (wasm) index derived from the JSON
  // conversation archive; CJK queries transparently use a LIKE fallback.
  chatArchive: {
    search(query: string, limit?: number): Promise<{ ok: boolean; hits?: Array<{ convId: string; title: string; turnIndex: number; role: string; snippet: string; updatedAt: string }>; mode?: 'fts' | 'like'; error?: string }>
    status(): Promise<{ ok: boolean; conversations?: number; messages?: number; indexed?: number; removed?: number; total?: number; ms?: number; error?: string }>
  }
  // Global quick-ask launcher window (summoned by the quick-ask hotkey).
  quickask: {
    /** Ask the next turn — STREAMS through onChunk; resolves with the final text. */
    ask(prompt: string): Promise<{ ok: boolean; text?: string; error?: string }>
    hide(): Promise<{ ok: boolean }>
    toggle(): Promise<{ ok: boolean }>
    /** Hide the launcher and focus the main app window. */
    openApp(): Promise<{ ok: boolean }>
    /** Cancel the in-flight run (Esc) without closing the bar. */
    abort(): Promise<{ ok: boolean }>
    /** Explicit New (Ctrl+N): clears the thread and the replayed exchange. */
    newSession(): Promise<{ ok: boolean; turns?: QuickAskTurn[]; lastExchange?: QuickAskExchange | null; pinned?: boolean; history?: string[] }>
    /** Pinned = losing focus no longer hides the window. */
    setPinned(pinned: boolean): Promise<{ ok: boolean; pinned: boolean }>
    /** Ctrl+J: hand the whole thread to the main window and hide the bar. */
    handoff(): Promise<{ ok: boolean; turns?: number; error?: string }>
    /** Pull the shown-payload on mount (the first summon fires before we subscribe). */
    sync(): Promise<{
      ok: boolean
      turns: QuickAskTurn[]
      lastExchange: QuickAskExchange | null
      pinned: boolean
      history: string[]
      busy: boolean
      context: QuickAskContext | null
      autoCapture: boolean
    }>
    /** Selection auto-capture (quickAskAutoCapture) — the bar's footer toggle. */
    setAutoCapture(enabled: boolean): Promise<{ ok: boolean; autoCapture: boolean }>
    /** Fires when the launcher is (re)shown — carries the thread to replay. */
    onShown(cb: (payload: {
      turns: QuickAskTurn[]
      lastExchange: QuickAskExchange | null
      pinned: boolean
      history: string[]
      /** True when an answer is still streaming — do not wipe it. */
      busy: boolean
      /** Clipboard/selection chip for this summon (null = nothing offered). */
      context: QuickAskContext | null
      autoCapture: boolean
    }) => void): () => void
    /** Streamed answer deltas (mirrors chat:chunk), batched ~150ms in main. */
    onChunk(cb: (chunk:
      | { type: 'delta'; text: string }
      | { type: 'done'; text: string }
      | { type: 'error'; error: string }
    ) => void): () => void
    /** Main-window side: the thread handed over from the bar (Ctrl+J). */
    onHandoff(cb: (payload: { turns: QuickAskTurn[] }) => void): () => void
  }
  // piper — LOCAL text-to-speech sidecar (light, CPU-fast).
  piper: {
    catalog(): Promise<{ ok: boolean; voices: Array<{ id: string; name: string; lang: string; quality: string; sizeMb: number }>; releases: unknown[] }>
    status(): Promise<{ installed: boolean; voices: { id: string }[] }>
    install(): Promise<{ ok: boolean; error?: string }>
    downloadVoice(id: string): Promise<{ ok: boolean; error?: string }>
    /**
     * STOP an in-flight voice download. PAUSE semantics on the `.onnx` weight
     * (97% of the bytes) — the `.part` stays and a re-download resumes.
     * `cancelled:false` = nothing pausable, including the sub-second
     * `.onnx.json` sidecar step which is not routed through the manager.
     */
    cancelDownload(id: string): Promise<{ ok: true; cancelled: boolean } | { ok: false; error: string }>
    removeVoice(id: string): Promise<{ ok: boolean; error?: string }>
    synthesize(input: { voiceId: string; text: string }): Promise<{ ok: boolean; path?: string; b64?: string; mime?: string; error?: string }>
    onInstallProgress(cb: (p: { stage: string; message: string; percent: number; bytes?: number; totalBytes?: number; speedBytesPerSec?: number; etaSec?: number }) => void): () => void
  }
  // kokoro — STUDIO-quality local TTS (kokoro-js, Kokoro-82M ONNX in-process on
  // CPU; ~92MB one-time download, then fully offline). Heavier but far better
  // voices than piper. See electron/services/kokoro-tts.ts.
  kokoro: {
    /** Offline-honest snapshot: `installed` = model files actually on disk. Never downloads. */
    status(): Promise<{
      installed: boolean
      downloading: boolean
      /** 0..1 while a download is in flight. */
      progress?: number
      voices: Array<{ id: string; label: string; gender: 'f' | 'm'; accent: 'us' | 'gb'; grade: string }>
      modelDir: string
    }>
    /** One-time model download when missing (the ONLY call that egresses; blocked in PRIVATE MODE). Resolves when ready. */
    ensure(): Promise<{ ok: boolean; error?: string }>
    /** Text (≤4000 chars) + voice id → WAV bytes as base64. Local-only; errors if the model isn't installed. */
    synthesize(input: { text: string; voice: string }): Promise<{ ok: boolean; b64?: string; error?: string }>
    /** Save base64 WAV bytes under <userData>/media/kokoro (served by tachi-media://). Register the returned path in media.store to surface it in Artifacts. */
    saveWav(input: { b64: string; name: string }): Promise<{ ok: boolean; path?: string; error?: string }>
    /** Download progress while ensure() runs: { progress: 0..1, file? }. Returns an unsubscribe fn. */
    onProgress(cb: (p: { progress: number; file?: string }) => void): () => void
  }
  // Media-scoped file helpers — the renderer-facing home of media:save-wav.
  media: {
    /** Save base64 WAV bytes under <userData>/media/kokoro (served by tachi-media://). */
    saveWav(input: { b64: string; name: string }): Promise<{ ok: boolean; path?: string; error?: string }>
  }
  // PRIVATE MODE (Tier 1) — renderer mirrors mode changes to main so Tier 2
  // can gate cloud providers at the IPC boundary without a renderer round-trip.
  privacy: {
    setMode(mode: 'open' | 'private'): Promise<{ ok: boolean; mode: 'open' | 'private' }>
    getMode(): Promise<{ mode: 'open' | 'private' }>
    /** Subscribe to mode changes broadcast from main to all windows. */
    onModeChange(cb: (mode: 'open' | 'private') => void): () => void
  }
  // PRIVATE MODE (Tier 4) — capability inbox. Mirrors mode + exposes per-request
  // approve/deny against the main-process CapabilityService. Push events arrive
  // via onPush; the renderer's useCapabilityStore enqueues them.
  inbox: {
    setMode(mode: 'immediate' | 'inbox'): Promise<{ ok: true; mode: 'immediate' | 'inbox' }>
    getMode(): Promise<{ mode: 'immediate' | 'inbox' }>
    /** Snapshot of currently-pending requests on the main side. Used on mount. */
    list(): Promise<{ requests: CapabilityRequestPayload[] }>
    approve(id: string): Promise<{ ok: true }>
    deny(id: string): Promise<{ ok: true }>
    cancel(id: string): Promise<{ ok: true }>
    /** New request pushed from main. Returns an unsubscribe fn. */
    onPush(cb: (req: CapabilityRequestPayload) => void): () => void
    /** Decision broadcast from main (after deliverDecision or cancelPending). */
    onResolve(cb: (payload: { id: string; decision: 'allow' | 'deny' }) => void): () => void
  }
  // gnap — multi-agent coordination via git.
  gnap: GnapAPI
  // parallel — multi-task coding agent registry (worktree-per-task).
  parallel: ParallelAgentsAPI
  // Unified model catalog — hardware detection, curated list, installed models, HF search.
  catalog: {
    hardware(): Promise<HardwareProfile>
    curated(): Promise<{ ok: boolean; entries: CatalogEntry[] }>
    installed(): Promise<{ ok: boolean; models: InstalledModel[] }>
    searchHf(query: string): Promise<{ ok: boolean; error?: string; entries: CatalogEntry[] }>
  }
  // Civitai weights source — browse (SFW-gated in main) + install.
  civitai: CivitaiAPI
  /**
   * HuggingFace weights host. The token is stored / removed through the generic
   * `settings.saveKey('huggingface', …)` channels — the same plumbing every
   * other credential uses — so the only HF-specific call is the validation
   * ping. It answers with the ACCOUNT NAME and never echoes the token back.
   */
  hf: {
    validateToken(token: string): Promise<{ ok: true; name: string } | KeyProbeFailure>
  }
}

// ── Civitai (weights source) ─────────────────────────────────────────────────
//
// MIRRORS electron/services/civitai-search.ts. This is THE shared row contract;
// the catalog tab, the install path and the user-model registry all build
// against it.

export interface CivitaiSearchRow {
  /** `civitai-<versionId>` — [a-z0-9-] only (a `:` breaks the Stop sweep). */
  id: string
  modelId: number
  versionId: number
  /** `<model.name> - <version.name>` */
  name: string
  /** raw Civitai type */
  type: string
  /** null = unmapped / not runnable by our engine. `zimage` is mapped so its
   *  ADAPTERS can be judged — a Z-Image checkpoint is still refused, since
   *  Civitai ships one file and the row needs three. */
  family: 'sd15' | 'sdxl' | 'flux' | 'zimage' | null
  baseModel: string
  /** ceil(sizeKB/1024) — never under-declared */
  sizeMb: number
  /** lowercased */
  sha256: string | null
  downloadUrl: string
  fileName: string
  format: string
  fp: string | null
  nsfwLevelModel: number
  /** the CHOSEN VERSION's level — the artifact the card installs */
  nsfwLevelVersion: number
  downloads: number
  likes: number
  /** data: URI, or null. MEMORY-ONLY in main — never written to disk. */
  thumbnail: string | null
  /**
   * nsfwLevel of the image the thumbnail came from; 0 when there is none.
   * THE BLUR CONTRACT: blur when `(thumbnailNsfwLevel & ~3) !== 0`. In SFW mode
   * it is always 0 or 1, so a locked catalog never blurs.
   */
  thumbnailNsfwLevel: number
  /**
   * This VERSION's page on the host the row was served from, built in MAIN from
   * the resolved 18+ mode. The renderer never picks between `.com` and `.red`;
   * it only opens what main handed it — which is what lets the detail panel show
   * "Open on Civitai" on its first frame instead of waiting for the by-id fetch.
   */
  pageUrl: string | null
  trainedWords: string[]
  license: { commercial: string[]; noCredit: boolean; derivatives: boolean }
  /** run-truth verdict */
  installable: boolean
  /** honest why-not, present iff !installable */
  reason?: string
  /** stable machine key for the same refusal (i18n / tests), iff !installable */
  reasonCode?: string
}

/**
 * THE FILTER VOCABULARY, for the renderer.
 *
 * These mirror CIVITAI_MODEL_TYPES / CIVITAI_SORTS / CIVITAI_PERIODS in
 * electron/services/civitai-search.ts, which is the source of truth (fetched
 * live from GET /api/v1/enums on 2026-07-28). They are declared here as TYPES
 * rather than shipped as a second runtime array because a duplicated 22-item
 * list is a list that drifts; a filter chip built from a string outside these
 * unions is a compile error, and the runtime list stays in one place.
 *
 * `LyCORIS` is deliberately absent: `types=LyCORIS` returns 400 (it was folded
 * into LoCon upstream). It survives only as a legacy `row.type` string.
 */
export type CivitaiModelType =
  | 'Checkpoint' | 'TextualInversion' | 'Hypernetwork' | 'AestheticGradient'
  | 'LORA' | 'LoCon' | 'DoRA' | 'Controlnet' | 'Upscaler' | 'MotionModule'
  | 'VAE' | 'TextEncoder' | 'UNet' | 'CLIPVision' | 'Poses' | 'Wildcards'
  | 'Workflows' | 'Detection' | 'VisionLanguage' | 'CLIP' | 'LLM' | 'Other'

export type CivitaiSort = 'Most Downloaded' | 'Newest' | 'Highest Rated'
export type CivitaiPeriod = 'AllTime' | 'Year' | 'Month' | 'Week' | 'Day'

export interface CivitaiSearchQuery {
  query?: string
  /** opaque `metadata.nextCursor`; pass back verbatim. Cursor ONLY — never page. */
  cursor?: string | null
  /** any of the 22 live ModelType values; unknown values are dropped in main
   *  rather than forwarded, because ONE bad value 400s the whole request */
  types?: string[]
  /** repeatable server-side filter (matches a model if ANY version matches) */
  baseModels?: string[]
  /** 'Most Downloaded' | 'Newest' | 'Highest Rated'; ignored on a cursor page */
  sort?: string
  /** 'AllTime' | 'Year' | 'Month' | 'Week' | 'Day'; ignored on a cursor page */
  period?: string
  limit?: number
  // NOTE there is deliberately NO adult flag here. The 18+ mode is resolved in
  // main from the settings store AND a live keychain read; a renderer cannot
  // ask for it, and the zod schema strips the key if one is sent.
}

/** What main reports about the 18+ unlock. `unlocked` is the only field that
 *  decides anything; the other three exist so the UI can explain it. */
export interface CivitaiAdultState {
  /** adultMode AND acceptedAt > 0 AND hasKey. Main's own predicate. */
  unlocked: boolean
  adultMode: boolean
  /** epoch ms of the affirmation; 0 = never affirmed */
  acceptedAt: number
  /** a Civitai credential is in the keychain right now */
  hasKey: boolean
}

// ── the detail view ──────────────────────────────────────────────────────────
//
// MIRRORS the same names in electron/services/civitai-search.ts. What the grid
// row cannot carry: the uploader's prose, who they are, and the sibling versions.
//
// MEASURED 2026-07-31 (six top models, list vs by-id): `description` is
// byte-IDENTICAL between the two endpoints, so this fetch buys no field the list
// already had — it exists so a 24-row search does not carry ~190 KB of prose
// nobody opened. What the by-id endpoint DOES change is images: it ignores
// `nsfw` and serves the unclamped set, which is why the gallery below is gated
// in main by the same bitmask predicates the grid uses.

export interface CivitaiDetailPreview {
  /** data: URI. Never a remote url — the prod CSP has no https: in img-src. */
  dataUri: string
  /** the source image's own nsfwLevel, so the panel blurs without guessing */
  level: number
}

export interface CivitaiDetailVersion {
  /** `civitai-<versionId>` — THE SAME id a grid row carries, so an
   *  already-installed version can be recognised and offered RUN. */
  id: string
  versionId: number
  name: string
  baseModel: string
  family: 'sd15' | 'sdxl' | 'flux' | 'zimage' | null
  /** RAW HTML from the API. Parse it with civitaiDescriptionBlocks() — never
   *  dangerouslySetInnerHTML, and never trust it. */
  description: string | null
  /** the API's own ISO string; formatting is the UI's job */
  publishedAt: string | null
  trainedWords: string[]
  sizeMb: number
  format: string
  fileName: string
  nsfwLevel: number
  pageUrl: string | null
  /** gated previews — populated for the LEAD version only */
  previews: CivitaiDetailPreview[]
  /** main's verdict. Render it; never recompute it. */
  installable: boolean
  reason?: string
  reasonCode?: string
}

export interface CivitaiModelDetail {
  modelId: number
  /** the MODEL name alone, not the row's `<model> - <version>` join */
  name: string
  type: string
  /** RAW HTML, or null. See CivitaiDetailVersion.description. */
  description: string | null
  /** USERNAME ONLY — the avatar is deliberately not shipped */
  creator: { username: string } | null
  downloads: number
  likes: number
  license: { commercial: string[]; noCredit: boolean; derivatives: boolean }
  /** the model page on the host this detail was served from (built in main) */
  pageUrl: string | null
  versions: CivitaiDetailVersion[]
  /** versions the GATE refused — said out loud, like the grid's filteredCount */
  filteredVersionCount: number
  /** how many versions the model really has, so a capped list can say so */
  versionsTotal: number
  /** the mode this detail was ACTUALLY served in */
  adult: boolean
}

export interface CivitaiAPI {
  /** Resolves even on failure: `rows`/`nextCursor`/`filteredCount` always
   *  present, `error` added. */
  search(opts?: CivitaiSearchQuery): Promise<{
    rows: CivitaiSearchRow[]
    nextCursor: string | null
    /** Models the server sent that the content gate removed entirely. The tab
     *  says this out loud so a 24-row page rendering 2 cards reads as a filter
     *  doing its job rather than as a broken search. */
    filteredCount: number
    /** the mode the page was ACTUALLY served in (resolved in main), or absent
     *  on an error result — nothing was served, so no mode was */
    adult?: boolean
    error?: string
  }>
  /**
   * ONE model, read to be read. Resolves even on failure (`detail: null` +
   * `error`) so the panel can show the failure next to the row facts it already
   * has rather than blanking.
   *
   * `versionId` decides which version leads and whose images the gallery shows.
   * It grants nothing — every version is re-gated and re-verdicted in main.
   */
  detail(opts: { modelId: number; versionId?: number }): Promise<{
    detail: CivitaiModelDetail | null
    error?: string
  }>
  /** Only `row.modelId` / `row.versionId` are used; main re-fetches and re-gates. */
  install(row: CivitaiSearchRow): Promise<{ ok: boolean; error?: string }>
  /** Read-only. The write path is settings.save({ civitaiAdultMode,
   *  civitaiAdultAcceptedAt }) from the 18+ dialog — there is no unlock IPC. */
  adultState(): Promise<CivitaiAdultState>
  /**
   * Is this PASTED key live, and whose account is it?
   *
   * Asked BEFORE the key is stored, so a REJECTED one never reaches the
   * keychain. `verdict: 'rejected'` (status 401) is Civitai saying no;
   * `verdict: 'unverified'` means we could not ask (offline, PRIVATE MODE, 5xx)
   * and the card stores the key while saying it was not checked.
   *
   * `ok: true` proves the key is a live account credential accepted for
   * authenticated reads — NOT that a given gated download will succeed, and
   * nothing at all about adult content.
   */
  validateKey(key: string): Promise<{ ok: true; username: string } | KeyProbeFailure>
}

// ── RIFE: local frame interpolation (rife-ncnn-vulkan sidecar) ─────────────

export interface RifeStatusInfo {
  installed: boolean
  /** Pinned upstream release tag. */
  version: string
  /** Model directory the engine runs (rife-v4.6). */
  model: string
  binPath: string | null
  modelDir: string | null
  /** Bytes the install will pull — the UI SAYS this before the click (431 MB). */
  downloadBytes: number
  /** false where upstream publishes no build for this platform. */
  supported: boolean
  /** Source paths with a run in flight right now (one run per file). */
  active: string[]
}

export type RifeRunStage =
  | 'probing' | 'extracting' | 'interpolating' | 'encoding' | 'done' | 'error' | 'cancelled'

export interface RifeRunProgress {
  /** The SOURCE PATH — the job identity, so any surface can follow one run. */
  jobId: string
  stage: RifeRunStage
  message: string
  /** 0..100 when measured, -1 when it is not. Never invented. */
  percent: number
  counts?: { done: number; total: number }
  outputPath?: string
  error?: string
}

export interface RifeAPI {
  status(): Promise<RifeStatusInfo>
  /** Download + sha-verify + extract + sanity-run the sidecar. Resolves with
   *  `{ ok:false, error }` rather than throwing, so the button can show why. */
  install(): Promise<{ ok: boolean; error?: string; installed?: boolean }>
  uninstall(): Promise<{ ok: boolean; error?: string }>
  /** One LOCAL video → "<name>-rife<N>x.mp4" beside it. Never overwrites. */
  interpolate(path: string, multiplier?: 2 | 4): Promise<{
    ok: boolean; outputPath?: string; error?: string; cancelled?: boolean
  }>
  /** Stop the run for one source path. `ok:false` = nothing was running. */
  cancel(path: string): Promise<{ ok: boolean }>
  onInstallProgress(cb: (p: {
    stage: string; message: string; percent: number
    bytes?: number; totalBytes?: number; speedBytesPerSec?: number; etaSec?: number
  }) => void): () => void
  onProgress(cb: (p: RifeRunProgress) => void): () => void
}

// ── parallel-code: multi-task coding agent registry ────────────────────────

export type ParallelTaskStatus = 'idle' | 'running' | 'done' | 'error' | 'aborted'

export interface ParallelTaskSnapshot {
  id:           string
  name:         string
  branchName:   string
  worktreePath: string
  sessionId:    string
  workingDir:   string
  status:       ParallelTaskStatus
  createdAt:    number
  lastLine?:    string
}

export interface ParallelStepEntry {
  id?:        string
  timestamp?: number
  [key: string]: unknown
}

export type ParallelEvent =
  | { kind: 'list';        tasks: ParallelTaskSnapshot[] }
  | { kind: 'step';        taskId: string; entry: ParallelStepEntry }
  | { kind: 'steps';       taskId: string; entries: ParallelStepEntry[] }
  | { kind: 'steps-error'; taskId: string; error: string }

export interface ParallelCreateTaskInput {
  name:          string
  projectRoot:   string
  baseBranch?:   string
  symlinkDirs?:  string[]
  branchPrefix?: string
}

export type ParallelCreateTaskResult =
  | { ok: true;  task: ParallelTaskSnapshot; warnings: string[] }
  | { ok: false; error: string }

export type ParallelDeleteTaskResult =
  | { ok: true;  warnings: string[] }
  | { ok: false; error: string }

/** Final lifecycle frame from a PTY spawn — exit code + tail. */
export interface ParallelPtyExitInfo {
  exit_code:   number | null
  signal:      number | null
  last_output: string[]
}

/**
 * Lazy PTY surface — one shell per parallel task, spawned on first
 * `pty.spawn` and surviving EVENTS↔PTY toggles. The shell is killed when
 * the task is deleted or `pty.kill` is called explicitly. Data frames
 * arrive base64-encoded over the `parallel:pty-data:<subId>` channel.
 */
export interface ParallelPtyAPI {
  spawn(taskId: string, cols?: number, rows?: number): Promise<
    | { ok: true; hadExisting: boolean }
    | { ok: false; error: string }
  >
  write(taskId: string, data: string):                       Promise<{ ok: boolean }>
  resize(taskId: string, cols: number, rows: number):        Promise<{ ok: boolean }>
  kill(taskId: string):                                      Promise<{ ok: boolean }>
  /**
   * Subscribe to PTY output frames for a task. The callback receives the
   * base64-encoded data string (decode with atob/Buffer.from before
   * feeding to xterm or stripping ANSI). Returns an unsubscribe function.
   */
  subscribe(
    taskId:  string,
    onData:  (base64Data: string) => void,
    onExit?: (info: ParallelPtyExitInfo) => void,
  ): Promise<() => void>
}

export interface ParallelAgentsAPI {
  list(): Promise<{ tasks: ParallelTaskSnapshot[] }>
  createTask(input: ParallelCreateTaskInput): Promise<ParallelCreateTaskResult>
  deleteTask(taskId: string, deleteBranch?: boolean): Promise<ParallelDeleteTaskResult>
  setStatus(taskId: string, status: ParallelTaskStatus): Promise<{ ok: true }>
  setLastLine(taskId: string, line: string): Promise<{ ok: true }>
  onEvent(cb: (event: ParallelEvent) => void): () => void
  /** Lazy PTY surface — see ParallelPtyAPI. */
  pty: ParallelPtyAPI
}

// ── llama.cpp sidecar types ────────────────────────────────────────────────

export type LlamaCppState = 'stopped' | 'starting' | 'loading' | 'running' | 'error'

export interface LlamaCppReleaseAssetInfo {
  id:        'win-cuda' | 'win-avx' | 'macos-arm64'
  label:     string
  filename:  string
  url:       string
  sha256:    string
  sizeMb:    number
  platform:  NodeJS.Platform
  needsCuda: boolean
}

export interface GgufModelInfo {
  id:                string
  label:             string
  family:            'qwen' | 'llama' | 'mistral' | 'deepseek' | 'phi' | 'gemma'
  paramsB:           number
  quant:             string
  url:               string
  sha256:            string
  sizeMb:            number
  contextK:          number
  recommendedRamGb:  number
}

export interface LlamaCppCatalog {
  version:           string
  platform:          NodeJS.Platform
  arch:              string
  releases:          LlamaCppReleaseAssetInfo[]
  defaultReleaseId:  string | null
  /** GPU-truth: the build to prefer given the detected GPU (CUDA build for NVIDIA). */
  recommendedReleaseId?: string | null
  /** One-line note when a GPU was detected (e.g. "RTX 3080 Ti detected — the CUDA build will use your GPU."). */
  gpuNote?:          string | null
  unsupportedReason: string | null
  models:            GgufModelInfo[]
}

export interface LlamaCppStatusInfo {
  state:            LlamaCppState
  port?:            number
  pid?:             number
  modelId?:         string
  uptimeMs?:        number
  error?:           string
  installed:        boolean
  downloadedModels: string[]
}

export type LlamaInstallStage =
  | 'checking'
  | 'downloading-binary'
  | 'extracting'
  | 'downloading-model'
  | 'verifying'
  | 'done'
  | 'error'

export interface LlamaCppInstallProgressEvent {
  stage:       LlamaInstallStage
  message:     string
  percent:     number
  bytes?:      number
  totalBytes?: number
}

// ─── Resumable download manager (UX #11) ────────────────────────────────────

export type DownloadItemState = 'queued' | 'active' | 'paused' | 'verifying' | 'done' | 'error'

export type DownloadErrorCode = 'DISK_FULL' | 'CHECKSUM_MISMATCH' | 'SIZE_MISMATCH' | 'RANGE_IGNORED' | 'NETWORK' | 'CANCELLED' | 'STORAGE_MOVED'

export interface DownloadItemInfo {
  id: string
  name: string
  kind: 'gguf-model' | 'gguf-url' | 'sd-model' | 'piper-voice' | 'whisper-model'
  state: DownloadItemState
  receivedBytes: number
  /** Best-known total (headers > exact expected > approx). 0 = unknown. */
  totalBytes: number
  /** 0..100, or -1 when the total is unknown. */
  percent: number
  speedBytesPerSec: number
  etaSec: number
  error?: string
  errorCode?: DownloadErrorCode
  /** How completion was ACTUALLY verified: pinned/LFS sha256, byte size, or not at all. */
  verified?: 'sha256' | 'size' | 'none'
  observedSha256?: string
  updatedAt: number
}

export interface DownloadsAPI {
  list(): Promise<DownloadItemInfo[]>
  /** Stop the transfer, KEEP the partial bytes; the strip offers RESUME. */
  pause(id: string): Promise<{ ok: boolean; error?: string }>
  /** Continue a paused/errored download from the bytes on disk. */
  resume(id: string): Promise<{ ok: boolean; error?: string }>
  /** Abort + delete the partial file + drop the task. */
  cancel(id: string): Promise<{ ok: boolean; error?: string }>
  /** Clear a settled (done/error) row from the strip. */
  dismiss(id: string): Promise<{ ok: boolean; error?: string }>
  /** Full-queue broadcast on every state change (progress throttled to 4/s). */
  onChanged(cb: (items: DownloadItemInfo[]) => void): () => void
}

export interface LlamaCppAPI {
  catalog():  Promise<LlamaCppCatalog>
  status():   Promise<LlamaCppStatusInfo>
  install(assetId?: string):                                     Promise<{ ok: true } | { ok: false; error: string }>
  downloadModel(modelId: string):                                 Promise<{ ok: true } | { ok: false; error: string }>
  downloadUrl(id: string, url: string):                           Promise<{ ok: true } | { ok: false; error: string }>
  cancelDownload(id: string):                                     Promise<{ ok: boolean; cancelled?: boolean; error?: string }>
  removeModel(modelId: string):                                   Promise<{ ok: boolean; error?: string }>
  /**
   * `cacheType` is OPTIONAL and rarely passed: main reads the user's stored
   * `llamaKvCache` preference when a caller omits it, so the four start sites
   * do not each have to remember. An explicit value here still wins.
   */
  start(opts: { modelId: string; contextSize?: number; nGpuLayers?: number; threads?: number; profile?: 'quality' | 'balanced' | 'speed'; cacheType?: 'f16' | 'q8_0' | 'q4_0' }):
    Promise<{ ok: true; status: LlamaCppStatusInfo; offload?: { nGpuLayers: number; reason: string } } | { ok: false; error: string }>
  stop():     Promise<{ ok: true; status: LlamaCppStatusInfo }>
  logs(lines?: number): Promise<{ lines: string[] }>
  /** Detected GPU + whether a GPU-capable llama build is installed (GPU-truth). */
  gpu(): Promise<{ vendor: string; name: string; vramMB: number; vramIsFloor: boolean; backend: string; source: string; gpuBuildInstalled: boolean }>
  onInstallProgress(cb: (event: LlamaCppInstallProgressEvent) => void): () => void
}

// ── Model-weight storage dashboard + relocation (Settings → Model Weights) ────

export type ModelEngineId = 'llama' | 'sd' | 'whisper' | 'piper'

/** One file inside an sd adapter container ('loras'/'embeddings'/'vae'). */
export interface ModelStorageFile {
  name: string
  displayName: string
  bytes: number
  location: 'root' | 'legacy'
}

export interface ModelUsageItem {
  id: string
  /** 'root' = already under the storage root; 'legacy' = still in userData. */
  location: 'root' | 'legacy'
  bytes: number
  /** Human-readable label — a checkpoint's registry name, never the raw
   *  `civitai-<versionId>` id. Falls back to `id` when unresolved. */
  displayName: string
  /** Present ONLY for the sd 'loras'/'embeddings'/'vae' shared container rows
   *  — these are every installed adapter of one kind sharing a directory, not
   *  one model, so Remove must target one file, never the whole container. */
  adapterKind?: 'lora' | 'embedding' | 'vae'
  containerFiles?: ModelStorageFile[]
  /** Other installed sd item ids sharing a hard-linked on-disk component with
   *  this one (undefined when nothing is shared). */
  sharedWith?: string[]
}

export interface EngineUsage {
  engine: ModelEngineId
  label: string
  items: ModelUsageItem[]
  totalBytes: number
  hasLegacy: boolean
}

export interface ModelStorageUsage {
  engines: EngineUsage[]
  totalBytes: number
  modelsRoot: string
  userDataRoot: string
  storageFreeBytes: number | null
  storageTotalBytes: number | null
  canRelocate: boolean
  /** True when `modelsRoot` is on a DIFFERENT drive than `userDataRoot` — i.e.
   *  moving actually frees space on the drive the weights sit on today. False
   *  (the stock case: Documents\Tachi Studio is on C: exactly like %APPDATA%)
   *  means a move shuffles gigabytes around one drive and frees nothing. */
  moveChangesDrive: boolean
  /** Free / total bytes on the drive holding the legacy (app-data) weights. */
  legacyFreeBytes: number | null
  legacyTotalBytes: number | null
}

/** What a staging file IS, read off the file itself (electron/services/staging-inventory.ts). */
export type StagingKind = 'abandoned-partial' | 'cached-archive'

export interface StagingFile {
  path: string
  name: string
  /** The engine directory it belongs to (`llama-cpp`), for grouping on screen. */
  owner: string
  bytes: number
  mtimeMs: number
  kind: StagingKind
}

export interface StagingInventory {
  files: StagingFile[]
  totalBytes: number
  /** Bytes whose removal costs the user nothing at all (interrupted transfers
   *  no code path can resume). */
  deadBytes: number
  /** Bytes whose removal costs only a re-download (extracted installer zips). */
  cachedBytes: number
  scannedDirs: string[]
  /** Seen and deliberately NOT offered — too new, or a download still owns it. */
  withheldCount: number
}

export interface StagingReclaimResult {
  freedBytes: number
  removed: string[]
  failed: Array<{ path: string; error: string }>
  /** Asked for, but a fresh scan would no longer offer it. */
  refused: string[]
}

export interface ModelMigrateProgress {
  engine: ModelEngineId
  phase: 'preflight' | 'copy' | 'delete' | 'done' | 'error' | 'aborted' | 'skip'
  filesDone: number
  filesTotal: number
  bytesDone: number
  bytesTotal: number
  currentFile?: string
  message?: string
  error?: string
}

export interface ModelMigrateResult {
  ok: boolean
  engine: ModelEngineId
  movedFiles: number
  movedBytes: number
  error?: string
  aborted?: boolean
  skipped?: boolean
}

// ── Local scheduler (Settings → Scheduled) ───────────────────────────────────
// Mirrors electron/services/scheduler-core.ts. Kept as a structural copy (not an
// import) because this ambient file must stay dependency-free for the renderer.

export type ScheduleType = 'once' | 'daily' | 'weekly' | 'interval'
/** What to do about an occurrence that came due while nothing was running. */
export type MissedRunPolicy = 'run' | 'skip'
/** 'loop' rows are written by the harness's loop controller (a LOOP-MODE run's
 *  resume point), never by the Settings form — the UI lists them read-only. */
export type ScheduledJobTarget = 'flow' | 'prompt' | 'loop'
export type ScheduledJobRunStatus = 'ok' | 'error' | 'blocked' | 'skipped'

export interface JobSchedule {
  type: ScheduleType
  /** `once`: absolute epoch ms. */
  at?: number
  /** `daily` / `weekly`: local 'HH:MM'. */
  timeOfDay?: string
  /** `weekly`: 0 = Sunday … 6 = Saturday. */
  weekday?: number
  /** `interval`: minutes between runs. */
  everyMinutes?: number
}

export interface ScheduledJob {
  id: string
  name: string
  target: ScheduledJobTarget
  flowFile?: string
  prompt: string
  schedule: JobSchedule
  missedPolicy: MissedRunPolicy
  enabled: boolean
  createdAt: number
  nextRunAt: number | null
  lastRunAt?: number
  lastStatus?: ScheduledJobRunStatus
  lastDetail?: string
  lastDurationMs?: number
  runCount: number
  /** target 'loop': where a LOOP-MODE harness run resumes from after a restart. */
  loop?: { key: string; goal: string; cap: number; iteration: number; workspaceRoot: string }
}

/** What the Settings form sends; the store fills in the bookkeeping fields. */
export interface ScheduledJobInput {
  id?: string
  name?: string
  target: ScheduledJobTarget
  flowFile?: string
  prompt?: string
  schedule: JobSchedule
  missedPolicy?: MissedRunPolicy
  enabled?: boolean
}

declare global {
  interface Window { tachi: TachiAPI }
}
