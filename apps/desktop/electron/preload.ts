import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { preloadBridge } from './ipc-router/preload-bridge'
import type { shellRouter } from './ipc/shell.ipc'
import type { bankrRouter } from './ipc/bankr.ipc'
import type { surplusRouter } from './ipc/surplus.ipc'
import type { veniceRouter } from './ipc/venice.ipc'
import type { openrouterRouter } from './ipc/openrouter.ipc'
import type { opengatewayRouter } from './ipc/opengateway.ipc'
import type { surplusMediaRouter } from './ipc/surplus-media.ipc'
import type { imgnaiMediaRouter } from './ipc/imgnai-media.ipc'
import type { pollinationsMediaRouter } from './ipc/pollinations-media.ipc'
import type { fusionRouter } from './ipc/fusion.ipc'
import type { playbookRouter } from './ipc/playbook.ipc'
import type { agentRuntimeRouter } from './ipc/agent-runtime.ipc'
import type { AgentRuntimeSnapshot } from './store/agent-runtime.store'
import type { checkpointsRouter } from './ipc/checkpoints.ipc'
import type { sessionMemoryRouter } from './ipc/session-memory.ipc'
import type { memoryFactsRouter } from './ipc/memory-facts.ipc'
import type { workspacePanelRouter } from './ipc/workspace-panel.ipc'
import type { rolesRouter } from './ipc/roles.ipc'
import type { skillsRouter } from './ipc/skills.ipc'
import type { nookRouter } from './ipc/nook.ipc'
import type { walletRouter } from './ipc/wallet.ipc'
import type { nookMiningRouter } from './ipc/nook-mining.ipc'
import type { nookActionsRouter } from './ipc/nook-actions.ipc'
import type { nookNetworkRouter } from './ipc/nook-network.ipc'
import type { nookMessagingRouter } from './ipc/nook-messaging.ipc'

type ChunkCallback = (chunk: unknown) => void
type LogCallback = (event: unknown) => void

// ── Sprint C1: typed router bridges ──────────────────────────────────────────
// These replace the hand-written ipcRenderer.invoke wrappers for the migrated
// namespaces. Channel names are identical to the old wiring.

const shellBridge = preloadBridge<typeof shellRouter>('shell', ['openExternal', 'revealInFolder'])

const bankrBridge = preloadBridge<typeof bankrRouter>('bankr', ['listModels'])

const nookMiningBridge = preloadBridge<typeof nookMiningRouter>('nookMining', [
  'getTrackStats', 'listChallenges', 'getRewards', 'solveOnce', 'startLoop', 'stopLoop', 'stats',
])

const walletBridge = preloadBridge<typeof walletRouter>('wallet', [
  'getInfo', 'getBalances', 'create', 'importRaw', 'importKeystore', 'exportKeystore',
  'forget', 'signMessage', 'sendTransaction',
  // darksol foundation — multi-wallet / multi-chain / multi-token + limits
  'listWallets', 'setActiveAgentWallet', 'createAgentWallet', 'importAgentWallet', 'forgetAgentWallet',
  'walletBalances', 'sendToken', 'fundAgentWallet', 'getAgentLimits', 'setAgentLimits', 'listNetworks',
  'listTx', 'verifyTxLog',
])

const nookBridge = preloadBridge<typeof nookRouter>('nook', [
  'get', 'getStatus', 'configure', 'clearCredentials', 'generateWallet', 'register', 'registerInApp',
  'connect', 'disconnect', 'getProfile', 'listBounties', 'claimBounty', 'submitWork',
  'listListings', 'goOnline', 'goOffline', 'getApprovals', 'approveAction', 'rejectAction', 'getActivity',
  'mcpStatus', 'mcpEnable', 'mcpDisable',
  'darksolMcpStatus', 'darksolMcpEnable', 'darksolMcpDisable',
  'exportKeystore', 'importKeystore',
  'setBrain', 'listBrainProviders',
])

const nookActionsBridge = preloadBridge<typeof nookActionsRouter>('nookActions', [
  'postBounty', 'applyBounty', 'submitWork', 'hireService',
])

const nookNetworkBridge = preloadBridge<typeof nookNetworkRouter>('nookNetwork', [
  'getFeed', 'getPost', 'publishPost', 'listCommunities', 'getLeaderboard', 'searchAgents', 'follow',
])

const nookMessagingBridge = preloadBridge<typeof nookMessagingRouter>('nookMessaging', [
  'inboxList', 'unreadCount', 'sendDM', 'markRead',
  'listChannels', 'channelMessages', 'channelMembers', 'sendChannel', 'joinChannel', 'leaveChannel',
])

const surplusBridge = preloadBridge<typeof surplusRouter>('surplus', ['listModels'])
const veniceBridge = preloadBridge<typeof veniceRouter>('venice', ['listModels', 'listMediaModels', 'generateImage', 'generateSpeech', 'transcribe', 'generateVideo', 'generateMusic'])
// OpenRouter live catalog — carries the per-model FREE signal (pricing 0/0).
const openrouterBridge = preloadBridge<typeof openrouterRouter>('openrouter', ['listModels'])
// OpenGateway live catalog — the windows THIS gateway serves (its
// nemotron-3-ultra is 131k where OpenRouter's is 1M), its effective prices, and
// its own free-promo expiry dates.
const opengatewayBridge = preloadBridge<typeof opengatewayRouter>('opengateway', ['listModels'])

const surplusMediaBridge = preloadBridge<typeof surplusMediaRouter>('surplusMedia', [
  'listModels',
  'modelParams',
  'generateImage',
  'generateSpeech',
  'transcribe',
  'submitVideo',
  'submitMusic',
  'pollJob',
  'saveArtifact',
])

// imgnAI Katana media (image + video). Generate calls resolve when the MAIN
// poll loop settles; live ticks arrive on the 'imgnai:gen-progress' push channel.
const imgnaiMediaBridge = preloadBridge<typeof imgnaiMediaRouter>('imgnaiMedia', [
  'listModels',
  'generateImage',
  'generateVideo',
])

// Pollinations keyless image engine. Generate resolves when MAIN's paced GET
// settles; live ticks arrive on the 'pollinations:gen-progress' push channel.
const pollinationsMediaBridge = preloadBridge<typeof pollinationsMediaRouter>('pollinationsMedia', [
  'listModels',
  'generateImage',
])

const fusionBridge = preloadBridge<typeof fusionRouter>('fusion', ['rerunMember'])

const playbookBridge = preloadBridge<typeof playbookRouter>('playbook', [
  'list',
  'load',
  'delete',
  'loadEntries',
])

// ── Sprint C2: agent-runtime bridge ──────────────────────────────────────────
// Request/response routes via the typed router.
const agentRuntimeBridge = preloadBridge<typeof agentRuntimeRouter>('agent-runtime', [
  'getState',
  'setStatus',
  'setHarness',
  'setProvider',
])

// ── Sprint C3: checkpoints bridge ─────────────────────────────────────────────
// Read/list/delete only. Writes are internal (main process only).
const checkpointsBridge = preloadBridge<typeof checkpointsRouter>('checkpoints', [
  'loadCheckpoint',
  'listCheckpoints',
  'deleteCheckpoint',
  'snapshotWorkspace',
  'listWorkspaceCheckpoints',
  'restoreWorkspace',
  'deleteWorkspaceCheckpoint',
])

// ── agent-session-memory bridge ───────────────────────────────────────────────
// Read/write session summaries by workspace path (ECC cross-run memory).
const sessionMemoryBridge = preloadBridge<typeof sessionMemoryRouter>('session-memory', [
  'save',
  'load',
  'buildContext',
  'list',
  'delete',
])

// ── Memory fact store bridge (T16) ────────────────────────────────────────────
// Managed, per-item persistent memory: list/add/edit/delete/toggle + preview.
const memoryFactsBridge = preloadBridge<typeof memoryFactsRouter>('memory-facts', [
  'list',
  'add',
  'edit',
  'delete',
  'toggle',
  'preview',
])

// ── Sprint C4: workspace-panel bridge ─────────────────────────────────────────
// Read-only. listRecentChanges surfaces tool-call turns from the checkpoint;
// getWorkspaceForConversation is a stub for future cross-window sync.
const workspacePanelBridge = preloadBridge<typeof workspacePanelRouter>('workspace-panel', [
  'listRecentChanges',
  'getWorkspaceForConversation',
])

// ── Sprint D5: roles bridge ────────────────────────────────────────────────────
// Typed bridge for the role registry: list, get, suggest.
const rolesBridge = preloadBridge<typeof rolesRouter>('roles', [
  'list',
  'get',
  'suggest',
])

// ── Skills bridge ─────────────────────────────────────────────────────────────
// Installed SKILL.md list + workspace suggestions + hash-pinned registry install.
const skillsBridge = preloadBridge<typeof skillsRouter>('skills', [
  'list',
  'suggest',
  'registry',
  'install',
])

contextBridge.exposeInMainWorld('tachi', {
  settings: {
    load: () => ipcRenderer.invoke('settings:load'),
    save: (settings: unknown) => ipcRenderer.invoke('settings:save', settings),
    saveKey: (providerId: string, key: string) => ipcRenderer.invoke('settings:save-key', { providerId, key }),
    deleteKey: (providerId: string) => ipcRenderer.invoke('settings:delete-key', { providerId }),
    listKeys: () => ipcRenderer.invoke('settings:list-keys'),
  },
  provider: {
    listModels: (providerId: string) => ipcRenderer.invoke('provider:list-models', { providerId }),
    cachedModels: (providerId: string) => ipcRenderer.invoke('provider:cached-models', { providerId }),
    healthCheck: (providerId: string) => ipcRenderer.invoke('provider:health-check', { providerId }),
    testKey: (providerId: string, key: string) => ipcRenderer.invoke('provider:test-key', { providerId, key }),
    // Validate a TYPED credential BEFORE the Settings card stores it. Named per
    // provider on purpose: only these four of the five OpenAI-shaped key cards
    // have an endpoint that reads the credential at all. OpenGateway does not —
    // every free endpoint it exposes answers 200 to any string, including no
    // header (measured tables in services/provider-key-probe.ts) — so there is
    // deliberately no channel for it to call by accident.
    // All four answer with an ACCOUNT FACT, never with the credential, and with
    // a verdict of 'rejected' (the provider said no — do not store) or
    // 'unverified' (we could not ask — store it and say so).
    validateBankrKey: (key: string) => ipcRenderer.invoke('provider:validate-bankr-key', { key }),
    validateImgnaiCredential: (key: string, secret: string) =>
      ipcRenderer.invoke('provider:validate-imgnai-credential', { key, secret }),
    validateVeniceKey: (key: string) => ipcRenderer.invoke('provider:validate-venice-key', { key }),
    validateSurplusKey: (key: string) => ipcRenderer.invoke('provider:validate-surplus-key', { key }),
    probeModel: (args: { baseUrl: string; model: string; providerId?: string }) =>
      ipcRenderer.invoke('provider:probe-model', args),
    // Custom OpenAI-compatible endpoint (USER-PAINS T17): TEST button probe +
    // live model list for the chat picker.
    testCustomEndpoint: (baseUrl: string, key?: string) =>
      ipcRenderer.invoke('provider:test-custom-endpoint', { baseUrl, key }),
    listCustomModels: (providerId: string, force?: boolean) =>
      ipcRenderer.invoke('provider:list-custom-models', { providerId, force }),
  },
  chat: {
    send: (payload: unknown) => ipcRenderer.invoke('chat:send', payload),
    abort: (conversationId: string) => ipcRenderer.invoke('chat:abort', { conversationId }),
    onChunk: (cb: ChunkCallback) => {
      const handler = (_: unknown, chunk: unknown) => cb(chunk)
      ipcRenderer.on('chat:chunk', handler)
      return () => ipcRenderer.off('chat:chunk', handler)
    },
    saveConversation: (conv: unknown) => ipcRenderer.invoke('chat:save-conversation', conv),
    deleteConversation: (id: string) => ipcRenderer.invoke('chat:delete-conversation', { id }),
    // D4: context-window monitoring events
    onContextCharsUpdated: (cb: (payload: { conversationId: string; deltaChars: number }) => void) => {
      const handler = (_: unknown, payload: { conversationId: string; deltaChars: number }) => cb(payload)
      ipcRenderer.on('chat:context-chars-updated', handler)
      return () => ipcRenderer.off('chat:context-chars-updated', handler)
    },
    onRedZoneEntered: (cb: (payload: { conversationId: string }) => void) => {
      const handler = (_: unknown, payload: { conversationId: string }) => cb(payload)
      ipcRenderer.on('chat:red-zone-entered', handler)
      return () => ipcRenderer.off('chat:red-zone-entered', handler)
    },
  },
  runtime: {
    scanAll: () => ipcRenderer.invoke('runtime:scan-all'),
    scanOne: (runtimeId: string) => ipcRenderer.invoke('runtime:scan-one', { runtimeId }),
    onUpdate: (cb: (update: unknown) => void) => {
      const handler = (_: unknown, update: unknown) => cb(update)
      ipcRenderer.on('runtime:card-update', handler)
      return () => ipcRenderer.off('runtime:card-update', handler)
    },
  },
  terminal: {
    create: (id: string) => ipcRenderer.invoke('terminal:create', { id }),
    write: (id: string, data: string) => ipcRenderer.invoke('terminal:write', { id, data }),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.invoke('terminal:resize', { id, cols, rows }),
    kill: (id: string) => ipcRenderer.invoke('terminal:kill', { id }),
    onData: (cb: (id: string, data: string) => void) => {
      const handler = (_: unknown, payload: { id: string; data: string }) => cb(payload.id, payload.data)
      ipcRenderer.on('terminal:data', handler)
      return () => ipcRenderer.off('terminal:data', handler)
    },
    onExit: (cb: (id: string) => void) => {
      const handler = (_: unknown, payload: { id: string }) => cb(payload.id)
      ipcRenderer.on('terminal:exit', handler)
      return () => ipcRenderer.off('terminal:exit', handler)
    },
  },
  logs: {
    onEvent: (cb: LogCallback) => {
      const handler = (_: unknown, event: unknown) => cb(event)
      ipcRenderer.on('logs:event', handler)
      return () => ipcRenderer.off('logs:event', handler)
    },
  },
  commands: {
    onEvent: (cb: (event: unknown) => void) => {
      const handler = (_: unknown, event: unknown) => cb(event)
      ipcRenderer.on('commands:event', handler)
      return () => ipcRenderer.off('commands:event', handler)
    },
  },
  profiles: {
    list:      () => ipcRenderer.invoke('profiles:list'),
    get:       (id: string) => ipcRenderer.invoke('profiles:get', { id }),
    create:    (input: unknown) => ipcRenderer.invoke('profiles:create', input),
    update:    (id: string, patch: unknown) => ipcRenderer.invoke('profiles:update', { id, patch }),
    delete:    (id: string) => ipcRenderer.invoke('profiles:delete', { id }),
    duplicate: (id: string) => ipcRenderer.invoke('profiles:duplicate', { id }),
    getActive: () => ipcRenderer.invoke('profiles:get-active'),
    setActive: (id: string | null) => ipcRenderer.invoke('profiles:set-active', { id }),
  },
  workspace: {
    open:         (path: string) => ipcRenderer.invoke('workspace:open', { path }),
    current:      () => ipcRenderer.invoke('workspace:current'),
    clear:        () => ipcRenderer.invoke('workspace:clear'),
    initAgentsMd: () => ipcRenderer.invoke('workspace:init-agents-md'),
  },
  sidecar: {
    list:   ()                                        => ipcRenderer.invoke('sidecar:list'),
    start:  (id: string, workingDir?: string)         => ipcRenderer.invoke('sidecar:start', { id, workingDir }),
    stop:   (id: string)                              => ipcRenderer.invoke('sidecar:stop',  { id }),
    health: (id: string)                              => ipcRenderer.invoke('sidecar:health', { id }),
    logs:   (id: string, lines?: number)              => ipcRenderer.invoke('sidecar:logs', { id, lines }),
    checkInstalled: ()                                => ipcRenderer.invoke('sidecar:check-installed'),
    install: ()                                       => ipcRenderer.invoke('sidecar:install'),
    onInstallProgress: (cb: (event: unknown) => void) => {
      const handler = (_: unknown, event: unknown) => cb(event)
      ipcRenderer.on('sidecar:install-progress', handler)
      return () => ipcRenderer.off('sidecar:install-progress', handler)
    },
  },
  agent: {
    pickFolder: () =>
      ipcRenderer.invoke('agent:pick-folder'),
    startSession: (
      workingDir: string,
      harness?: string,
      provider?: 'default' | 'opengateway' | 'bankr' | 'surplus' | 'venice' | 'imgnai',
      bankrModel?: string,
      surplusModel?: string,
      surplusSmartRouting?: boolean,
      veniceModel?: string,
      imgnaiModel?: string,
    ) =>
      ipcRenderer.invoke('agent:start-session', {
        workingDir,
        harness:      harness      ?? 'tachi',
        provider:     provider     ?? 'default',
        bankrModel:   bankrModel   ?? 'claude-opus-5',
        surplusModel: surplusModel ?? 'claude-sonnet-4.5',
        veniceModel:  veniceModel  ?? 'zai-org-glm-4.7',
        imgnaiModel:  imgnaiModel  ?? 'glm-5-2',
        surplusSmartRouting: surplusSmartRouting ?? false,
      }),
    routeModel: (message: string, provider?: 'surplus' | 'bankr') =>
      ipcRenderer.invoke('agent:route-model', { message, tools: true, provider }),
    // F1: parsedCommand is optional; present when input is a slash command.
    // parallel-code: optional `taskId` routes to a per-task runtime in main.
    // Omitted by single-session callers — they get the 'default' runtime.
    // `depth` is a trailing OPTIONAL positional arg AFTER `mode` so existing
    // 8-arg callers keep working; it carries the thinking-depth toggle to the
    // server-side TACHI harness (normal/think/ultra; default normal in main).
    send: (sessionId: string, task: string, harness: string, workingDir: string, parsedCommand?: unknown, taskId?: string, roleId?: string, mode?: 'plan' | 'build', depth?: 'normal' | 'think' | 'ultra', history?: Array<{ role: 'user' | 'assistant'; content: string }>, images?: string[], trust?: 'safe' | 'standard' | 'auto') =>
      ipcRenderer.invoke('agent:send', { sessionId, task, harness, workingDir, parsedCommand, taskId, roleId, mode, depth, history, images, trust }),
    abort: (taskId?: string) =>
      ipcRenderer.invoke('agent:abort', taskId ? { taskId } : undefined),
    // LOOP MODE: ask a running /loop to stop AFTER the current iteration
    // (graceful — abort() is the hard stop). ok:false = no such live loop.
    stopLoop: (sessionId: string) =>
      ipcRenderer.invoke('agent:stop-loop', { sessionId }),
    // parallel-code: optional `taskId` lets callers stop a specific parallel
    // task without tracking sessionIds. Omitting it preserves legacy
    // single-session behaviour (sessionId-only).
    stopSession: (sessionId: string, taskId?: string) =>
      ipcRenderer.invoke('agent:stop-session', taskId ? { sessionId, taskId } : { sessionId }),
    onEvent: (cb: (event: unknown) => void) => {
      const handler = (_: unknown, event: unknown) => cb(event)
      ipcRenderer.on('agent:event', handler)
      return () => ipcRenderer.off('agent:event', handler)
    },
    listDir: (dir: string) =>
      ipcRenderer.invoke('agent:list-dir', { dir }),
    generateAgentsMd: (workingDir: string) =>
      ipcRenderer.invoke('agent:generate-agents-md', { workingDir }),
    readFile: (path: string) =>
      ipcRenderer.invoke('agent:read-file', { path }),
    writeFile: (path: string, content: string) =>
      ipcRenderer.invoke('agent:write-file', { path, content }),
    saveArtifactCopy: (path: string) =>
      ipcRenderer.invoke('agent:save-artifact-copy', { path }),
    registerWorkspace: (dir: string) =>
      ipcRenderer.invoke('agent:register-workspace', { dir }),
    createFile: (dir: string, name: string) =>
      ipcRenderer.invoke('agent:create-file', { dir, name }),
    createFolder: (dir: string, name: string) =>
      ipcRenderer.invoke('agent:create-folder', { dir, name }),
    renameEntry: (path: string, newName: string) =>
      ipcRenderer.invoke('agent:rename-entry', { path, newName }),
    deleteEntry: (path: string) =>
      ipcRenderer.invoke('agent:delete-entry', { path }),
    /** B2.1: Send the user's permission decision back to the main process. */
    permissionResponse: (id: string, decision: string) =>
      ipcRenderer.invoke('agent:permission-response', { id, decision }),
    /**
     * Permission prompts main is STILL awaiting — the renderer's re-sync.
     * Called ONCE at renderer startup by the app-lifetime agent event bridge
     * (src/store/agentEventBridge.ts), so a card raised before a reload comes
     * back instead of stranding the run that is blocked on it.
     */
    permissionPending: () =>
      ipcRenderer.invoke('agent:permission-pending'),
    /** B2.1: Subscribe to permission requests pushed from the main process. */
    onPermissionRequest: (cb: (req: unknown) => void) => {
      const handler = (_: unknown, req: unknown) => cb(req)
      ipcRenderer.on('agent:permission-request', handler)
      return () => ipcRenderer.off('agent:permission-request', handler)
    },
    /**
     * Requests main has already settled without the user (10-min timeout, or
     * the run was aborted/stopped, or a remote surface answered). The card must
     * disappear — answering it would go nowhere.
     */
    onPermissionCancel: (cb: (payload: unknown) => void) => {
      const handler = (_: unknown, payload: unknown) => cb(payload)
      ipcRenderer.on('agent:permission-cancel', handler)
      return () => ipcRenderer.off('agent:permission-cancel', handler)
    },
    /**
     * F4: Approve a slash-command plan and send a follow-up agent directive.
     * fix=true means "execute without further confirmation" (--fix semantics).
     * fix=false (default) means "execute step by step, ask if unsure".
     *
     * parallel-code: optional `opts.taskId` resolves the target session via
     * the parallel-agent manager so callers don't need to track sessionIds
     * across parallel tasks. When provided, takes precedence over sessionId.
     */
    approvePlan: (sessionId: string, plan: unknown, opts?: { fix?: boolean; taskId?: string }) =>
      ipcRenderer.invoke('agent:approve-plan', {
        sessionId,
        plan,
        fix: opts?.fix ?? false,
        ...(opts?.taskId ? { taskId: opts.taskId } : {}),
      }),
  },
  openclaude: {
    checkInstalled: () => ipcRenderer.invoke('openclaude:check-installed'),
    install:        () => ipcRenderer.invoke('openclaude:install'),
    start:          () => ipcRenderer.invoke('openclaude:start'),
    stop:           () => ipcRenderer.invoke('openclaude:stop'),
    onInstallProgress: (cb: (event: unknown) => void) => {
      const handler = (_: unknown, event: unknown) => cb(event)
      ipcRenderer.on('openclaude:install-progress', handler)
      return () => ipcRenderer.off('openclaude:install-progress', handler)
    },
  },
  ollama: {
    status:        () => ipcRenderer.invoke('ollama:status'),
    ensureRunning: () => ipcRenderer.invoke('ollama:ensure-running'),
    listModels:    () => ipcRenderer.invoke('ollama:list-models'),
    pull:          (name: string) => ipcRenderer.invoke('ollama:pull', { name }),
    delete:        (name: string) => ipcRenderer.invoke('ollama:delete', { name }),
    onPullProgress: (cb: (event: unknown) => void) => {
      const handler = (_: unknown, event: unknown) => cb(event)
      ipcRenderer.on('ollama:pull-progress', handler)
      return () => ipcRenderer.off('ollama:pull-progress', handler)
    },
  },
  bankr: bankrBridge,
  surplus: surplusBridge,
  venice: veniceBridge,
  openrouter: openrouterBridge,
  opengateway: opengatewayBridge,
  surplusMedia: surplusMediaBridge,
  // imgnAI Katana media — typed router bridge + the gen-progress push channel.
  imgnaiMedia: {
    ...imgnaiMediaBridge,
    onGenProgress: (cb: (p: { requestId: string; kind: 'image' | 'video'; status: string; elapsedSec: number }) => void) => {
      const h = (_: unknown, p: { requestId: string; kind: 'image' | 'video'; status: string; elapsedSec: number }) => cb(p)
      ipcRenderer.on('imgnai:gen-progress', h)
      return () => ipcRenderer.off('imgnai:gen-progress', h)
    },
  },
  // Pollinations keyless image — typed router bridge + gen-progress channel.
  pollinationsMedia: {
    ...pollinationsMediaBridge,
    onGenProgress: (cb: (p: { requestId: string; kind: 'image'; status: string; elapsedSec: number; completedAfterPrivate?: boolean }) => void) => {
      const h = (_: unknown, p: { requestId: string; kind: 'image'; status: string; elapsedSec: number; completedAfterPrivate?: boolean }) => cb(p)
      ipcRenderer.on('pollinations:gen-progress', h)
      return () => ipcRenderer.off('pollinations:gen-progress', h)
    },
  },
  // Fusion panel RE-RUN — retry a single failed panel member from the transcript.
  fusion: {
    rerunMember: (input: { providerId: string; model: string; brief: string }) => fusionBridge.rerunMember(input),
  },
  claudeCodeRouter: {
    checkInstalled: () => ipcRenderer.invoke('claude-code-router:check-installed'),
    install:        () => ipcRenderer.invoke('claude-code-router:install'),
    start:          () => ipcRenderer.invoke('claude-code-router:start'),
    stop:           () => ipcRenderer.invoke('claude-code-router:stop'),
    readConfig:     () => ipcRenderer.invoke('claude-code-router:read-config'),
    writeConfig:    (cfg: unknown) => ipcRenderer.invoke('claude-code-router:write-config', cfg),
    seedConfig:     () => ipcRenderer.invoke('claude-code-router:seed-config'),
    onInstallProgress: (cb: (event: unknown) => void) => {
      const handler = (_: unknown, event: unknown) => cb(event)
      ipcRenderer.on('claude-code-router:install-progress', handler)
      return () => ipcRenderer.off('claude-code-router:install-progress', handler)
    },
  },
  telegram: {
    status:          () => ipcRenderer.invoke('telegram:status'),
    setToken:        (token: string) => ipcRenderer.invoke('telegram:set-token', { token }),
    setEnabled:      (enabled: boolean) => ipcRenderer.invoke('telegram:set-enabled', { enabled }),
    unpair:          () => ipcRenderer.invoke('telegram:unpair'),
    chooseWorkspace: () => ipcRenderer.invoke('telegram:choose-workspace'),
  },
  codex: {
    status:  () => ipcRenderer.invoke('codex:status'),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke('codex:set-enabled', { enabled }),
    install: () => ipcRenderer.invoke('codex:install'),
    login:   () => ipcRenderer.invoke('codex:login'),
    logout:  () => ipcRenderer.invoke('codex:logout'),
    adoptAuth: () => ipcRenderer.invoke('codex:adopt-auth'),
    getLog: () => ipcRenderer.invoke('codex:get-log'),
    onLogEvent: (cb: (line: unknown) => void) => {
      const handler = (_: unknown, line: unknown) => cb(line)
      ipcRenderer.on('codex:log-event', handler)
      return () => ipcRenderer.removeListener('codex:log-event', handler)
    },
    onInstallProgress: (cb: (p: { step: string; message: string; percent: number }) => void) => {
      const handler = (_: unknown, p: { step: string; message: string; percent: number }) => cb(p)
      ipcRenderer.on('codex:install-progress', handler)
      return () => ipcRenderer.removeListener('codex:install-progress', handler)
    },
    onLoginProgress: (cb: (p: { line: string }) => void) => {
      const handler = (_: unknown, p: { line: string }) => cb(p)
      ipcRenderer.on('codex:login-progress', handler)
      return () => ipcRenderer.removeListener('codex:login-progress', handler)
    },
  },
  storage: {
    info:   () => ipcRenderer.invoke('storage:info'),
    choose: () => ipcRenderer.invoke('storage:choose'),
    open:   () => ipcRenderer.invoke('storage:open'),
    reset:  () => ipcRenderer.invoke('storage:reset'),
  },
  // Model-weight storage dashboard + relocation (Settings → Model Weights).
  modelStorage: {
    usage:   (force?: boolean) => ipcRenderer.invoke('model-storage:usage', { force: !!force }),
    remove:  (engine: string, id: string) => ipcRenderer.invoke('model-storage:remove', { engine, id }),
    migrate: (engine?: string) => ipcRenderer.invoke('model-storage:migrate', { engine }),
    abort:   (engine?: string) => ipcRenderer.invoke('model-storage:migrate-abort', { engine }),
    isMigrating: (engine?: string) => ipcRenderer.invoke('model-storage:is-migrating', { engine }),
    staging: () => ipcRenderer.invoke('model-storage:staging'),
    reclaimStaging: (paths: string[]) => ipcRenderer.invoke('model-storage:reclaim-staging', { paths }),
    onMigrateProgress: (cb: (event: unknown) => void) => {
      const handler = (_: unknown, event: unknown) => cb(event)
      ipcRenderer.on('model-storage:migrate-progress', handler)
      return () => ipcRenderer.off('model-storage:migrate-progress', handler)
    },
  },
  // Local scheduler (Settings → Scheduled): saved flows / prompts on a timer,
  // surviving restarts and PC sleep.
  scheduler: {
    list:       () => ipcRenderer.invoke('scheduler:list'),
    save:       (job: unknown) => ipcRenderer.invoke('scheduler:save', job),
    remove:     (id: string) => ipcRenderer.invoke('scheduler:delete', { id }),
    setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('scheduler:set-enabled', { id, enabled }),
    runNow:     (id: string) => ipcRenderer.invoke('scheduler:run-now', { id }),
    onChanged: (cb: (payload: { jobs: unknown[] }) => void) => {
      const handler = (_: unknown, payload: { jobs: unknown[] }) => cb(payload)
      ipcRenderer.on('scheduler:changed', handler)
      return () => ipcRenderer.off('scheduler:changed', handler)
    },
  },
  app: {
    getDataPath:      () => ipcRenderer.invoke('app:get-data-path'),
    resetOnboarding:  () => ipcRenderer.invoke('app:reset-onboarding'),
    openDevTools:     () => ipcRenderer.invoke('app:open-devtools'),
    deleteAllData:    () => ipcRenderer.invoke('app:delete-all-data'),
    checkForUpdates:  () => ipcRenderer.invoke('app:check-for-updates'),
    downloadUpdate:   () => ipcRenderer.invoke('app:download-update'),
    quitAndInstall:   () => ipcRenderer.invoke('app:quit-and-install'),
    // TACHIAPP: where this app's own source lives (folder-free self-improvement chat).
    resolveAppRepo:   () => ipcRenderer.invoke('app:resolve-app-repo'),
    chooseAppRepo:    () => ipcRenderer.invoke('app:choose-app-repo'),
    onUpdateStatus: (cb: (status: { state: string; version?: string }) => void) => {
      const handler = (_: unknown, status: { state: string; version?: string }) => cb(status)
      ipcRenderer.on('app:update-status', handler)
      return () => ipcRenderer.off('app:update-status', handler)
    },
  },
  notification: {
    show: (payload: { title: string; body?: string; silent?: boolean }) =>
      ipcRenderer.invoke('notification:show', payload),
  },
  tray: {
    onNewChat: (cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.on('tray:new-chat', handler)
      return () => ipcRenderer.off('tray:new-chat', handler)
    },
    onOpenAgent: (cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.on('tray:open-agent', handler)
      return () => ipcRenderer.off('tray:open-agent', handler)
    },
  },
  system: {
    info: () => ipcRenderer.invoke('system:info'),
  },
  oauth: {
    anthropicStart:    () => ipcRenderer.invoke('oauth:anthropic-start'),
    anthropicComplete: (code: string) => ipcRenderer.invoke('oauth:anthropic-complete', { code }),
    openrouterStart:   () => ipcRenderer.invoke('oauth:openrouter-start'),
    openrouterCancel:  () => ipcRenderer.invoke('oauth:openrouter-cancel'),
  },
  cost: {
    // 30-day per-provider spend rollup + the configured budget (cost ledger).
    summary: () =>
      ipcRenderer.invoke('cost:summary') as Promise<{
        windowDays: number
        totalUsd: number
        budgetUsd: number
        byProvider: Record<string, { usd: number; promptTokens: number; completionTokens: number; events: number; unpricedEvents: number }>
        byTaskType: Record<string, { usd: number; promptTokens: number; completionTokens: number; events: number }>
      }>,
    // Recent per-task agent runs (run log), newest first.
    recentRuns: (n?: number) =>
      ipcRenderer.invoke('cost:recent-runs', n) as Promise<Array<{
        ts: number
        task: string
        harness: string
        workingDir: string
        outcome: 'done' | 'error' | 'abort'
        durationMs: number
        error?: string
      }>>,
  },
  ytdlp: {
    installed: () => ipcRenderer.invoke('ytdlp:installed') as Promise<{ installed: boolean }>,
    info: (url: string) =>
      ipcRenderer.invoke('ytdlp:info', { url }) as Promise<{
        ok: boolean
        info?: { title: string; thumbnail?: string; durationSec?: number; extractor?: string; formats: Array<{ id: string; label: string; height: number }> }
        error?: string
      }>,
    download: (url: string, formatId?: string, audioOnly?: boolean) =>
      ipcRenderer.invoke('ytdlp:download', { url, formatId, audioOnly }) as Promise<{ ok: boolean; path?: string; mediaUrl?: string; error?: string }>,
    onDownloadProgress: (cb: (p: { url: string; percent: number; speed?: string; eta?: string; total?: string }) => void) => {
      const h = (_: unknown, p: { url: string; percent: number; speed?: string; eta?: string; total?: string }) => cb(p)
      ipcRenderer.on('yt-dlp:download-progress', h)
      return () => ipcRenderer.off('yt-dlp:download-progress', h)
    },
    onInstallProgress: (cb: (p: { stage: string; message: string; percent: number }) => void) => {
      const h = (_: unknown, p: { stage: string; message: string; percent: number }) => cb(p)
      ipcRenderer.on('yt-dlp:install-progress', h)
      return () => ipcRenderer.off('yt-dlp:install-progress', h)
    },
  },
  // RIFE frame interpolation (rife-ncnn-vulkan). Fully local: reads a file the
  // user already has, spawns three local programs, writes a file next to it.
  rife: {
    status: () =>
      ipcRenderer.invoke('rife:status') as Promise<{
        installed: boolean; version: string; model: string
        binPath: string | null; modelDir: string | null
        downloadBytes: number; supported: boolean; active: string[]
      }>,
    install:   () => ipcRenderer.invoke('rife:install') as Promise<{ ok: boolean; error?: string; installed?: boolean }>,
    uninstall: () => ipcRenderer.invoke('rife:uninstall') as Promise<{ ok: boolean; error?: string }>,
    interpolate: (path: string, multiplier?: 2 | 4) =>
      ipcRenderer.invoke('rife:interpolate', { path, multiplier }) as Promise<{ ok: boolean; outputPath?: string; error?: string; cancelled?: boolean }>,
    cancel: (path: string) => ipcRenderer.invoke('rife:cancel', { path }) as Promise<{ ok: boolean }>,
    onInstallProgress: (cb: (p: { stage: string; message: string; percent: number; bytes?: number; totalBytes?: number; speedBytesPerSec?: number; etaSec?: number }) => void) => {
      const h = (_: unknown, p: { stage: string; message: string; percent: number; bytes?: number; totalBytes?: number; speedBytesPerSec?: number; etaSec?: number }) => cb(p)
      ipcRenderer.on('rife:install-progress', h)
      return () => ipcRenderer.off('rife:install-progress', h)
    },
    onProgress: (cb: (p: { jobId: string; stage: string; message: string; percent: number; counts?: { done: number; total: number }; outputPath?: string; error?: string }) => void) => {
      const h = (_: unknown, p: { jobId: string; stage: string; message: string; percent: number; counts?: { done: number; total: number }; outputPath?: string; error?: string }) => cb(p)
      ipcRenderer.on('rife:progress', h)
      return () => ipcRenderer.off('rife:progress', h)
    },
  },
  mcp: {
    list:      ()                                                         => ipcRenderer.invoke('mcp:list'),
    add:       (config: unknown)                                          => ipcRenderer.invoke('mcp:add', config),
    remove:    (name: string)                                             => ipcRenderer.invoke('mcp:remove', { name }),
    start:     (name: string)                                             => ipcRenderer.invoke('mcp:start', { name }),
    stop:      (name: string)                                             => ipcRenderer.invoke('mcp:stop', { name }),
    listTools: (name: string)                                             => ipcRenderer.invoke('mcp:list-tools', { name }),
    // ── One-click marketplace (curated static catalog → install → enable).
    catalog:   ()                                                         => ipcRenderer.invoke('mcp:catalog'),
    install:   (req: unknown)                                             => ipcRenderer.invoke('mcp:install', req),
    setServerEnabled: (name: string, enabled: boolean)                    => ipcRenderer.invoke('mcp:set-server-enabled', { name, enabled }),
    // ── In-process MCP server (Clauge-style auto-start; the server Tachi
    //    EXPOSES to external agents on 127.0.0.1:7421). Distinct from the
    //    methods above, which manage external MCP servers Tachi CONNECTS TO.
    status:           () =>
      ipcRenderer.invoke('mcp:status') as Promise<{ running: boolean; enabled: boolean; url: string | null; port: number | null }>,
    revealToken:      () =>
      ipcRenderer.invoke('mcp:reveal-token') as Promise<string | null>,
    rotateToken:      () =>
      ipcRenderer.invoke('mcp:rotate-token') as Promise<{ running: boolean; url: string | null; port: number | null }>,
    setEnabled:       (enabled: boolean) =>
      ipcRenderer.invoke('mcp:set-enabled', { enabled }) as Promise<{ running: boolean; enabled: boolean; url: string | null; port: number | null }>,
    copyClientConfig: () =>
      ipcRenderer.invoke('mcp:copy-client-config') as Promise<{ claudeDesktop: { mcpServers: Record<string, { url: string; headers: Record<string, string> }> } } | null>,
  },
  // ── Local OpenAI-compatible API server (the endpoint Tachi EXPOSES on
  //    127.0.0.1:11435/v1 so external tools can chat through FreeLLM +
  //    llama.cpp). Same reveal-only key discipline as the MCP block above.
  apiServer: {
    status: () =>
      ipcRenderer.invoke('api-server:status') as Promise<{ running: boolean; enabled: boolean; baseUrl: string | null; port: number | null }>,
    revealToken: () =>
      ipcRenderer.invoke('api-server:reveal-token') as Promise<string | null>,
    rotateToken: () =>
      ipcRenderer.invoke('api-server:rotate-token') as Promise<{ running: boolean; enabled: boolean; baseUrl: string | null; port: number | null }>,
    setEnabled: (enabled: boolean) =>
      ipcRenderer.invoke('api-server:set-enabled', { enabled }) as Promise<{ running: boolean; enabled: boolean; baseUrl: string | null; port: number | null }>,
    copySnippet: () =>
      ipcRenderer.invoke('api-server:copy-snippet') as Promise<{ baseUrl: string; curl: string; python: string } | null>,
  },
  // Sprint C1: shell.openExternal wraps the string url into the { url } object
  // expected by the typed router's Zod schema, preserving the renderer call-site
  // signature: window.tachi.shell.openExternal(url: string).
  // nookplot mining — real discover/solve/rewards via the runtime MiningManager.
  nookMining: {
    getTrackStats:  () => nookMiningBridge.getTrackStats({}),
    listChallenges: (opts?: { limit?: number }) => nookMiningBridge.listChallenges(opts ?? {}),
    getRewards:     () => nookMiningBridge.getRewards({}),
    solveOnce:      () => nookMiningBridge.solveOnce({}),
    startLoop:      (opts?: { maxCredits?: number }) => nookMiningBridge.startLoop(opts ?? {}),
    stopLoop:       () => nookMiningBridge.stopLoop({}),
    stats:          () => nookMiningBridge.stats({}),
  },
  // App-wide Base wallet — shared signer for nookplot, x402, and other integrations.
  wallet: {
    getInfo:        () => walletBridge.getInfo({}),
    getBalances:    () => walletBridge.getBalances({}),
    create:         () => walletBridge.create({}),
    importRaw:      (privateKey: string) => walletBridge.importRaw({ privateKey }),
    importKeystore: (json: string, password: string) => walletBridge.importKeystore({ json, password }),
    exportKeystore: (password: string) => walletBridge.exportKeystore({ password }),
    forget:         () => walletBridge.forget({}),
    signMessage:    (message: string) => walletBridge.signMessage({ message }),
    sendTransaction: (tx: { to: string; value?: string; data?: string; amountEth?: string }) => walletBridge.sendTransaction(tx),
    // darksol foundation — multi-wallet / multi-chain / multi-token + agent limits.
    listWallets:          () => walletBridge.listWallets({}),
    setActiveAgentWallet: (name: string) => walletBridge.setActiveAgentWallet({ name }),
    createAgentWallet:    (name: string) => walletBridge.createAgentWallet({ name }),
    importAgentWallet:    (name: string, privateKey: string) => walletBridge.importAgentWallet({ name, privateKey }),
    forgetAgentWallet:    (name: string) => walletBridge.forgetAgentWallet({ name }),
    walletBalances:       (args: { kind: 'app' | 'agent'; name?: string; chainId?: number }) => walletBridge.walletBalances(args),
    sendToken:            (args: { kind: 'app' | 'agent'; name?: string; chainId: number; tokenSymbol: string; to: string; amount: string }) => walletBridge.sendToken(args),
    fundAgentWallet:      (args: { toAgent: string; chainId: number; amountEth: string }) => walletBridge.fundAgentWallet(args),
    getAgentLimits:       (name: string) => walletBridge.getAgentLimits({ name }),
    setAgentLimits:       (args: { name: string; limits: { maxPerTradeEth: string; dailyLimitEth: string; dryRun: boolean; allowlist: string[] } }) => walletBridge.setAgentLimits(args),
    listNetworks:         () => walletBridge.listNetworks({}),
    listTx:               (limit?: number) => walletBridge.listTx({ limit }),
    verifyTxLog:          () => walletBridge.verifyTxLog({}),
    onChanged: (cb: (info: unknown) => void) => {
      const handler = (_: unknown, info: unknown) => cb(info)
      ipcRenderer.on('wallet:changed', handler)
      return () => ipcRenderer.off('wallet:changed', handler)
    },
    // S6: real-tx confirmation gate. Main asks the renderer to confirm a real
    // send/transfer before signing; the renderer replies with the user's answer.
    onConfirmRequest: (cb: (req: { id: number; summary: { kind: string; to: string; amount: string; symbol: string; chainId?: number } }) => void) => {
      const handler = (_: unknown, req: { id: number; summary: { kind: string; to: string; amount: string; symbol: string; chainId?: number } }) => cb(req)
      ipcRenderer.on('wallet:confirm-request', handler)
      return () => ipcRenderer.off('wallet:confirm-request', handler)
    },
    confirmRespond: (id: number, approved: boolean) => ipcRenderer.send('wallet:confirm-response', { id, approved }),
  },
  // nookplot — first-class integration backed by @nookplot/runtime in main.
  nook: {
    get: (path: string, apiKey?: string) => nookBridge.get({ path, apiKey }),
    getStatus:        () => nookBridge.getStatus({}),
    configure:        (input: { apiKey?: string; privateKey?: string }) => nookBridge.configure(input),
    clearCredentials: () => nookBridge.clearCredentials({}),
    generateWallet:   () => nookBridge.generateWallet({}),
    register:         (input: { name?: string; description?: string }) => nookBridge.register(input),
    registerInApp:    (input: { name: string; description?: string; model?: { provider: string; name: string }; capabilities?: string[] }) => nookBridge.registerInApp(input),
    connect:          () => nookBridge.connect({}),
    disconnect:       () => nookBridge.disconnect({}),
    getProfile:       () => nookBridge.getProfile({}),
    listBounties:     (opts?: { limit?: number; community?: string }) => nookBridge.listBounties(opts ?? {}),
    claimBounty:      (id: string) => nookBridge.claimBounty({ id }),
    submitWork:       (id: string, description: string, deliverables: string[]) => nookBridge.submitWork({ id, description, deliverables }),
    listListings:     (opts?: { query?: string; limit?: number }) => nookBridge.listListings(opts ?? {}),
    goOnline:         (provider?: string, model?: string) => nookBridge.goOnline({ provider, model }),
    setBrain:         (provider: string, model?: string) => nookBridge.setBrain({ provider, model }),
    listBrainProviders: () => nookBridge.listBrainProviders({}),
    goOffline:        () => nookBridge.goOffline({}),
    getApprovals:     () => nookBridge.getApprovals({}),
    approveAction:    (id: string) => nookBridge.approveAction({ id }),
    rejectAction:     (id: string) => nookBridge.rejectAction({ id }),
    getActivity:      (limit?: number) => nookBridge.getActivity({ limit }),
    mcpStatus:        () => nookBridge.mcpStatus({}),
    mcpEnable:        () => nookBridge.mcpEnable({}),
    mcpDisable:       () => nookBridge.mcpDisable({}),
    darksolMcpStatus:  () => nookBridge.darksolMcpStatus({}),
    darksolMcpEnable:  () => nookBridge.darksolMcpEnable({}),
    darksolMcpDisable: () => nookBridge.darksolMcpDisable({}),
    exportKeystore:   (password: string) => nookBridge.exportKeystore({ password }),
    importKeystore:   (json: string, password: string) => nookBridge.importKeystore({ json, password }),
    onStatus: (cb: (status: unknown) => void) => {
      const handler = (_: unknown, s: unknown) => cb(s)
      ipcRenderer.on('nook:status', handler)
      return () => ipcRenderer.off('nook:status', handler)
    },
    onEvent: (cb: (event: unknown) => void) => {
      const handler = (_: unknown, e: unknown) => cb(e)
      ipcRenderer.on('nook:event', handler)
      return () => ipcRenderer.off('nook:event', handler)
    },
  },
  // nookplot write-actions — post/apply bounties, submit work, hire services.
  nookActions: {
    postBounty:  (i: { title: string; description: string; community: string; token: string; amount: string; deadline: number }) => nookActionsBridge.postBounty(i),
    applyBounty: (i: { id: string; message: string }) => nookActionsBridge.applyBounty(i),
    submitWork:  (i: { id: string; description: string; deliverables?: string[] }) => nookActionsBridge.submitWork(i),
    hireService: (i: { listingId: string; terms: string; deadline: number; token?: string; amount?: string }) => nookActionsBridge.hireService(i),
  },
  // nookplot network/knowledge — feed, publish, communities, leaderboard, agent search, follow.
  nookNetwork: {
    getFeed:         (opts?: { limit?: number; community?: string; sort?: 'hot' | 'new' | 'top' | 'reputation' }) => nookNetworkBridge.getFeed(opts ?? {}),
    getPost:         (cid: string) => nookNetworkBridge.getPost({ cid }),
    publishPost:     (input: { title: string; body: string; community: string; tags?: string[] }) => nookNetworkBridge.publishPost(input),
    listCommunities: (opts?: { limit?: number }) => nookNetworkBridge.listCommunities(opts ?? {}),
    getLeaderboard:  (opts?: { limit?: number }) => nookNetworkBridge.getLeaderboard(opts ?? {}),
    searchAgents:    (query: string, limit?: number) => nookNetworkBridge.searchAgents({ query, limit }),
    follow:          (address: string) => nookNetworkBridge.follow({ address }),
  },
  // nookplot messaging — inbox DMs + group channels.
  nookMessaging: {
    inboxList:       (opts?: { unreadOnly?: boolean; from?: string; limit?: number }) => nookMessagingBridge.inboxList(opts ?? {}),
    unreadCount:     () => nookMessagingBridge.unreadCount({}),
    sendDM:          (toAddress: string, content: string) => nookMessagingBridge.sendDM({ toAddress, content }),
    markRead:        (messageId: string) => nookMessagingBridge.markRead({ messageId }),
    listChannels:    (opts?: { limit?: number; isPublic?: boolean; channelType?: string }) => nookMessagingBridge.listChannels(opts ?? {}),
    channelMessages: (channelId: string, limit?: number, before?: string) => nookMessagingBridge.channelMessages({ channelId, limit, before }),
    channelMembers:  (channelId: string) => nookMessagingBridge.channelMembers({ channelId }),
    sendChannel:     (channelId: string, content: string) => nookMessagingBridge.sendChannel({ channelId, content }),
    joinChannel:     (channelId: string) => nookMessagingBridge.joinChannel({ channelId }),
    leaveChannel:    (channelId: string) => nookMessagingBridge.leaveChannel({ channelId }),
  },
  shell: {
    openExternal: (url: string) => shellBridge.openExternal({ url }),
    // Bug 3: reveal a file in the OS file explorer (Explorer on Windows, Finder on macOS).
    // Calls shell.showItemInFolder on the main process side.
    revealInFolder: (path: string) => shellBridge.revealInFolder({ path }),
  },
  theme: {
    apply: (theme: string) => ipcRenderer.invoke('theme:apply', { theme }),
  },
  // app-control: the TACHI harness drives curated app actions (theme, navigate,
  // providers) via main→renderer. The renderer subscribes with onExec and replies
  // with result. Action allowlist (renderer-side) is the security boundary.
  appControl: {
    onExec: (cb: (p: { id: string; action: string; args: Record<string, unknown> }) => void) => {
      const handler = (_: unknown, p: { id: string; action: string; args: Record<string, unknown> }) => cb(p)
      ipcRenderer.on('app-control:exec', handler)
      return () => ipcRenderer.off('app-control:exec', handler)
    },
    result: (payload: { id: string; ok: boolean; result?: unknown; error?: string }) =>
      ipcRenderer.send('app-control:result', payload),
  },
  // Custom window controls (replaces Windows titleBarOverlay so we can render
  // brutalist min/max/close buttons inline in the renderer).
  window: {
    minimize:       () => ipcRenderer.invoke('window:minimize'),
    maximizeToggle: () => ipcRenderer.invoke('window:maximize-toggle'),
    close:          () => ipcRenderer.invoke('window:close'),
    getState:       () => ipcRenderer.invoke('window:get-state') as Promise<{ maximized: boolean; transparent: boolean }>,
    onStateChanged: (cb: (s: { maximized: boolean }) => void) => {
      const handler = (_: unknown, s: { maximized: boolean }) => cb(s)
      ipcRenderer.on('window:state-changed', handler)
      return () => ipcRenderer.off('window:state-changed', handler)
    },
  },
  overlay: {
    getSourceId:   () => ipcRenderer.invoke('overlay:get-source-id'),
    reportCapture: (dataUrl: string) => ipcRenderer.invoke('overlay:capture-done', { dataUrl }),
    captureRegion: (rect: { x: number; y: number; w: number; h: number }) =>
      ipcRenderer.invoke('overlay:capture-region', rect),
    cancel: () => ipcRenderer.invoke('overlay:cancel'),
    onCaptureDone: (cb: (data: { dataUrl: string }) => void) => {
      const handler = (_: unknown, data: { dataUrl: string }) => cb(data)
      ipcRenderer.on('overlay:capture-done', handler)
      return () => ipcRenderer.off('overlay:capture-done', handler)
    },
  },
  connectors: {
    list:       () => ipcRenderer.invoke('connectors:list'),
    disconnect: (id: string) => ipcRenderer.invoke('connectors:disconnect', { id }),
  },
  networkAudit: {
    list:  (limit?: number) => ipcRenderer.invoke('network-audit:list', { limit }),
    clear: ()               => ipcRenderer.invoke('network-audit:clear'),
  },
  whisper: {
    checkInstalled: () => ipcRenderer.invoke('whisper:check-installed'),
    listModels:     () => ipcRenderer.invoke('whisper:list-models'),
    downloadModel:  (modelName?: string) => ipcRenderer.invoke('whisper:download-model', { modelName }),
    // STOP an in-flight model download — PAUSE semantics, `.part` kept, a
    // re-download resumes. `cancelled:false` = nothing was pausable.
    cancelDownload: (modelName: string) => ipcRenderer.invoke('whisper:cancel-download', { modelName }),
    // Delete one downloaded ggml weight (the whisper-cli binary is untouched).
    removeModel:    (modelName: string) => ipcRenderer.invoke('whisper:remove-model', { modelName }),
    transcribe:     (audioBase64: string, modelName?: string, lang?: string) =>
      ipcRenderer.invoke('whisper:transcribe', { audioBase64, modelName, lang }),
    onProgress: (cb: (event: unknown) => void) => {
      const handler = (_: unknown, event: unknown) => cb(event)
      ipcRenderer.on('whisper:progress', handler)
      return () => ipcRenderer.off('whisper:progress', handler)
    },
    install: () => ipcRenderer.invoke('whisper:install'),
    onInstallProgress: (cb: (event: unknown) => void) => {
      const handler = (_: unknown, event: unknown) => cb(event)
      ipcRenderer.on('whisper:install-progress', handler)
      return () => ipcRenderer.off('whisper:install-progress', handler)
    },
  },
  nodes: {
    saveRefImage: (dataUrl: string, fileName?: string) =>
      ipcRenderer.invoke('nodes:save-ref-image', { dataUrl, fileName }),
    saveFlow: (flowName: string, json: string) =>
      ipcRenderer.invoke('nodes:save-flow', { flowName, json }),
    listFlows: () =>
      ipcRenderer.invoke('nodes:list-flows'),
    loadFlow: (filename: string) =>
      ipcRenderer.invoke('nodes:load-flow', { filename }),
    deleteFlow: (filename: string) =>
      ipcRenderer.invoke('nodes:delete-flow', { filename }),
    renameFlow: (filename: string, newName: string) =>
      ipcRenderer.invoke('nodes:rename-flow', { filename, newName }),
    // Revisions (A1): every save leaves a snapshot under Flows/.history — list
    // them, read one back, or restore one as the current flow file.
    listRevisions: (filename: string) =>
      ipcRenderer.invoke('nodes:list-revisions', { filename }),
    readRevision: (filename: string, ts: number) =>
      ipcRenderer.invoke('nodes:read-revision', { filename, ts }),
    restoreRevision: (filename: string, ts: number) =>
      ipcRenderer.invoke('nodes:restore-revision', { filename, ts }),
    // Read-only folder existence probe for the self-healing flow-doctor
    // (NODES-RESEARCH #4). Returns { existing: { <path>: boolean } }.
    pathsExist: (paths: string[]) =>
      ipcRenderer.invoke('nodes:paths-exist', { paths }),
    // Compile + EXECUTE the visual graph as a real agent-kit Network.
    runGraph: (flow: unknown, input: string) =>
      ipcRenderer.invoke('graph:run', { flow, input }),
    // Run JUST one node (the "execute step" affordance): resolves the node's
    // prompt/tokens from upstream `lastOutput`s in `flow`, runs only it.
    //
    // `runSeed` is the RUN-ALL invocation's entropy. Omitted by a lone RUN
    // button (a single node stays reproducible); passed by the in-order Run-all
    // loop so its stages get the same decorrelated per-stage seeds the
    // one-network mode already derives (deriveStageSeed).
    runNode: (flow: unknown, nodeId: string, runSeed?: string) =>
      ipcRenderer.invoke('graph:run-node', { flow, nodeId, ...(runSeed ? { runSeed } : {}) }),
    // Live execution: fires as the run hands control to each node ({nodeId})
    // and once with {nodeId:null} when the run ends.
    onNodeActive: (cb: (p: { nodeId: string | null }) => void) => {
      const handler = (_: unknown, p: { nodeId: string | null }) => cb(p)
      ipcRenderer.on('graph:node-active', handler)
      return () => ipcRenderer.off('graph:node-active', handler)
    },
    // BATCH35 lane B — inbound webhook triggers (TradingView alerts). The route
    // only exists on the local API server while a canvas node has armed it, and
    // it carries its own per-hook secret (never the app's /v1 bearer). Inbound
    // SIGNAL only: an alert becomes text on a node, never an order.
    webhooks: {
      status: () =>
        ipcRenderer.invoke('webhooks:status'),
      arm: (hookId: string, source: string) =>
        ipcRenderer.invoke('webhooks:arm', { hookId, source }),
      disarm: (hookId: string) =>
        ipcRenderer.invoke('webhooks:disarm', { hookId }),
      forget: (hookId: string) =>
        ipcRenderer.invoke('webhooks:forget', { hookId }),
      rotate: (hookId: string, source: string) =>
        ipcRenderer.invoke('webhooks:rotate', { hookId, source }),
      recent: (hookId: string) =>
        ipcRenderer.invoke('webhooks:recent', { hookId }),
      onAlert: (cb: (a: { hookId: string; source: string; receivedAt: number; text: string; json?: unknown; bytes: number }) => void) => {
        const handler = (_: unknown, a: { hookId: string; source: string; receivedAt: number; text: string; json?: unknown; bytes: number }) => cb(a)
        ipcRenderer.on('webhooks:alert', handler)
        return () => ipcRenderer.off('webhooks:alert', handler)
      },
    },
  },
  // Design tab — stream a self-contained HTML design from a prompt + brand preset.
  // Electron 32+ removed File.path from the renderer; webUtils.getPathForFile
  // (preload-only) is the sanctioned way to resolve a dropped/picked File's
  // absolute disk path. Returns '' for synthetic Files with no disk backing.
  files: {
    pathFor: (file: File): string => {
      try { return webUtils.getPathForFile(file) } catch { return '' }
    },
  },
  design: {
    // ── THE VIDEO ENCODER ─────────────────────────────────────────────────────
    // Fetched from Remotion's official npm package on an explicit click, never
    // bundled: its FFmpeg build states its own licence forbids redistribution,
    // so shipping it would make us the distributor. `state` is what lets the UI
    // quote the size before asking. See remotion-binaries-installer.ts.
    encoderState: () => ipcRenderer.invoke('remotion-binaries:state') as Promise<{
      installed: boolean; dir: string | null; fromDevTree: boolean
      version: string; packageName: string; approxBytes: number | null
    }>,
    installEncoder: () => ipcRenderer.invoke('remotion-binaries:install') as Promise<{ ok: boolean; dir?: string; error?: string }>,
    removeEncoder: () => ipcRenderer.invoke('remotion-binaries:remove') as Promise<{ ok: boolean; error?: string }>,
    onEncoderProgress: (cb: (p: { stage: string; message: string; percent: number; bytes?: number; totalBytes?: number }) => void) => {
      const h = (_e: unknown, p: { stage: string; message: string; percent: number; bytes?: number; totalBytes?: number }) => cb(p)
      ipcRenderer.on('remotion-binaries:progress', h)
      return () => ipcRenderer.removeListener('remotion-binaries:progress', h)
    },
    generate: (payload: unknown) => ipcRenderer.invoke('design:generate', payload),
    clarify: (payload: unknown) => ipcRenderer.invoke('design:clarify', payload),
    extractBrand: (url: string) => ipcRenderer.invoke('design:extract-brand', { url }) as Promise<{ ok: boolean; brand?: { url: string; siteName: string; colors: string[]; fonts: string[]; logo?: string; copy: string[] }; markdown?: string; error?: string }>,
    abort: (requestId: string) => ipcRenderer.invoke('design:abort', { requestId }),
    // Stash preview HTML for the tachi-preview:// scheme (own CSP → inline scripts run).
    setPreview: (id: string, html: string) => ipcRenderer.invoke('design:set-preview', { id, html }),
    pickFolder: () => ipcRenderer.invoke('design:pick-folder'),
    // Read a folder attached by DROP (or path) — no native dialog.
    readFolder: (folder: string) => ipcRenderer.invoke('design:read-folder', { folder }),
    saveFile: (payload: { project?: string; name?: string; content: string }) => ipcRenderer.invoke('design:save-file', payload),
    // Attach a media file (video/audio/gif) as a design asset. Preferred input
    // is an absolute path (zero-copy); bytes are the fallback for File objects
    // without a resolvable disk path.
    addAsset: (payload: { path?: string; name?: string; bytes?: ArrayBuffer }) =>
      ipcRenderer.invoke('design:add-asset', payload) as Promise<{ ok: true; name: string; relPath: string; bytes: number } | { ok: false; error: string }>,
    reveal: (project?: string) => ipcRenderer.invoke('design:reveal', { project }),
    getBase: () => ipcRenderer.invoke('design:get-base'),
    setBase: () => ipcRenderer.invoke('design:set-base'),
    // Export an animation composition to a real H.264 MP4 (managed Chromium +
    // @remotion/renderer). First call downloads Chromium on demand.
    renderMp4: (payload: { code: string; name?: string; targetHeight?: number }) => ipcRenderer.invoke('design:render-mp4', payload),
    // Synthesize a voiceover line (piper TTS) into the design-audio dir; the
    // returned file name goes into the composition via staticFile(file).
    synthesizeVo: (payload: { voiceId: string; text: string; name?: string }) => ipcRenderer.invoke('design:synthesize-vo', payload),
    // Servable audio files currently in design-audio (newest first).
    listAudio: () => ipcRenderer.invoke('design:list-audio'),
    // Copy an existing audio artifact into design-audio (Nodes/Media bridge).
    importAudio: (path: string) => ipcRenderer.invoke('design:import-audio', { path }),
    // Export a page design to PNG or PDF (hidden BrowserWindow capture — free, no Chromium download).
    exportImage: (payload: { html: string; name?: string; format: 'png' | 'pdf' }) => ipcRenderer.invoke('design:export-image', payload),
    // Fires per streamed text chunk: { requestId, chunk }.
    onDelta: (cb: (p: { requestId: string; chunk: string }) => void) => {
      const handler = (_: unknown, p: { requestId: string; chunk: string }) => cb(p)
      ipcRenderer.on('design:delta', handler)
      return () => ipcRenderer.off('design:delta', handler)
    },
    // MP4 export progress: { stage, percent, message }. Also relays the Chromium
    // install-progress events emitted during a first-run download.
    onRenderProgress: (cb: (p: { stage: string; percent: number; message: string }) => void) => {
      const r = (_: unknown, p: { stage: string; percent: number; message: string }) => cb(p)
      const c = (_: unknown, p: { stage: string; percent: number; message: string }) => cb({ stage: 'browser', percent: p.percent, message: p.message })
      ipcRenderer.on('design:render-progress', r)
      ipcRenderer.on('chromium:install-progress', c)
      return () => { ipcRenderer.off('design:render-progress', r); ipcRenderer.off('chromium:install-progress', c) }
    },
  },
  freellmapi: {
    listFallbackModels: () =>
      ipcRenderer.invoke('freellmapi:list-fallback-models'),
    // What the relay actually carries, so the Free Providers card can stop
    // asserting platforms it merely expects to be there.
    listPlatforms: () =>
      ipcRenderer.invoke('freellmapi:list-platforms'),
    setSortMode: (mode: 'intelligence' | 'speed' | 'budget') =>
      ipcRenderer.invoke('freellmapi:set-sort-mode', { mode }),
  },
  // Smart-router telemetry (read-only): per-tier routed counts + top bandit arms.
  routerStats: {
    get: () => ipcRenderer.invoke('router:stats') as Promise<{
      routes: { SIMPLE: number; MID: number; TOP: number }
      arms: Array<{ bucket: string; model: string; ok: number; err: number; mean: number }>
      // Compactor savings (headroom-inspired) — rides the same observability channel.
      compaction: { charsSaved: number; tokensSaved: number; reductions: number }
      // Provider prompt-cache hits (CACHE-ALIGN 2026-07-21) — reported:false → UI "--".
      cache: { cachedInputTokens: number; totalInputTokens: number; hitRatio: number | null; samples: number; reported: boolean }
    }>,
  },
  // llama.cpp — truly-local LLM sidecar (Vitalik-aligned: SHA-verified
  // binary + SHA-verified GGUF weights, zero external egress at chat time).
  // Surface mirrors freellmapi's: catalog/status reads, install/start/stop/
  // download lifecycle actions, and a progress push channel.
  sdCpp: {
    catalog: () => ipcRenderer.invoke('sd-cpp:catalog'),
    status: () => ipcRenderer.invoke('sd-cpp:status'),
    install: () => ipcRenderer.invoke('sd-cpp:install'),
    // Distinct from install, which short-circuits when a binary exists.
    updateEngine: () => ipcRenderer.invoke('sd-cpp:update-engine'),
    downloadModel: (id: string) => ipcRenderer.invoke('sd-cpp:download-model', { id }),
    // Stop = PAUSE: the component .part files are kept for resume.
    cancelDownload: (id: string) => ipcRenderer.invoke('sd-cpp:cancel-download', { id }),
    removeModel: (id: string) => ipcRenderer.invoke('sd-cpp:remove-model', { id }),
    // Adapters (LoRA / textual inversion / VAE). The LISTING rides on status();
    // these are the two lifecycle verbs.
    downloadAdapter: (id: string) => ipcRenderer.invoke('sd-cpp:download-adapter', { id }),
    removeAdapter: (id: string) => ipcRenderer.invoke('sd-cpp:remove-adapter', { id }),
    // A CURATED SPEED PACK (the 4-step distill LoRAs of one video row). The
    // listing rides on catalog(); this is the only lifecycle verb it has.
    downloadSpeedAdapter: (id: string) => ipcRenderer.invoke('sd-cpp:download-speed-adapter', { id }),
    // A CURATED UPSCALER (one ESRGAN file). Same shape as the speed pack: the
    // listing (with `installed`) rides on catalog(), and this is its one
    // lifecycle verb.
    downloadUpscaler: (id: string) => ipcRenderer.invoke('sd-cpp:download-upscaler', { id }),
    // THE REFERENCE-IMAGE WEIGHTS (IP-Adapter): adapter + the CLIP-Vision encoder
    // it requires. The listing (with `installed` and the shared-bytes discount)
    // rides on catalog(), and this is its one lifecycle verb.
    downloadIpAdapter: (id: string) => ipcRenderer.invoke('sd-cpp:download-ip-adapter', { id }),
    generate: (input: unknown) => ipcRenderer.invoke('sd-cpp:generate', input),
    generateVideo: (input: unknown) => ipcRenderer.invoke('sd-cpp:generate-video', input),
    // `-M upscale` on a file already on disk. A DIFFERENT MODE, not a generation:
    // it loads no checkpoint and takes no prompt, so it has its own verb rather
    // than a flag on generate(). Progress rides the shared gen-progress channel,
    // and cancelGeneration() stops it (one sd-cli, one child, one button).
    upscale: (input: { path: string; upscalerId?: string; repeats?: number; tileSize?: number }) =>
      ipcRenderer.invoke('sd-cpp:upscale', input),
    // Stop = KILL: unlike cancelDownload there is no partial artifact to resume.
    cancelGeneration: () => ipcRenderer.invoke('sd-cpp:cancel-generation'),
    onInstallProgress: (cb: (p: { stage: string; message: string; percent: number; bytes?: number; totalBytes?: number; speedBytesPerSec?: number; etaSec?: number }) => void) => {
      const h = (_: unknown, p: { stage: string; message: string; percent: number; bytes?: number; totalBytes?: number; speedBytesPerSec?: number; etaSec?: number }) => cb(p)
      ipcRenderer.on('sd-cpp:install-progress', h)
      return () => ipcRenderer.off('sd-cpp:install-progress', h)
    },
    // `stage` is the run's LAST WORD (absent on every mid-run tick): main sends
    // exactly one `done`/`error` on this channel per run, so a listener that is
    // not the awaiting caller still learns the render ended.
    onGenProgress: (cb: (p: { step: number | null; total: number | null; percent: number; message: string; heartbeat: boolean; phase?: 'starting' | 'loading' | 'sampling' | 'decoding'; stage?: 'done' | 'error'; kind?: 'image' | 'video'; elapsedMs?: number; preview?: string }) => void) => {
      const h = (_: unknown, p: { step: number | null; total: number | null; percent: number; message: string; heartbeat: boolean; phase?: 'starting' | 'loading' | 'sampling' | 'decoding'; stage?: 'done' | 'error'; kind?: 'image' | 'video'; elapsedMs?: number; preview?: string }) => cb(p)
      ipcRenderer.on('sd-cpp:gen-progress', h)
      return () => ipcRenderer.off('sd-cpp:gen-progress', h)
    },
  },
  // Bulk export / backup (Settings → Advanced). Explicit path/dir = e2e path.
  backup: {
    save: (json: string, path?: string) => ipcRenderer.invoke('backup:save', { json, path }),
    load: (path?: string) => ipcRenderer.invoke('backup:load', { path }),
    exportMd: (files: Array<{ name: string; content: string }>, dir?: string) => ipcRenderer.invoke('backup:export-md', { files, dir }),
  },
  // Local folder RAG (MiniLM embeddings in-process; index lives in userData).
  rag: {
    index: (root: string, force?: boolean) => ipcRenderer.invoke('rag:index', { root, force }),
    search: (root: string, query: string, k?: number) => ipcRenderer.invoke('rag:search', { root, query, k }),
    status: (root: string) => ipcRenderer.invoke('rag:status', { root }),
  },
  // App-wide sidecar health check (doctor-service): executes every external
  // binary with a probe arg and classifies ok/missing/broken/timeout/error.
  doctor: {
    run: () => ipcRenderer.invoke('doctor:run'),
  },
  // Full-text chat search: SQLite FTS5 (wasm) index over the JSON archive.
  chatArchive: {
    search: (query: string, limit?: number) => ipcRenderer.invoke('chat-archive:search', { query, limit }),
    status: () => ipcRenderer.invoke('chat-archive:status'),
  },
  // Global quick-ask launcher window (see quick-ask-service).
  quickask: {
    ask: (prompt: string) => ipcRenderer.invoke('quickask:ask', { prompt }),
    hide: () => ipcRenderer.invoke('quickask:hide'),
    toggle: () => ipcRenderer.invoke('quickask:toggle'),
    openApp: () => ipcRenderer.invoke('quickask:open-app'),
    /** Cancel the streaming run without closing the bar (Esc). */
    abort: () => ipcRenderer.invoke('quickask:abort'),
    /** Explicit New (Ctrl+N): drop the thread + the replayed exchange. */
    newSession: () => ipcRenderer.invoke('quickask:new'),
    /** Pinned = losing focus no longer hides the window. */
    setPinned: (pinned: boolean) => ipcRenderer.invoke('quickask:set-pinned', { pinned }),
    /** Ctrl+J: carry the whole thread into a fresh main-window chat. */
    handoff: () => ipcRenderer.invoke('quickask:handoff'),
    /** Pull the shown-payload on mount (the first summon fires before we subscribe). */
    sync: () => ipcRenderer.invoke('quickask:sync'),
    /** Selection auto-capture toggle (quickAskAutoCapture). */
    setAutoCapture: (enabled: boolean) => ipcRenderer.invoke('quickask:set-auto-capture', { enabled }),
    onShown: (cb: (payload: {
      turns: Array<{ role: 'user' | 'assistant'; content: string }>
      lastExchange: { prompt: string; answer: string; ts: number } | null
      pinned: boolean
      history: string[]
      busy: boolean
      context: { kind: 'clipboard' | 'selection'; text: string; preview: string; chars: number; armed: boolean } | null
      autoCapture: boolean
    }) => void) => {
      const h = (_: unknown, payload: unknown) => cb(payload as never)
      ipcRenderer.on('quickask:shown', h)
      return () => ipcRenderer.off('quickask:shown', h)
    },
    /** Streamed answer deltas (mirrors chat:chunk), batched ~150ms in main. */
    onChunk: (cb: (chunk: { type: 'delta'; text: string } | { type: 'done'; text: string } | { type: 'error'; error: string }) => void) => {
      const h = (_: unknown, chunk: unknown) => cb(chunk as never)
      ipcRenderer.on('quickask:chunk', h)
      return () => ipcRenderer.off('quickask:chunk', h)
    },
    /** Main-window side: the thread handed over from the bar (Ctrl+J). */
    onHandoff: (cb: (payload: { turns: Array<{ role: 'user' | 'assistant'; content: string }> }) => void) => {
      const h = (_: unknown, payload: unknown) => cb(payload as never)
      ipcRenderer.on('quickask:handoff', h)
      return () => ipcRenderer.off('quickask:handoff', h)
    },
  },
  piper: {
    catalog: () => ipcRenderer.invoke('piper:catalog'),
    status: () => ipcRenderer.invoke('piper:status'),
    install: () => ipcRenderer.invoke('piper:install'),
    downloadVoice: (id: string) => ipcRenderer.invoke('piper:download-voice', { id }),
    // STOP an in-flight voice download — PAUSE semantics on the `.onnx` weight,
    // `.part` kept, a re-download resumes. `cancelled:false` = nothing pausable.
    cancelDownload: (id: string) => ipcRenderer.invoke('piper:cancel-download', { id }),
    removeVoice: (id: string) => ipcRenderer.invoke('piper:remove-voice', { id }),
    synthesize: (input: unknown) => ipcRenderer.invoke('piper:synthesize', input),
    onInstallProgress: (cb: (p: { stage: string; message: string; percent: number; bytes?: number; totalBytes?: number; speedBytesPerSec?: number; etaSec?: number }) => void) => {
      const h = (_: unknown, p: { stage: string; message: string; percent: number; bytes?: number; totalBytes?: number; speedBytesPerSec?: number; etaSec?: number }) => cb(p)
      ipcRenderer.on('piper:install-progress', h)
      return () => ipcRenderer.off('piper:install-progress', h)
    },
  },
  // Kokoro — studio-quality local TTS (kokoro-js in-process; see kokoro-tts.ts).
  kokoro: {
    status: () => ipcRenderer.invoke('kokoro:status'),
    // One-time ~92MB model download (the ONLY call that egresses; private-mode gated).
    ensure: () => ipcRenderer.invoke('kokoro:ensure'),
    synthesize: (input: { text: string; voice: string }) => ipcRenderer.invoke('kokoro:synthesize', input),
    // Persist WAV bytes into <userData>/media/kokoro (tachi-media:// servable);
    // register the returned path in media.store so it shows in Artifacts.
    saveWav: (input: { b64: string; name: string }) => ipcRenderer.invoke('media:save-wav', input),
    onProgress: (cb: (p: { progress: number; file?: string }) => void) => {
      const h = (_: unknown, p: { progress: number; file?: string }) => cb(p)
      ipcRenderer.on('kokoro:progress', h)
      return () => ipcRenderer.off('kokoro:progress', h)
    },
  },
  // Media-scoped file helpers (channel media:save-wav lives in kokoro-tts.ts).
  // The renderer consumers call window.tachi.media.saveWav — keep this namespace.
  media: {
    saveWav: (input: { b64: string; name: string }) => ipcRenderer.invoke('media:save-wav', input),
  },
  llamaCpp: {
    catalog: () => ipcRenderer.invoke('llama-cpp:catalog'),
    status:  () => ipcRenderer.invoke('llama-cpp:status'),
    gpu:     () => ipcRenderer.invoke('llama-cpp:gpu') as Promise<{ vendor: string; name: string; vramMB: number; vramIsFloor: boolean; backend: string; source: string; gpuBuildInstalled: boolean }>,
    install: (assetId?: string) =>
      ipcRenderer.invoke('llama-cpp:install', { assetId }),
    downloadModel: (modelId: string) =>
      ipcRenderer.invoke('llama-cpp:download-model', { modelId }),
    downloadUrl: (id: string, url: string) =>
      ipcRenderer.invoke('llama-cpp:download-url', { id, url }),
    cancelDownload: (id: string) =>
      ipcRenderer.invoke('llama-cpp:cancel-download', { id }),
    removeModel: (modelId: string) =>
      ipcRenderer.invoke('llama-cpp:remove-model', { modelId }),
    start: (opts: { modelId: string; contextSize?: number; nGpuLayers?: number; threads?: number; profile?: 'quality' | 'balanced' | 'speed'; cacheType?: 'f16' | 'q8_0' | 'q4_0' }) =>
      ipcRenderer.invoke('llama-cpp:start', opts),
    stop: () => ipcRenderer.invoke('llama-cpp:stop'),
    logs: (lines?: number) => ipcRenderer.invoke('llama-cpp:logs', { lines }),
    onInstallProgress: (cb: (event: unknown) => void) => {
      const handler = (_: unknown, event: unknown) => cb(event)
      ipcRenderer.on('llama-cpp:install-progress', handler)
      return () => ipcRenderer.off('llama-cpp:install-progress', handler)
    },
  },
  // Resumable download manager (UX #11) — pause/resume/cancel for large model
  // downloads + the live queue the DownloadStrip renders from any tab.
  downloads: {
    list:    () => ipcRenderer.invoke('downloads:list'),
    pause:   (id: string) => ipcRenderer.invoke('downloads:pause',   { id }),
    resume:  (id: string) => ipcRenderer.invoke('downloads:resume',  { id }),
    cancel:  (id: string) => ipcRenderer.invoke('downloads:cancel',  { id }),
    dismiss: (id: string) => ipcRenderer.invoke('downloads:dismiss', { id }),
    onChanged: (cb: (items: unknown[]) => void) => {
      const handler = (_: unknown, items: unknown[]) => cb(items)
      ipcRenderer.on('downloads:changed', handler)
      return () => ipcRenderer.off('downloads:changed', handler)
    },
  },
  catalog: {
    hardware:  () => ipcRenderer.invoke('catalog:hardware'),
    curated:   () => ipcRenderer.invoke('catalog:curated'),
    installed: () => ipcRenderer.invoke('catalog:installed'),
    searchHf:  (query: string) => ipcRenderer.invoke('catalog:search-hf', { query }),
  },
  // HuggingFace — a WEIGHTS HOST, like Civitai. The token itself lives in the
  // keychain and is saved/removed through the generic settings key channels;
  // the only HF-specific channel is the validation ping, which answers with an
  // account NAME and never with the token.
  hf: {
    validateToken: (token: string) => ipcRenderer.invoke('hf:validate-token', { token }),
  },
  // Civitai — a WEIGHTS SOURCE, not a provider. `search` is cursor-paginated
  // (never page) and every row is already gated + verdicted in main; `install`
  // re-checks both server-side and ignores everything in the row except the
  // model/version ids.
  civitai: {
    search: (opts: {
      query?: string
      cursor?: string | null
      types?: string[]
      baseModels?: string[]
      sort?: string
      period?: string
      limit?: number
    } = {}) => ipcRenderer.invoke('civitai:search', opts),
    // ONE model, read to be read: the description, the creator and the sibling
    // versions a grid row cannot carry. `versionId` only decides which version
    // leads and whose images the gallery shows — it grants nothing, and main
    // re-gates and re-verdicts everything either way.
    detail: (opts: { modelId: number; versionId?: number }) =>
      ipcRenderer.invoke('civitai:detail', opts),
    install: (row: unknown) => ipcRenderer.invoke('civitai:install', { row }),
    // 18+ state, READ-ONLY. There is no unlock channel: the two settings are
    // written through settings:save (whose schema is the write allowlist) and
    // the effective answer is recomputed in main — including a keychain read
    // the renderer cannot make — every time this is asked.
    adultState: () => ipcRenderer.invoke('civitai:adult-state'),
    // Validate a TYPED key before the card stores it. Civitai's public
    // endpoints answer 200 to a garbage bearer (measured), so main asks
    // /api/v1/me — the one endpoint that reacts to the caller — and sends back
    // the account username, never the key.
    validateKey: (key: string) => ipcRenderer.invoke('civitai:validate-key', { key }),
  },
  // PRIVATE MODE (Tier 1) — renderer mirrors mode changes here so the main
  // process can gate cloud providers at the IPC boundary in Tier 2.
  privacy: {
    setMode: (mode: 'open' | 'private') =>
      ipcRenderer.invoke('privacy:set-mode', { mode }),
    getMode: () =>
      ipcRenderer.invoke('privacy:get-mode') as Promise<{ mode: 'open' | 'private' }>,
    onModeChange: (cb: (mode: 'open' | 'private') => void): (() => void) => {
      const handler = (_: unknown, payload: { mode: 'open' | 'private' }) => cb(payload.mode)
      ipcRenderer.on('privacy:mode-changed', handler)
      return () => ipcRenderer.off('privacy:mode-changed', handler)
    },
  },
  // PRIVATE MODE (Tier 4) — capability inbox bridge. Mirrors mode + exposes
  // per-request approve/deny + a push subscription so a queued request lands
  // in the renderer without polling.
  inbox: {
    setMode: (mode: 'immediate' | 'inbox') =>
      ipcRenderer.invoke('inbox:set-mode', { mode }) as Promise<{ ok: true; mode: 'immediate' | 'inbox' }>,
    getMode: () =>
      ipcRenderer.invoke('inbox:get-mode') as Promise<{ mode: 'immediate' | 'inbox' }>,
    list: () =>
      ipcRenderer.invoke('inbox:list') as Promise<{ requests: unknown[] }>,
    approve: (id: string) =>
      ipcRenderer.invoke('inbox:approve', { id }) as Promise<{ ok: true }>,
    deny: (id: string) =>
      ipcRenderer.invoke('inbox:deny', { id }) as Promise<{ ok: true }>,
    cancel: (id: string) =>
      ipcRenderer.invoke('inbox:cancel', { id }) as Promise<{ ok: true }>,
    onPush: (cb: (req: unknown) => void): (() => void) => {
      const handler = (_: unknown, req: unknown) => cb(req)
      ipcRenderer.on('inbox:push', handler)
      return () => ipcRenderer.off('inbox:push', handler)
    },
    onResolve: (cb: (payload: { id: string; decision: 'allow' | 'deny' }) => void): (() => void) => {
      const handler = (_: unknown, payload: { id: string; decision: 'allow' | 'deny' }) => cb(payload)
      ipcRenderer.on('inbox:resolve', handler)
      return () => ipcRenderer.off('inbox:resolve', handler)
    },
  },
  // parallel — multi-task coding agent registry (worktree-per-task). Mirrors
  // parallel-code's surface: createTask spins up a git worktree under
  // <projectRoot>/.worktrees/<branch>, deleteTask tears it down (with retry
  // for Windows EBUSY on node_modules). Subscribe via onEvent to receive
  // bootstrap snapshots and live step/status pushes.
  parallel: {
    list: () =>
      ipcRenderer.invoke('parallel:list') as Promise<{ tasks: unknown[] }>,
    createTask: (input: {
      name:          string
      projectRoot:   string
      baseBranch?:   string
      symlinkDirs?:  string[]
      branchPrefix?: string
    }) =>
      ipcRenderer.invoke('parallel:create-task', input),
    deleteTask: (taskId: string, deleteBranch: boolean = true) =>
      ipcRenderer.invoke('parallel:delete-task', { taskId, deleteBranch }),
    setStatus: (taskId: string, status: string) =>
      ipcRenderer.invoke('parallel:set-status', { taskId, status }),
    setLastLine: (taskId: string, line: string) =>
      ipcRenderer.invoke('parallel:set-last-line', { taskId, line }),
    onEvent: (cb: (event: unknown) => void): (() => void) => {
      const handler = (_: unknown, event: unknown) => cb(event)
      ipcRenderer.on('parallel:event', handler)
      return () => ipcRenderer.off('parallel:event', handler)
    },
    // PTY per parallel task (lazy — only spawned when the tile toggles to
    // PTY display). `subscribe` returns an unsubscribe function that tears
    // down both the renderer-side ipcRenderer listener and the main-side
    // dispatcher record.
    pty: {
      spawn: (taskId: string, cols?: number, rows?: number) =>
        ipcRenderer.invoke('parallel:pty-spawn', { taskId, cols, rows }) as Promise<{ ok: true; hadExisting: boolean } | { ok: false; error: string }>,
      write: (taskId: string, data: string) =>
        ipcRenderer.invoke('parallel:pty-write', { taskId, data }) as Promise<{ ok: boolean }>,
      resize: (taskId: string, cols: number, rows: number) =>
        ipcRenderer.invoke('parallel:pty-resize', { taskId, cols, rows }) as Promise<{ ok: boolean }>,
      kill: (taskId: string) =>
        ipcRenderer.invoke('parallel:pty-kill', { taskId }) as Promise<{ ok: boolean }>,
      /**
       * Subscribe to PTY frames for a task. Returns a Promise that resolves
       * to an unsubscribe function. We have to wait for the spawn handshake
       * to learn the subId before we can attach the listener — but we
       * attach the listener *before* awaiting so the first frame
       * (rare but possible on a hot PTY) isn't dropped.
       */
      subscribe: async (
        taskId:  string,
        onData:  (data: string) => void,
        onExit?: (info: { exit_code: number | null; signal: number | null; last_output: string[] }) => void,
      ): Promise<() => void> => {
        const result = await ipcRenderer.invoke('parallel:pty-subscribe', { taskId }) as
          { ok: true; subId: string } | { ok: false; error: string }
        if (!result.ok) {
          // Return a no-op unsubscribe; callers must check returns of
          // pty.spawn() separately to surface failures to the user.
          return () => { /* no-op */ }
        }
        const channel = `parallel:pty-data:${result.subId}`
        const handler = (_: unknown, msg: { type: 'Data'; data: string } | { type: 'Exit'; data: { exit_code: number | null; signal: number | null; last_output: string[] } }) => {
          if (msg.type === 'Data') {
            onData(msg.data)
          } else if (msg.type === 'Exit' && onExit) {
            onExit(msg.data)
          }
        }
        ipcRenderer.on(channel, handler)
        return () => {
          ipcRenderer.off(channel, handler)
          void ipcRenderer.invoke('parallel:pty-unsubscribe', { subId: result.subId })
        }
      },
    },
  },
  // gnap — multi-agent coordination via git. Every method takes the working
  // repo path as its first argument so the same renderer surface can drive
  // multiple swarms. watch() returns an unsubscribe fn that tears down the
  // per-subscription channel + the main-side fs watcher.
  gnap: {
    initSwarm: (repoPath: string, opts?: { protocolVersion?: string }) =>
      ipcRenderer.invoke('gnap:init-swarm', { repoPath, opts }),
    listAgents: (repoPath: string) =>
      ipcRenderer.invoke('gnap:list-agents', { repoPath }),
    registerAgent: (repoPath: string, agent: unknown) =>
      ipcRenderer.invoke('gnap:register-agent', { repoPath, agent }),
    updateAgentStatus: (repoPath: string, agentId: string, status: 'active' | 'paused' | 'stopped') =>
      ipcRenderer.invoke('gnap:update-agent-status', { repoPath, agentId, status }),
    listTasks: (repoPath: string, filter?: { state?: string; assignedTo?: string }) =>
      ipcRenderer.invoke('gnap:list-tasks', { repoPath, filter }),
    createTask: (repoPath: string, task: unknown) =>
      ipcRenderer.invoke('gnap:create-task', { repoPath, task }),
    updateTaskState: (repoPath: string, taskId: string, state: string, by: string) =>
      ipcRenderer.invoke('gnap:update-task-state', { repoPath, taskId, state, by }),
    claimTask: (repoPath: string, taskId: string, agentId: string, ttlSec?: number) =>
      ipcRenderer.invoke('gnap:claim-task', { repoPath, taskId, agentId, ttlSec }),
    claimAndRun: (repoPath: string, taskId: string, agentId: string, harness?: 'tachi') =>
      ipcRenderer.invoke('gnap:claim-and-run', { repoPath, taskId, agentId, harness }),
    startRun: (repoPath: string, run: unknown) =>
      ipcRenderer.invoke('gnap:start-run', { repoPath, run }),
    completeRun: (repoPath: string, runId: string, patch: unknown) =>
      ipcRenderer.invoke('gnap:complete-run', { repoPath, runId, patch }),
    listRuns: (repoPath: string, taskId?: string) =>
      ipcRenderer.invoke('gnap:list-runs', { repoPath, taskId }),
    postMessage: (repoPath: string, msg: unknown) =>
      ipcRenderer.invoke('gnap:post-message', { repoPath, msg }),
    listMessages: (repoPath: string, filter?: { to?: string; unreadBy?: string }) =>
      ipcRenderer.invoke('gnap:list-messages', { repoPath, filter }),
    markRead: (repoPath: string, msgId: string, agentId: string) =>
      ipcRenderer.invoke('gnap:mark-read', { repoPath, msgId, agentId }),
    watch: (
      repoPath: string,
      onEvent: (info: { sha: string; subject: string; touchedFiles: string[] }) => void,
    ): (() => void) => {
      const subscriptionId = `gnap-watch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const channel = `gnap:event:${subscriptionId}`
      const listener = (_event: unknown, info: { sha: string; subject: string; touchedFiles: string[] }) =>
        onEvent(info)
      ipcRenderer.on(channel, listener)
      // Fire-and-forget the start — the listener is already wired so we won't
      // miss the first event even if the renderer is awaiting elsewhere.
      void ipcRenderer.invoke('gnap:watch-start', { repoPath, subscriptionId })
      return () => {
        ipcRenderer.removeListener(channel, listener)
        void ipcRenderer.invoke('gnap:watch-stop', { subscriptionId })
      }
    },
  },
  aeon: {
    ghStatus:      () => ipcRenderer.invoke('aeon:gh-status'),
    loginStart:    () => ipcRenderer.invoke('aeon:login-start'),
    loginCancel:   () => ipcRenderer.invoke('aeon:login-cancel'),
    onLoginCode:   (cb: (d: { code: string; verificationUri: string }) => void) => {
      const h = (_: unknown, d: { code: string; verificationUri: string }) => cb(d)
      ipcRenderer.on('aeon:login-code', h)
      return () => ipcRenderer.removeListener('aeon:login-code', h)
    },
    onLoginDone:   (cb: (d: { ok: boolean; error?: string }) => void) => {
      const h = (_: unknown, d: { ok: boolean; error?: string }) => cb(d)
      ipcRenderer.on('aeon:login-done', h)
      return () => ipcRenderer.removeListener('aeon:login-done', h)
    },
    detectFork:    () => ipcRenderer.invoke('aeon:detect-fork'),
    fork:          () => ipcRenderer.invoke('aeon:fork'),
    listWorkflows: (owner: string) => ipcRenderer.invoke('aeon:list-workflows', { owner }),
    listRuns:      (owner: string, limit?: number) => ipcRenderer.invoke('aeon:list-runs', { owner, limit }),
    trigger:       (owner: string, workflowPath: string, ref?: string, inputs?: Record<string, string>) => ipcRenderer.invoke('aeon:trigger', { owner, workflowPath, ref, inputs }),
    setSecret:     (owner: string, name: string, value: string) => ipcRenderer.invoke('aeon:set-secret', { owner, name, value }),
    pushLocalProviderSecret: (
      owner: string,
      provider: 'opengateway' | 'bankr-gateway' | 'anthropic-oauth' | 'anthropic',
    ) => ipcRenderer.invoke('aeon:push-local-provider-secret', { owner, provider }),
    enableActions: (owner: string) => ipcRenderer.invoke('aeon:enable-actions', { owner }),
    actionsStatus: (owner: string) => ipcRenderer.invoke('aeon:actions-status', { owner }),
    syncFork:      (owner: string, branch?: string) => ipcRenderer.invoke('aeon:sync-fork', { owner, branch }),
    runLogs:       (owner: string, runId: number) => ipcRenderer.invoke('aeon:run-logs', { owner, runId }),
    patchWorkflowForOpenGateway: (owner: string) => ipcRenderer.invoke('aeon:patch-workflow-opengateway', { owner }),
    unpatchWorkflowForOpenGateway: (owner: string) => ipcRenderer.invoke('aeon:unpatch-workflow-opengateway', { owner }),
    workflowPatchStatus: (owner: string) => ipcRenderer.invoke('aeon:workflow-patch-status', { owner }),
    getGateway:    (owner: string) => ipcRenderer.invoke('aeon:get-gateway', { owner }),
    setGateway:    (owner: string, provider: 'direct' | 'bankr' | 'opengateway') =>
                     ipcRenderer.invoke('aeon:set-gateway', { owner, provider }),
    listDashboardOutputs: (owner: string) =>
                     ipcRenderer.invoke('aeon:list-dashboard-outputs', { owner }),
    getDashboardOutput:   (owner: string, filename: string) =>
                     ipcRenderer.invoke('aeon:get-dashboard-output', { owner, filename }),
    cronState:     (owner: string) => ipcRenderer.invoke('aeon:cron-state', { owner }),
    skillHealth:   (owner: string) => ipcRenderer.invoke('aeon:skill-health', { owner }),
    probeDashboard: (port?: number) =>
                     ipcRenderer.invoke('aeon:probe-dashboard', port !== undefined ? { port } : {}),
    // Auto-spawn the dashboard (zero-terminal). Streams progress over
    // `aeon:dashboard-progress` — use onDashboardProgress to subscribe.
    dashboardPrereqs:  () => ipcRenderer.invoke('aeon:dashboard-prereqs'),
    dashboardStatus:   () => ipcRenderer.invoke('aeon:dashboard-status'),
    dashboardInstallAndLaunch: (owner: string) =>
                       ipcRenderer.invoke('aeon:dashboard-install-and-launch', { owner }),
    dashboardStop:     () => ipcRenderer.invoke('aeon:dashboard-stop'),
    dashboardReset:    () => ipcRenderer.invoke('aeon:dashboard-reset'),
    onDashboardProgress: (cb: (event: { stage: string; bytes?: number; total?: number; port?: number; message?: string }) => void): (() => void) => {
      const handler = (_: unknown, event: { stage: string; bytes?: number; total?: number; port?: number; message?: string }) => cb(event)
      ipcRenderer.on('aeon:dashboard-progress', handler)
      return () => ipcRenderer.off('aeon:dashboard-progress', handler)
    },
    deleteRun:     (owner: string, runId: number) => ipcRenderer.invoke('aeon:delete-run', { owner, runId }),
    rerunRun:      (owner: string, runId: number) => ipcRenderer.invoke('aeon:rerun-run', { owner, runId }),
    listJobs:      (owner: string, runId: number) => ipcRenderer.invoke('aeon:list-jobs', { owner, runId }),
    jobLogs:       (owner: string, jobId: number) => ipcRenderer.invoke('aeon:job-logs', { owner, jobId }),
    workflowInputs: (owner: string, workflowPath: string) =>
      ipcRenderer.invoke('aeon:workflow-inputs', { owner, workflowPath }),
    listSkillDirs: (owner: string) => ipcRenderer.invoke('aeon:list-skill-dirs', { owner }),
    getSkillAnalytics: (owner: string) => ipcRenderer.invoke('aeon:get-skill-analytics', { owner }),
    // E2: fork-behind indicator
    getSyncStatus: () => ipcRenderer.invoke('aeon:get-sync-status'),
    // E4: memory search
    searchMemory: (query: string) => ipcRenderer.invoke('aeon:search-memory', { query }),
  },
  // Sprint C3: checkpoints — typed bridge for read/list/delete.
  // The renderer uses this to surface "View checkpoint" or "Export session" actions.
  // Writes are main-process-internal (called from agent.ipc.ts).
  checkpoints: {
    loadCheckpoint:  (sessionId: string) => checkpointsBridge.loadCheckpoint({ sessionId }),
    listCheckpoints: ()                  => checkpointsBridge.listCheckpoints({}),
    deleteCheckpoint:(sessionId: string) => checkpointsBridge.deleteCheckpoint({ sessionId }),
    // Git-backed WORKSPACE checkpoints (agent file-change undo).
    snapshotWorkspace:         (root: string, label?: string) => checkpointsBridge.snapshotWorkspace({ root, label }),
    listWorkspaceCheckpoints:  (root: string)                 => checkpointsBridge.listWorkspaceCheckpoints({ root }),
    restoreWorkspace:          (root: string, id: string)     => checkpointsBridge.restoreWorkspace({ root, id }),
    deleteWorkspaceCheckpoint: (root: string, id: string)     => checkpointsBridge.deleteWorkspaceCheckpoint({ root, id }),
  },
  // agent-session-memory — session memory between agent runs (ECC pattern).
  // Keyed by workspace PATH. save() on agent stop; load()/buildContext() on start.
  sessionMemory: {
    save:         (input: { workspacePath: string; lastTask: string; keyDecisions?: string[]; filesChanged?: string[]; notes?: string }) => sessionMemoryBridge.save(input),
    load:         (workspacePath: string) => sessionMemoryBridge.load({ workspacePath }),
    buildContext: (workspacePath: string) => sessionMemoryBridge.buildContext({ workspacePath }),
    list:         () => sessionMemoryBridge.list({}),
    delete:       (workspacePath: string) => sessionMemoryBridge.delete({ workspacePath }),
  },
  // Structured persistent-memory fact store (T16). The fact manager UI + chat
  // auto-capture call through here; enabled facts are injected into every chat.
  memoryFacts: {
    list:    () => memoryFactsBridge.list({}),
    add:     (text: string, source?: 'user' | 'auto') => memoryFactsBridge.add({ text, source }),
    edit:    (id: string, text: string) => memoryFactsBridge.edit({ id, text }),
    delete:  (id: string) => memoryFactsBridge.delete({ id }),
    toggle:  (id: string, enabled: boolean) => memoryFactsBridge.toggle({ id, enabled }),
    preview: () => memoryFactsBridge.preview({}),
  },
  safeStorage: {
    isAvailable: (): Promise<{ available: boolean }> =>
      ipcRenderer.invoke('safe-storage:is-available'),
    encrypt: (plaintext: string): Promise<{ encrypted: string }> =>
      ipcRenderer.invoke('safe-storage:encrypt', { plaintext }),
    decrypt: (encrypted: string): Promise<{ plaintext: string }> =>
      ipcRenderer.invoke('safe-storage:decrypt', { encrypted }),
  },
  // Sprint C4: workspace-panel — read-only routes for the per-conversation panel.
  workspacePanel: {
    listRecentChanges:            (input: { sessionId: string }) =>
      workspacePanelBridge.listRecentChanges(input),
    getWorkspaceForConversation:  (input: { conversationId: string }) =>
      workspacePanelBridge.getWorkspaceForConversation(input),
  },
  hotkeys: {
    load: (): Promise<Record<string, string>> =>
      ipcRenderer.invoke('hotkeys:load'),
    save: (hotkeys: Record<string, string>): Promise<void> =>
      ipcRenderer.invoke('hotkeys:save', { hotkeys }),
    /** Per-action global-shortcut binding results ({id, accel, ok}). */
    registrations: (): Promise<Array<{ id: string; accel: string; ok: boolean }>> =>
      ipcRenderer.invoke('hotkeys:registrations'),
    onFired: (cb: (payload: { id: string }) => void): (() => void) => {
      const handler = (_: unknown, payload: { id: string }) => cb(payload)
      ipcRenderer.on('hotkey:fired', handler)
      return () => ipcRenderer.off('hotkey:fired', handler)
    },
  },
  // Sprint C1: playbook — manual wrappers preserve the renderer-facing call signatures
  // (plain string args) while routing through the typed router's object-based payloads.
  // Sprint D3: added loadEntries for structured block-tree entries.
  playbook: {
    list:         () =>                       playbookBridge.list({}),
    load:         (workspacePath: string) =>  playbookBridge.load({ workspacePath }),
    delete:       (workspacePath: string) =>  playbookBridge.delete({ workspacePath }),
    loadEntries:  (workspacePath: string) =>  playbookBridge.loadEntries({ workspacePath }),
  },
  // Sprint D5: roles — typed bridge for role registry.
  roles: {
    list:    ()                                                           => rolesBridge.list({}),
    get:     (id: string)                                                 => rolesBridge.get({ id }),
    suggest: (workspaceFiles: string[], recentUserText: string)           =>
      rolesBridge.suggest({ workspaceFiles, recentUserText }),
  },
  // Skills: installed SKILL.md list, workspace suggestions, hash-pinned registry install.
  skills: {
    list:     ()           => skillsBridge.list({}),
    suggest:  ()           => skillsBridge.suggest({}),
    registry: ()           => skillsBridge.registry({}),
    install:  (id: string) => skillsBridge.install({ id }),
  },
  // Sprint C2: agent-runtime — request/response bridge + push-channel subscription.
  // The push subscription returns an unsubscribe fn for cleanup on unmount.
  agentRuntime: {
    getState:    (input: Record<string, never>) => agentRuntimeBridge.getState(input),
    setStatus:   (input: { status: string })    => agentRuntimeBridge.setStatus(input as Parameters<typeof agentRuntimeBridge.setStatus>[0]),
    setHarness:  (input: { harness: string })   => agentRuntimeBridge.setHarness(input as Parameters<typeof agentRuntimeBridge.setHarness>[0]),
    setProvider: (input: { provider: string; bankrModel?: string }) =>
      agentRuntimeBridge.setProvider(input as Parameters<typeof agentRuntimeBridge.setProvider>[0]),
    /** Subscribe to push broadcasts from the main store. Returns an unsubscribe fn. */
    onStateChanged: (cb: (snapshot: AgentRuntimeSnapshot) => void): (() => void) => {
      const handler = (_: unknown, snapshot: AgentRuntimeSnapshot) => cb(snapshot)
      ipcRenderer.on('agent-runtime:state-changed', handler)
      return () => ipcRenderer.off('agent-runtime:state-changed', handler)
    },
  },
})
