// apps/desktop/electron/services/egress-policy.ts
//
// PRIVATE MODE (Tier 2) — central egress policy.
//
// This module is the single source of truth for "may this main-process code
// path reach the public internet right now?" It is consulted from every
// network-touching code path in the main process:
//
//   - chat-service.ts        — guards each provider branch at dispatch time
//   - ipc/agent.ipc.ts       — guards harness invocation (TACHI / OpenClaude)
//   - openclaude wrapper     — DUPLICATED inline at install time (see
//                              openclaude-installer.ts WRAPPER_TEMPLATE) so the
//                              spawned sidecar can enforce without IPC bounce.
//
// Two policy axes:
//
//   1. Provider classification — `classifyProvider(id)` returns 'cloud',
//      'local', or 'unknown'. In PRIVATE MODE only 'local' is permitted;
//      'unknown' defaults to denied (paranoid). This is the gate for
//      chat-service and agent.ipc.
//
//   2. Tool / shell egress     — `checkToolEgress(name)` and
//      `checkBashCommandEgress(cmd)` deny WebFetch, WebSearch, and shell
//      commands that touch the network (curl, wget, ssh, scp, rsync, nc).
//      This is the gate enforced inside the openclaude wrapper's canUseTool
//      hook (where the denylists are inlined — see note above).
//
// PRIVATE MODE is the renderer's source of truth; this module reads the
// mirror via `getCurrentPrivacyMode()` from ipc/privacy.ipc.ts so the gate is
// synchronous (no IPC round-trip).

import { getCurrentPrivacyMode } from '../ipc/privacy.ipc'
import { isSafeOutboundUrl as _isSafeOutboundUrl } from './ssrf-guard'

// Re-export the SSRF guard so callers only need one import.
// isSafeOutboundUrl / assertSafeUrl are mode-independent: they block non-global
// IPs regardless of PRIVATE MODE.  Local providers route to loopback — pass
// allowLoopback:true for those paths (see checkUrlEgress below).
export { isSafeOutboundUrl, assertSafeUrl, SsrfBlockedError } from './ssrf-guard'

// Provider IDs that egress over the public internet to third-party endpoints.
// Both the discovery-layer ids (model-discovery.ts PROBES keys) and the
// chat-service.ts longer ids are listed because either name surfaces depending
// on the dispatch path.
//
// freellmapi-local routes to 127.0.0.1 BUT the sidecar internally talks to
// cloud providers (Pollinations, LLM7, NVIDIA, etc.). When PRIVATE MODE is
// on, even freellmapi-local must be blocked since the sidecar is a proxy
// to cloud endpoints.
//
// free-claude-code likewise proxies to Anthropic via OAuth — also cloud.
export const CLOUD_PROVIDER_IDS = [
  // Short / discovery-layer ids
  'bankr', 'bankr-gateway',
  'openrouter', 'openrouter-oauth',
  'anthropic', 'anthropic-oauth', 'anthropic-direct',
  'opengateway',
  // Kilo Gateway — RETAINED after the standalone provider was removed (Kilo is
  // now an upstream inside the FreeLLM local router, not a pickable provider).
  //
  // Why the id stays even though nothing dispatches it any more: this gate is
  // keyed on the provider id carried by the request, and old persisted
  // conversations and cost-ledger rows still carry 'kilo-gateway'. Keeping the
  // entry means replaying one of those in PRIVATE MODE is denied with the real
  // destination named, instead of falling to the "unknown provider" wording.
  // Either way it is DENIED — classifyProvider treats unknown as not-local — so
  // this is about the quality of the refusal, not about whether it refuses.
  //
  // The live Kilo traffic is covered elsewhere and must stay that way: the app
  // reaches Kilo only THROUGH the relay, and 'freellmapi'/'freellmapi-local'
  // below are already classified cloud, so PRIVATE MODE blocks the relay as a
  // single unit before it can forward to api.kilo.ai. There is no per-upstream
  // egress decision inside the sidecar, which is exactly why gating the relay
  // as one unit is the thing that must never be weakened.
  'kilo-gateway',
  // Surplus Intelligence — crypto-native LLM marketplace on Base; cloud egress.
  'surplus', 'surplus-intelligence',
  // Venice — privacy-first inference API (api.venice.ai); cloud egress.
  'venice',
  // imgnAI Katana — text + image + video gateway (kat.imgnai.com); cloud egress.
  'imgnai',
  // Pollinations — KEYLESS image generation (image.pollinations.ai). No key,
  // no account, but the prompt still travels to their server: cloud egress.
  // Listed explicitly (unknown⇒denied would already block it) so the PRIVATE
  // MODE denial names the real destination instead of "unknown provider".
  'pollinations',
  'openai',
  'groq',
  'mistral',
  'cerebras',
  'cohere',
  // ── WEIGHTS SOURCES ────────────────────────────────────────────────────────
  // Not LLM providers, but they are network egress to a third party and the
  // gate is the same gate. Listed explicitly rather than relying on the
  // unknown⇒denied default, so the denial REASON names the real destination.
  //
  // civitai — model browse/search/download (civitai.com). Also the keychain id.
  'civitai',
  // huggingface — GGUF search in hf-search.ts. This one was a live PRIVATE MODE
  // HOLE until 2026-07-28: catalog:search-hf reached huggingface.co with no
  // egress check at all, so PRIVATE MODE silently did not cover the Catalog's
  // search box (risk R6). Pinned by test/unit/civitaiEgress.test.ts.
  'huggingface', 'hf',
  // freellmapi sidecar — proxies to cloud, treat as cloud.
  'freellmapi', 'freellmapi-local',
  // free-claude-code sidecar — proxies to Anthropic, treat as cloud.
  'free-claude-code',
] as const

// Provider IDs that are TRULY local — no public internet egress.
// Ollama (talking to local 127.0.0.1:11434 daemon) and llama.cpp (our own
// bundled `llama-server` on a local port) both qualify. SHA-verified GGUF
// weights make llama.cpp the Vitalik-aligned default — see secure_llms.
export const LOCAL_PROVIDER_IDS = ['ollama', 'ollama-local', 'llama-cpp', 'llama-cpp-local', 'sd-cpp', 'sdcpp', 'piper'] as const

export type ProviderClassification = 'cloud' | 'local' | 'unknown'

export function classifyProvider(providerId: string | null | undefined): ProviderClassification {
  if (!providerId) return 'unknown'
  if ((LOCAL_PROVIDER_IDS as readonly string[]).includes(providerId)) return 'local'
  if ((CLOUD_PROVIDER_IDS as readonly string[]).includes(providerId)) return 'cloud'
  return 'unknown'  // unknown defaults to cloud-treatment (paranoid)
}

export interface EgressDecision {
  allowed: boolean
  reason?: string
}

/**
 * Check whether a provider call is allowed under the current privacy mode.
 *   'open'    → always allowed.
 *   'private' → only LOCAL providers allowed; unknown defaults to denied.
 */
export function checkProviderEgress(providerId: string | null | undefined): EgressDecision {
  const mode = getCurrentPrivacyMode()
  if (mode === 'open') return { allowed: true }
  const kind = classifyProvider(providerId)
  if (kind === 'local') return { allowed: true }
  return {
    allowed: false,
    reason: `PRIVATE MODE blocks ${kind} provider "${providerId ?? '(none)'}". Toggle off in Command Palette or switch to a local provider (Ollama).`,
  }
}

/**
 * PRIVATE MODE egress gate for a USER-ADDED custom OpenAI-compatible endpoint
 * (USER-PAINS T17). Locality can't be derived from the provider id alone (it's
 * `custom:<opaque>`), so the caller passes the resolved hostname classification
 * (`local` = loopback/RFC1918/LAN — see @tachi/core isLocalCustomEndpoint).
 *
 *   'open'    → always allowed.
 *   'private' → LAN-local endpoints allowed (reaching an LM Studio box at
 *               192.168.x is the point of the feature); cloud endpoints blocked.
 */
export function checkCustomEndpointEgress(local: boolean): EgressDecision {
  const mode = getCurrentPrivacyMode()
  if (mode === 'open') return { allowed: true }
  if (local) return { allowed: true }
  return {
    allowed: false,
    reason: 'PRIVATE MODE blocks custom endpoints on non-local hosts. Toggle it off or point the endpoint at a localhost/LAN address.',
  }
}

/**
 * PRIVATE MODE egress gate for a user-installed MCP server (USER-PAINS T11).
 * An MCP server is an arbitrary third-party binary; we classify it from the
 * marketplace catalog's `requiresNetwork` flag (see mcp-catalog.ts), or as
 * network-needing when the user added it by hand and we cannot know.
 *
 *   'open'    → always allowed.
 *   'private' → only servers declared network-free may run (filesystem, sqlite,
 *               memory, git, sequential-thinking). Everything else — including
 *               every hand-added custom server — is refused, matching the
 *               paranoid-by-default posture of classifyProvider().
 *
 * Enforced twice: mcp-manager.startServer() refuses to spawn the process at
 * all, and the TACHI bridge filters descriptors again at session build time so
 * a server started BEFORE the toggle flipped cannot leak into a private run.
 */
export function checkMcpServerEgress(
  serverName: string,
  requiresNetwork: boolean,
): EgressDecision {
  const mode = getCurrentPrivacyMode()
  if (mode === 'open') return { allowed: true }
  if (!requiresNetwork) return { allowed: true }
  return {
    allowed: false,
    reason: `PRIVATE MODE blocks MCP server "${serverName}" — it reaches the public internet. Toggle PRIVATE MODE off in the Command Palette, or use a local-only server (Filesystem, SQLite, Memory, Git).`,
  }
}

/**
 * Throw on denial. Use this when you want fail-fast semantics inside an IPC
 * handler — the error string will surface to the renderer as the response.
 */
export function enforceProviderEgress(providerId: string | null | undefined): void {
  const d = checkProviderEgress(providerId)
  if (!d.allowed) throw new Error(d.reason!)
}

/**
 * Tool-call gate for the openclaude wrapper canUseTool hook.
 * Returns true if the tool may run, false otherwise.
 * Denied tool names in PRIVATE MODE: WebFetch, WebSearch (any tool that
 * reaches the public internet from inside the agent loop).
 *
 * EXPORTED because openclaude-installer.ts's WRAPPER_TEMPLATE interpolates
 * this set at build time (the wrapper runs in a spawned sidecar and cannot
 * import this module at runtime, but the installer CAN — so the wrapper's
 * copy is DERIVED, never hand-maintained). The previous hand-copied version
 * drifted: it was missing `browse` and `deep_research` (fixed 2026-08-01).
 */
export const NETWORK_TOOLS_DENIED_IN_PRIVATE = new Set([
  'WebFetch', 'WebSearch', 'browse', 'deep_research',
  // Codex worker talks to OpenAI/ChatGPT — defense-in-depth: the loop doesn't
  // even wire it in private mode, this entry catches any other dispatch path.
  'codex_worker',
  // Interactive browser sessions — same story: unwired in private mode, and
  // browser-session.ts re-guards every navigation; this is the third fence.
  'browser_open', 'browser_act', 'browser_read', 'browser_close',
])

export function checkToolEgress(toolName: string): EgressDecision {
  const mode = getCurrentPrivacyMode()
  if (mode === 'open') return { allowed: true }
  if (NETWORK_TOOLS_DENIED_IN_PRIVATE.has(toolName)) {
    return {
      allowed: false,
      reason: `PRIVATE MODE blocks network tool "${toolName}". Agents may only read/write within workspaceRoot and shell to local commands.`,
    }
  }
  return { allowed: true }
}

/**
 * Check whether a URL may be fetched under the current privacy mode.
 *   'open'    → always allowed.
 *   'private' → only loopback hostnames allowed (localhost / 127.0.0.1 / ::1).
 *
 * Other "local-ish" names (mDNS .local, RFC1918 private IPs like 192.168.x.x,
 * 10.x.x.x, 172.16-31.x.x) are intentionally DENIED by default since the
 * local network includes routers, NAS, IoT devices and other devices the
 * user may not want an MCP-driven agent reaching. A future PRIVATE MODE
 * setting could whitelist private CIDRs explicitly.
 *
 * Used by the in-process MCP server's http_fetch tool to gate outbound HTTP
 * by external agents (Claude Desktop, Codex, etc.).
 */
export function checkUrlEgress(rawUrl: string): EgressDecision {
  const mode = getCurrentPrivacyMode()
  if (mode === 'open') return { allowed: true }
  let host: string
  try {
    host = new URL(rawUrl).hostname.toLowerCase()
  } catch {
    return { allowed: false, reason: `PRIVATE MODE: invalid URL "${rawUrl}"` }
  }
  const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
  if (LOOPBACK_HOSTS.has(host)) return { allowed: true }
  return {
    allowed: false,
    reason: `PRIVATE MODE blocks fetch to "${host}". Only loopback hosts allowed. Toggle off in Command Palette to allow public internet.`,
  }
}

/**
 * Async variant of checkUrlEgress that also runs the full SSRF guard
 * (DNS resolution + non-global IP classification) on top of the privacy-mode
 * check.  This is the recommended gate for any agent / MCP http_fetch path.
 *
 *   'private' -> loopback-only (as per checkUrlEgress) AND SSRF-safe.
 *   'open'    -> SSRF guard still runs -- blocks RFC1918/loopback/link-local
 *               destinations even when the user has not toggled PRIVATE MODE,
 *               because an agent should never silently reach 192.168.x.x (a
 *               router/NAS/IoT device) just because open mode is on.
 *
 * Local providers (ollama, llama.cpp, sd.cpp, piper) route to 127.x -- those
 * callers should pass allowLoopback:true.
 */
export async function checkUrlEgressSafe(
  rawUrl: string,
  opts: { allowLoopback?: boolean } = {},
): Promise<EgressDecision> {
  // 1. Privacy-mode fast gate (synchronous, no DNS).
  const sync = checkUrlEgress(rawUrl)
  if (!sync.allowed) return sync

  // 2. SSRF guard -- always-on regardless of privacy mode.
  const safe = await _isSafeOutboundUrl(rawUrl, opts)
  if (!safe) {
    let host = '(unknown)'
    try { host = new URL(rawUrl).hostname } catch { /* ignore */ }
    return {
      allowed: false,
      reason: `SSRF guard: "${host}" resolves to a non-global IP address. Blocked to prevent SSRF attacks.`,
    }
  }

  return { allowed: true }
}

/**
 * Bash command denylist for PRIVATE MODE. Strict — denies any command line
 * containing curl/wget/nc/ssh/scp/rsync/http/https as separate tokens.
 * Used by the openclaude wrapper canUseTool hook for Bash tool gates.
 *
 * EXPORTED (like NETWORK_TOOLS_DENIED_IN_PRIVATE above) so the wrapper copy
 * in openclaude-installer.ts WRAPPER_TEMPLATE is interpolated from these
 * regexes at build time instead of being a second hand-maintained copy.
 */
// Match command name at a token position only — preceded by start-of-string,
// whitespace, or a shell separator (; & | ( ` $), and followed by end-of-string,
// whitespace, or a shell separator/option. `\b` boundaries were too loose:
// `ls /tmp/curl-results/` would falsely match because `\b` triggers between
// `/` and `c` and between `l` and `-`. The explicit anchors below only match
// the keyword in actual command-token positions.
// Command-token network tools. Added the idiomatic Windows download tools
// (PowerShell is the default shell — tools.ts) that the original list missed:
// iwr / irm / Invoke-WebRequest / Invoke-RestMethod / certutil / bitsadmin /
// Start-BitsTransfer (audit 2026-06-12, dimension 6).
export const BASH_NETWORK_DENY = /(?:^|[\s;&|(`$])(curl|wget|nc|netcat|ssh|scp|rsync|aria2c|axel|fetch|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|certutil|bitsadmin|Start-BitsTransfer)(?=$|[\s;&|)`])/i

// Interpreter one-liners (python -c / node -e / perl -e / …) whose inline code
// references a network primitive. Heuristic — surgical enough to avoid blocking
// a local `node build.js` while catching `python -c "import urllib…"` exfil.
export const BASH_INTERPRETER_EXFIL = /\b(python3?|node|deno|bun|perl|ruby|php)\b[^|;&]*\s-(c|e)\b[^|;&]*\b(urllib|requests|httplib|socket|fetch|https?|XMLHttpRequest|net\b|Net::HTTP|file_get_contents|urlopen)\b/i

/**
 * Pure: does this shell command line invoke a network tool / network one-liner?
 * Returns the matched fragment (for the denial reason) or null. Mode-independent
 * so it can be unit-tested without the privacy mirror.
 */
export function matchesNetworkCommand(command: string): string | null {
  const m = command.match(BASH_NETWORK_DENY)
  if (m) return m[0].trim()
  const i = command.match(BASH_INTERPRETER_EXFIL)
  if (i) return i[0].slice(0, 48)
  return null
}

export function checkBashCommandEgress(command: string): EgressDecision {
  const mode = getCurrentPrivacyMode()
  if (mode === 'open') return { allowed: true }
  const hit = matchesNetworkCommand(command)
  if (hit) {
    return {
      allowed: false,
      reason: `PRIVATE MODE blocks network shell commands. Detected: ${hit}`,
    }
  }
  return { allowed: true }
}

/**
 * Combined tool-call egress check: looks at the tool name first, and (when
 * the tool is a shell-executing tool) also inspects the command string for
 * network keywords.
 *
 * Used by the PRE-EMPTIVE TACHI tool gate in agent.ipc.ts (and by the
 * scheduler / swarm / telegram autonomous paths). The OpenClaude
 * wrapper does this inline inside canUseTool (see openclaude-installer.ts
 * WRAPPER_TEMPLATE) and does not call this helper.
 *
 * `parsedInput` is the tool's input — already JSON-parsed when possible.
 * For Bash-shaped tools, we read the `command` property (string).
 *
 * Returns the denial reason if the tool would be blocked, or null if allowed.
 */
const BASH_SHAPED_TOOLS = new Set([
  'Bash', 'bash', 'developer__shell', 'shell',
])

export function checkAgentToolEgress(
  toolName: string,
  parsedInput: unknown,
): EgressDecision {
  const mode = getCurrentPrivacyMode()
  if (mode === 'open') return { allowed: true }

  // Tool-name denylist (WebFetch / WebSearch).
  const named = checkToolEgress(toolName)
  if (!named.allowed) return named

  // Bash-shaped tools: inspect the command string.
  if (BASH_SHAPED_TOOLS.has(toolName)) {
    const cmd = (parsedInput && typeof parsedInput === 'object'
      ? (parsedInput as Record<string, unknown>).command
      : undefined)
    if (typeof cmd === 'string') {
      const bash = checkBashCommandEgress(cmd)
      if (!bash.allowed) return bash
    }
  }

  return { allowed: true }
}
