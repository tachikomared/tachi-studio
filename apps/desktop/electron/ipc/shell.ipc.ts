// apps/desktop/electron/ipc/shell.ipc.ts
//
// Migrated to the typed IPC router (Sprint C1).
// Wire channel "shell:open-external" is UNCHANGED — the renderer call
// window.tachi.shell.openExternal(url) continues to work identically.
//
// The legacy registerShellIpc() export is kept as a no-op so main.ts
// can be updated incrementally without a compile break.

import { shell } from 'electron'
import { z } from 'zod'
import { defineRouter, route } from '../ipc-router/router'

// ── Allowlist ─────────────────────────────────────────────────────────────────

// Hostname allowlist for shell.openExternal. The renderer can only open URLs
// whose hostname (case-insensitive) matches one of these (or any subdomain of
// the entries marked with a leading dot). This prevents a compromised renderer
// from launching arbitrary external apps via custom URL schemes or opening
// drive-by-download links.
const ALLOWED_HOSTS = new Set<string>([
  // OAuth + identity
  'console.anthropic.com',
  'claude.ai',
  'docs.claude.com',
  'openrouter.ai',
  'github.com',
  'api.github.com',
  // Provider docs / signup
  'gitlawb.com',
  'opengateway.gitlawb.com',
  'openclaude.gitlawb.com',
  'docs.openclaw.ai',
  'openclaw.ai',
  'docs.bankr.bot',
  'bankr.bot',
  'api.bankr.bot',
  'x.com',
  'platform.openai.com',
  'console.groq.com',
  'console.cerebras.ai',
  'console.mistral.ai',
  'aistudio.google.com',
  'console.cloud.google.com',
  'cohere.com',
  'developers.cloudflare.com',
  'cloud.sambanova.ai',
  // freellmapi "Get key" signup pages (freellmapi-providers.ts signupUrl) —
  // every entry there MUST be openable or the button silently no-ops.
  'cloud.cerebras.ai',
  'dashboard.cohere.com',
  'dash.cloudflare.com',
  'open.bigmodel.cn',
  'build.nvidia.com',
  'pollinations.ai',
  'llm7.io',
  'endpoints.ai.cloud.ovh.net',
  'console.scaleway.com',
  'github.com/marketplace/models',
  'huggingface.co',
  // Civitai model pages — the "Open on Civitai" link in the catalog's detail
  // panel. BOTH hosts, because civitai.com is the SFW site and civitai.red
  // carries SFW+NSFW (they split on 2026-04-15; see civitai-search.ts), and the
  // panel opens the page on the host its data was SERVED from. Without .red an
  // unlocked user's link would reject and the button would silently no-op —
  // exactly the dead control the catalog's honesty law forbids. The url itself
  // is built in MAIN (civitaiModelPageUrl) from the resolved mode, never
  // assembled in the renderer.
  'civitai.com',
  'civitai.red',
  // Runtime ecosystem docs / homepages used by Studio's "Open" buttons
  'opencode.ai',
  'ollama.com',
  // Sources / search
  'brave.com',
  'api.search.brave.com',
  'duckduckgo.com',
  // Project & docs
  'github.com/aaronjmars/aeon',
  'github.com/Gitlawb/openclaude',
  'github.com/Alishahryar1/free-claude-code',
  'github.com/openai/codex',
  // nookplot protocol
  'nookplot.com',
  'gateway.nookplot.com',
  'github.com/nookprotocol',
])

const ALLOWED_SUFFIXES = ['.github.com', '.githubusercontent.com', '.gitlawb.com']

// Loopback hosts — services running on the user's own machine. We trust
// these because (a) the renderer is already running locally and (b) any
// surface that can already make HTTP requests to these ports can already
// exfiltrate from them. Opening the URL in the system browser is no worse.
// Includes the "0.0.0.0" wildcard-bind shorthand some local servers print.
// NOTE: URL.hostname returns IPv6 literals WITH brackets ("[::1]"), so the
// bracketed form is the one that actually matches — the bare "::1" never would.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

// Custom protocol URIs allowed for OS-handoff (launches installed app).
// Each only works if the user has the app installed — there's no
// drive-by-install attack surface. We bound the set so a compromised
// renderer can't trigger arbitrary protocol handlers.
const ALLOWED_PROTOCOLS_NON_HTTP = new Set([
  'vscode:',
  'vscode-insiders:',
  'lmstudio:',
  'jan:',
  'cursor:',
])

// Exported so main.ts's setWindowOpenHandler enforces the SAME allowlist —
// window.open / target=_blank must not be a bypass around shell:open-external.
export function isExternalUrlAllowed(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl)

    // Custom protocols for OS app handoff (vscode://, lmstudio://, etc.)
    if (ALLOWED_PROTOCOLS_NON_HTTP.has(u.protocol)) return true

    // Otherwise must be http(s).
    if (!['https:', 'http:'].includes(u.protocol)) return false

    const host = u.hostname.toLowerCase()

    // Always allow loopback — local servers shipped/spawned by TachiDesk
    // (OpenClaw gateway, Ollama, ComfyUI, Aeon dashboard iframe, etc.).
    if (LOOPBACK_HOSTS.has(host)) return true
    // *.localhost is also a loopback alias per RFC 6761.
    if (host.endsWith('.localhost')) return true

    if (ALLOWED_HOSTS.has(host)) return true
    if (ALLOWED_SUFFIXES.some(s => host.endsWith(s))) return true
    return false
  } catch { return false }
}

// ── Router definition ─────────────────────────────────────────────────────────

export const shellRouter = defineRouter('shell', {
  openExternal: route({
    input: z.object({ url: z.string().url() }),
    output: z.object({ ok: z.literal(true) }),
    handle: async ({ url }) => {
      if (!isExternalUrlAllowed(url)) {
        throw new Error(
          `Refusing to open URL — hostname not in allowlist: ${new URL(url).hostname}`,
        )
      }
      await shell.openExternal(url)
      return { ok: true as const }
    },
  }),

  // Reveal a file or directory in the OS file explorer (Explorer on Windows,
  // Finder on macOS). The path must be absolute; relative paths are rejected.
  // No allowlist is needed — this only shows files the user already saved via
  // TachiDesk, and shell.showItemInFolder can't execute or exfiltrate.
  revealInFolder: route({
    input: z.object({ path: z.string().min(1) }),
    output: z.object({ ok: z.literal(true) }),
    handle: async ({ path: absPath }) => {
      if (!require('path').isAbsolute(absPath)) {
        throw new Error(`revealInFolder requires an absolute path, got: ${absPath}`)
      }
      shell.showItemInFolder(absPath)
      return { ok: true as const }
    },
  }),
})

// ── Legacy shim ───────────────────────────────────────────────────────────────
// Kept so main.ts can call registerShellIpc() without compile error while
// the caller is updated to use registerRouter(shellRouter) instead.
// Remove once main.ts is updated.
/** @deprecated Use registerRouter(shellRouter) from ipc-router/router instead. */
export function registerShellIpc(): void {
  // No-op: registerRouter(shellRouter) is called from main.ts
}
