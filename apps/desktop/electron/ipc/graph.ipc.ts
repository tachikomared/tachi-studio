// apps/desktop/electron/ipc/graph.ipc.ts
//
// IPC bridge that actually EXECUTES a Nodes-editor graph.
//
// Channel:
//   graph:run — receives { flow: TachiFlow, input: string }, compiles the
//               visual graph into a runnable @inngest/agent-kit Network via
//               compileGraph(), runs it, and returns the per-agent results.
//
// Unlike the legacy "Run flow" button (which only copied chain[0] into the
// Agent store and navigated away), this handler runs the graph for real:
//
//   1. PRIVATE MODE guard — in private mode, reject any graph whose provider
//      nodes map to a cloud provider (bankr / freellmapi proxy). Only truly
//      local providers (ollama / llama.cpp) may run while private.
//   2. Resolve a default model so a bare agent graph (no provider node wired)
//      still runs: freellmapi sidecar in open mode, ollama in private mode.
//   3. Resolve credentials + per-node base URLs (secrets are NOT in the flow
//      JSON; they are injected at runtime here).
//   4. compileGraph(...) → { network, state } (try/catch — surfaces the
//      compiler's actionable errors for unsupported provider nodes).
//   5. network.run(input, { state }) (try/catch).
//   6. Flatten run.state.results → [{ agent, text }]; final = last text.
//
// The handler NEVER throws — every failure path returns { ok: false, error }.

// BrowserWindow is a VALUE here (not just a type) because the rife stage pushes
// its progress to a window, and the run-node handler resolves the one that
// asked — the same `fromWebContents` rule rife.ipc follows.
import { ipcMain, BrowserWindow } from 'electron'

import {
  compileGraph,
  mediaPromptWritersOf,
  runMediaPhase,
  runMediaNode,
  runRifeNode,
  isMediaPhaseNode,
  resolveWiredImages,
  resolveTemplateTokens,
  extractOutputText,
  sweepStaleSdInitTemps,
  type MediaNodeResult,
} from '../services/graph-to-agentkit'
import { veniceVisionChat } from '../services/venice-media-service'
import { compatVisionChat, anthropicVisionChat, prefersAnthropicVision } from '../services/vision-chat'
import { isVisionModel } from '@tachi/core'
import type { Artifact } from '../services/surplus-media-service'
import { makeFreellmapiAdapter, makeOllamaAdapter } from '../services/agentkit-adapters'
import { getLlamaCppPort, startLlamaCpp } from '../services/llama-cpp-client'
import { listOllamaModels } from '../services/ollama-service'
import {
  startFreellmapi,
  getFreellmapiPort,
  getFreellmapiApiKey,
  getMcpHandle,
} from '../services/sidecar-manager'
import { retrieveKey } from '../services/keychain'
import { getCurrentPrivacyMode } from './privacy.ipc'
import { classifyProvider } from '../services/egress-policy'
// R8b: the MCP SDK client entries load on first PROBE, not at boot. Same
// reasoning as services/mcp-manager.ts — they measured ~0.1 ms only because
// services/mcp-server.ts had already paid for the shared SDK internals; that
// module is deferred now, so this one has to be too or the cost just relocates.
// Both are used ONLY inside probeMcp() below, which is already async and whose
// catch already turns *any* failure into `false` (skip wiring this server).
import type { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'

import type { TachiFlow, TachiNode } from '../../src/pages/nodes/types'
import { decideCodexSandbox } from '../../src/pages/nodes/canvas/codexWriteGate'

/**
 * Probe an MCP server the same way agent-kit will (connect + listTools). If it
 * fails, the caller skips wiring it — an unreachable MCP server would otherwise
 * throw inside agent.run() and terminate the entire graph run.
 */
async function probeMcp(url: string, token?: string): Promise<boolean> {
  let client: McpClient | null = null
  try {
    const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    ])
    const transport = new StreamableHTTPClientTransport(
      new URL(url),
      token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined,
    )
    client = new Client({ name: 'tachi-mcp-probe', version: '1.0.0' }, { capabilities: {} })
    await Promise.race([
      (async () => { await client!.connect(transport); await client!.listTools() })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('mcp probe timeout')), 4000)),
    ])
    return true
  } catch {
    return false
  } finally {
    try { await client?.close() } catch { /* ignore */ }
  }
}

// ── Unresolved-model gate (Ollama) ────────────────────────────────────────────
//
// 'auto' is a placeholder for SOME providers and a real model id for others:
// OpenGateway routes on it server-side and the freellmapi sidecar picks a free
// model with it, so nothing here may reject it globally. Ollama is the case
// where it means nothing at all — /api/chat wants a pulled model name and
// answers `model 'auto' not found`, which is why this asks BEFORE a run starts
// instead of letting the user wait for it.

/** True when a node's model field cannot name a model (blank or the placeholder). */
function isUnresolvedModel(model: unknown): boolean {
  const m = String(model ?? '').trim().toLowerCase()
  return m === '' || m === 'auto'
}

const OLLAMA_MODEL_GAP_ERROR =
  'An Ollama node has no model selected — pick one of your pulled models on the node. ' +
  'Ollama has no "auto"; pull a model first if the dropdown is empty (e.g. `ollama pull llama3.2`).'

/**
 * The private-mode DEFAULT adapter (a graph with no provider node at all) had
 * the same hole and cannot use the gate above: there is no node to point at.
 * Nothing on screen claims a model here either, so this RESOLVES instead of
 * refusing — the same thing chat-service does before it sends. Falls back to
 * the old literal 'auto' when Ollama can't be listed, which fails no worse.
 */
async function ollamaDefaultModel(): Promise<string> {
  try {
    const models = await listOllamaModels()
    return models.find(m => m?.name)?.name || 'auto'
  } catch {
    return 'auto'
  }
}

// ── Result shapes ──────────────────────────────────────────────────────────────

export interface GraphRunAgentResult {
  agent: string
  text:  string
}

export type GraphRunResult =
  | { ok: true;  results: GraphRunAgentResult[]; final: string; media?: MediaNodeResult[] }
  | { ok: false; error: string }

/**
 * graph:run-node result — runs JUST one node (media or agent) using the known
 * outputs of upstream nodes (passed by the renderer as `lastOutput` on those
 * nodes inside `flow`). For a MEDIA node: { ok, artifacts?, text?, error? }. For
 * an AGENT node: { ok, text?, error? }.
 */
export type GraphRunNodeResult =
  | { ok: true; text?: string; artifacts?: Artifact[] }
  | { ok: false; error: string }

/**
 * Build the outputs map for per-node runs: canvas node id → that node's known
 * output text. The renderer stamps `lastOutput` onto upstream nodes' data before
 * sending the flow, so a downstream node can resolve `{{node:<id>}}` tokens and
 * the prompt-plug feeder against PINNED outputs without re-running upstream.
 */
function outputsFromFlow(flow: TachiFlow): Map<string, string> {
  const out = new Map<string, string>()
  for (const n of flow.nodes) {
    const lastOutput = (n.data as { lastOutput?: unknown }).lastOutput
    if (typeof lastOutput === 'string' && lastOutput.trim()) out.set(n.id, lastOutput)
  }
  return out
}

/**
 * Outputs from STATIC input nodes only (Text / Reference-Image) — nodes with no
 * agent to run, whose output is simply their own data. Seeded into a full Run
 * Flow's compile + media phase so an agent/prompt instruction or media prompt
 * that references a Text node via `{{node:<id>}}` (or wires it into the prompt
 * plug) resolves at compile/run time. Agent→agent token refs are intentionally
 * NOT seeded here — those stay on the per-node path.
 */
function staticInputOutputs(flow: TachiFlow): Map<string, string> {
  const out = new Map<string, string>()
  for (const n of flow.nodes) {
    // Text + Reference-Image inputs, AND Output result cards (their text feeds
    // downstream just like a Text node when you branch off a result).
    // 'webhook' joins them (BATCH35 lane B): an inbound alert's body is static
    // data on the node by the time a run starts, so a Run-flow that references
    // the trigger resolves the alert text without a per-node run.
    if (n.type !== 'text' && n.type !== 'imageref' && n.type !== 'output' && n.type !== 'webhook') continue
    const lo = (n.data as { lastOutput?: unknown }).lastOutput
    if (typeof lo === 'string' && lo.trim()) out.set(n.id, lo)
  }
  return out
}

/**
 * Build a sub-flow for a single agent node: the agent itself plus its directly
 * wired provider / permission / folder / internet / mcp nodes, and the edges
 * among that set. Excludes other agents (no chaining) so compileGraph runs ONLY
 * this agent. Upstream agent outputs are injected separately as token outputs.
 */
function subFlowForAgent(flow: TachiFlow, agentId: string): TachiFlow {
  const keep = new Set<string>([agentId])
  const SUPPORT: ReadonlySet<string> = new Set(['provider', 'skill', 'folder', 'internet', 'mcp'])
  for (const e of flow.edges) {
    if (e.source === agentId || e.target === agentId) {
      const otherId = e.source === agentId ? e.target : e.source
      const other = flow.nodes.find(n => n.id === otherId)
      if (other && SUPPORT.has(other.type)) keep.add(otherId)
    }
  }
  const nodes = flow.nodes.filter(n => keep.has(n.id))
  const edges = flow.edges.filter(e => keep.has(e.source) && keep.has(e.target))
  return { version: 1, name: `node-${agentId}`, nodes, edges, savedAt: new Date().toISOString() }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Map the UI providerId vocabulary onto the egress-policy classification ids.
 * The egress module classifies 'freellmapi'/'freellmapi-local' as CLOUD (the
 * sidecar proxies to cloud endpoints) and 'ollama'/'llama-cpp' as LOCAL. The
 * canvas uses 'llamacpp' (no hyphen) for the llama.cpp provider node, so we
 * normalize it to the policy's 'llama-cpp' before classifying.
 */
function classifyUiProvider(uiProviderId: string): ReturnType<typeof classifyProvider> {
  const id = uiProviderId === 'llamacpp' ? 'llama-cpp' : uiProviderId
  return classifyProvider(id)
}

/**
 * Resolve an ordered list of free-model candidates for the fallback chain.
 * Strategy: keep the sidecar's own router first ('auto'), then append the live
 * model ids the sidecar reports from /v1/models (so we never retry against a
 * model that no longer exists upstream — the cause of the MiniMax 404). On any
 * failure we degrade to just ['auto'] so behaviour is unchanged.
 */
async function resolveFreeModelCandidates(port: number, apiKey: string | undefined): Promise<string[]> {
  const candidates: string[] = ['auto']
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    })
    if (res.ok) {
      const json = (await res.json()) as { data?: Array<{ id?: unknown }> }
      const ids = Array.isArray(json.data)
        ? json.data.map(m => (typeof m.id === 'string' ? m.id : '')).filter(Boolean)
        : []
      for (const id of ids) {
        if (!candidates.includes(id)) candidates.push(id)
      }
    }
  } catch {
    /* sidecar may not expose /v1/models — fall back to ['auto'] only */
  }
  // Cap the retry breadth so a fully-dead free tier fails fast instead of
  // hammering dozens of models.
  return candidates.slice(0, 5)
}

/**
 * Heuristic: is this error worth retrying with a different free model? We retry
 * on upstream/model errors (404/400/provider/model-not-found/no upstream) but
 * NOT on structural/graph errors, which would just fail again.
 */
/** Human-readable error string that also unwraps undici-style `.cause`. */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause
    if (cause) {
      const c = cause instanceof Error ? cause.message : String(cause)
      return `${err.message}${c && c !== err.message ? ` (cause: ${c})` : ''}`
    }
    return err.message
  }
  return String(err)
}

function isRetryableModelError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return /\b(40[0-9]|429|50[0-9])\b/.test(msg)
    || msg.includes('provider')
    || msg.includes('model')
    || msg.includes('not found')
    || msg.includes('no upstream')
    || msg.includes('unavailable')
}

/**
 * Light structural validation of the inbound flow. Returns a TachiFlow on
 * success or a string error message. We don't trust the renderer payload
 * blindly — compileGraph also validates, but a clearer up-front message helps.
 */
function coerceFlow(raw: unknown): TachiFlow | string {
  if (!raw || typeof raw !== 'object') return 'Invalid flow payload (not an object).'
  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj.nodes)) return 'Invalid flow payload (missing nodes array).'
  if (!Array.isArray(obj.edges)) return 'Invalid flow payload (missing edges array).'
  return {
    version: 1,
    name:    typeof obj.name === 'string' ? obj.name : 'compiled-graph',
    nodes:   obj.nodes as TachiNode[],
    edges:   obj.edges as TachiFlow['edges'],
    savedAt: typeof obj.savedAt === 'string' ? obj.savedAt : new Date().toISOString(),
  }
}

/**
 * Expand every `prompt` node into a synthetic PROVIDER + AGENT pair so the rest
 * of the pipeline (compileGraph, subFlowForAgent, the media prompt-feeder, token
 * outputs) treats it as an ordinary provider→agent chain — no special-casing
 * anywhere downstream. The synthetic AGENT keeps the prompt node's id, so every
 * external edge (e.g. prompt→media `prompt` plug, {{node:<id>}} tokens) stays
 * valid. Idempotent: a flow with no prompt nodes is returned unchanged.
 */
function expandPromptNodes(flow: TachiFlow): TachiFlow {
  if (!flow.nodes.some(n => n.type === 'prompt')) return flow
  const nodes: TachiNode[] = []
  const edges = [...flow.edges]
  for (const n of flow.nodes) {
    if (n.type !== 'prompt') { nodes.push(n); continue }
    const d = n.data as {
      label?: string; providerId?: string; model?: string; endpoint?: string
      instruction?: string; systemPrompt?: string; final?: boolean
      lastOutput?: string; pinned?: boolean
    }
    const provId = `${n.id}__prov`
    // Synthetic provider node carrying the prompt node's own provider config.
    nodes.push({
      id: provId, type: 'provider', position: { x: n.position.x - 40, y: n.position.y },
      data: {
        label: 'prompt provider',
        providerId: typeof d.providerId === 'string' && d.providerId ? d.providerId : 'freellmapi',
        ...(typeof d.model === 'string' ? { model: d.model } : {}),
        ...(typeof d.endpoint === 'string' ? { endpoint: d.endpoint } : {}),
      },
    } as TachiNode)
    // Synthetic agent — SAME id as the prompt node so external edges keep working.
    const instruction = typeof d.instruction === 'string' ? d.instruction
      : typeof d.systemPrompt === 'string' ? d.systemPrompt : ''

    // Bake a strict "output ONLY a clean prompt" framing so the prompt node emits
    // a usable generation prompt (no "I can't generate images…" chatter), tailored
    // to whatever media node it feeds (image/video/music/tts), else a generic one.
    const downstreamMedia = flow.nodes.find(x =>
      x.type === 'media' && flow.edges.some(ed => ed.source === n.id && ed.target === x.id))
    const dm = downstreamMedia ? String((downstreamMedia.data as { modality?: unknown }).modality || '') : ''
    const kindWord = dm === 'video' ? 'VIDEO' : dm === 'music' ? 'MUSIC' : dm === 'tts' ? 'SPEECH' : 'IMAGE'
    const detail =
      dm === 'video' ? 'Describe subject, motion, camera, pacing, and mood.'
      : dm === 'music' ? 'Describe genre, mood, instrumentation, and tempo.'
      : dm === 'tts'   ? 'Output ONLY the exact words to be spoken aloud.'
      : 'Describe subject, composition, lighting, lens, style, and mood.'
    const framing =
      `You are an expert prompt engineer for AI ${kindWord} generation. Turn the user's request into ONE clean, vivid ${kindWord.toLowerCase()} generation prompt. ` +
      `Output ONLY the prompt itself — no preamble, no commentary, no apologies, no "I can't", no quotes, no markdown, no lists. ${detail}`
    const systemPrompt = instruction ? `${framing}\n\nUser request:\n${instruction}` : framing

    nodes.push({
      id: n.id, type: 'agent', position: n.position,
      data: {
        label: typeof d.label === 'string' ? d.label : 'Prompt',
        harnessId: 'openclaude',
        systemPrompt,
        ...(d.final ? { final: true } : {}),
        ...(typeof d.lastOutput === 'string' ? { lastOutput: d.lastOutput } : {}),
        ...(d.pinned ? { pinned: true } : {}),
      },
    } as TachiNode)
    edges.push({ id: `${provId}__edge`, source: provId, target: n.id } as TachiFlow['edges'][number])
  }
  return { ...flow, nodes, edges }
}

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Headless entry point into the graph runtime — the SAME code path the canvas
 * uses, with no renderer attached. Wired by registerGraphIpc(); null before the
 * app finishes booting. Used by the scheduler so a scheduled flow run cannot
 * drift from an interactive one.
 */
let graphRunner: ((payload: unknown, emitActive: (nodeId: string | null) => void) => Promise<GraphRunResult>) | null = null

/** Run a saved flow with no window in the loop (scheduler / automation). */
export async function runGraphFlowHeadless(payload: { flow: unknown; input?: string }): Promise<GraphRunResult> {
  if (!graphRunner) return { ok: false, error: 'The graph runtime is not ready yet — try again once the app has finished starting.' }
  return graphRunner(payload, () => { /* nobody is watching the canvas */ })
}

/** How long after boot the temp sweep runs. Late enough to cost the startup
 *  prelude nothing (R8b), early enough that a session cleans up after the last
 *  one. Unref'd, so it can never hold the process open. */
const SD_INIT_SWEEP_DELAY_MS = 10_000

export function registerGraphIpc(hostWin: BrowserWindow): void {
  // Collect the init-frame temps earlier sessions left in %TEMP% (FLF driver,
  // finding 5 — 882 of them on one machine). New ones no longer accrue on
  // EITHER route: the canvas run has a per-run `finally` in runMediaNode, and
  // the Media page's two generate handlers have theirs in sd-cpp.ipc — this
  // sweep is now only for what a crash, a Stop or a power cut leaves behind.
  // DEFERRED: a readdir of the system temp dir is not something to spend the
  // boot prelude on, and nothing waits on the result.
  const sweepTimer = setTimeout(() => {
    try { sweepStaleSdInitTemps() } catch { /* never worth a boot failure */ }
  }, SD_INIT_SWEEP_DELAY_MS)
  ;(sweepTimer as unknown as { unref?: () => void }).unref?.()

  // The graph runtime itself, decoupled from the IPC event: `emitActive`
  // streams "now running this node" to whoever is watching (the canvas for an
  // interactive run, a no-op for a headless/scheduled one).
  //
  // `win` is where a rife stage pushes its own progress (the activity strip's
  // rows come from `rife:progress`, not from emitActive). It defaults to the
  // window this registrar was given, which is deliberately NOT the same call as
  // emitActive's no-op for a headless run: nobody is watching the CANVAS then,
  // but the activity rail is app-wide, and a scheduled flow quietly holding the
  // GPU for forty minutes with no row is the exact failure the rail exists to
  // prevent. Pass null only where there is genuinely no window.
  const runGraph = async (
    payload: unknown,
    emitActive: (nodeId: string | null) => void,
    win: BrowserWindow | null = hostWin,
  ): Promise<GraphRunResult> => {
    // Force LLM-gateway responses to be uncompressed. agent-kit/undici auto-
    // requests gzip/br and throws "incorrect header check" on gateways (e.g.
    // OpenGateway) that mislabel the encoding on non-streamed replies. Setting
    // Accept-Encoding: identity here (on the actual request) sidesteps it. We
    // also surface the provider's error body for non-2xx responses.
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      const isGw = /opengateway|gitlawb|bankr|surplus|chat\/completions|\/messages/i.test(url)
      if (!isGw) return origFetch(input as never, init as never)
      const h = new Headers((init?.headers as HeadersInit | undefined) ?? undefined)
      h.set('accept-encoding', 'identity')
      const res = await origFetch(input as never, { ...init, headers: h } as never)
      if (!res.ok) {
        try { console.warn('[graph:fetch]', res.status, url, '—', (await res.clone().text()).slice(0, 400)) } catch { /* */ }
      }
      return res
    }) as typeof fetch

    try {
      const { flow: rawFlow, input } =
        (payload as { flow?: unknown; input?: unknown } | null | undefined) ?? {}

      const flowOrErr = coerceFlow(rawFlow)
      if (typeof flowOrErr === 'string') return { ok: false, error: flowOrErr }
      const flow = expandPromptNodes(flowOrErr)

      const userInput = typeof input === 'string' ? input : ''

      const providerNodes = flow.nodes.filter(n => n.type === 'provider')
      const agentNodes    = flow.nodes.filter(n => n.type === 'agent')
      const mediaNodes    = flow.nodes.filter(n => n.type === 'media')
      // Everything Phase 2 owns: the generating media nodes PLUS the rife
      // post-process nodes. A flow of one video node and one interpolate node
      // has a Phase 2 and no Phase 1, and gating on `mediaNodes` alone would
      // have walked straight past the rife stage.
      const phase2Nodes   = flow.nodes.filter(n => isMediaPhaseNode(n))
      const mode = getCurrentPrivacyMode()

      // 1. PRIVATE MODE guard — block cloud providers + internet + external MCP.
      if (mode === 'private') {
        // Media is Surplus-backed (cloud-only) — blocked while private. The
        // single source of truth for this is egress-policy.ts (surplus is in
        // CLOUD_PROVIDER_IDS); we surface a clear message up-front here.
        const cloudMedia = mediaNodes.filter(n => String((n.data as { provider?: unknown }).provider || 'surplus') !== 'local')
        if (cloudMedia.length > 0) {
          return {
            ok: false,
            error:
              `PRIVATE MODE: a media node uses a cloud provider (Surplus/Venice/imgnAI image/video/music/TTS/STT). ` +
              `Switch it to the Local provider, remove it, or toggle PRIVATE MODE off in the Command Palette.`,
          }
        }
        for (const node of providerNodes) {
          const uiId = String((node.data as { providerId?: unknown }).providerId || '')
          const klass = classifyUiProvider(uiId)
          if (klass !== 'local') {
            return {
              ok: false,
              error:
                `PRIVATE MODE: this graph uses a cloud provider ("${uiId || '(unknown)'}"). ` +
                `Only local providers (Ollama, llama.cpp) may run while PRIVATE MODE is on. ` +
                `Toggle it off in the Command Palette, or swap the provider node for a local one.`,
            }
          }
        }
        // Internet nodes give public web access — not allowed while private.
        if (flow.nodes.some(n => n.type === 'internet')) {
          return {
            ok: false,
            error:
              `PRIVATE MODE: this graph has an Internet node (public web access), which is blocked. ` +
              `Remove it or toggle PRIVATE MODE off in the Command Palette.`,
          }
        }
        // MCP nodes pointing at a non-loopback URL would reach a remote server.
        for (const node of flow.nodes) {
          if (node.type !== 'mcp') continue
          const url = String((node.data as { url?: unknown }).url || '').trim()
          if (url && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(url)) {
            return {
              ok: false,
              error:
                `PRIVATE MODE: an MCP node points at a remote server ("${url}"). ` +
                `Only the built-in/loopback MCP server is allowed while PRIVATE MODE is on.`,
            }
          }
        }
      }

      // 1b. MEDIA-ONLY graph (media / rife nodes, no agents): skip Phase 1 (there
      //     is no text network to run) and go straight to Phase 2. Each media node
      //     uses its typed prompt, a wired Text node, or {{node:<id>}} tokens — all
      //     resolved from the static lastOutputs (Text / Reference-Image nodes).
      //     A rife node needs none of that: it reads the clip off the wire.
      if (agentNodes.length === 0 && phase2Nodes.length > 0) {
        const media = await runMediaPhase(flow, outputsFromFlow(flow), (nodeId) => emitActive(nodeId), { win })
        emitActive(null)
        const final = media.find(r => r.ok && r.text)?.text
          ?? (media.some(r => r.ok) ? '[media generated — see artifacts]' : '')
        return { ok: true, results: [], final, media }
      }

      // 2. Resolve the sidecar (open mode only) — needed for the default model
      //    of bare agents AND for the free-model fallback chain. Private mode
      //    uses ollama locally and skips all of this.
      const baseUrlByNodeId: Record<string, string> = {}
      let freellmapiApiKey: string | undefined
      let freellmapiBaseUrl: string | undefined
      let port: number | undefined

      if (mode !== 'private') {
        try {
          await startFreellmapi()
        } catch (err) {
          return {
            ok: false,
            error:
              `Could not start the freellmapi sidecar (needed for the default model): ` +
              `${err instanceof Error ? err.message : String(err)}`,
          }
        }
        port = getFreellmapiPort()
        if (!port) {
          return { ok: false, error: 'freellmapi sidecar started but no port was assigned.' }
        }
        freellmapiBaseUrl = `http://127.0.0.1:${port}/v1`
        freellmapiApiKey  = getFreellmapiApiKey() ?? undefined
      }

      // 3. Resolve credentials + per-node base URLs.
      const bankrApiKey       = retrieveKey('bankr-gateway') ?? undefined
      const opengatewayApiKey = retrieveKey('opengateway')   ?? undefined
      const surplusApiKey     = retrieveKey('surplus')       ?? undefined
      const veniceApiKey      = retrieveKey('venice')        ?? undefined
      const imgnaiApiKey      = retrieveKey('imgnai')        ?? undefined
      // Built-in MCP server (for MCP nodes with a blank url): inject its
      // loopback URL + bearer token so wired agents can reach it.
      const mcpHandle      = getMcpHandle()
      const mcpDefaultUrl  = mcpHandle?.url
      const mcpBearerToken = mcpHandle?.token

      // Pre-probe every MCP server referenced by the graph. Only reachable ones
      // are wired (compileGraph honors allowedMcpUrls) — an unreachable MCP
      // server would otherwise terminate the whole run.
      const allowedMcpUrls = new Set<string>()
      const wantedMcpUrls = new Set<string>()
      for (const node of flow.nodes) {
        if (node.type !== 'mcp') continue
        const explicit = String((node.data as { url?: unknown }).url || '').trim()
        const u = explicit || mcpDefaultUrl
        if (u) wantedMcpUrls.add(u)
      }
      for (const u of wantedMcpUrls) {
        const ok = await probeMcp(u, u === mcpDefaultUrl ? mcpBearerToken : undefined)
        if (ok) allowedMcpUrls.add(u)
        else console.warn(`[graph:run] MCP server unreachable, skipping: ${u}`)
      }

      // llama.cpp: AUTO-START the chosen local model in the bundled llama-server
      // (idempotent — no-op if already loaded), then point llama-cpp provider
      // nodes at its loopback /v1. Local → allowed in private mode too.
      const llamaProviderNodes = providerNodes.filter(n =>
        ['llamacpp', 'llama-cpp'].includes(String((n.data as { providerId?: unknown }).providerId || '')))
      let llamaBaseUrl: string | undefined
      if (llamaProviderNodes.length > 0) {
        const modelId = String((llamaProviderNodes[0].data as { model?: unknown }).model || '').trim()
        if (!modelId || modelId === 'auto') {
          return { ok: false, error: 'A llama.cpp node has no model selected — pick an installed one (Status → llama.cpp).' }
        }
        try {
          await startLlamaCpp({ modelId })
        } catch (err) {
          return { ok: false, error: `Could not start llama.cpp model "${modelId}": ${err instanceof Error ? err.message : String(err)}` }
        }
        const lport = getLlamaCppPort()
        if (!lport) return { ok: false, error: 'llama.cpp started but no port was assigned.' }
        llamaBaseUrl = `http://127.0.0.1:${lport}/v1`
      }

      // Ollama, same gate, same reason. Chat resolves 'auto' by listing
      // /api/tags before it sends; this path does not — it forwards 'auto' to
      // /api/chat, and Ollama answers `model 'auto' not found` after the whole
      // request has been built. The user waits minutes to be told the model
      // they thought they picked does not exist. Scoped to Ollama on purpose:
      // 'auto' is a REAL model id on OpenGateway (gateway-side routing) and on
      // the freellmapi sidecar, so it must never be rejected across the board.
      const ollamaModelGap = providerNodes.find(n =>
        ['ollama', 'ollama-local'].includes(String((n.data as { providerId?: unknown }).providerId || ''))
        && isUnresolvedModel((n.data as { model?: unknown }).model))
      if (ollamaModelGap) {
        return { ok: false, error: OLLAMA_MODEL_GAP_ERROR }
      }

      for (const node of providerNodes) {
        const uiId = String((node.data as { providerId?: unknown }).providerId || '')
        if ((uiId === 'freellmapi' || uiId === 'freellmapi-local') && freellmapiBaseUrl) {
          baseUrlByNodeId[node.id] = freellmapiBaseUrl
        }
        if ((uiId === 'llamacpp' || uiId === 'llama-cpp') && llamaBaseUrl) {
          baseUrlByNodeId[node.id] = llamaBaseUrl
        }
      }

      // 4. Build the free-model fallback chain. Only multi-attempt when freellmapi
      //    is actually in play (a freellmapi node, or bare agents using the
      //    default model); otherwise a single attempt with the node's own model.
      const usesFreellmapi = providerNodes.some(n => {
        const id = String((n.data as { providerId?: unknown }).providerId || '')
        return id === 'freellmapi' || id === 'freellmapi-local'
      }) || providerNodes.length === 0
      let candidates: string[] = ['auto']
      if (mode !== 'private' && usesFreellmapi && port) {
        candidates = await resolveFreeModelCandidates(port, freellmapiApiKey)
      }

      // 5. Try each candidate model until the graph runs successfully.
      let lastError = 'Graph run failed.'
      // Resolved once, not per attempt — the fallback chain retries free CLOUD
      // models, and none of that changes which model Ollama has pulled.
      const privateDefaultModel = mode === 'private' ? await ollamaDefaultModel() : 'auto'
      for (let attempt = 0; attempt < candidates.length; attempt++) {
        const candidate = candidates[attempt]!

        const defaultModel = mode === 'private'
          ? makeOllamaAdapter({ model: privateDefaultModel })
          : makeFreellmapiAdapter({
              model:   candidate,
              baseUrl: freellmapiBaseUrl ?? 'http://127.0.0.1:31415/v1',
              apiKey:  freellmapiApiKey,
            })

        let compiled
        try {
          compiled = compileGraph(flow, {
            bankrApiKey,
            freellmapiApiKey,
            opengatewayApiKey,
            surplusApiKey,
            veniceApiKey,
            imgnaiApiKey,
            defaultModel,
            baseUrlByNodeId,
            // Static input nodes (Text / Reference-Image) → resolve {{node:<id>}}
            // tokens in agent/prompt instructions at compile time in a full run.
            outputsByNodeId: staticInputOutputs(flow),
            freellmapiModelOverride: candidate,
            // Real tools now run: file tools (sandboxed to a Folder node),
            // web_fetch (Internet node), and MCP server tools (MCP node).
            // Agents with no tool nodes wired stay pure-LLM automatically.
            disableTools: false,
            mcpDefaultUrl,
            mcpBearerToken,
            allowedMcpUrls,
            onAgentStart: (nodeId) => emitActive(nodeId),
            maxIter: 20,
            // Layer C — auto-frame bare text agents wired into a media node's
            // `prompt` plug as prompt-writers for that modality.
            mediaPromptWriters: mediaPromptWritersOf(flow),
          })
        } catch (err) {
          // Compile errors are deterministic — they won't change across model
          // candidates, so surface immediately rather than retrying.
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }

        try {
          // Cap the run so a non-responsive provider (e.g. one that hangs on a
          // Multi-agent + tool-loop runs (e.g. Builder writes files, then
          // Reviewer reads them) legitimately take minutes. Cap generously, and
          // on timeout RETURN PARTIAL RESULTS (read from the live state) instead
          // of discarding the work that already completed.
          const RUN_TIMEOUT_MS = 300_000
          let timedOut = false
          await Promise.race([
            compiled.network.run(userInput, { state: compiled.state }),
            new Promise<void>(resolve => setTimeout(() => { timedOut = true; resolve() }, RUN_TIMEOUT_MS)),
          ])
          // The state is mutated in place during the run, so it holds whatever
          // completed — even on timeout.
          const rawResults =
            (compiled.state as unknown as { results?: Array<{ agentName: string; output: unknown }> }).results ?? []
          if (timedOut) console.warn(`[graph:run] timed out after ${RUN_TIMEOUT_MS / 1000}s — returning partial results`)
          // An agent that calls tools produces multiple results (the tool-call
          // pass with empty text, then the final-answer pass). Collapse to the
          // LAST result per agent so each shows once with its real answer.
          const byAgent = new Map<string, GraphRunAgentResult>()
          for (const r of rawResults) {
            byAgent.set(r.agentName, { agent: r.agentName, text: extractOutputText(r.output) })
          }
          const results: GraphRunAgentResult[] = [...byAgent.values()]
          if (timedOut) {
            results.push({
              agent: 'system',
              text: `[Flow timed out after ${RUN_TIMEOUT_MS / 1000}s — showing partial results. ` +
                `Files already written are on disk; some later agents may not have finished.]`,
            })
          }
          // If nothing completed at all, treat the timeout as a hard failure.
          if (timedOut && results.length <= 1) {
            emitActive(null)
            return {
              ok: false,
              error: `Run timed out after ${RUN_TIMEOUT_MS / 1000}s with no output — the provider may be unresponsive.`,
            }
          }
          // Final answer: the agent node the user marked as `final` (its
          // agentName is "<label>#<nodeId>"), else fall back to the last to run.
          const answerable = results.filter(r => r.agent !== 'system')
          let final = answerable.length > 0 ? answerable[answerable.length - 1]!.text : ''
          const finalNode = flow.nodes.find(
            n => n.type === 'agent' && (n.data as { final?: unknown }).final === true,
          )
          if (finalNode) {
            const match = answerable.find(r => r.agent.endsWith(`#${finalNode.id}`))
            if (match) final = match.text
          }

          // ── Phase 2: media + rife nodes ─────────────────────────────────────
          // No-op for pure-text graphs (phase2Nodes is empty → runMediaPhase
          // returns []). When present, resolve each media node's prompt from the
          // agent feeding its `prompt` plug (matched by the "#<nodeId>" suffix on
          // agentName), else its typed field, then call the engine.
          let media: MediaNodeResult[] | undefined
          if (phase2Nodes.length > 0) {
            // Seed STATIC input nodes (Text / Reference-Image) first, then overlay
            // fresh agent results — lets {{node:<id>}} tokens and the Text
            // prompt-feeder resolve in a full Run Flow. (The per-node path already
            // reads every lastOutput via outputsFromFlow.)
            const agentResultsByNodeId = staticInputOutputs(flow)
            for (const r of results) {
              if (r.agent === 'system') continue
              const hash = r.agent.lastIndexOf('#')
              if (hash >= 0) agentResultsByNodeId.set(r.agent.slice(hash + 1), r.text)
            }
            media = await runMediaPhase(flow, agentResultsByNodeId, (nodeId) => emitActive(nodeId), { win })
          }

          emitActive(null)
          return { ok: true, results, final, ...(media ? { media } : {}) }
        } catch (err) {
          // Surface the FULL error (with cause) to the dev log — "terminated" and
          // similar undici messages are useless without the underlying cause.
          console.error('[graph:run] network.run failed (attempt', attempt, '):', err)
          const cause = (err as { cause?: unknown })?.cause
          if (cause) console.error('[graph:run]   cause:', cause)
          let msg = describeError(err)
          // A dropped connection on a tool-enabled run almost always means the
          // model/gateway doesn't support function-calling. Point the user at one
          // that does instead of leaving them with a bare "terminated".
          if (/terminated|fetch failed|econnreset|socket hang up|aborted/i.test(msg)) {
            msg += ' — this usually means the chosen model does not support tool-calling. ' +
              'Use Bankr with a Claude or GPT model (or a tool-capable free model); ' +
              'OpenGateway/mimo and many free models cannot call tools.'
          }
          lastError = `Graph run failed: ${msg}`
          emitActive(null)
          // Non-model errors won't be fixed by swapping models — stop early.
          if (!isRetryableModelError(err)) {
            return { ok: false, error: lastError }
          }
          // else: fall through to the next free-model candidate
        }
      }

      // Every candidate failed.
      emitActive(null)
      return {
        ok: false,
        error: candidates.length > 1
          ? `${lastError} — tried ${candidates.length} free models, all failed. ` +
            `Try Bankr (paid) for reliability, or check the freellmapi dashboard.`
          : lastError,
      }
    } catch (err) {
      // Absolute backstop — the handler must never throw.
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      globalThis.fetch = origFetch
    }
  }
  graphRunner = runGraph

  ipcMain.handle('graph:run', async (event, payload: unknown): Promise<GraphRunResult> =>
    runGraph(payload, (nodeId) => {
      // Stream "now running this node" to the renderer so the canvas can
      // animate execution moving across the graph.
      try { event.sender.send('graph:node-active', { nodeId }) } catch { /* window gone */ }
    }))

  // ── graph:run-node — run JUST one node (the "execute step" affordance) ───────
  // Input: { flow, nodeId }. Resolves the target node, runs only it using the
  // known outputs of upstream nodes (the renderer stamps `lastOutput` onto them),
  // and returns its output. Media → { ok, artifacts?, text? }; agent → { ok, text }.
  // Never throws; every failure path returns { ok: false, error }.
  ipcMain.handle('graph:run-node', async (event, payload: unknown): Promise<GraphRunNodeResult> => {
    const emitActive = (nodeId: string | null) => {
      try { event.sender.send('graph:node-active', { nodeId }) } catch { /* window gone */ }
    }

    // Same identity-fetch shim as graph:run (gateway gzip mislabeling fix).
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      const isGw = /opengateway|gitlawb|bankr|surplus|chat\/completions|\/messages/i.test(url)
      if (!isGw) return origFetch(input as never, init as never)
      const h = new Headers((init?.headers as HeadersInit | undefined) ?? undefined)
      h.set('accept-encoding', 'identity')
      return origFetch(input as never, { ...init, headers: h } as never)
    }) as typeof fetch

    try {
      const { flow: rawFlow, nodeId, runSeed: rawRunSeed } =
        (payload as { flow?: unknown; nodeId?: unknown; runSeed?: unknown } | null | undefined) ?? {}
      if (typeof nodeId !== 'string' || !nodeId) return { ok: false, error: 'graph:run-node: missing nodeId.' }
      // RUN-ALL (IN ORDER) threads its ONE invocation entropy through here, so
      // a seedless local media stage derives its own seed instead of sharing
      // sd.cpp's fixed default 42 with every other stage of the sequence (FLF
      // driver, finding 2). Absent on a lone RUN button — that path is meant to
      // stay reproducible, and `undefined` is what keeps it that way.
      const runSeed = typeof rawRunSeed === 'string' && rawRunSeed.trim() ? rawRunSeed.trim() : undefined

      const flowOrErr = coerceFlow(rawFlow)
      if (typeof flowOrErr === 'string') return { ok: false, error: flowOrErr }

      // ── VISION Prompt node ──────────────────────────────────────────────────
      // A Prompt node with a Reference-Image wired in → run a DIRECT multimodal
      // chat (agent-kit can't carry images) so the TEXT model SEES the reference
      // (character / object / style) while writing the prompt. Venice only for
      // now (its own key + endpoint). Detected on the RAW flow, before prompt
      // nodes get expanded into provider+agent pairs.
      {
        const raw = flowOrErr.nodes.find(n => n.id === nodeId)
        if (raw && raw.type === 'prompt') {
          // Vision input = ALL images wired in: Reference-Image nodes AND Output
          // cards holding a generated image (so a branched result is "seen" too).
          const imageUrls = await resolveWiredImages(nodeId, flowOrErr)
          const rawProvider = String((raw.data as { providerId?: unknown }).providerId ?? '').toLowerCase()
          // Nodes short id → canonical registry id for the cloud vision gateways.
          // Vision is NOT Venice-only: any OpenAI-compatible gateway with a
          // vision-capable model (Claude, Gemini, GPT-4o/5, Qwen-VL…) can read images.
          const VISION_CANON: Record<string, string> = { venice: 'venice', bankr: 'bankr-gateway', 'bankr-gateway': 'bankr-gateway', surplus: 'surplus', opengateway: 'opengateway', imgnai: 'imgnai' }
          const provider = VISION_CANON[rawProvider]
          if (imageUrls.length > 0 && provider) {
            if (getCurrentPrivacyMode() === 'private') {
              return { ok: false, error: 'PRIVATE MODE: cloud gateways are blocked — vision prompts need a cloud model.' }
            }
            const model = String((raw.data as { model?: unknown }).model ?? '').trim()
            if (!model || model === 'auto' || !isVisionModel(model)) {
              return { ok: false, error: 'Pick a vision-capable model on the Prompt node (Claude, Gemini, GPT-4o/5, Qwen-VL, Pixtral…) to read a reference image.' }
            }
            const outputs = outputsFromFlow(flowOrErr)
            const rawInstr = typeof (raw.data as { instruction?: unknown }).instruction === 'string'
              ? (raw.data as { instruction: string }).instruction : ''
            const system = resolveTemplateTokens(rawInstr, outputs) || rawInstr.trim()
            // User text = upstream text outputs (topic / concept), excluding self
            // and the Reference-Image marker strings (the image goes as image_url).
            const userText = [...outputs.entries()]
              .filter(([id]) => id !== nodeId && flowOrErr.nodes.find(n => n.id === id)?.type !== 'imageref')
              .map(([, t]) => t).join('\n\n').trim()
            emitActive(nodeId)
            try {
              const { text } = provider === 'venice'
                ? await veniceVisionChat({ model, system, userText, imageUrls })
                : prefersAnthropicVision(provider, model)
                  ? await anthropicVisionChat({ providerId: provider, model, system, userText, imageUrls })
                  : await compatVisionChat({ providerId: provider, model, system, userText, imageUrls })
              emitActive(null)
              return { ok: true, text }
            } catch (err) {
              emitActive(null)
              return { ok: false, error: err instanceof Error ? err.message : String(err) }
            }
          }
          // Image wired but the node's provider has no vision gateway here —
          // FAIL LOUDLY instead of silently running text-only and letting the
          // model bluff about an image it never saw.
          if (imageUrls.length > 0 && !provider) {
            return {
              ok: false,
              error: `A reference image is wired into this Prompt node, but provider "${rawProvider || '(none)'}" can't read images here. ` +
                `Switch the node to Venice / Bankr / Surplus / OpenGateway / imgnAI and pick a vision-capable model.`,
            }
          }
        }
      }

      const flow = expandPromptNodes(flowOrErr)

      const node = flow.nodes.find(n => n.id === nodeId)
      if (!node) return { ok: false, error: `graph:run-node: node ${nodeId} not found in flow.` }

      const mode = getCurrentPrivacyMode()
      const outputsByNodeId = outputsFromFlow(flow)

      // ── MEDIA node ────────────────────────────────────────────────────────────
      if (node.type === 'media') {
        const mprov = String((node.data as { provider?: unknown }).provider || 'surplus')
        if (mode === 'private' && mprov !== 'local') {
          return { ok: false, error: 'PRIVATE MODE: this media node uses a cloud provider (Surplus/Venice/imgnAI). Switch it to Local.' }
        }
        emitActive(nodeId)
        const result = await runMediaNode(node, flow, outputsByNodeId, (id) => emitActive(id), runSeed)
        emitActive(null)
        if (!result.ok) return { ok: false, error: result.error || 'Media generation failed.' }
        return { ok: true, ...(result.text ? { text: result.text } : {}), artifacts: result.artifacts }
      }

      // ── RIFE node ─────────────────────────────────────────────────────────────
      // NO PRIVATE-MODE GATE, matching rife.ipc: this reads a file already on
      // disk and spawns three local programs, so blocking it while private would
      // be theatre. The one guard that matters (localVideoRefusal, which keeps a
      // remote URL away from ffmpeg) lives inside the runner, before any spawn.
      if (node.type === 'rife') {
        emitActive(nodeId)
        // The window that ASKED gets the progress — same rule rife:interpolate
        // follows, so a run started from a reopened window still reports to the
        // surface in front of the user.
        const win = BrowserWindow.fromWebContents(event.sender) ?? hostWin
        const result = await runRifeNode(node, flow, win)
        emitActive(null)
        if (!result.ok) return { ok: false, error: result.error || 'Frame interpolation failed.' }
        return { ok: true, artifacts: result.artifacts }
      }

      // ── AGENT node: CODEX harness ────────────────────────────────────────────
      // Executes via the REAL Codex CLI (runCodexTask), not an in-process LLM.
      // WRITE-MODE is opt-in and fail-closed: the codex `workspace-write` sandbox
      // runs ONLY when the node's data.codexAllowWrite is true AND private mode is
      // off AND a Folder node is actually wired (see decideCodexSandbox). With no
      // wired folder the workspace falls back to the storage root and the run
      // STAYS read-only — write-mode never targets the storage root. Containment
      // is codex's own sandbox; the renderer gates consent one-per-session.
      if (node.type === 'agent' && String((node.data as { harnessId?: unknown }).harnessId || '') === 'codex') {
        if (mode === 'private') {
          return { ok: false, error: 'PRIVATE MODE: the Codex node calls the OpenAI cloud. Remove it or leave private mode.' }
        }
        const { isCodexInstalled } = await import('../services/codex-installer')
        if (!isCodexInstalled()) {
          return { ok: false, error: 'Codex is not installed — Settings → Codex Agent → INSTALL, then log in.' }
        }
        const { loadSettings } = await import('../services/settings-store')
        if (loadSettings().codexWorkerEnabled === false) {
          return { ok: false, error: 'The Codex agent is switched OFF — flip the CODEX chip in the CODE tab (or Settings).' }
        }
        const sub = subFlowForAgent(flow, nodeId)
        const folderNode = sub.nodes.find(n => n.type === 'folder' && typeof (n.data as { path?: unknown }).path === 'string' && String((n.data as { path?: unknown }).path).trim())
        const hasWiredFolder = !!folderNode
        const { getStorageRoot } = await import('../services/storage-root')
        const workspaceRoot = folderNode ? String((folderNode.data as { path: string }).path).trim() : getStorageRoot()
        // Task = the node's custom instructions + upstream results (same
        // template-token/outputs model every other node uses).
        const custom = typeof (node.data as { systemPrompt?: unknown }).systemPrompt === 'string'
          ? String((node.data as { systemPrompt: string }).systemPrompt).trim() : ''
        const upstream = flow.edges
          .filter(e => e.target === nodeId)
          .map(e => outputsByNodeId.get(e.source))
          .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        const task = [
          custom || 'Analyze this workspace as instructed by the upstream context below and report your findings concisely.',
          ...(upstream.length ? ['\nUpstream results from earlier nodes:', ...upstream.map((u, i) => `--- upstream ${i + 1} ---\n${u.slice(0, 6000)}`)] : []),
        ].join('\n')
        // Fail-closed sandbox decision, re-derived in MAIN (never trusts the
        // renderer's consent alone). Write only when the node opted in, private
        // mode is off, AND a Folder node is wired — else read-only.
        const allowWrite = (node.data as { codexAllowWrite?: unknown }).codexAllowWrite === true
        // privateMode is provably false here — the branch returns early above when
        // mode === 'private' — but decideCodexSandbox keeps the check as its own
        // fail-closed guard regardless.
        const sandbox = decideCodexSandbox({ allowWrite, privateMode: false, hasWiredFolder })
        console.log(`[graph:run-node] codex node ${nodeId} → sandbox=${sandbox.mode} (${sandbox.reason}); workspace=${workspaceRoot}`)
        const { runCodexTask } = await import('../services/codex-worker')
        emitActive(nodeId)
        const r = await runCodexTask({ workspaceRoot, task, write: sandbox.write })
        emitActive(null)
        if (!r.ok) return { ok: false, error: r.error ?? 'Codex node run failed.' }
        return { ok: true, text: r.answer }
      }

      // ── AGENT node ──────────────────────────────────────────────────────────
      if (node.type === 'agent') {
        // PRIVATE MODE: only local providers may run.
        const sub = subFlowForAgent(flow, nodeId)
        if (mode === 'private') {
          for (const pn of sub.nodes.filter(n => n.type === 'provider')) {
            const uiId = String((pn.data as { providerId?: unknown }).providerId || '')
            if (classifyUiProvider(uiId) !== 'local') {
              return { ok: false, error: `PRIVATE MODE: agent uses a cloud provider ("${uiId || '(unknown)'}").` }
            }
          }
          if (sub.nodes.some(n => n.type === 'internet')) {
            return { ok: false, error: 'PRIVATE MODE: this agent has an Internet node, which is blocked.' }
          }
        }

        // Resolve the sidecar (open mode) for the default model + freellmapi nodes.
        const baseUrlByNodeId: Record<string, string> = {}
        let freellmapiApiKey: string | undefined
        let freellmapiBaseUrl: string | undefined
        let port: number | undefined
        if (mode !== 'private') {
          try { await startFreellmapi() } catch (err) {
            return { ok: false, error: `Could not start the freellmapi sidecar: ${err instanceof Error ? err.message : String(err)}` }
          }
          port = getFreellmapiPort()
          if (!port) return { ok: false, error: 'freellmapi sidecar started but no port was assigned.' }
          freellmapiBaseUrl = `http://127.0.0.1:${port}/v1`
          freellmapiApiKey  = getFreellmapiApiKey() ?? undefined
          for (const pn of sub.nodes.filter(n => n.type === 'provider')) {
            const uiId = String((pn.data as { providerId?: unknown }).providerId || '')
            if (uiId === 'freellmapi' || uiId === 'freellmapi-local') baseUrlByNodeId[pn.id] = freellmapiBaseUrl
          }
        }

        // llama.cpp is LOCAL (allowed in private mode too): AUTO-START the node's
        // chosen model in the bundled llama-server (idempotent — no-op if it's
        // already loaded), then point the provider node at its loopback /v1.
        {
          const llamaProviders = sub.nodes.filter(n =>
            n.type === 'provider' && ['llamacpp', 'llama-cpp'].includes(String((n.data as { providerId?: unknown }).providerId || '')))
          if (llamaProviders.length > 0) {
            const modelId = String((llamaProviders[0].data as { model?: unknown }).model || '').trim()
            if (!modelId || modelId === 'auto') {
              return { ok: false, error: 'Pick an installed llama.cpp model on the node (download one in Status → llama.cpp).' }
            }
            try {
              emitActive(nodeId)
              await startLlamaCpp({ modelId })
            } catch (err) {
              return { ok: false, error: `Could not start llama.cpp model "${modelId}": ${err instanceof Error ? err.message : String(err)}` }
            }
            const lport = getLlamaCppPort()
            if (!lport) return { ok: false, error: 'llama.cpp started but no port was assigned.' }
            for (const pn of llamaProviders) baseUrlByNodeId[pn.id] = `http://127.0.0.1:${lport}/v1`
          }
        }

        // Ollama has no 'auto' either — fail here rather than minutes later
        // inside the provider (see the same check on the whole-flow path).
        {
          const gap = sub.nodes.find(n =>
            n.type === 'provider'
            && ['ollama', 'ollama-local'].includes(String((n.data as { providerId?: unknown }).providerId || ''))
            && isUnresolvedModel((n.data as { model?: unknown }).model))
          if (gap) return { ok: false, error: OLLAMA_MODEL_GAP_ERROR }
        }

        const bankrApiKey       = retrieveKey('bankr-gateway') ?? undefined
        const opengatewayApiKey = retrieveKey('opengateway')   ?? undefined
        const surplusApiKey     = retrieveKey('surplus')       ?? undefined
        const veniceApiKey      = retrieveKey('venice')        ?? undefined
      const imgnaiApiKey      = retrieveKey('imgnai')        ?? undefined

        const defaultModel = mode === 'private'
          ? makeOllamaAdapter({ model: await ollamaDefaultModel() })
          : makeFreellmapiAdapter({
              model:   'auto',
              baseUrl: freellmapiBaseUrl ?? 'http://127.0.0.1:31415/v1',
              apiKey:  freellmapiApiKey,
            })

        let compiled
        try {
          compiled = compileGraph(sub, {
            bankrApiKey,
            freellmapiApiKey,
            opengatewayApiKey,
            surplusApiKey,
            veniceApiKey,
            imgnaiApiKey,
            defaultModel,
            baseUrlByNodeId,
            disableTools: false,
            // Inject pinned upstream outputs so `{{node:<id>}}` tokens in this
            // agent's instructions/systemPrompt resolve without re-running upstream.
            outputsByNodeId,
            onAgentStart: (id) => emitActive(id),
            maxIter: 10,
          })
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }

        // The "input" for a single agent is the concatenation of its known
        // upstream agent outputs (so it has something to build on), else empty.
        const upstreamText = [...outputsByNodeId.entries()]
          .filter(([id]) => id !== nodeId)
          .map(([, t]) => t)
          .join('\n\n')
          .trim()

        try {
          await compiled.network.run(upstreamText, { state: compiled.state })
          const rawResults =
            (compiled.state as unknown as { results?: Array<{ agentName: string; output: unknown }> }).results ?? []
          const byAgent = new Map<string, string>()
          for (const r of rawResults) byAgent.set(r.agentName, extractOutputText(r.output))
          // The sub-flow has exactly one agent — take the last result with our suffix.
          let text = ''
          for (const [name, t] of byAgent) {
            if (name.endsWith(`#${nodeId}`)) text = t
          }
          if (!text && byAgent.size > 0) text = [...byAgent.values()][byAgent.size - 1] ?? ''
          emitActive(null)
          return { ok: true, text }
        } catch (err) {
          emitActive(null)
          return { ok: false, error: `Node run failed: ${describeError(err)}` }
        }
      }

      return { ok: false, error: `graph:run-node: node type "${node.type}" is not runnable as a step.` }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      globalThis.fetch = origFetch
    }
  })
}
