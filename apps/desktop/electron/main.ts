// FIRST import on purpose: sets ESBUILD_BINARY_PATH before anything can load
// esbuild (it captures the env var at module load) — packaged MP4 export.
// EVEN EARLIER than esbuild-binary-path: this can redirect app.getPath('userData'),
// and setPath only redirects what has not been read yet. Any module that computes
// a path at import time must load AFTER it. See services/portable-mode.ts.
import './services/portable-mode'
import './services/esbuild-binary-path'
import { app, BrowserWindow, Menu, ipcMain, session, shell, desktopCapturer, screen } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { registerMediaScheme, registerMediaProtocol } from './services/media-protocol'
import { registerPreviewScheme, registerPreviewProtocol } from './services/preview-protocol'
import { installFetchPatch } from './services/network-audit'
import { registerNetworkAuditIpc } from './ipc/network-audit.ipc'
import { registerSettingsIpc } from './ipc/settings.ipc'
import { registerCostIpc } from './ipc/cost.ipc'
import { registerYtDlpIpc } from './ipc/yt-dlp.ipc'
import { registerProviderIpc } from './ipc/providers.ipc'
import { registerChatIpc } from './ipc/chat.ipc'
import { registerRuntimeIpc } from './ipc/runtime.ipc'
import { registerTerminalIpc } from './ipc/terminal.ipc'
import { registerLogsIpc } from './ipc/logs.ipc'
import { registerCommandsIpc } from './ipc/commands.ipc'
import { registerProfilesIpc } from './ipc/profiles.ipc'
import { registerWorkspaceIpc } from './ipc/workspace.ipc'
import { registerSidecarIpc } from './ipc/sidecar.ipc'
import { registerShellIpc } from './ipc/shell.ipc'
import { registerAgentIpc } from './ipc/agent.ipc'
import { registerOpenClaudeIpc } from './ipc/openclaude.ipc'
import { registerClaudeCodeRouterIpc } from './ipc/claude-code-router.ipc'
import { registerAppIpc } from './ipc/app.ipc'
import { registerAeonIpc } from './ipc/aeon.ipc'
import { registerOAuthIpc } from './ipc/oauth.ipc'
import { registerOverlayIpc } from './ipc/overlay.ipc'
import { registerMCPIpc, registerInProcessMcpIpc } from './ipc/mcp.ipc'
import { registerApiServerIpc } from './ipc/api-server.ipc'
import { registerNotificationIpc } from './ipc/notification.ipc'
import { registerConnectorsIpc } from './ipc/connectors.ipc'
import { registerSafeStorageIpc } from './ipc/safe-storage.ipc'
import { registerWhisperIpc } from './ipc/whisper.ipc'
import { registerHotkeysIpc } from './ipc/hotkeys.ipc'
import { registerOllamaIpc } from './ipc/ollama.ipc'
import { registerBankrIpc, bankrRouter } from './ipc/bankr.ipc'
import { surplusRouter } from './ipc/surplus.ipc'
import { veniceRouter } from './ipc/venice.ipc'
import { openrouterRouter } from './ipc/openrouter.ipc'
// Importing this registers OpenGateway's live rate resolver with the cost
// ledger (see the service's footer) as well as mounting the catalog route.
import { opengatewayRouter } from './ipc/opengateway.ipc'
import { surplusMediaRouter } from './ipc/surplus-media.ipc'
import { imgnaiMediaRouter } from './ipc/imgnai-media.ipc'
import { pollinationsMediaRouter } from './ipc/pollinations-media.ipc'
import { fusionRouter } from './ipc/fusion.ipc'
import { registerPlaybookIpc, playbookRouter } from './ipc/playbook.ipc'
import { registerRolesIpc, rolesRouter } from './ipc/roles.ipc'
import { skillsRouter } from './ipc/skills.ipc'
import { registerWindowIpc } from './ipc/window.ipc'
import { registerNodesIpc } from './ipc/nodes.ipc'
import { registerCodexIpc } from './ipc/codex.ipc'
import { registerTelegramIpc } from './ipc/telegram.ipc'
import { syncTelegramService, stopTelegramService } from './services/telegram-service'
import { startCatalogRefresher, stopCatalogRefresher } from './services/model-catalog-cache'
import { registerGraphIpc } from './ipc/graph.ipc'
import { registerSchedulerIpc } from './ipc/scheduler.ipc'
import { initScheduler, stopScheduler } from './services/scheduler-service'
import { registerDesignIpc } from './ipc/design.ipc'
import { registerRagIpc } from './ipc/rag.ipc'
import { registerDoctorIpc } from './ipc/doctor.ipc'
import { registerChatArchiveIpc } from './ipc/chat-archive.ipc'
import { registerBackupIpc } from './ipc/backup.ipc'
import { registerFreellmapiIpc } from './ipc/freellmapi.ipc'
import { registerLlamaCppIpc } from './ipc/llama-cpp.ipc'
import { registerDownloadsIpc } from './ipc/downloads.ipc'
import { initDownloadManager } from './services/download-manager'
import { registerSdCppIpc } from './ipc/sd-cpp.ipc'
import { registerPiperIpc } from './ipc/piper.ipc'
import { registerModelCatalogIpc } from './ipc/model-catalog.ipc'
import { registerModelStorageIpc } from './ipc/model-storage.ipc'
import { registerPrivacyIpc } from './ipc/privacy.ipc'
import { registerInboxIpc } from './ipc/inbox.ipc'
import { registerRouterStatsIpc } from './ipc/router-stats.ipc'
import { capabilityService } from './services/capability-service'
import { pendingPermissions } from './services/pending-permissions'
import { registerGnapIpc } from './ipc/gnap.ipc'
import { registerParallelAgentsIpc } from './ipc/parallel-agents.ipc'
import { shellRouter, isExternalUrlAllowed } from './ipc/shell.ipc'
import { agentRuntimeRouter } from './ipc/agent-runtime.ipc'
import { checkpointsRouter } from './ipc/checkpoints.ipc'
import { sessionMemoryRouter } from './ipc/session-memory.ipc'
import { memoryFactsRouter } from './ipc/memory-facts.ipc'
import { workspacePanelRouter } from './ipc/workspace-panel.ipc'
import { nookRouter } from './ipc/nook.ipc'
import { nookActionsRouter } from './ipc/nook-actions.ipc'
import { nookNetworkRouter } from './ipc/nook-network.ipc'
import { nookMessagingRouter } from './ipc/nook-messaging.ipc'
import { nookMiningRouter } from './ipc/nook-mining.ipc'
import { walletRouter } from './ipc/wallet.ipc'
import { registerWalletConfirm } from './ipc/wallet-confirm.ipc'
import { registerRouter } from './ipc-router/router'
import { stopOllamaIfWeStartedIt } from './services/ollama-service'
// Quit must not orphan the GPU (see will-quit). Free on the boot path: sd-cpp-
// client is already in the static graph through ipc/sd-cpp.ipc, so naming it
// here adds no module and no package to the prelude.
import { cancelGeneration, isGenerating } from './services/sd-cpp-client'
import { initHotkeyManager, registerAll as registerAllHotkeys } from './services/hotkey-manager'
import { registerQuickAsk } from './services/quick-ask-service'
import { loadSettings } from './services/settings-store'
import {
  startFreellmapi,
  stopAllSidecars,
  startInProcessMcp,
  getMcpHandle,
  setInProcessMcpEnabled,
  rotateInProcessMcpToken,
  isInProcessMcpEnabled,
  startLocalApiServer,
  getApiServerHandle,
  setLocalApiServerEnabled,
  rotateLocalApiServerToken,
  isLocalApiServerEnabled,
} from './services/sidecar-manager'
import { stopAllMCPServers } from './services/mcp-manager'
import { isFreellmapiInstalled } from './services/freellmapi-installer'
import { createTray, destroyTray } from './services/tray-service'
import { setupAutoUpdate } from './services/auto-update'
import { installCrashTelemetry, watchWebContentsHealth } from './services/crash-log'

let mainWindow: BrowserWindow | null = null

// ── R8a: STARTUP INSTRUMENTATION (measure first, refactor later) ──────────────
//
// PLAN RELIABILITY+GROWTH 2026-07-26 R8, step 1 ONLY. main.ts has 98 static
// top-level imports and 0 dynamic; per DO-NOT #10 we do NOT start converting
// them to `await import()` until there is a number to beat. So: mark the phases,
// print ONE line per boot, and change nothing else.
//
// Everything lands on the standard Performance timeline (`performance.mark` /
// `performance.measure`, names prefixed `tachi:`), so a future Diagnostics card
// (R10) can read it with `performance.getEntriesByType('measure')` — no export
// from main.ts, no new IPC surface, and zero cost when nobody looks.
//
// Cheap by construction: a mark is a monotonic clock read plus a push; `phase()`
// wraps a synchronous call and never swallows its error.

/** ms since this module was first evaluated — the earliest point we can observe. */
const STARTUP_T0 = performance.now()
/** Instants: name → ms after STARTUP_T0. */
const startupMarks: Array<{ name: string; at: number }> = []
/** Spans: name → duration in ms. */
const startupPhases: Array<{ name: string; ms: number }> = []
let startupSummaryLogged = false

function startupMark(name: string): void {
  const at = performance.now() - STARTUP_T0
  startupMarks.push({ name, at: Math.round(at) })
  try { performance.mark(`tachi:${name}`) } catch { /* timeline full / unavailable */ }
}

/** Time a synchronous subsystem init. Errors propagate unchanged. */
function startupPhase<T>(name: string, fn: () => T): T {
  const t0 = performance.now()
  try {
    return fn()
  } finally {
    const ms = performance.now() - t0
    startupPhases.push({ name, ms: Math.round(ms) })
    // `start` is a performance-timeline timestamp (same base as
    // performance.now()), NOT an epoch ms — do not add timeOrigin.
    try { performance.measure(`tachi:phase:${name}`, { start: t0, duration: ms }) }
    catch { /* older timeline API — the summary line still carries it */ }
  }
}

/** Same, for an async init we want a duration for without blocking boot on it. */
function startupPhaseAsync<T>(name: string, p: Promise<T>): Promise<T> {
  const t0 = performance.now()
  const done = (): void => {
    const ms = performance.now() - t0
    startupPhases.push({ name, ms: Math.round(ms) })
    try { performance.measure(`tachi:phase:${name}`, { start: t0, duration: ms }) }
    catch { /* ignore */ }
  }
  return p.then(v => { done(); return v }, err => { done(); throw err })
}

/**
 * One line per boot, at the first `did-finish-load` (the earliest point the user
 * can actually see the app). Idempotent — a reload must not re-log.
 */
function logStartupSummary(reason: string): void {
  if (startupSummaryLogged) return
  startupSummaryLogged = true
  const total = Math.round(performance.now() - STARTUP_T0)
  // ── R8b: make the PRELUDE observable ───────────────────────────────────────
  //
  // The R8b baseline found that `module-eval-end` marks at 0 ms on every boot —
  // not because module eval is fast, but because the bundler hoists all 34
  // external require()s and inlines all 284 first-party modules ABOVE
  // `const STARTUP_T0`. By the time STARTUP_T0 is read, 100% of the import graph
  // has already been evaluated, so `total` covers only 467 ms of a 1793 ms boot
  // and structurally EXCLUDES the 1317 ms prelude.
  //
  // In the main process `performance.timeOrigin` is V8 init, measured 13 ms
  // after process start — so a bare `performance.now()` here is essentially the
  // whole boot, and `boot - total` IS the prelude: Electron bootstrap + the
  // app.asar header parse + the hoisted import graph.
  //
  // This matters because R8b's deferrals (agent-kit, typescript, express, the
  // MCP SDK, systeminformation, electron-updater, yaml, libsodium) ALL live in
  // that window. Without this number the next measured build would print an
  // unchanged `total=` and the ~400 ms saving would be invisible.
  const boot = Math.round(performance.now())
  const marks  = startupMarks.map(m => `${m.name}@${m.at}ms`).join(' ')
  const phases = [...startupPhases].sort((a, b) => b.ms - a.ms).map(p => `${p.name}=${p.ms}ms`).join(' ')
  console.log(
    `[startup] boot=${boot}ms prelude=${boot - total}ms total=${total}ms (to ${reason}) · marks: ${marks || 'none'} · phases (slowest first): ${phases || 'none'}`,
  )
}

type OverlayTheme = 'dark' | 'light'

const OVERLAY_COLORS: Record<OverlayTheme, { color: string; symbolColor: string }> = {
  dark:  { color: '#141414', symbolColor: '#888888' },
  light: { color: '#fcf9f8', symbolColor: '#1c1b1b' },
}

// Brand icon (purple square). In dev, build/ lives inside the app path so the
// window + taskbar show our icon. In the packaged app the exe icon is supplied
// by electron-builder (win.icon), and build/ isn't shipped, so this resolves to
// undefined and Electron falls back to the exe icon — both correct.
function brandIconPath(): string | undefined {
  const file = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  const p = join(app.getAppPath(), 'build', file)
  return existsSync(p) ? p : undefined
}

// ── Transparent-shell feature flag ────────────────────────────────────────
// The window is created transparent+frameless for EVERY theme, which is what
// lets a theme inset the app into a plate and decorate — or cut through — the
// margin around it. Transparent windows on Windows disable a few DWM niceties,
// so it is guarded behind an env flag: default ON, set
// `TACHI_CRAB_TRANSPARENT=0` for the opaque fallback shell. Themes that draw
// edge-to-edge look identical either way, because the renderer paints a
// full-bleed opaque body over the alpha.
//
// ONE FLAG, NO PER-THEME LIST — by construction: `tachikoma-red`
// (TachikomaChrome.tsx) and `tachi-opus5` (OpusChrome.tsx) need no id of their
// own here. Both fill their margin with an OPAQUE milled slab drawn in CSS
// rather than letting the desktop through, so they are the case that looks
// nearly the same with the flag OFF — only their outer corner chamfers stop
// cutting to the desktop. If a future frame ever needs real transparency,
// extend THIS constant (never a per-theme branch) so there stays exactly one
// switch; note that it is read at window construction, so any change needs an
// app RESTART — a theme switch alone cannot re-create the window.
//
// THE ENV VAR STILL CARRIES THE OLD NAME. The flag was introduced for the
// `tachi-crab` theme, whose claws floated in a genuinely transparent gutter;
// that theme was deleted on 2026-07-26 but the variable name is a documented
// escape hatch someone may already have set, so renaming it would silently
// stop honouring their setting. The constant is named for what it does.
const TRANSPARENT_WINDOW = process.env.TACHI_CRAB_TRANSPARENT !== '0'

function createWindow() {
  startupMark('window-construct-begin')
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    icon: brandIconPath(),
    // Frameless window — we render our own min/max/close controls in
    // <TitleBar /> so they match the brutalist style and don't float on
    // top of page content.
    ...(TRANSPARENT_WINDOW
      ? {
          // Transparent-capable shell. `frame: false` is REQUIRED for a
          // transparent window on Windows; `thickFrame: true` keeps
          // WS_THICKFRAME so native edge-resize + window shadow + snap still
          // work (a transparent window strips it by default → not resizable).
          // `roundedCorners: false` keeps the brutalist square corners and
          // stops Win11 rounding from clipping the full-bleed body into alpha.
          // Programmatic maximize (our TitleBar button → win.maximize()) is
          // unaffected; only the system-menu maximize is restricted.
          transparent: true,
          backgroundColor: '#00000000',
          frame: false,
          thickFrame: true,
          roundedCorners: false,
        }
      : {
          // Fail-safe fallback — the original opaque window, byte-identical to
          // the shell that shipped before any theme wanted alpha:
          // `titleBarStyle: 'hidden'` reserves no native overlay and the
          // renderer owns the drag region.
          backgroundColor: '#0f0f0f',
          titleBarStyle: 'hidden' as const,
        }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Hardened defaults — the renderer is sandbox-isolated. The preload
      // still talks to main via contextBridge + ipcRenderer (both work in
      // sandboxed mode); only direct require()/process access is blocked.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })

  startupMark('window-created')

  // R8a: the first paint the user can actually see. Also where the one-line
  // startup summary is printed (a later reload re-fires this; the log is
  // idempotent so only the FIRST load is reported).
  mainWindow.webContents.once('did-finish-load', () => {
    startupMark('first-did-finish-load')
    logStartupSummary('first did-finish-load')
  })

  // Crash telemetry: renderer hang (unresponsive) / recovery (responsive)
  // breadcrumbs for the main window → userData/logs/crash.jsonl.
  watchWebContentsHealth(mainWindow.webContents, 'main-window')

  // ── Security hardening ───────────────────────────────────────────────────
  // Block navigation away from the renderer entry. Even XSS can't pivot to
  // a remote origin. Allowed: the dev server URL (only in development).
  const allowedRendererUrl = process.env.ELECTRON_RENDERER_URL ?? ''
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const target = new URL(url)
      const allowed = allowedRendererUrl && url.startsWith(allowedRendererUrl)
      const isFile  = target.protocol === 'file:'
      if (!allowed && !isFile) {
        event.preventDefault()
        console.warn('[security] blocked navigation to', url)
      }
    } catch {
      event.preventDefault()
    }
  })
  // Block window.open / target=_blank — enforce the SAME hostname allowlist
  // as the shell:open-external IPC route. Previously this forwarded ANY
  // http(s) URL to shell.openExternal, which made window.open a bypass
  // around the allowlist (drive-by link from a compromised renderer).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrlAllowed(url)) {
      shell.openExternal(url).catch(() => { /* ignore */ })
    } else {
      console.warn('[security] blocked window.open to', url)
    }
    return { action: 'deny' }
  })
  // ── webRequest header pass ─────────────────────────────────────────────
  // Two jobs in one handler (Electron's session only supports one
  // `onHeadersReceived` listener — second registration would overwrite the
  // first):
  //
  //   1. **Production**: inject our own strict CSP on file:// loads.
  //      Dev mode keeps vite's default CSP so HMR stays alive.
  //   2. **Localhost iframe embeds**: strip `frame-ancestors` directives
  //      and `X-Frame-Options` from responses originating on 127.0.0.1 /
  //      localhost. The OpenClaw daemon ships `frame-ancestors 'none'`
  //      which blocks our /openclaw in-app dashboard. We only frame
  //      localhost servers the user has chosen to surface in our UI
  //      (Aeon next-dev, OpenClaw daemon) — both come up under our own
  //      installer flows, so the `frame-ancestors` protection was
  //      assuming a hostile embedder; in our case it isn't one.
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    const isLocalhost =
      /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(details.url)
    const isProd = !process.env.ELECTRON_RENDERER_URL
    // The app's own privileged schemes set their OWN CSP (tachi-preview:// must
    // run the preview's inline scripts; tachi-media:// streams files). Don't let
    // the strict renderer CSP below clobber them (it would re-block scripts and
    // add frame-ancestors 'none', which also prevents framing the preview).
    const isAppScheme = /^tachi-(preview|media):/i.test(details.url)

    // Start from the existing headers; we'll add / replace as needed.
    // Headers are returned as Record<string, string[]> by Electron.
    const next: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(details.responseHeaders ?? {})) {
      next[k] = Array.isArray(v) ? [...v] : [String(v)]
    }

    if (isLocalhost) {
      // Drop the whole X-Frame-Options header (no negotiation possible),
      // and strip `frame-ancestors` directives out of any CSP value
      // while preserving the rest of the CSP.
      for (const key of Object.keys(next)) {
        const lc = key.toLowerCase()
        if (lc === 'x-frame-options') {
          delete next[key]
          continue
        }
        if (lc === 'content-security-policy' || lc === 'content-security-policy-report-only') {
          next[key] = (next[key] ?? []).map(v =>
            v
              .split(';')
              .filter(d => !/^\s*frame-ancestors/i.test(d))
              .join(';'),
          )
        }
      }
    }

    if (isProd && !isAppScheme) {
      // The ONE allowed inline script is index.html's anti-FOUC theme-setter
      // (reads localStorage 'tachi-theme' before first paint). Its sha256 is
      // pinned here so the strict CSP permits exactly that script and nothing
      // else — without it, script-src 'self' blocks the inline tag and the app
      // flashes the default theme on cold start. If the inline script text in
      // index.html changes, update this hash (the browser logs the expected one).
      const THEME_INIT_SHA = "'sha256-zWa23t6FuQPV4JsqdzRxYavAfYULi/kki2/VBl3PsgM='"
      next['Content-Security-Policy'] = [
        // Strict CSP for production: only same-origin, no remote scripts,
        // allow inline styles (brutalist inline-style heavy), data: for images.
        // `frame-src http://127.0.0.1:*` lets the renderer embed Aeon and
        // OpenClaw dashboards as iframes (both run on localhost ports).
        // connect-src is loopback-only: all provider/cloud egress happens in the
        // MAIN process (via IPC), never directly from the renderer. The previous
        // bare `https:` let a compromised renderer exfiltrate to any origin
        // (audit 2026-06-12, M3). If a renderer ever needs a specific external
        // host, add that exact origin here rather than re-opening the wildcard.
        // esm.sh is allowed for scripts + connect ONLY to power the Design tab's
        // live Remotion preview (React/remotion/@remotion/player + Babel load from
        // the CDN INSIDE the sandboxed, no-same-origin preview iframe — it cannot
        // reach window.tachi). The main renderer is bundled 'self' and never loads
        // remote scripts. fonts.googleapis/gstatic let generated designs use webfonts.
        // 'wasm-unsafe-eval' permits WebAssembly.compile ONLY (not JS eval) — the
        // chat's shiki syntax highlighter runs its oniguruma regex engine as a
        // bundled wasm module; without this the strict CSP silently killed
        // highlighting in packaged builds (code fell back to an unreadable
        // theme-colored <pre>). The wasm is 'self'-bundled, never remote.
        `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://esm.sh https://unpkg.com ${THEME_INIT_SHA}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: tachi-media:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' https://esm.sh https://unpkg.com http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; frame-src 'self' blob: tachi-preview: http://127.0.0.1:*; media-src 'self' data: blob: mediastream: tachi-media:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none';`,
      ]
    }

    cb({ responseHeaders: next })
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  startupMark('ipc-registration-begin')
  registerSettingsIpc()
  registerCostIpc()
  registerYtDlpIpc()
  registerProviderIpc()
  registerChatIpc(mainWindow)
  registerRuntimeIpc(mainWindow)
  registerTerminalIpc(mainWindow)
  registerLogsIpc(mainWindow)
  registerCommandsIpc(mainWindow)
  registerProfilesIpc()
  registerWorkspaceIpc()
  registerSidecarIpc(mainWindow)
  // Sprint C1: typed router registrations (shell, bankr, playbook).
  // These replace the legacy ipcMain.handle calls in the respective ipc files.
  registerRouter(shellRouter)
  registerRouter(bankrRouter)
  registerRouter(surplusRouter)
  // Venice — standalone OpenAI-compatible provider (chat model catalog).
  registerRouter(veniceRouter)
  // OpenRouter LIVE catalog — carries the per-model FREE signal (pricing 0/0).
  registerRouter(openrouterRouter)
  registerRouter(opengatewayRouter)
  // Surplus MEDIA engine — image / TTS / STT / video / music / embeddings.
  registerRouter(surplusMediaRouter)
  // imgnAI Katana MEDIA engine — image + video (submit + poll in main).
  registerRouter(imgnaiMediaRouter)
  // Pollinations KEYLESS image engine — cloud GET, paced 1/15s in main.
  registerRouter(pollinationsMediaRouter)
  // Fusion panel RE-RUN — retry a single failed panel member from the transcript.
  registerRouter(fusionRouter)
  registerRouter(playbookRouter)
  // Sprint C2: main-process agent-runtime store + cross-window broadcast.
  registerRouter(agentRuntimeRouter)
  // Sprint C3: stateless sidecar checkpointing — read/list/delete routes.
  // The write path is internal (agent.ipc.ts → recordCheckpoint); no IPC needed for writes.
  registerRouter(checkpointsRouter)
  // agent-session-memory: cross-run session summaries keyed by workspace path.
  registerRouter(sessionMemoryRouter)
  // Structured persistent-memory fact store (T16): list/add/edit/delete/toggle/preview.
  registerRouter(memoryFactsRouter)
  // Sprint C4: per-conversation workspace panel — listRecentChanges + getWorkspaceForConversation.
  registerRouter(workspacePanelRouter)
  // Sprint D5: role registry — list, get, suggest routes.
  registerRouter(rolesRouter)
  // Skills: installed list + workspace suggestions + hash-pinned registry install.
  registerRouter(skillsRouter)
  // nookplot gateway proxy — server-side GET reads (renderer can't fetch the
  // gateway directly because it sends no CORS headers).
  registerRouter(nookRouter)
  // nookplot write-actions, network/knowledge, and messaging routers.
  registerRouter(nookActionsRouter)
  registerRouter(nookNetworkRouter)
  registerRouter(nookMessagingRouter)
  registerRouter(nookMiningRouter)
  registerRouter(walletRouter)
  registerShellIpc()   // no-op shim — kept for legibility until all callers updated
  registerAgentIpc(mainWindow)
  registerOpenClaudeIpc(mainWindow)
  registerClaudeCodeRouterIpc(mainWindow)
  registerAppIpc(mainWindow)
  registerAeonIpc(mainWindow)
  registerOAuthIpc()
  registerOverlayIpc(mainWindow)
  registerMCPIpc()
  registerInProcessMcpIpc(
    () => getMcpHandle(),
    (v) => setInProcessMcpEnabled(v),
    () => rotateInProcessMcpToken(),
    () => isInProcessMcpEnabled(),
  )
  registerApiServerIpc(
    () => getApiServerHandle(),
    (v) => setLocalApiServerEnabled(v),
    () => rotateLocalApiServerToken(),
    () => isLocalApiServerEnabled(),
  )
  registerNotificationIpc(mainWindow)
  registerConnectorsIpc()
  registerNetworkAuditIpc()
  registerSafeStorageIpc()
  registerHotkeysIpc()
  registerWhisperIpc(mainWindow)
  registerOllamaIpc(mainWindow)
  registerModelCatalogIpc()
  registerModelStorageIpc(mainWindow)  // Settings → Model Weights: usage + relocation
  registerBankrIpc()    // no-op shim — router registration above handles the channel
  registerPlaybookIpc() // no-op shim — router registration above handles the channel
  registerRolesIpc()    // no-op shim — router registration above handles the channel
  registerWindowIpc(mainWindow, TRANSPARENT_WINDOW)  // custom min/max/close + reports window transparency
  registerNodesIpc()            // nodes canvas: save/list/load flows (storage root)
  registerCodexIpc()            // Codex worker sidecar: status/install/login
  registerTelegramIpc()         // Telegram remote channel into the TACHI agent
  startupPhase('telegram-sync', () => syncTelegramService())   // starts the long-poll only if enabled + token + not private
  startupPhase('catalog-refresher', () => startCatalogRefresher()) // auto-refresh provider model catalogs (12h + boot)
  registerGraphIpc(mainWindow)  // nodes canvas: compile + EXECUTE a graph as an agent-kit Network
  registerSchedulerIpc()        // local scheduler: CRUD over saved flow/prompt jobs
  startupPhase('scheduler', () => initScheduler(mainWindow!))  // …and its timer wheel (boot catch-up + powerMonitor wake)
  registerDesignIpc(mainWindow) // Design tab: stream a self-contained HTML design from a prompt+preset
  startupPhase('rag', () => registerRagIpc())              // local folder RAG: index/search (MiniLM in-process)
  registerDoctorIpc()           // sidecar health check: execute-probe every external binary
  startupPhase('chat-archive', () => registerChatArchiveIpc()) // chat full-text search: SQLite FTS5 (wasm) over the JSON archive
  registerBackupIpc(mainWindow) // bulk export/backup: save/load JSON + chats→Markdown
  registerFreellmapiIpc()       // freellmapi model list + fallback sort mode
  registerLlamaCppIpc(mainWindow) // llama.cpp local-LLM sidecar (truly local; downloads SHA256-verified against authoritative digests, fail-closed in packaged builds)
  startupPhase('download-manager', () => initDownloadManager()) // resumable download manager: restore persisted queue (PAUSED — resume is a user click on the strip)
  registerDownloadsIpc()          // downloads:* — pause/resume/cancel/list for the DownloadStrip
  registerSdCppIpc(mainWindow)    // stable-diffusion.cpp local image-gen sidecar (zero-terminal)
  registerPiperIpc(mainWindow)    // piper local text-to-speech sidecar (zero-terminal)
  // PRIVATE MODE — main-process mirror + broadcast. The persisted strict flag is
  // read HERE and injected so privacy.ipc stays settings-store-free (it is
  // imported by many electron-free-ish callers).
  registerPrivacyIpc({ strictPrivacyMode: loadSettings().strictPrivacyMode })
  registerInboxIpc()            // PRIVATE MODE Tier 4 — capability inbox bridge
  registerRouterStatsIpc()      // smart-router savings/bandit telemetry (read-only)
  registerGnapIpc(mainWindow)   // gnap: multi-agent coordination via git
  registerWalletConfirm(mainWindow)  // S6: confirm-modal gate before real tx broadcast
  registerParallelAgentsIpc(mainWindow) // parallel coding tasks via git worktrees

  // Initialise the hotkey manager and register global shortcuts from saved settings.
  startupPhase('hotkeys', () => {
    initHotkeyManager(mainWindow!)
    const { hotkeys } = loadSettings()
    registerAllHotkeys(hotkeys ?? {})
    registerQuickAsk(mainWindow!) // global quick-ask launcher (hotkey 'quick-ask')
  })

  // theme:apply used to repaint the native titleBarOverlay. We no longer
  // have one — the custom <TitleBar /> picks its colors from the active
  // CSS theme, so this handler is a no-op kept for back-compat with
  // settings code that still calls it.
  ipcMain.handle('theme:apply', () => {
    /* no-op — TitleBar reads CSS vars and re-renders on theme change */
  })
  startupMark('ipc-registration-end')
}

// Crash telemetry — FIRST executable wiring on purpose: the app fully exited
// twice under automation with zero evidence (no dump, no log). This registers
// every process-death signal Electron exposes (render-process-gone,
// child-process-gone, uncaughtExceptionMonitor, unhandledRejection,
// before-quit breadcrumb) so the NEXT crash leaves a JSONL trail in
// <userData>/logs/crash.jsonl. uncaughtExceptionMonitor observes fatals
// WITHOUT altering Electron's default fatal path; every handler is wrapped so
// logging itself can never take the app down.
installCrashTelemetry({ app, getUserDataDir: () => app.getPath('userData') })

// Patch global fetch in main process as early as possible so that every
// outbound request — including those made during app startup — is captured.
installFetchPatch()

// Must run BEFORE app 'ready' — registers the tachi-media:// scheme used to
// serve generated media artifacts to the renderer (file:// won't load there).
registerMediaScheme()
// Likewise, the tachi-preview:// scheme that serves the Design tab's live
// preview HTML with its OWN CSP (a blob iframe inherits the strict renderer CSP
// and silently blocks the preview's inline scripts in packaged builds).
registerPreviewScheme()
// Let the Design preview's Remotion <Player autoPlay> start WITH sound —
// Chromium's default autoplay policy blocks audible playback until a user
// gesture, which reads as "my <Audio> is broken" in the sandboxed iframe.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

startupMark('module-eval-end')

app.whenReady().then(async () => {
  // R8a: everything before this is Electron bootstrap + our 98 static top-level
  // imports; everything after is our own wiring. The gap between
  // `module-eval-end` and `app-ready` is what the step-2 import refactor targets.
  startupMark('app-ready')
  Menu.setApplicationMenu(null)

  // Windows: match the electron-builder appId so the taskbar groups the app
  // under its own icon/identity (and toast notifications attribute correctly)
  // when launched from the installed Start-menu/desktop shortcut.
  if (process.platform === 'win32') app.setAppUserModelId('studio.tachi.desktop')

  // ── Right-click context menu (every window, incl. quick-ask/overlay) ──────
  // Electron ships NO native context menu — without this, right-click →
  // copy/paste simply doesn't exist anywhere in the app (user-reported).
  // Contextual roles only: editable fields get cut/paste, selections get copy,
  // misspellings get suggestions; plain canvas right-clicks show nothing.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('context-menu', (_ev, params) => {
      const items: Electron.MenuItemConstructorOptions[] = []
      for (const s of params.dictionarySuggestions.slice(0, 4)) {
        items.push({ label: s, click: () => contents.replaceMisspelling(s) })
      }
      if (items.length > 0) items.push({ type: 'separator' })
      if (params.isEditable) {
        items.push(
          { role: 'undo', enabled: params.editFlags.canUndo },
          { type: 'separator' },
          { role: 'cut', enabled: params.editFlags.canCut },
          { role: 'copy', enabled: params.editFlags.canCopy },
          { role: 'paste', enabled: params.editFlags.canPaste },
          { role: 'selectAll' },
        )
      } else if (params.selectionText.trim()) {
        items.push({ role: 'copy' }, { role: 'selectAll' })
      } else if (params.linkURL) {
        items.push({ label: 'Copy link', click: () => { require('electron').clipboard.writeText(params.linkURL) } })
      }
      if (items.length > 0) Menu.buildFromTemplate(items).popup()
    })
  })

  // Serve media artifacts under <userData>/media via tachi-media://.
  registerMediaProtocol()
  // Serve the Design tab's live preview HTML via tachi-preview:// (own CSP).
  registerPreviewProtocol()

  // ── Display-media request handler ───────────────────────────────────────
  // Required for navigator.mediaDevices.getDisplayMedia() to work in the
  // overlay renderer without a system picker UI. Without this, Electron
  // returns an error and the renderer falls back to a black frame. We grab
  // the primary screen source and hand it back. The optional `useSystemPicker`
  // is macOS-15+-only so we don't pass it — default (false) routes to *this*
  // handler on all platforms, which is what we want for Windows.
  // Docs: https://www.electronjs.org/docs/latest/api/session#sessessetdisplaymediarequesthandlerhandler-opts
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    const primary  = screen.getPrimaryDisplay()
    desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        if (sources.length === 0) {
          // No screens available — pass nothing so the request rejects cleanly.
          callback({})
          return
        }
        const primaryIdStr = String(primary.id)
        const source =
          sources.find(s => (s as unknown as { display_id?: string }).display_id === primaryIdStr)
          ?? sources[0]
        callback({ video: source })
      })
      .catch((err) => {
        console.warn('[displayMedia] getSources failed:', err)
        callback({})
      })
  })

  startupPhase('create-window', () => createWindow())
  if (mainWindow) {
    startupPhase('tray', () => createTray(mainWindow!))
    if (app.isPackaged) startupPhase('auto-update', () => setupAutoUpdate(mainWindow!))
  }
  // Start freellmapi in the background only if it has been installed.
  // If not installed, the renderer's onboarding flow will trigger sidecar:install.
  if (isFreellmapiInstalled()) {
    startupPhaseAsync('freellmapi-start', startFreellmapi()).catch(err => {
      console.warn('[sidecar] freellmapi failed to start:', err)
    })
  }

  // Auto-start the in-process MCP server (Clauge-style). The server binds
  // 127.0.0.1:7421 with +5 fallback so even if a previous run is stuck on a
  // port, this one picks the next free one. Default-enabled; the user can
  // toggle via the ProvidersCard row.
  startupPhaseAsync('mcp-server-start', startInProcessMcp()).catch(err => {
    console.warn('[mcp] auto-start failed:', err)
  })

  // Auto-start the local OpenAI-compatible API server (user-wants #1): one
  // Bearer-gated loopback URL (127.0.0.1:11435/v1, +5 fallback) serving
  // FreeLLM + llama.cpp to external tools. Toggle sits next to the MCP row.
  startupPhaseAsync('api-server-start', startLocalApiServer()).catch(err => {
    console.warn('[api-server] auto-start failed:', err)
  })
  // The quit-time handle on the RIFE runner, fetched here rather than in
  // will-quit: that handler cannot await, so an `import()` issued from inside it
  // would resolve one microtask after the process had already started tearing
  // down. The import is DYNAMIC because main.ts deliberately names no RIFE
  // module statically (rifeWiring.test.ts pins that) — and it costs nothing,
  // because rife-runner is already evaluated in the bundle via the graph runtime.
  void import('./services/rife-runner')
    .then(m => { stopRifeRuns = m.cancelAllRifeRuns })
    .catch(() => { /* the feature is simply unavailable then */ })

  startupMark('when-ready-end')
  // Safety net: if the renderer never fires did-finish-load (load failure, a
  // headless/CI run with no window), still emit the boot line so a broken start
  // is measurable rather than silent.
  setTimeout(() => logStartupSummary('whenReady + 15s (no did-finish-load)'), 15_000)
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
// PRIVATE MODE Tier 4: release any agents blocked on a pending inbox decision
// before the sidecars get torn down in will-quit. Each pending Promise resolves
// as 'deny' so the harness unwinds cleanly instead of dangling.
app.on('before-quit', () => {
  capabilityService.cancelAll()
  // Same guarantee for the MODAL path: every tool blocked on a permission card
  // is denied ('cancelled') so no await outlives the window that owned it.
  pendingPermissions.cancelAll()
})
// ── QUIT MUST NOT LEAVE THE GPU (AND GIGABYTES) BEHIND ────────────────────────
//
// A local render is the one operation in this app that can hold the whole GPU
// for over an hour, and quitting issued no cancel at all: sd-cli kept the card
// pinned (owner-reported, personally hit) and rife's rife-ncnn-vulkan/ffmpeg
// children were in the same position — with a multi-gigabyte PNG sequence in
// %TEMP% that their own `finally` never got to delete, because a `finally` does
// not run when the PROCESS is killed.
//
// MEASURED ON WINDOWS (2026-07-31, this machine) — the answer is not the obvious
// one, and the shape of this handler follows from it:
//   • libuv puts every NON-DETACHED child in a global job with
//     KILL_ON_JOB_CLOSE, so a child does die when the main process finally
//     exits — but only then, and hard, with no chance for its own cleanup.
//     POSIX has no such job: there the child simply outlives us.
//   • a `taskkill` (killProcessTree's Windows arm) issued and then ABANDONED
//     dies inside that same job: with the parent exiting immediately the victim
//     survived every time; the kill only landed once the parent stayed alive
//     ~300 ms. "Issue the kill and exit" is therefore not a teardown.
//
// So: condemn both engines FIRST (at the moment the user asked, not whenever the
// process happens to fall over), then hold the quit open for a bounded drain —
// which is what lets the kill land in-process and lets rife's `finally` delete
// its frame directory, the one thing no OS-level reaping will ever do for us.
// The boot sweep in graph-to-agentkit is the backstop for whatever the timebox
// does not cover.
let stopRifeRuns: (() => { cancelled: number; drained: Promise<void> }) | null = null

/** Ceiling on how long a quit may be held waiting for a condemned engine. */
const QUIT_KILL_GRACE_MS = 4_000

/**
 * Wait for sd-cli to actually be gone. `isGenerating()` reads the client's own
 * handle, which its `close`/`error` listeners clear — so this polls a REAL
 * signal rather than sleeping a guessed number, and gives up at the cap.
 */
function untilSdCliIsGone(capMs: number): Promise<void> {
  return new Promise<void>(resolve => {
    const t0 = Date.now()
    const tick = (): void => {
      if (!isGenerating() || Date.now() - t0 >= capMs) { resolve(); return }
      setTimeout(tick, 50)
    }
    tick()
  })
}

/** Re-entrancy latch: the drain below prevents the first quit and re-issues it,
 *  and the teardown must not run twice. */
let quitTeardownStarted = false

app.on('will-quit', (e) => {
  if (quitTeardownStarted) return
  quitTeardownStarted = true

  // Everything here is guarded: a quit is never blocked by a teardown step that
  // throws. Both cancels are issued before any of the teardown below can fail.
  const waits: Array<Promise<void>> = []
  // 1. sd-cli — one child at a time, killed by tree.
  try {
    if (cancelGeneration().cancelled) waits.push(untilSdCliIsGone(QUIT_KILL_GRACE_MS))
  } catch { /* nothing running, or already gone */ }
  // 2. every in-flight interpolation, plus the window its `finally` needs.
  try {
    const rife = stopRifeRuns?.()
    if (rife && rife.cancelled > 0) waits.push(rife.drained)
  } catch { /* same */ }

  destroyTray()
  stopAllSidecars()
  stopAllMCPServers().catch(() => {})
  stopOllamaIfWeStartedIt()
  // Tear down the nookplot runtime WebSocket cleanly.
  import('./services/nook-service').then(m => m.stopNook()).catch(() => {})
  // Tear down any live agent browser sessions (each is a whole Chromium).
  import('./services/browser-session').then(m => m.closeAllBrowserSessions()).catch(() => {})
  stopTelegramService()
  stopScheduler()
  stopCatalogRefresher()
  // Kill the auto-spawned Aeon dashboard (next dev) too — otherwise it stays
  // bound to its port across app restarts.
  import('./services/aeon-dashboard-service').then(m => m.stopDashboard()).catch(() => {})

  // Hold the quit open ONLY when a local render was actually in flight, and only
  // for the timebox. Every other quit — the overwhelming majority — falls off the
  // end of this handler exactly as it did before. The re-issued quit re-enters
  // here and is short-circuited by the latch, so it proceeds by default.
  if (waits.length > 0) {
    e.preventDefault()
    void Promise.all(waits)
      .catch(() => { /* neither wait rejects; belt and braces */ })
      .then(() => { app.quit() })
  }
})
