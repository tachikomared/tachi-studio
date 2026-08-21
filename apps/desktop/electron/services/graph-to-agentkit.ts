// apps/desktop/electron/services/graph-to-agentkit.ts
//
// Graph compiler: TachiDesk Nodes editor flow -> runnable @inngest/agent-kit
// Network. This module is the bridge layer between the visual canvas
// (ProviderNode / AgentNode / SkillNode-aka-PermissionNode wired by
// prose-labeled edges in apps/desktop/src/pages/nodes/) and the agent-kit
// execution runtime.
//
// It is a PURE function: no IPC, no fetch, no file I/O. Inputs are a
// TachiFlow (the JSON shape produced by serialization.ts) plus optional
// runtime hints; outputs are an agent-kit Network + State pair plus the
// id of the entry agent so callers know where the run loop begins.
//
// Key conventions:
//
//   - Node discriminants: TachiNode.type is one of 'provider' | 'agent' |
//     'skill'. 'skill' is the legacy slot name for what the UI now calls
//     a "permission" node (see SkillNode.tsx).
//
//   - Edge typing: edges have no explicit role field. The "role" of an
//     edge is inferred from the TYPES of its source and target nodes:
//       provider -> agent : feeds the agent's model adapter
//       agent    -> agent : routing transition (prose label = condition)
//       agent    -> skill : grants the agent a permission tier / tool
//                           allowlist
//
//   - Permission allowlist (PARANOID default): if an agent has zero
//     incoming edges from skill/permission nodes, its tool list is EMPTY.
//     Tools are only enabled when explicitly wired via a permission node
//     carrying a non-empty allowedTools array.
//
//   - Provider mapping: the UI's providerId vocabulary is broader than
//     agentkit-adapters supports. Only the four ids known to
//     makeAdapterFor (bankr / ollama / llamacpp / freellmapi-local) are
//     translated; everything else produces a null adapter and the
//     downstream agent runs without a model (callers should validate).
//     The UI sometimes writes 'freellmapi' (legacy); we normalize it to
//     'freellmapi-local' for the adapter layer.
//
//   - Entry agent discovery: the agent with no incoming agent->agent
//     edges is the entry. If multiple agents qualify, the one nearest
//     the top-left of the canvas wins. If still tied, the first by id.
//
//   - Router condition matching (V1): the prose `instruction` on an
//     agent->agent edge is matched as a case-insensitive substring
//     against the textual content of lastResult.output. An empty / absent
//     instruction is treated as an unconditional route. This is
//     deliberately primitive and will be replaced by a typed predicate
//     DSL in a later pass.
//
// @example
//   import { compileGraph } from './graph-to-agentkit'
//   import type { TachiFlow } from '../../src/pages/nodes/types'
//
//   const flow: TachiFlow = await loadFlowFromDisk(path)
//   const { network, state, entryAgentId } = compileGraph(flow, {
//     bankrApiKey: 'bk_...',
//     maxIter:     20,
//   })
//   await network.run('hello', { state })

// ── R8b: @inngest/agent-kit is loaded ON FIRST COMPILE, not at boot ──────────
//
// Measured (R8b baseline, installed build 2026-07-27): 98-101 ms of the 1317 ms
// pre-STARTUP_T0 prelude, reached from main.ts → chat.ipc.ts → chat-service.ts
// → surplus-workflow-escalation.ts → here (and from main.ts → graph.ipc.ts).
// The whole framework was paid for at every boot even though nothing loads it
// until the user runs a node graph or a surplus workflow escalates.
//
// The type imports below are ERASED at compile time and cost nothing — only
// the three FACTORY functions are values, and all three are used inside
// compileGraph(). A bare-specifier `require()` (allowed; see
// test/unit/noRuntimeRelativeRequire.test.ts) keeps compileGraph SYNCHRONOUS,
// so its three call sites (graph.ipc.ts ×2, surplus-workflow-escalation.ts ×1)
// and their try/catch error reporting are untouched — a load failure throws out
// of compileGraph exactly where a compile failure already did.
import type { Agent, Network, State, MCP } from '@inngest/agent-kit'
import type { AiAdapter } from '@inngest/ai'
// TYPE ONLY — erased at compile time, so this module still imports no electron
// value and stays the pure compiler its header promises.
import type { BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { generateImage as sdGenerateImage, generateVideo as sdGenerateVideo, type SdLoraSelection } from './sd-cpp-client'
import { applyStyle, SD_STYLES } from './sd-cpp-models'
import { synthesize as piperSynthesize } from './piper-client'
// STUDIO (kokoro) local TTS — in-process ONNX, the "A-grade voice" tier above
// piper. The canvas node's local-TTS list now merges kokoro voices alongside
// piper's (useMediaModels, audit 3D-1), so this branch has to recognise them.
import { kokoroSynthesize, saveWavToMediaLibrary, kokoroInstalled, KOKORO_VOICES } from './kokoro-tts'
// mime → extension, shared with the Media route's materialiser (util/init-image)
// so a data: URL becomes a file with the SAME name shape on both routes — and one
// the sweep below can still recognise. Node-builtins only; free at boot.
import { extForMime, materializeInitImageOwned } from './util/init-image'
// The FLF hop's extractor. Node-builtins only at module scope (ffmpeg itself is
// resolved through a lazy import inside), so it costs the boot prelude nothing.
import { lastFrameDataUrl } from './video-last-frame'
// The RIFE sidecar, for the `rife` canvas node's stage. Already on the boot path
// (sd-cpp.ipc → rife.ipc → here), so this import costs the prelude nothing new,
// and rifeWiring's zero-egress walk is unaffected: it constrains what the rife
// modules IMPORT, not who imports them.
import { interpolateVideo } from './rife-runner'

import {
  makeAdapterFor,
  type AgentKitProviderId,
} from './agentkit-adapters'
import { buildAgentTools } from './graph-tools'
import {
  generateImage,
  generateSpeech,
  transcribe,
  submitVideo,
  submitMusic,
  pollMediaJobUntilSettled,
  modelParamSchema,
  type Artifact as MediaArtifact,
  type MediaJobResult,
} from './surplus-media-service'
// THE SECOND GENERATION SURFACE (audit D3). Every resolver below was defined
// inside MediaPage.tsx, so this branch — which runs in MAIN and cannot import a
// React page — never got the size / duration / frames / negative_prompt fixes
// and was three bugs behind. They live in a pure module now; both surfaces call
// the same functions with the same live schema.
import {
  resolveLocalSdSize, resolveLocalWanSize, resolveLocalWanFrames,
  resolveLocalGenParams, resolveLocalNegative, resolveLocalSpeedMode, schemaNegativeDefault,
  resolveLocalBatch, resolveLocalHires, localImagesOf,
  resolveLocalClipSkip, resolveLocalMemoryFlags, resolveLocalStrength, schemaOffersClipSkip,
  resolveLocalIpAdapter, schemaOffersIpAdapter,
} from '../../src/pages/media/localGenParams'
// The rife node's pure core — the SAME module the canvas card reads, for the
// reason localGenParams exists: a resolver that lives on only one of the two
// surfaces is a drift waiting to happen (audit D3).
import { resolveRifeMultiplier, wiredVideoPathsInto } from '../../src/pages/nodes/rifeNode'
import {
  veniceGenerateImage,
  veniceSpeech,
  veniceTranscribe,
  veniceSubmitVideo,
  veniceSubmitMusic,
} from './venice-media-service'
import {
  imgnaiGenerateImage,
  imgnaiGenerateVideo,
} from './imgnai-media'
import { pollinationsGenerateImage } from './pollinations-media'
import { POLLINATIONS_DEFAULT_MODEL } from './pollinations-media-core'

// Kahn's-algorithm topological sort over the canvas edges. Already the Run-All
// ordering primitive on the renderer side; Phase 2 (media) needs the same answer
// in MAIN, so both surfaces sort by one implementation. Pure + type-only
// dependencies, so it adds nothing to the boot import graph.
import { topoOrder } from '../../src/pages/nodes/canvas/topo-order'

import type {
  TachiFlow,
  TachiNode,
  TachiEdge,
  TachiProviderNode,
  TachiAgentNode,
  TachiSkillNode,
  TachiFolderNode,
  TachiInternetNode,
  TachiMcpNode,
  TachiMediaNode,
  TachiRifeNode,
  MediaNodeModality,
} from '../../src/pages/nodes/types'

type AgentKit = typeof import('@inngest/agent-kit')
let agentKitModule: AgentKit | null = null
/** The agent-kit factories, loaded on first graph compile (see header). Memoized. */
function agentKit(): AgentKit {
  return (agentKitModule ??= require('@inngest/agent-kit') as AgentKit)
}

type McpServerConfig = MCP.Server

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Result of compileGraph: a ready-to-run Network plus the seed State plus
 * the id of the entry agent (the canvas node id, not the agent name).
 */
export interface CompiledGraph<Ctx extends Record<string, unknown> = Record<string, unknown>> {
  network:      Network<Ctx>
  state:        State<Ctx>
  entryAgentId: string
}

/**
 * Optional compile-time inputs. Provider credentials live here rather than
 * on the canvas because secrets must never be persisted to flow JSON.
 */
export interface CompileGraphOptions<Ctx extends Record<string, unknown> = Record<string, unknown>> {
  /** Initial state.data payload threaded into createState(). */
  initialContext?:    Ctx
  /** Network maxIter; defaults to 50. */
  maxIter?:           number
  /** Bankr LLM gateway key. Required if any provider node uses providerId='bankr'. */
  bankrApiKey?:       string
  /** freellmapi sidecar key. Required if any provider uses providerId='freellmapi'/'freellmapi-local' with auth. */
  freellmapiApiKey?:  string
  /** Override the llama-server bearer token if any llamacpp provider needs one. */
  llamaCppApiKey?:    string
  /** OpenGateway key. Required if any provider node uses providerId='opengateway'. */
  opengatewayApiKey?: string
  /** Surplus Intelligence key (inf_*). Required if any provider node uses providerId='surplus'. */
  surplusApiKey?:     string
  /** Venice key. Required if any provider node uses providerId='venice'. */
  veniceApiKey?:      string
  /** imgnAI combined "api_key:api_secret". Required for providerId='imgnai'. */
  imgnaiApiKey?:      string
  /**
   * Force the model on every freellmapi/freellmapi-local provider node (and the
   * default model when it's a freellmapi adapter). Lets the caller retry the
   * whole graph against a different free model when the auto-picked one fails
   * (the free-model fallback chain). Ignored by non-freellmapi providers.
   */
  freellmapiModelOverride?: string
  /**
   * Fallback workspace root for file tools when an agent has file permissions
   * but no Folder node wired. If absent, file tools simply aren't built.
   */
  defaultWorkspaceRoot?: string
  /** Bearer token for the app's built-in MCP server (injected into MCP node requests). */
  mcpBearerToken?: string
  /** Default MCP URL used when an MCP node leaves its url blank (the built-in server). */
  mcpDefaultUrl?: string
  /**
   * When provided, only MCP servers whose resolved URL is in this set are wired
   * (the caller pre-probes reachability). MCP that can't connect would otherwise
   * terminate the whole agent run, so unreachable servers are skipped instead.
   */
  allowedMcpUrls?: Set<string>
  /**
   * Called by the router each time it hands control to an agent, with that
   * agent's canvas node id. Lets the caller stream "now running this node" to
   * the UI so the user can watch execution move across the graph.
   */
  onAgentStart?: (nodeId: string) => void
  /**
   * Optional per-node base URL overrides keyed by canvas node id. Lets the
   * caller redirect (e.g.) a freellmapi provider node at the actual sidecar
   * port resolved at runtime via sidecar-manager.
   */
  baseUrlByNodeId?:   Record<string, string>
  /**
   * Fallback model adapter for agents with no provider node wired. Lets a bare
   * agent graph still run (e.g. via the free local sidecar). Passed straight to
   * createNetwork({ defaultModel }).
   */
  defaultModel?:      AiAdapter.Any
  /**
   * v1 execution flag: skip synthesizing tools from permission nodes. The tool
   * runtime isn't bound yet, so stub tools would make a real run fail. When
   * true, agents run as pure-LLM and permission nodes are advisory only.
   */
  disableTools?:      boolean
  /**
   * Layer C — media pipeline. Maps an agent node id → the media modality whose
   * `prompt` plug it feeds, ONLY for agents with no custom systemPrompt. When
   * set, the compiler auto-frames such an agent as a "prompt-writer for {modality}"
   * so a bare text node wired into a media node's prompt plug "just works".
   * Agents with custom instructions are never overridden.
   */
  mediaPromptWriters?: Record<string, MediaNodeModality>
  /**
   * #2 backbone — reference tokens. A map of canvas node id → that node's known
   * output text. When an agent's custom instructions / systemPrompt contain
   * `{{node:<id>}}` tokens, they are resolved against this map at compile time
   * (best-effort: an id with no known output resolves to ''). Used by the
   * per-node run (graph:run-node) to inject PINNED upstream outputs, and harmless
   * for a full run (defaults to empty → token templates resolve to blank, but
   * agents rarely use tokens in a full run). Templates with no tokens are
   * unaffected.
   */
  outputsByNodeId?: Map<string, string>
}

/**
 * Compile a TachiFlow into a runnable agent-kit Network.
 *
 * Throws Error with an actionable message when the graph is structurally
 * invalid (no agents, no entry, providerNode with missing model). Returns
 * a fresh Network + State on success. The compiler is referentially
 * transparent — calling it twice with the same input yields equivalent
 * (though distinct) objects.
 */
export function compileGraph<Ctx extends Record<string, unknown> = Record<string, unknown>>(
  flow: TachiFlow,
  opts: CompileGraphOptions<Ctx> = {},
): CompiledGraph<Ctx> {
  if (!flow || !Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) {
    throw new Error('compileGraph: invalid TachiFlow (nodes/edges missing)')
  }

  // R8b: first touch of agent-kit in the process (memoized module-wide).
  const { createAgent, createNetwork, createState } = agentKit()

  // -- 1. Index nodes by type ------------------------------------------------
  const providerNodes: TachiProviderNode[] = []
  const agentNodes:    TachiAgentNode[]    = []
  const skillNodes:    TachiSkillNode[]    = []
  for (const node of flow.nodes) {
    switch (node.type) {
      case 'provider': providerNodes.push(node); break
      case 'agent':    agentNodes.push(node);    break
      case 'skill':    skillNodes.push(node);    break
      // Tool nodes (folder/internet/mcp) are resolved per-agent via edges in
      // step 3, so we don't need to bucket them here — just acknowledge them so
      // the exhaustiveness guard stays meaningful for genuinely-unknown types.
      case 'folder':   break
      case 'internet': break
      case 'mcp':      break
      // Media nodes (image/video/music/tts/stt) run in Phase 2 of graph:run,
      // AFTER the text network settles — they are not agent-kit agents, so the
      // compiler just ignores them here.
      case 'media':    break
      // Prompt nodes are EXPANDED into a provider + agent pair upstream (in
      // graph.ipc, before compile), so the compiler should never see one. The
      // case exists only to keep the exhaustiveness guard happy.
      case 'prompt':   break
      // Static input nodes (Text / Reference-Image) carry no agent and no
      // provider — they feed downstream nodes purely as data (Text → prompt /
      // {{node:<id>}} tokens; Reference-Image → a media node's image_url). The
      // compiler ignores them; their values are resolved via outputsByNodeId
      // (Text) and imageRefFeederUrl (Reference-Image) at run time.
      case 'text':     break
      case 'imageref': break
      // Output cards are RESULTS dropped on the canvas by a run — pure data the
      // compiler ignores; their text resolves via outputsByNodeId like a Text node.
      case 'output':   break
      // Sticky NOTE nodes (NODES-RESEARCH #7) are pure canvas annotations — no
      // agent, no provider, no output, no handles. The compiler ignores them;
      // they are never runnable and are skipped by a run like a static input.
      case 'note':     break
      // Subflow proxies (NODES-RESEARCH #8) are a VISUAL COLLAPSE affordance —
      // no agent, no provider, no output. The collapsed CHILDREN keep their own
      // nodes (only `hidden`), so the compiler still sees + runs them normally;
      // the proxy itself is ignored here like a sticky note.
      case 'subflow':  break
      // Webhook TRIGGER nodes (BATCH35 lane B) are an inbound signal SOURCE: the
      // alert body sits on the node as `lastOutput` and is resolved downstream
      // exactly like a Text node's text. There is no agent and nothing to
      // execute, so the compiler ignores it — and it deliberately cannot reach
      // any tool: a trigger delivers text, never an action.
      case 'webhook':  break
      // RIFE nodes run in PHASE 2 (runRifeNode), not in the agent-kit network:
      // there is no model, no prompt and no tool call to compile — it is ffmpeg
      // and a GPU sidecar chewing on a file. The compiler ignores it for the
      // same reason it ignores a media node.
      case 'rife':     break
      // Unknown nodes (NODES-RESEARCH #3) are a loaded-but-unregistered type that
      // sanitizeFlow preserved as inert data — the compiler ignores them; they
      // are not runnable, so a run skips them exactly like a static input node.
      case 'unknown':  break
      default: {
        // Exhaustiveness guard: TachiNode is a closed union; if a new
        // discriminant appears we want a loud compile error.
        const _exhaustive: never = node
        void _exhaustive
      }
    }
  }

  if (agentNodes.length === 0) {
    throw new Error('compileGraph: graph contains no agent nodes — nothing to run')
  }

  // -- 2. Build provider adapters keyed by canvas node id --------------------
  const adapters = new Map<string, AiAdapter.Any>()
  for (const node of providerNodes) {
    const adapter = buildAdapter(node, opts)
    if (adapter) adapters.set(node.id, adapter)
  }

  // -- 3. Build agents -------------------------------------------------------
  // For each agent node:
  //   - resolve its model adapter from the upstream provider edge (first one wins)
  //   - resolve its tool allowlist from incoming skill/permission edges
  const agentsByNodeId = new Map<string, Agent<Ctx>>()
  for (const node of agentNodes) {
    const providerEdge = flow.edges.find(e => e.target === node.id && isFromNodeOfType(e.source, flow, 'provider'))

    const model = providerEdge ? adapters.get(providerEdge.source) : undefined
    if (providerEdge && !model) {
      // Provider node was present but its adapter could not be built (unsupported
      // providerId, missing model, missing credential). This is a soft warning
      // condition — we keep the agent but it will run without a model, which
      // agent-kit will fail loudly on at .run() time. Throwing here gives a
      // better error surface than letting it blow up mid-run.
      throw new Error(
        `compileGraph: agent '${node.data.label}' (node ${node.id}) has a provider edge ` +
        `from node ${providerEdge.source} but no adapter could be built. ` +
        `Check the provider node's providerId/model and that required credentials ` +
        `(bankrApiKey, freellmapiApiKey, etc.) were passed in CompileGraphOptions.`,
      )
    }

    const agentName = agentNameFor(node)

    // Resolve REAL tools from wired tool nodes + Role permissions (unless tools
    // are disabled). Folder/Internet/MCP nodes may be wired in either direction.
    const toolsDisabled = opts.disableTools ?? false
    const allowed = collectAllowedTools(node.id, flow)
    const folderNode   = connectedNodeOfType(node.id, flow, 'folder')   as TachiFolderNode   | undefined
    const internetNode = connectedNodeOfType(node.id, flow, 'internet') as TachiInternetNode | undefined
    const mcpWired     = connectedNodesOfType(node.id, flow, 'mcp')     as TachiMcpNode[]
    const workspaceRoot =
      (folderNode && typeof folderNode.data.path === 'string' && folderNode.data.path.trim())
        ? folderNode.data.path.trim()
        : opts.defaultWorkspaceRoot

    const tools = toolsDisabled
      ? []
      : buildAgentTools({ workspaceRoot, allowed, internet: !!internetNode })

    const mcpServers = toolsDisabled ? [] : mcpWired
      .map(n => toMcpServer(n, opts))
      .filter((s): s is McpServerConfig => s !== null)

    // Hints from incoming agent->agent edges (e.g. "needs review") tell this
    // agent what its upstream sender expects it to do with their output.
    const incomingHints = flow.edges
      .filter(e => e.target === node.id && isFromNodeOfType(e.source, flow, 'agent'))
      .map(e => (typeof e.data?.instruction === 'string' ? e.data.instruction.trim() : ''))
      .filter(h => h.length > 0)

    agentsByNodeId.set(node.id, createAgent<Ctx>({
      name:   agentName,
      system: defaultSystemPrompt(node, incomingHints, opts.mediaPromptWriters?.[node.id], opts.outputsByNodeId),
      ...(model ? { model } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(mcpServers.length > 0 ? { mcpServers } : {}),
    }))
  }

  // -- 4. Pick entry agent ---------------------------------------------------
  const entryAgentId = findEntryAgent(agentNodes, flow.edges)
  const entryAgent   = agentsByNodeId.get(entryAgentId)
  if (!entryAgent) {
    throw new Error(`compileGraph: internal — entry agent ${entryAgentId} missing from agent map`)
  }

  // Reverse lookup: agent name -> canvas node id. We need this in the router
  // because lastResult exposes agentName (string) but our routing edges are
  // keyed by canvas node id.
  const agentNodeIdByName = new Map<string, string>()
  for (const [nodeId, agent] of agentsByNodeId) {
    agentNodeIdByName.set(agent.name, nodeId)
  }

  // -- 5. Build router -------------------------------------------------------
  // Routing semantics:
  //   - A plain chain (A -> B -> C) ALWAYS proceeds to the next agent. Edge
  //     labels are hints for the downstream agent, NOT gates — so "Writer ->
  //     Reviewer" runs both, and the LAST agent's output is the final answer.
  //   - When an agent has MULTIPLE outgoing agent edges (a branch), a labelled
  //     edge whose text substring-matches the output wins (explicit conditional
  //     routing); otherwise we fall back to the first outgoing edge so the flow
  //     never dead-ends silently.
  //   - `visited` guards against cycles (each agent runs at most once).
  const visited = new Set<string>([entryAgentId])
  const router: Network.Router<Ctx> = ({ lastResult, callCount }) => {
    if (callCount === 0) {
      opts.onAgentStart?.(entryAgentId)
      return entryAgent
    }

    // Find the source agent's canvas node id.
    const lastAgentName  = lastResult?.agentName
    const lastAgentNodeId = lastAgentName ? agentNodeIdByName.get(lastAgentName) : undefined
    if (!lastAgentNodeId) return undefined

    // Tool loop: agent.run() runs ONE inference and executes any tools it called,
    // but does NOT re-infer — so an agent that just called a tool hasn't produced
    // its final answer yet. Re-invoke the SAME agent so it can read the tool
    // results and respond. (Bounded by the network's maxIter.) Without this, a
    // single-agent + tools graph returns empty (the tool ran, but no text reply).
    const toolCalls = (lastResult as { toolCalls?: unknown[] } | undefined)?.toolCalls
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      const sameAgent = agentsByNodeId.get(lastAgentNodeId)
      if (sameAgent) {
        opts.onAgentStart?.(lastAgentNodeId)
        return sameAgent
      }
    }

    const outgoing = flow.edges.filter(e =>
      e.source === lastAgentNodeId
      && isFromNodeOfType(e.target, flow, 'agent'),
    )
    if (outgoing.length === 0) return undefined // end of chain — halt

    // Prefer a labelled edge whose condition matches (conditional branch)...
    const outputText = extractOutputText(lastResult?.output)
    let nextNodeId: string | undefined
    for (const edge of outgoing) {
      const instruction = typeof edge.data?.instruction === 'string' ? edge.data.instruction : ''
      if (instruction.trim().length > 0 && matchCondition(instruction, outputText)) {
        nextNodeId = edge.target
        break
      }
    }
    // ...otherwise just follow the first outgoing edge (linear chain always runs).
    if (!nextNodeId) nextNodeId = outgoing[0]!.target

    if (visited.has(nextNodeId)) return undefined // cycle guard — halt
    visited.add(nextNodeId)
    const nextAgent = agentsByNodeId.get(nextNodeId)
    if (nextAgent) {
      opts.onAgentStart?.(nextNodeId)
      return nextAgent
    }
    return undefined // halt
  }

  // -- 6. Assemble Network + State ------------------------------------------
  const initialContext = (opts.initialContext ?? ({} as Ctx)) as Ctx
  const state = createState<Ctx>(initialContext)
  const network = createNetwork<Ctx>({
    name:    flow.name || 'compiled-graph',
    agents:  [...agentsByNodeId.values()],
    router,
    maxIter: opts.maxIter ?? 50,
    ...(opts.defaultModel ? { defaultModel: opts.defaultModel } : {}),
  })

  return { network, state, entryAgentId }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Map a ProviderNode to an AiAdapter via makeAdapterFor. Bridges the UI's
 * provider vocabulary onto agentkit-adapters' narrower union.
 *
 * Returns null when:
 *   - providerId is unsupported by the adapter layer (e.g. 'anthropic', which
 *     needs OAuth + the native /v1/messages format) — these will need their
 *     own factory before they can be used by the compiled network
 *   - the required model field is missing on the provider node
 *   - a required credential wasn't supplied in CompileGraphOptions
 */
function buildAdapter(
  node: TachiProviderNode,
  opts: CompileGraphOptions<Record<string, unknown>>,
): AiAdapter.Any | null {
  const uiProviderId = String(node.data.providerId || '')
  const adapterId = mapProviderId(uiProviderId)
  if (!adapterId) return null

  // Default to 'auto' for providers that accept it — the freellmapi sidecar
  // picks a free model with it and OpenGateway routes on it server-side.
  // OLLAMA DOES NOT: it wants a pulled model name and answers `model 'auto'
  // not found`, minutes in. (Chat gets away with 'auto' only because
  // chat-service resolves it against /api/tags before sending.) That gap is
  // caught before the run starts — see graph.ipc's isUnresolvedModel gate —
  // rather than by rewriting the model here, where nothing knows what the node
  // is showing the user.
  const explicitModel = typeof node.data.model === 'string' ? node.data.model : ''
  // bankr + surplus are Bearer gateways with named catalogs — they reject 'auto',
  // so an explicit model is required (the provider node seeds a sensible default).
  const model = explicitModel
    || (adapterId === 'bankr' || adapterId === 'surplus' || adapterId === 'venice' || adapterId === 'imgnai' ? ''
      : 'auto')
  if (!model) return null

  // Resolve the base URL. A runtime override (baseUrlByNodeId) always wins —
  // those are fully-qualified URLs resolved by the caller (e.g. the freellmapi
  // sidecar port). The canvas node's `endpoint` is a human-readable display
  // hint (e.g. 'llm.bankr.bot/v1', 'localhost:11434') that is frequently
  // scheme-less or path-incomplete; feeding it to `new URL()` would throw. So
  // we only honor it when it's already a complete absolute http(s) URL, and
  // otherwise fall back to the adapter's own (correct) default base URL.
  const baseUrl =
    opts.baseUrlByNodeId?.[node.id]
    ?? asAbsoluteUrl(node.data.endpoint)

  const adapterOpts: Record<string, unknown> = { model }
  if (baseUrl) adapterOpts.baseUrl = baseUrl

  switch (adapterId) {
    case 'bankr':
      if (!opts.bankrApiKey) return null
      adapterOpts.apiKey = opts.bankrApiKey
      break
    case 'freellmapi-local':
      if (opts.freellmapiApiKey) adapterOpts.apiKey = opts.freellmapiApiKey
      // Fallback-chain override: force a specific free model id on retry.
      if (opts.freellmapiModelOverride) adapterOpts.model = opts.freellmapiModelOverride
      break
    case 'llamacpp':
      if (opts.llamaCppApiKey) adapterOpts.apiKey = opts.llamaCppApiKey
      if (!baseUrl) return null
      break
    case 'ollama':
      // keyless, no baseUrl required (adapter defaults to the local port)
      break
    case 'opengateway':
      if (!opts.opengatewayApiKey) return null
      adapterOpts.apiKey = opts.opengatewayApiKey
      break
    case 'surplus':
      if (!opts.surplusApiKey) return null
      adapterOpts.apiKey = opts.surplusApiKey
      break
    case 'venice':
      if (!opts.veniceApiKey) return null
      adapterOpts.apiKey = opts.veniceApiKey
      break
    case 'imgnai':
      if (!opts.imgnaiApiKey) return null
      adapterOpts.apiKey = opts.imgnaiApiKey
      break
    default: {
      const _exhaustive: never = adapterId
      void _exhaustive
      return null
    }
  }

  return makeAdapterFor(adapterId, adapterOpts)
}

/**
 * Return `raw` only if it is already a complete absolute http(s) URL; else
 * undefined. Used to decide whether a provider node's display `endpoint` is a
 * usable base URL or just a label — see buildAdapter for the rationale.
 */
function asAbsoluteUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!/^https?:\/\//i.test(trimmed)) return undefined
  try {
    void new URL(trimmed)
    return trimmed
  } catch {
    return undefined
  }
}

/**
 * Translate a UI providerId -> agentkit-adapters AgentKitProviderId.
 * Returns null for ids the adapter layer doesn't (yet) support (e.g. Anthropic,
 * OpenRouter).
 *
 * Accepts BOTH the legacy short node ids ('bankr', 'ollama', 'llamacpp',
 * 'freellmapi') AND the canonical provider-registry ids ('bankr-gateway',
 * 'ollama-local', 'llama-cpp', 'freellmapi-local'). This is the compatibility
 * shim that lets the Nodes UI migrate to the shared registry's canonical
 * vocabulary without breaking flows saved with the old short ids.
 */
function mapProviderId(uiId: string): AgentKitProviderId | null {
  switch (uiId) {
    case 'bankr':
    case 'bankr-gateway':    return 'bankr'
    case 'ollama':
    case 'ollama-local':     return 'ollama'
    case 'llamacpp':
    case 'llama-cpp':        return 'llamacpp'
    case 'freellmapi':
    case 'freellmapi-local': return 'freellmapi-local'
    case 'opengateway':      return 'opengateway'
    case 'surplus':          return 'surplus'
    case 'venice':           return 'venice'
    case 'imgnai':           return 'imgnai'
    default:                 return null
  }
}

/**
 * Collect the union of Role/permission allowedTools (lowercased) across every
 * skill/role node connected to this agent (in EITHER edge direction). Returns
 * an empty set when no permission node is wired (paranoid default — no tools).
 */
function collectAllowedTools(agentId: string, flow: TachiFlow): Set<string> {
  const allowed = new Set<string>()
  for (const skill of connectedNodesOfType(agentId, flow, 'skill')) {
    const data = skill.data as { allowedTools?: unknown }
    const tools = Array.isArray(data.allowedTools) ? data.allowedTools : []
    for (const t of tools) {
      if (typeof t === 'string' && t.length > 0) allowed.add(t.toLowerCase())
    }
  }
  return allowed
}

/** All nodes of `type` connected to `agentId` via any edge (either direction). */
function connectedNodesOfType(agentId: string, flow: TachiFlow, type: TachiNode['type']): TachiNode[] {
  const ids = new Set<string>()
  for (const e of flow.edges) {
    if (e.source === agentId && isFromNodeOfType(e.target, flow, type)) ids.add(e.target)
    if (e.target === agentId && isFromNodeOfType(e.source, flow, type)) ids.add(e.source)
  }
  const out: TachiNode[] = []
  for (const id of ids) {
    const n = flow.nodes.find(x => x.id === id)
    if (n) out.push(n)
  }
  return out
}

/** First node of `type` connected to `agentId`, if any. */
function connectedNodeOfType(agentId: string, flow: TachiFlow, type: TachiNode['type']): TachiNode | undefined {
  return connectedNodesOfType(agentId, flow, type)[0]
}

/**
 * Convert an MCP node into an agent-kit MCP.Server config. A blank url falls
 * back to the app's built-in server (mcpDefaultUrl); the bearer token, when
 * provided, is injected as an Authorization header.
 */
function toMcpServer(
  node: TachiMcpNode,
  opts: CompileGraphOptions<Record<string, unknown>>,
): McpServerConfig | null {
  const explicit = typeof node.data.url === 'string' ? node.data.url.trim() : ''
  const url = explicit || opts.mcpDefaultUrl
  if (!url) return null
  // Skip MCP servers the caller couldn't reach — wiring an unreachable server
  // would terminate the whole agent run (agent-kit throws on MCP init failure).
  if (opts.allowedMcpUrls && !opts.allowedMcpUrls.has(url)) return null
  const requestInit: RequestInit | undefined = opts.mcpBearerToken
    ? { headers: { Authorization: `Bearer ${opts.mcpBearerToken}` } }
    : undefined
  return {
    name: (node.data.label || `mcp-${node.id}`).trim(),
    transport: {
      type: 'streamable-http',
      url,
      ...(requestInit ? { requestInit } : {}),
    },
  }
}

/**
 * Find the entry agent: an agent node with no incoming agent->agent edges.
 *
 * Tie-breakers:
 *   1. node.data.isEntry === true (reserved for future UI marker; not yet
 *      part of AgentNodeData, but harmless to probe via index access)
 *   2. top-left canvas position (lowest y, then lowest x)
 *   3. first by node id (lexicographic) as a final deterministic fallback
 */
function findEntryAgent(agentNodes: TachiAgentNode[], edges: TachiEdge[]): string {
  const agentIds = new Set(agentNodes.map(n => n.id))
  const hasIncomingAgentEdge = (id: string) =>
    edges.some(e => e.target === id && agentIds.has(e.source))

  const candidates = agentNodes.filter(n => !hasIncomingAgentEdge(n.id))
  const pool = candidates.length > 0 ? candidates : agentNodes // fallback to all if every agent is in a cycle

  // Tie-break 1: explicit isEntry marker (future-proof; data is open record)
  const explicit = pool.find(n => {
    const flagged = (n.data as Record<string, unknown>)['isEntry']
    return flagged === true
  })
  if (explicit) return explicit.id

  // Tie-break 2: top-left position
  const sorted = [...pool].sort((a, b) => {
    const ay = a.position?.y ?? 0
    const by = b.position?.y ?? 0
    if (ay !== by) return ay - by
    const ax = a.position?.x ?? 0
    const bx = b.position?.x ?? 0
    if (ax !== bx) return ax - bx
    // Tie-break 3: id
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  const winner = sorted[0]
  if (!winner) throw new Error('compileGraph: could not determine entry agent (no agent nodes)')
  return winner.id
}

/**
 * Return true iff the edge label is empty OR appears as a case-insensitive
 * substring of the agent's textual output. This is the V1 routing predicate
 * and will be superseded by a typed DSL.
 */
function matchCondition(label: string, outputText: string): boolean {
  const trimmed = label.trim()
  if (trimmed.length === 0) return true
  return outputText.toLowerCase().includes(trimmed.toLowerCase())
}

/**
 * Flatten the assistant TextMessage output array into a single searchable
 * string. Tool calls and tool results are ignored — routing keys off
 * natural-language assistant text only. (Also used by graph.ipc.ts to flatten
 * AgentResult.output for run results.)
 */
export function extractOutputText(output: unknown): string {
  if (!Array.isArray(output)) return ''
  const parts: string[] = []
  for (const m of output) {
    if (m && typeof m === 'object' && (m as { type?: unknown }).type === 'text') {
      const content = (m as { content?: unknown }).content
      if (typeof content === 'string') {
        parts.push(content)
      } else if (Array.isArray(content)) {
        for (const c of content) {
          if (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string') {
            parts.push((c as { text: string }).text)
          }
        }
      }
    }
  }
  return parts.join('\n')
}

/**
 * True iff the node identified by `id` exists in the graph and has the
 * given node `type`. Used to classify edges by their endpoints' types.
 */
function isFromNodeOfType(
  id:    string,
  flow:  TachiFlow,
  kind:  TachiNode['type'],
): boolean {
  const n = flow.nodes.find(x => x.id === id)
  return !!n && n.type === kind
}

/**
 * Derive a deterministic, agent-kit-friendly agent name from a TachiAgentNode.
 * agent-kit uses the name as a map key inside Network.agents, so duplicates
 * are silently overwritten by later additions. We disambiguate with the
 * node id suffix to guarantee uniqueness even when two agents share a label.
 */
function agentNameFor(node: TachiAgentNode): string {
  const base = (node.data.label || node.data.harnessId || 'agent').trim() || 'agent'
  return `${base}#${node.id}`
}

/**
 * Synthesize a system prompt from the canvas-node data. Today the editor
 * doesn't surface a system-prompt field, so we use a sensible default
 * that names the agent and its harness. Once AgentNodeData gains a
 * systemPrompt field (or a wiring to a system-prompt node), replace this.
 */
function defaultSystemPrompt(
  node: TachiAgentNode,
  incomingHints: string[] = [],
  promptWriterModality?: MediaNodeModality,
  outputsByNodeId?: Map<string, string>,
): string {
  const label   = node.data.label   || 'Agent'
  const harness = node.data.harnessId || 'agent'
  // #2 backbone — resolve `{{node:<id>}}` reference tokens in the user's custom
  // instructions against known outputs (best-effort). No tokens → unchanged.
  const rawCustom = typeof node.data.systemPrompt === 'string' ? node.data.systemPrompt : ''
  const custom = hasNodeToken(rawCustom)
    ? resolveTemplateTokens(rawCustom, outputsByNodeId ?? new Map())
    : rawCustom.trim()
  // Layer C — media prompt-writer auto-framing. When this agent feeds a media
  // node's `prompt` plug AND has no custom instructions, reframe it as a writer
  // of generation prompts for that modality so its output is a clean prompt
  // (not a chatty reply). Custom-instruction agents are NEVER overridden.
  if (!custom && promptWriterModality) {
    const guidance = mediaPromptGuidance(promptWriterModality)
    const base =
      `You are ${label}, a prompt-writer inside a TachiDesk Nodes flow. Your sole job is ` +
      `to turn the user's request (and any earlier agents' output above) into ONE vivid, ` +
      `self-contained ${promptWriterModality} generation prompt. ${guidance} ` +
      `Output ONLY the final prompt text — no preamble, no quotes, no explanation.`
    if (incomingHints.length > 0) {
      return `${base} Additional guidance for this step: ${incomingHints.join('; ')}.`
    }
    return base
  }
  // If the user wrote custom instructions on the node, honor them as the agent's
  // persona/role; otherwise synthesize a sensible default. Either way we still
  // tell it that it's one step in a pipeline and append any incoming edge hints.
  const base = custom
    ? `${custom}\n\n(You are "${label}", one step in a TachiDesk multi-agent flow. ` +
      `Earlier agents' output, if any, is in the conversation above — build on it. Respond concisely.)`
    : `You are ${label}, a ${harness} agent inside a TachiDesk Nodes flow. ` +
      `You are one step in a multi-agent pipeline. If earlier agents have already ` +
      `responded, their output is in the conversation above — build on it (review, ` +
      `refine, summarize, or continue) rather than starting over. Respond concisely.`
  if (incomingHints.length > 0) {
    return `${base} Your task in this step: ${incomingHints.join('; ')}.`
  }
  return base
}

/** Per-modality writing guidance for an auto-framed media prompt-writer agent. */
function mediaPromptGuidance(modality: MediaNodeModality): string {
  switch (modality) {
    case 'image': return 'Describe the subject, composition, lighting, style, and mood for an image generator.'
    case 'video': return 'Describe the scene, motion, camera, and pacing for a video generator.'
    case 'music': return 'Describe the genre, mood, instrumentation, and tempo for a music generator.'
    case 'tts':   return 'Write the exact text that should be spoken aloud, naturally and clearly.'
    case 'stt':   return 'Describe the audio to transcribe.'
  }
}

// ===========================================================================
// Layer C — Phase 2: media node execution
// ===========================================================================
//
// graph:run is two-phase. Phase 1 (compileGraph + network.run) is UNCHANGED;
// it produces the per-agent text results. Phase 2 (below) runs AFTER, only when
// the graph contains media nodes:
//
//   for each media node:
//     1. resolve its prompt — the result text of the agent wired into its
//        `prompt` plug (a `media` target handle id 'prompt'), else the node's
//        typed `prompt` field.
//     2. resolve its auto-save dir — a Folder node wired into its `folder` plug
//        (target handle 'folder'), else the node's typed `autoSaveDir`.
//     3. call the media engine (sync image/tts, async video/music submit+poll,
//        sync stt), collect artifacts.
//     4. surface a per-node MediaNodeResult back to the caller.
//
// A pure-text graph has no media nodes → runMediaPhase returns [] and graph:run
// behaves exactly as before. The engine is imported directly (main-process), so
// async submit+poll happen in the same lifetime (per Layer A's caveat).

// ---------------------------------------------------------------------------
// Reference tokens (#2 backbone — the cross-node data-flow primitive)
// ---------------------------------------------------------------------------
//
// A template string (a media node's typed prompt, or an agent's instructions/
// systemPrompt) may embed REFERENCE TOKENS of the EXACT form:
//
//     {{node:<nodeId>}}
//
// At run time each token is replaced by that node's resolved output text. This
// lets a single field combine MULTIPLE upstream outputs, e.g.
//     "{{node:abc}}, mood: {{node:def}}"
// which the prompt-plug feeder (single upstream) can't express. Unknown tokens
// resolve to '' (blank). The result is trimmed. A template with NO tokens is
// returned UNCHANGED (modulo the outer trim) — so existing flows are unaffected.

/** Matches `{{node:<id>}}` — id is any run of non-`}` chars, whitespace-tolerant. */
const NODE_TOKEN_RE = /\{\{\s*node:\s*([^}]+?)\s*\}\}/g

/**
 * Replace every `{{node:<id>}}` token in `template` with that node's resolved
 * output text from `outputsByNodeId` (missing → ''). Returns the trimmed result.
 * Pure + side-effect-free; safe to call on every template at compile/run time.
 */
export function resolveTemplateTokens(
  template: string,
  outputsByNodeId: Map<string, string>,
): string {
  if (!template) return ''
  if (!template.includes('{{')) return template.trim()  // fast path: no tokens
  return template
    .replace(NODE_TOKEN_RE, (_match, id: string) => {
      const text = outputsByNodeId.get(id.trim())
      return typeof text === 'string' ? text : ''
    })
    .trim()
}

/** True iff a string contains at least one `{{node:<id>}}` reference token. */
function hasNodeToken(s: unknown): boolean {
  return typeof s === 'string' && /\{\{\s*node:/.test(s)
}

/** Per-media-node Phase 2 result, surfaced to the renderer alongside text. */
export interface MediaNodeResult {
  nodeId:    string
  label:     string
  modality:  MediaNodeModality
  /** The prompt actually used (resolved plug output or typed field). */
  prompt:    string
  ok:        boolean
  artifacts: MediaArtifact[]
  /** STT transcript (no artifact). */
  text?:     string
  error?:    string
}

/** All media nodes in the flow. */
function mediaNodesOf(flow: TachiFlow): TachiMediaNode[] {
  return flow.nodes.filter((n): n is TachiMediaNode => n.type === 'media')
}

/**
 * The agent node feeding a media node's `prompt` plug, if any. We look for an
 * edge whose target is the media node with targetHandle 'prompt' and whose
 * source is an agent. (Falls back to ANY agent→media edge if no explicit
 * prompt-handle is recorded, so older saves / loose wiring still resolve.)
 */
function promptFeederAgentId(mediaNodeId: string, flow: TachiFlow): string | undefined {
  const explicit = flow.edges.find(e =>
    e.target === mediaNodeId
    && (e.targetHandle === 'prompt' || e.targetHandle == null)
    && isFromNodeOfType(e.source, flow, 'agent'),
  )
  if (explicit) return explicit.source
  return undefined
}

/** The Folder node wired into a media node's `folder` plug, if any. */
function folderFeederPath(mediaNodeId: string, flow: TachiFlow): string | undefined {
  const edge = flow.edges.find(e =>
    e.target === mediaNodeId
    && (e.targetHandle === 'folder' || e.targetHandle == null)
    && isFromNodeOfType(e.source, flow, 'folder'),
  )
  if (!edge) return undefined
  const node = flow.nodes.find(n => n.id === edge.source)
  const path = node && node.type === 'folder' && typeof node.data.path === 'string' ? node.data.path.trim() : ''
  return path || undefined
}

/** The artifact fields resolveWiredImages reads, from either carrier node. */
type WiredArtifact = { kind?: string; mimeType?: string; path?: string; b64?: string }

/**
 * Data URLs of EVERY Reference-Image node wired into `targetId` — detected by
 * SOURCE TYPE (any plug). Two consumers:
 *   • a Media node → its reference image / image-to-video init frame (image_url)
 *   • a Prompt/agent node → vision input, so the text model SEES the reference
 *     while writing (handled in graph.ipc via veniceVisionChat).
 */
export function imageRefUrlsInto(targetId: string, flow: TachiFlow): string[] {
  const urls: string[] = []
  for (const e of flow.edges) {
    if (e.target !== targetId) continue
    const src = flow.nodes.find(n => n.id === e.source)
    if (!src || src.type !== 'imageref') continue
    const d = src.data as { dataUrl?: unknown; filePath?: unknown }
    // Legacy nodes stored the image INLINE as a base64 data URL (multi-MB in
    // localStorage — the canvas-lag source). Still honored so old flows run.
    if (typeof d.dataUrl === 'string' && d.dataUrl.trim()) {
      urls.push(d.dataUrl.trim())
      continue
    }
    // Newer nodes keep the image on disk (userData/media/refs) and store only
    // its path — inline it here so providers still receive a data URL.
    if (typeof d.filePath === 'string' && d.filePath.trim()) {
      const p = d.filePath.trim()
      const ext = p.split('.').pop()?.toLowerCase() ?? 'png'
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
        : ext === 'webp' ? 'image/webp'
        : ext === 'gif' ? 'image/gif'
        : 'image/png'
      try { urls.push(`data:${mime};base64,${readFileSync(p).toString('base64')}`) }
      catch { /* unreadable ref file → skip (node shows the preview from the same path) */ }
    }
  }
  return urls
}

/**
 * ALL reference-image data URLs wired into a node (any plug), from BOTH sources:
 *   1. Reference-Image nodes → their stored data URLs, AND
 *   2. Output cards holding a generated image → the artifact's b64, or read off
 *      disk (path) → a data URL.
 * Async because an artifact may need a disk read. Used for a media node's
 * `image_url` (img2img / i2v frame) AND a Prompt node's VISION input (so the
 * model literally sees the character/object you wired in).
 */
export async function resolveWiredImages(targetId: string, flow: TachiFlow): Promise<string[]> {
  const urls: string[] = [...imageRefUrlsInto(targetId, flow)]
  for (const e of flow.edges) {
    if (e.target !== targetId) continue
    const src = flow.nodes.find(n => n.id === e.source)
    if (!src) continue
    // An Output card holds its result under `artifacts`. A MEDIA node holds its
    // own last result under `lastArtifacts` — the field the renderer stamps after
    // a per-node run AND the one runMediaPhase threads mid-Run-all — so a media
    // node wired STRAIGHT into the next one (the storyboard shape: image → i2v
    // video) hands its picture over. Without this branch that wire resolved to
    // nothing at all and the second stage silently generated from text only.
    const arts = src.type === 'output' ? (src.data as { artifacts?: WiredArtifact[] }).artifacts
      : src.type === 'media' ? (src.data as { lastArtifacts?: WiredArtifact[] }).lastArtifacts
      : undefined
    const img = Array.isArray(arts) ? arts.find(a => a.kind === 'image') : undefined
    if (!img) continue
    if (img.b64) urls.push(`data:${img.mimeType || 'image/png'};base64,${img.b64}`)
    else if (img.path) {
      try { urls.push(`data:${img.mimeType || 'image/png'};base64,${readFileSync(img.path).toString('base64')}`) }
      catch { /* unreadable artifact → skip */ }
    }
  }
  // One picture is often reachable twice — a media node AND the Output card that
  // mirrors it, both wired into the same node. Offer it once.
  return [...new Set(urls)]
}

/** First reference image wired into a media node → its data URL (for image_url). */
async function resolveWiredImage(mediaNodeId: string, flow: TachiFlow): Promise<string | undefined> {
  return (await resolveWiredImages(mediaNodeId, flow))[0]
}

// ── The FLF last-frame hop ────────────────────────────────────────────────────
//
// The storyboard technique (LOWVRAM-META-RESEARCH DELTA ADDENDUM, "FLF
// CHAINING"): a scene's LAST FRAME starts the next scene, and chained segments
// walk a story forward that no single pass could hold. On this canvas that is a
// media(video) → media(video) wire — and the artifact travelling down it is an
// .mp4 while the consuming slot is an INIT FRAME.
//
// resolveWiredImages answers with IMAGES only (`kind === 'image'`), so before
// this hop such a wire resolved to nothing at all and the next segment silently
// generated from text — the same silent-wrong-picture class the topo fix cured,
// and just as invisible in the result. The hop closes it by decoding the clip's
// last frame to a PNG (zero VRAM, post-decode) and threading THAT.
//
// It is deliberately a LAST RESORT: an explicit image wire, or an image_url on
// the node, always wins untouched, so nothing that worked before changes shape,
// and no ffmpeg runs for a graph that never needed one.

/** Modalities whose `image_url` is a real input: an i2v init frame (video) or an
 *  img2img / reference image. Music, TTS and STT have no image slot to fill. */
const LAST_FRAME_CONSUMERS: ReadonlySet<MediaNodeModality> = new Set(['image', 'video'])

/**
 * On-disk paths of the VIDEO artifacts wired into `targetId`, from the same two
 * carriers resolveWiredImages reads (a media node's `lastArtifacts`, an Output
 * card's `artifacts`). A b64-only artifact is skipped: ffmpeg needs a file, and
 * inventing one for a clip that never landed on disk would trade a missing frame
 * for a wrong one.
 */
// ONE implementation, shared with the canvas: the rife node asks the same
// question ("which clip is wired in?") and must get the same answer, and the
// carrier set grew a third member (a `rife` node's own interpolated output) that
// both readers have to know about. See src/pages/nodes/rifeNode.ts.
function wiredVideoPaths(targetId: string, flow: TachiFlow): string[] {
  return wiredVideoPathsInto(targetId, flow.nodes, flow.edges)
}

/**
 * The last frame of the first wired clip that yields one, as a PNG data URL —
 * the same shape resolveWiredImages hands every provider (a filesystem path
 * would be meaningless to the cloud branches). undefined when there is no clip,
 * no ffmpeg, or no decodable frame: the segment then runs WITHOUT an init frame,
 * exactly as it does after a failed upstream stage.
 */
async function resolveWiredLastFrame(targetId: string, flow: TachiFlow): Promise<string | undefined> {
  for (const path of wiredVideoPaths(targetId, flow)) {
    const url = await lastFrameDataUrl(path)
    if (url) return url
  }
  return undefined
}

/**
 * A Text node wired into a media node's `prompt` plug, if any. A Text node is a
 * STATIC prompt source (its typed text IS its output, mirrored to lastOutput),
 * so it should feed the prompt directly like an agent would — but the agent
 * prompt-feeder branch ignores it (it isn't an agent), so we match it here.
 * Returns the node id; its text lives in outputsByNodeId.
 */
function textFeederNodeId(mediaNodeId: string, flow: TachiFlow): string | undefined {
  const edge = flow.edges.find(e => {
    if (e.target !== mediaNodeId) return false
    if (!(e.targetHandle === 'prompt' || e.targetHandle == null)) return false
    const src = flow.nodes.find(n => n.id === e.source)
    if (!src) return false
    if (src.type === 'text') return true
    // Output cards feed the prompt ONLY when they're TEXT results — a media
    // (image) result must NOT pollute the prompt with its "[media result]"
    // marker; it goes to the `image` plug instead.
    if (src.type === 'output' && (src.data as { kind?: string }).kind !== 'media') return true
    return false
  })
  return edge?.source
}

/**
 * Build the mediaPromptWriters map for compileGraph: agent node id → the media
 * modality whose `prompt` plug that agent feeds. Used to auto-frame bare text
 * agents as prompt-writers at compile time. Only the FIRST media node an agent
 * feeds determines its framing (an agent feeding multiple is rare).
 */
export function mediaPromptWritersOf(flow: TachiFlow): Record<string, MediaNodeModality> {
  const out: Record<string, MediaNodeModality> = {}
  for (const media of mediaNodesOf(flow)) {
    const agentId = promptFeederAgentId(media.id, flow)
    if (agentId && !(agentId in out)) out[agentId] = media.data.modality
  }
  return out
}

/**
 * Resolve a media node's effective prompt. Precedence:
 *   1. The node's typed `prompt` field IF it contains reference tokens —
 *      resolved against the upstream outputs map. Tokens let one prompt combine
 *      MULTIPLE upstream outputs (e.g. "{{node:a}}, mood: {{node:b}}"), which the
 *      single prompt-plug feeder can't express, so a token template wins.
 *   2. Else the wired prompt-feeder agent's result text (the single upstream
 *      agent on the `prompt` plug, matched by canvas node id).
 *   3. Else the typed `prompt` field verbatim (no tokens → returned trimmed).
 */
function resolveMediaPrompt(
  media: TachiMediaNode,
  flow: TachiFlow,
  outputsByNodeId: Map<string, string>,
): string {
  const typed = typeof media.data.prompt === 'string' ? media.data.prompt : ''

  // 1. Token template wins — it can fuse several upstream outputs.
  if (hasNodeToken(typed)) {
    const resolved = resolveTemplateTokens(typed, outputsByNodeId)
    if (resolved) return resolved
  }

  // 2. Prompt-plug feeder (single upstream agent).
  const feederId = promptFeederAgentId(media.id, flow)
  if (feederId) {
    const text = outputsByNodeId.get(feederId)
    if (text && text.trim()) return text.trim()
  }

  // 2b. A Text node wired into the prompt plug feeds its literal text directly.
  const textFeeder = textFeederNodeId(media.id, flow)
  if (textFeeder) {
    const text = outputsByNodeId.get(textFeeder)
    if (text && text.trim()) return text.trim()
  }

  // 3. Typed field verbatim (no tokens, or tokens resolved to empty).
  return typed.trim()
}

/**
 * Strip the params keys that map to a typed engine field (so they aren't sent
 * twice) plus the renderer-only `audioPath`. Everything left (negative_prompt,
 * seed, steps, cfg, sampler, strength, aspect_ratio, image_url, genre,
 * instrumental, …) is forwarded as the engine's schema-driven `params` and
 * merged into the request body defensively.
 */
function extraParamsFor(modality: MediaNodeModality, params: Record<string, unknown>): Record<string, unknown> {
  const TYPED: Record<MediaNodeModality, string[]> = {
    image: ['size', 'n', 'audioPath'],
    video: ['duration', 'resolution', 'audioPath'],
    music: ['lyrics', 'duration', 'resolution', 'audioPath'],
    tts:   ['voice', 'format', 'audioPath'],
    stt:   ['audioPath'],
  }
  const skip = new Set(TYPED[modality] ?? ['audioPath'])
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) if (!skip.has(k)) out[k] = v
  return out
}

// ── The init-frame temps (FLF driver, finding 5) ─────────────────────────────
//
// Every canvas run whose reference image arrives as a `data:` URL writes one
// PNG into %TEMP% so sd-cli has something to open. The write shipped; the
// delete did not, and 882 of them were sitting on the driver's machine. The
// per-run half is a `finally` inside runMediaNode (the video-last-frame
// pattern); this is the other half — the ones already on disk, plus anything a
// hard kill (a crash, a Stop, a power cut) leaves behind in the future.
//
// Conservative on purpose: OUR filename shape only, and only files old enough
// that no live run could still hold one. A 44-minute Wan render keeps its init
// frame open the whole time it runs, so an aggressive age here would break the
// very runs this file exists to serve.

/**
 * Only these get collected: the exact names the two materialisation sites write.
 *
 * The extension set is `extForMime`'s WHOLE range, not just `.png`. It used to be
 * .png alone, so every init frame the MEDIA route wrote from a JPEG / WebP / BMP
 * data URL fell outside the pattern and was uncollectable *forever* — nothing
 * else on the machine ever looks at these files again. Adding an extension to
 * extForMime means adding it here (sdInitTempCleanup pins the two together by
 * materialising one temp per mime and demanding the sweep take all of them).
 */
const SD_INIT_TEMP_RE = /^sd-init-\d+(-[0-9a-f]+)?\.(png|jpe?g|webp|bmp)$/

/**
 * The OTHER shape a local-media run leaves in %TEMP%, and the bigger one.
 *
 * rife-runner opens `mkdtempSync(app.getPath('temp'), 'tachi-rife-')` and holds
 * a whole decoded PNG SEQUENCE in it — gigabytes for a 300-frame 1080p clip. Its
 * `finally` removes it on every path the runner controls, but a `finally` does
 * not run when the PROCESS is killed, so a crash (or, until now, an app quit)
 * stranded the whole directory permanently. Nothing on the machine ever looks at
 * one again, which is exactly the property that made the 882 `sd-init-*` files
 * accumulate.
 *
 * `mkdtempSync` appends exactly six [A-Za-z0-9] characters (libuv's tempchars)
 * and the runner's prefix carries NO infix — so `tachi-rife-a1B2c3` is ours,
 * while `tachi-rife-test-a1B2c3` and `tachi-rife-inst-a1B2c3` (the two vitest
 * fixtures) are not. Deleting one of those mid-suite would be a self-inflicted
 * flake, and the SHAPE is the only thing that can tell them apart.
 *
 * (`app.getPath('temp')` and `os.tmpdir()` are the same directory on all three
 * platforms — that is why one sweep over `tmpdir()` sees both shapes.)
 */
const RIFE_TEMP_DIR_RE = /^tachi-rife-[A-Za-z0-9]{6}$/

/**
 * The third shape, added with the live latent preview (2026-08-03).
 *
 * `generateImage` gives sd-cli a temp path to rewrite its preview frame into
 * and removes it on BOTH exits — the process `close` handler and the catch. A
 * killed process runs neither, so a crash mid-render strands one ~12 KB PNG
 * forever. Small, but it is the same accumulation that produced 882 stranded
 * `sd-init-*` files, and it costs one line to never think about again.
 *
 * The name is `tachi-sd-preview-<epoch>-<perfCounter>.png`, both integers, so
 * the pattern cannot claim a user's file that merely starts the same way.
 */
const SD_PREVIEW_TEMP_RE = /^tachi-sd-preview-\d+-\d+\.png$/

export type MediaTempKind = 'init-frame' | 'rife-workdir' | 'preview-frame'

/**
 * What each shape IS on disk — a file or a directory.
 *
 * The sweep used to spell this as `kind === 'init-frame' ? !isFile() : !isDirectory()`,
 * a two-way ternary over what was then a two-value union. Adding
 * `'preview-frame'` (a FILE) made every preview PNG take the `else` branch and
 * be tested for directory-ness, so the sweep skipped the very file the same
 * commit claimed it now collected. The classifier test passed throughout,
 * because it only ever asked the classifier.
 *
 * A TABLE rather than a condition: adding a kind without deciding its disk
 * shape now fails to typecheck instead of silently exempting it.
 */
const MEDIA_TEMP_SHAPE: Record<MediaTempKind, 'file' | 'dir'> = {
  'init-frame':   'file',
  'rife-workdir': 'dir',
  'preview-frame': 'file',
}

/**
 * What a %TEMP% entry is TO US, by name alone — age and file-vs-directory are
 * the sweep's own checks. Exported because this matcher is the entire safety
 * argument for a function that deletes recursively: everything it does not claim
 * is untouchable, however old.
 */
export function classifyMediaTemp(name: string): MediaTempKind | null {
  if (SD_INIT_TEMP_RE.test(name)) return 'init-frame'
  if (RIFE_TEMP_DIR_RE.test(name)) return 'rife-workdir'
  if (SD_PREVIEW_TEMP_RE.test(name)) return 'preview-frame'
  return null
}

/** How stale a leftover must be before it is certainly nobody's — for BOTH
 *  shapes. A 44-minute Wan render holds its init frame open the whole time it
 *  runs and an interpolation holds its frame directory, so an aggressive age
 *  here would break the very runs this file exists to serve. */
export const SD_INIT_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Drop stale local-media leftovers — `sd-init-*` FILES and `tachi-rife-*`
 * DIRECTORIES — from a temp directory. Returns how many entries were removed.
 * Never throws: an unreadable dir, an entry that vanished between the readdir
 * and the unlink, and a directory another process holds open are all "not this
 * sweep's problem".
 *
 * `dir` is a parameter (defaulting to the real tmpdir) so the sweep is testable
 * without mocking `os`.
 */
export function sweepStaleMediaTemps(
  dir: string = tmpdir(),
  maxAgeMs: number = SD_INIT_TEMP_MAX_AGE_MS,
  now: number = Date.now(),
): number {
  let entries: string[] = []
  try { entries = readdirSync(dir) } catch { return 0 }
  let removed = 0
  for (const name of entries) {
    const kind = classifyMediaTemp(name)
    if (!kind) continue
    const p = join(dir, name)
    try {
      const st = statSync(p)
      // The type check is per-shape on purpose: a FILE named like a work dir is
      // not one of ours, and neither is a directory named like an init frame.
      const wantDir = MEDIA_TEMP_SHAPE[kind] === 'dir'
      if (wantDir ? !st.isDirectory() : !st.isFile()) continue
      if (now - st.mtimeMs < maxAgeMs) continue
      rmSync(p, wantDir ? { recursive: true, force: true } : { force: true })
      removed++
    } catch { /* gone, locked, or not ours to worry about */ }
  }
  return removed
}

/**
 * The boot entry point, still under its original name: graph.ipc.ts's deferred
 * timer is the only caller in the app, and it is scheduling the same one sweep
 * it always did — now over both shapes rather than one.
 */
export { sweepStaleMediaTemps as sweepStaleSdInitTemps }

// (schemaNegativeDefault moved to src/pages/media/localGenParams — the media
// tab's two local assemblies need the same rule, and a renderer surface cannot
// import an electron service. The call below is unchanged.)

// ── Per-stage seeds (Run-all only) ────────────────────────────────────────────
//
// THE CORRELATION. sd.cpp's own default seed is a FIXED 42, not "random" —
// sd-cpp-client says it in as many words next to resolveActualSeed: "buildSdArgs
// omits `--seed` entirely when the caller passes none, and sd-cli's own default
// is a fixed number, not random". A canvas media node is born with `params: {}`
// and nothing pre-fills the schema's `-1`, so "no seed" is the DEFAULT state of
// a media node, not a corner case. In a Run-all every seedless local stage then
// samples the SAME noise: two txt2img nodes in one flow come out suspiciously
// alike, and an i2v stage re-uses the image stage's noise pattern.
//
// THE FIX. One entropy draw per Run-all invocation, hashed with each stage's
// canvas node id. Stages decorrelate WITHIN a run (different node ids) and runs
// decorrelate FROM EACH OTHER (different draw) — hashing the node id alone would
// only have moved the correlation from "all stages alike" to "every run alike".
//
// WHAT IS DELIBERATELY NOT TOUCHED:
//  • an explicit seed — including an explicit -1, which IS the user asking the
//    engine to pick one — wins byte-for-byte; the gate below is the same
//    `typeof params.seed === 'number'` the two call sites already read;
//  • the per-node manual run (graph:run-node passes no runSeed), which keeps
//    today's reproducible-by-default behaviour exactly;
//  • the CLOUD providers. The fixed-default bug is sd.cpp's; Surplus/Venice/
//    imgnAI randomise server-side when no seed is sent, and Venice's schemas are
//    strict, so inventing a seed for them would be an unproven behaviour change
//    rather than a fix. Widening the gate is a one-line change if that ever
//    turns out to be wanted.

/** The seed ceiling the app's own schema advertises for every seedable model
 *  (surplus-media-service CURATED_SCHEMA: `min: -1, max: 2_147_483_647`), i.e.
 *  int32. The mask below is what keeps a derived seed inside it. */
const SEED_MAX = 2_147_483_647

/**
 * A stage's seed: FNV-1a over `<runSeed>\0<nodeId>`, masked to a non-negative
 * int32. Pure and deterministic — the same pair always yields the same seed, so
 * one Run-all's assignment is reproducible from its two inputs.
 *
 * The NUL separator matters: without it ('ab','c') and ('a','bc') would hash the
 * same string. The final `& 0x7fffffff` clears the sign bit, so the result is in
 * [0, 2147483647] — never negative (`resolveActualSeed` honours a REQUESTED seed
 * only when it is >= 0; a negative one would be recorded in the tachi-gen chunk
 * as -1 and the stage would be unreproducible from its own metadata).
 */
export function deriveStageSeed(runSeed: string, nodeId: string): number {
  const s = `${runSeed}\u0000${nodeId}`
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h = Math.imul(h ^ (c & 0xff), 0x01000193)
    h = Math.imul(h ^ (c >>> 8), 0x01000193)
  }
  return (h >>> 0) & SEED_MAX
}

/** One entropy draw per Run-all invocation — what makes two runs of the SAME
 *  flow differ. Never persisted: a run's seeds live on in the artifacts'
 *  metadata (the engine seed sd-cpp-client stamps), which is what a Remix reads. */
function newRunSeed(): string {
  return randomUUID()
}

// ── STUDIO (kokoro) voice ids — the local-tts branch tells them apart from a
// piper voice id by set membership (KOKORO_VOICES is the curated 10; piper ids
// look like 'en_US-amy-medium' and never collide with kokoro's 'af_heart'
// shape, but membership is the honest check rather than a naming guess). ──────
const KOKORO_VOICE_IDS: ReadonlySet<string> = new Set(KOKORO_VOICES.map(v => v.id))

/** Deterministic filename for a canvas STUDIO (kokoro) render — the same shape
 *  as MediaPage's `kokoroTtsFileName` (4f384a5). Duplicated rather than
 *  imported: that helper lives in a .tsx renderer page this MAIN-process file
 *  cannot pull in (the same reason localGenParams was extracted, audit D3). */
function nodeKokoroFileName(promptText: string, now: number): string {
  const slug = promptText.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'tts'
  return `tts-${slug}-${now}.wav`
}

/**
 * A node's own `params.loras` — the SAME shape MediaPage's composer emits as
 * `activeLoras` (7c42c26's localSelections; `promptWithLoraTags` builds the
 * `<lora:slug:weight>` tags from it — there is no `--lora` flag). Parsed
 * defensively since `params` is an open bag with no schema enforcement here;
 * anything malformed or absent → undefined, so the spread at the call site
 * adds nothing (today's behaviour, unchanged) rather than sending a half-formed
 * selection to the engine.
 */
function parseNodeLoras(v: unknown): SdLoraSelection[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: SdLoraSelection[] = []
  for (const item of v) {
    if (!item || typeof item !== 'object') continue
    const slug = (item as { slug?: unknown }).slug
    if (typeof slug !== 'string' || !slug.trim()) continue
    const weightRaw = (item as { weight?: unknown }).weight
    const weight = typeof weightRaw === 'number' ? weightRaw : undefined
    const highNoise = (item as { highNoise?: unknown }).highNoise === true ? true : undefined
    out.push({ slug, ...(weight !== undefined ? { weight } : {}), ...(highNoise ? { highNoise } : {}) })
  }
  return out.length > 0 ? out : undefined
}

/**
 * Run ONE media node and return its result. Shared by the full Phase-2 pass
 * (runMediaPhase) and the per-node run IPC (graph:run-node). `outputsByNodeId`
 * maps a node's canvas id → its known output text (agent results for the full
 * pass; pinned upstream outputs for the per-node run). Never throws — failures
 * are captured in the returned MediaNodeResult.
 *
 * `runSeed` is the Run-all invocation's entropy; passing it opts this node into
 * per-stage seed derivation (above). The per-node IPC omits it on purpose.
 */
export async function runMediaNode(
  media: TachiMediaNode,
  flow: TachiFlow,
  outputsByNodeId: Map<string, string>,
  onProgress?: (nodeId: string, state: MediaJobResult) => void,
  runSeed?: string,
): Promise<MediaNodeResult> {
  const modality = media.data.modality
  const label = media.data.label || modality
  const model = typeof media.data.model === 'string' ? media.data.model.trim() : ''
  let params: Record<string, unknown> = media.data.params ?? {}
  // A wired Reference-Image node OR an upstream Output card holding a generated
  // image supplies this media node's `image_url` (image-to-video init frame /
  // image-model reference), unless the node already carries its own image_url.
  // Injected here so BOTH the Venice and Surplus paths + extraParamsFor see it.
  //
  // …and when NO picture is wired in but a VIDEO is, the FLF hop decodes that
  // clip's last frame and threads it instead (see resolveWiredLastFrame). Last
  // resort by construction: an explicit image, wired or typed, is never touched,
  // and no ffmpeg runs for a graph that never chained a clip.
  if (!(typeof params.image_url === 'string' && params.image_url.trim())) {
    const refImageUrl = await resolveWiredImage(media.id, flow)
      ?? (LAST_FRAME_CONSUMERS.has(modality) ? await resolveWiredLastFrame(media.id, flow) : undefined)
    if (refImageUrl) params = { ...params, image_url: refImageUrl }
  }
  // Run-all + local engine + no seed of its own → derive one, so this stage does
  // not share sd.cpp's fixed default 42 with every other seedless stage.
  if (runSeed !== undefined && media.data.provider === 'local' && typeof params.seed !== 'number') {
    params = { ...params, seed: deriveStageSeed(runSeed, media.id) }
  }
  const extra = extraParamsFor(modality, params)
  const autoSaveDir = folderFeederPath(media.id, flow)
    ?? (typeof media.data.autoSaveDir === 'string' && media.data.autoSaveDir.trim() ? media.data.autoSaveDir.trim() : undefined)

  // ── LOCAL provider — stable-diffusion.cpp. Image (text→image + img2img) and
  // video (Wan t2v/i2v). The reference image on params.image_url becomes the
  // img2img init (image) or the i2v init frame (video). Allowed in PRIVATE MODE. ──
  if (media.data.provider === 'local') {
    if (modality !== 'image' && modality !== 'video' && modality !== 'tts') {
      return { nodeId: media.id, label, modality, prompt: '', ok: false, artifacts: [],
        error: 'Local engine supports image, video, and TTS. Use Venice/Surplus for music/STT.' }
    }
    const lprompt = resolveMediaPrompt(media, flow, outputsByNodeId)
    if (!model)   return { nodeId: media.id, label, modality, prompt: lprompt, ok: false, artifacts: [], error: 'No local model/voice selected — download one in Media → Local.' }
    if (!lprompt) return { nodeId: media.id, label, modality, prompt: lprompt, ok: false, artifacts: [], error: 'No prompt/text — wire a text node into the prompt plug, or type one on the node.' }
    // The init frame THIS RUN wrote, if any — tracked separately from
    // `initImagePath` because only a file we materialised may be deleted: an
    // init frame that arrived as a path is the user's own picture (see the
    // `finally` at the end of this block).
    let ownTempInit: string | undefined
    /** …and the REFERENCE IMAGE's temp, tracked apart for the same reason: only a
     *  file we wrote may be deleted. */
    let ownTempRef: string | undefined
    try {
      if (modality === 'tts') {
        // STUDIO (kokoro) — the node's model id is one of the curated kokoro
        // voices useMediaModels now also lists (audit 3D-1); anything else is
        // a piper voice id, exactly as before.
        if (KOKORO_VOICE_IDS.has(model)) {
          if (!kokoroInstalled()) {
            return { nodeId: media.id, label, modality, prompt: lprompt, ok: false, artifacts: [],
              error: 'STUDIO voice model is not downloaded yet — download it in Media → Local.' }
          }
          const r = await kokoroSynthesize({ text: lprompt, voice: model })
          if (!r.ok || !r.b64) {
            return { nodeId: media.id, label, modality, prompt: lprompt, ok: false, artifacts: [],
              error: r.error || 'Local TTS failed' }
          }
          // Save to disk immediately, mirroring MediaPage's composer (4f384a5):
          // a b64-only kokoro artifact has no `path`, so it cannot be Saved
          // from the Output card and does not survive a restart, unlike every
          // other local TTS/image/video artifact.
          const saved = saveWavToMediaLibrary({ b64: r.b64, name: nodeKokoroFileName(lprompt, Date.now()) })
          if (!saved.ok || !saved.path) {
            return { nodeId: media.id, label, modality, prompt: lprompt, ok: false, artifacts: [],
              error: saved.error || 'Local TTS save failed' }
          }
          return { nodeId: media.id, label, modality, prompt: lprompt, ok: true,
            artifacts: [{ kind: 'audio', mimeType: 'audio/wav', path: saved.path, b64: r.b64 }] }
        }
        const r = await piperSynthesize({ voiceId: model, text: lprompt })
        return { nodeId: media.id, label, modality, prompt: lprompt, ok: true,
          artifacts: [{ kind: 'audio', mimeType: r.mime, path: r.path, b64: r.b64 }] }
      }
      let initImagePath: string | undefined
      const ref = typeof params.image_url === 'string' ? params.image_url.trim() : ''
      if (ref) {
        const dm = /^data:([^;,]*);base64,(.+)$/s.exec(ref)
        if (dm) {
          // A `data:` URL has no path of its own — the renderer holds a File and
          // sd-cli needs something to open — so materialise it here. The name
          // carries entropy as well as a timestamp: two runs inside one
          // millisecond (a fan-out, a fast Run-all) would otherwise write the
          // same filename and the second would hand the first one's frame back.
          //
          // …and the EXTENSION is the declared mime's, not a blanket `.png`: this
          // branch named every frame .png whatever the bytes were (the regex did
          // not even capture the mime), so a JPEG the picker read reached sd-cli
          // under a name that lied about it. extForMime is the same table the
          // Media route's materialiser uses — one answer for both.
          ownTempInit = join(tmpdir(), `sd-init-${Date.now()}-${randomUUID().slice(0, 8)}${extForMime(dm[1] ?? '')}`)
          initImagePath = ownTempInit
          writeFileSync(initImagePath, Buffer.from(dm[2], 'base64'))
        }
        else if (existsSync(ref)) { initImagePath = ref }
        // file:// and http(s) references are not supported by the one-shot sd-cli — ignored.
      }
      // Apply the node's style preset (Fooocus-style prompt wrap + negative) and
      // forward any performance-preset params the node stored (steps/cfg/sampler).
      const styleId = typeof (media.data as { stylePreset?: unknown }).stylePreset === 'string'
        ? (media.data as { stylePreset?: string }).stylePreset : undefined
      const styleObj = SD_STYLES.find(s => s.id === styleId) ?? SD_STYLES[0]
      // THE LIVE SCHEMA for this (modality, model) — the same data the node's
      // controls are rendered from. Resolved once here and reused by the video
      // branch below, so the args and the UI can never read different tables.
      const lschema = modelParamSchema(modality, model)
      // `negative_prompt` is the SCHEMA's name; this branch read `params.negative`,
      // a key nothing writes, so a negative prompt typed on a media node was
      // dropped entirely and only the style preset's own negative survived.
      //
      // …and the ROW's own negative (Wan's official string) is the schema's
      // `default` for that param — which ParamFields DISPLAYS but no canvas
      // effect ever wrote into the bag, so the field showed it and the argv had
      // no `-n` (FLF driver, finding 1). Passing it as the fallback makes the
      // displayed value the value that runs; a bag that HOLDS the key (including
      // an empty string the user cleared) still wins untouched.
      const existingNeg = resolveLocalNegative(params, schemaNegativeDefault(lschema))
      const styled = applyStyle(styleObj, lprompt, existingNeg)
      // THE REFERENCE IMAGE (IP-Adapter), resolved from the bag under the live
      // schema and then materialised the same way the init frame was — through
      // the SHARED materialiser rather than a second inline data-URL parser,
      // which is the drift the extForMime note above is about.
      const refAsked  = resolveLocalIpAdapter(params, schemaOffersIpAdapter(lschema))
      const refOwned  = materializeInitImageOwned(refAsked.ipAdapterImage)
      const refImage  = refOwned.path
      if (refOwned.ownTemp) ownTempRef = refOwned.ownTemp
      const refStrength = typeof refAsked.ipAdapterStrength === 'number'
        ? { ipAdapterStrength: refAsked.ipAdapterStrength }
        : {}
      const genCommon = {
        ...(styled.negative ? { negative: styled.negative } : {}),
        // steps / cfg / sampler under the schema's names, with the legacy keys
        // still read as a fallback (a node saved by an older build holds them).
        ...resolveLocalGenParams(params),
        // …and the LOW-VRAM LADDER (--vae-tiling / --vae-conv-direct / --max-vram
        // / --stream-layers / --auto-fit). The node renders the same schema the
        // media tab does, so the five toggles APPEAR here whether or not this
        // payload carries them — and a control that appears and does nothing is
        // the audit-D1 class, which is the whole reason this resolver is shared
        // rather than written once per surface.
        ...resolveLocalMemoryFlags(params),
      }
      // LoRAs / VAE swap — the same two fields the composer's localSelections
      // carry (7c42c26). No canvas control writes them yet, but the ENGINE has
      // to be able to run with them the moment one does (audit 3D-2): a
      // node's params bag is open, so this is additive and a no-op for every
      // node today (neither key is ever set).
      const nodeLoras = parseNodeLoras(params.loras)
      const nodeVaeAdapterId = typeof params.vaeAdapterId === 'string' && params.vaeAdapterId.trim()
        ? params.vaeAdapterId.trim() : undefined
      if (modality === 'video') {
        // The node stores `resolution` / `aspect_ratio` / `duration` — the video
        // schema has no numeric width/height/frames at all, so the old
        // `typeof params.width === 'number'` spreads NEVER fired and every clip
        // came out at the model row's 832x480 / 33 frames. The live schema
        // supplies the same out-vote bounds MediaPage uses.
        const vschema = lschema
        const r = await sdGenerateVideo({
          modelId: model, prompt: styled.positive,
          ...genCommon,
          ...resolveLocalWanSize(params, vschema.find(s => s.name === 'resolution')?.enum),
          ...resolveLocalWanFrames(params, vschema.find(s => s.name === 'duration')),
          // The SPEED PACK toggle, from the same resolver the media tab uses.
          // A node saved before the control existed holds no key at all, and
          // that is the "use the pack if it is installed" case, not an opt-out.
          ...resolveLocalSpeedMode(params),
          ...(typeof params.seed === 'number' ? { seed: params.seed } : {}),
          ...(initImagePath ? { initImagePath } : {}),
          ...(nodeLoras ? { loras: nodeLoras } : {}),
          ...(nodeVaeAdapterId ? { vaeAdapterId: nodeVaeAdapterId } : {}),
        })
        // The engine's REAL seed rides the artifact (>= 0 only — -1 is "the
        // engine did not say", and stamping that would claim provenance this
        // run does not have). A .webm has no tEXt chunk, so for canvas video
        // this field is the only road back to the clip: the gallery capture
        // stamps it into the entry params (stampLocalSeed) so Remix reproduces
        // what actually rendered — exactly what MediaPage already does.
        return { nodeId: media.id, label, modality, prompt: lprompt, ok: true,
          artifacts: [{ kind: 'video', mimeType: r.mime, path: r.path, b64: r.b64,
            ...(typeof r.seed === 'number' && r.seed >= 0 ? { seed: r.seed } : {}) }] }
      }
      const r = await sdGenerateImage({
        modelId: model, prompt: styled.positive,
        ...genCommon,
        // …and the image node stores `size` ("1024x1024"), never width/height.
        ...resolveLocalSdSize(params),
        // `n` → --batch-count and the hires toggle — the same two spreads the
        // composer sends (W3-A), so a canvas node's params bag can carry them.
        ...resolveLocalBatch(params),
        ...resolveLocalHires(params),
        // …and CLIP skip, the one advanced control that is image-only (Wan and
        // LTX condition on umt5/Gemma, so there are no CLIP layers to skip) —
        // gated on the LIVE schema for this row, because it is also offered only
        // on the CLIP families and a node's bag outlives a model change.
        ...resolveLocalClipSkip(params, schemaOffersClipSkip(lschema)),
        // …and the REFERENCE IMAGE (IP-Adapter), gated on the same live schema.
        // A node's bag outlives a model change, and this control exists only
        // while compatible weights are installed — so without the gate a path
        // set against an SD 1.5 row would travel with the Z-Image one.
        //
        // MATERIALISED HERE, like the init frame above, because this route calls
        // the service directly and never crosses the IPC boundary that does it.
        // `ownTempRef` joins the `finally` below for the same reason `ownTempInit`
        // is there: whoever writes the temp deletes it, and a reference that
        // arrived as a PATH is the user's own picture.
        ...(refImage ? { ipAdapterImagePath: refImage, ...refStrength } : {}),
        ...(typeof params.seed === 'number' ? { seed: params.seed } : {}),
        // THE THIRD COPY OF THE img2img DEFAULT, now gone. This line used to
        // inline its own numeric fallback for an unset strength — a private
        // default beside the arg builder's private default beside a composer
        // slider that displayed a THIRD number for the same "unset" (the
        // checkpoint-A P1: two runs went out at 0.6 with 0 on screen). The shared
        // resolver forwards the bag's number when it has a usable one and NOTHING
        // otherwise, so SD_IMG2IMG_STRENGTH_DEFAULT decides once, for every
        // surface, and no file may name a second number.
        ...(initImagePath ? { initImagePath, ...resolveLocalStrength(params, true) } : {}),
        ...(nodeLoras ? { loras: nodeLoras } : {}),
        ...(nodeVaeAdapterId ? { vaeAdapterId: nodeVaeAdapterId } : {}),
      })
      // Same seed ride-along as the video branch above. A PNG self-records it
      // in the tachi-gen tEXt chunk too, but the gallery entry must not depend
      // on re-reading bytes off disk to know what made them. A batch (n>1)
      // yields one artifact per image, each with its own engine seed.
      const nodeImages = localImagesOf(r)
      return { nodeId: media.id, label, modality, prompt: lprompt, ok: true,
        artifacts: nodeImages.map(i => ({ kind: 'image' as const, mimeType: i.mime, path: i.path, b64: i.b64,
          ...(typeof i.seed === 'number' && i.seed >= 0 ? { seed: i.seed } : {}) })) }
    } catch (err) {
      return { nodeId: media.id, label, modality, prompt: lprompt, ok: false, artifacts: [],
        error: err instanceof Error ? err.message : String(err) }
    } finally {
      // The engine has finished with the frame either way (sd-cli is a one-shot
      // child, and the artifact it returns is its own file), so this is the last
      // moment it can be dropped — and before this line it never was: one
      // `sd-init-<ts>.png` per canvas run stayed in %TEMP% forever, 882 of them
      // on the driver's machine. Same shape as video-last-frame's mkdtemp +
      // finally. `ownTempInit` is set ONLY for a data: URL we materialised.
      // …and the REFERENCE IMAGE's, on every path, for the same reason.
      for (const own of [ownTempInit, ownTempRef]) {
        if (own) { try { rmSync(own, { force: true }) } catch { /* best effort */ } }
      }
    }
  }

  // ── Venice provider — route to the STANDALONE venice-media engine (its own
  // endpoints/key, NOT Surplus). Venice schemas are strict so we send only the
  // fields it documents; video/music queue+poll server-side and resolve here. ──
  if (media.data.provider === 'venice') {
    let vprompt = ''
    try {
      if (modality === 'stt') {
        const audioPath = typeof params.audioPath === 'string' ? params.audioPath.trim() : ''
        if (!model || !audioPath) {
          return { nodeId: media.id, label, modality, prompt: '', ok: false, artifacts: [],
            error: !model ? 'No model selected.' : 'No audio file set on the STT node.' }
        }
        const { text } = await veniceTranscribe({ model, audioPath })
        return { nodeId: media.id, label, modality, prompt: audioPath, ok: true, artifacts: [], text }
      }
      vprompt = resolveMediaPrompt(media, flow, outputsByNodeId)
      if (!model)   return { nodeId: media.id, label, modality, prompt: vprompt, ok: false, artifacts: [], error: 'No model selected.' }
      if (!vprompt) return { nodeId: media.id, label, modality, prompt: vprompt, ok: false, artifacts: [], error: 'No prompt — wire a text agent into the prompt plug, or type a prompt.' }
      if (modality === 'image') {
        // Pass `params` so a reference image (params.image_url — the node's
        // "Reference image" control, a wired Reference-Image node, or an upstream
        // Output card) routes to Venice's /image/edit instead of being ignored.
        const { artifacts } = await veniceGenerateImage({ model, prompt: vprompt,
          ...(typeof params.size === 'string' ? { size: params.size } : {}), params })
        return { nodeId: media.id, label, modality, prompt: vprompt, ok: true, artifacts }
      }
      if (modality === 'tts') {
        const { artifacts } = await veniceSpeech({ model, input: vprompt,
          ...(typeof params.voice === 'string' && params.voice ? { voice: params.voice } : {}),
          ...(typeof params.format === 'string' && params.format ? { format: params.format } : {}) })
        return { nodeId: media.id, label, modality, prompt: vprompt, ok: true, artifacts }
      }
      // video / music — Venice queues + polls server-side, resolving with artifacts.
      const durNum = typeof params.duration === 'number' ? params.duration : NaN
      if (modality === 'video') {
        const durationEnum = `${Math.min(15, Math.max(4, Number.isFinite(durNum) ? Math.round(durNum) : 5))}s`
        // Pass the node's params (aspect_ratio/resolution/image_url) — veniceSubmitVideo
        // is capability-aware and sends only what this model supports.
        const { artifacts } = await veniceSubmitVideo({ model, prompt: vprompt, duration: durationEnum, params })
        return { nodeId: media.id, label, modality, prompt: vprompt, ok: true, artifacts }
      }
      const { artifacts } = await veniceSubmitMusic({ model, prompt: vprompt,
        ...(typeof params.lyrics === 'string' && params.lyrics ? { lyrics: params.lyrics } : {}),
        ...(Number.isFinite(durNum) ? { durationSeconds: Math.round(durNum) } : {}) })
      return { nodeId: media.id, label, modality, prompt: vprompt, ok: true, artifacts }
    } catch (err) {
      return { nodeId: media.id, label, modality, prompt: vprompt, ok: false, artifacts: [],
        error: err instanceof Error ? err.message : String(err) }
    }
  }

  // ── imgnAI Katana provider — image + video via the standalone imgnai-media
  // engine (submit ?wait=false → MAIN-side poll → expiring assets downloaded to
  // disk). Cloud-only: the run gates + egress-policy block it in PRIVATE MODE. ──
  if (media.data.provider === 'imgnai') {
    const iprompt = resolveMediaPrompt(media, flow, outputsByNodeId)
    if (modality !== 'image' && modality !== 'video') {
      return { nodeId: media.id, label, modality, prompt: iprompt, ok: false, artifacts: [],
        error: 'imgnAI Katana generates image and video only — use Surplus/Venice for music/TTS/STT.' }
    }
    if (!model)   return { nodeId: media.id, label, modality, prompt: iprompt, ok: false, artifacts: [], error: 'No model selected.' }
    if (!iprompt) return { nodeId: media.id, label, modality, prompt: iprompt, ok: false, artifacts: [], error: 'No prompt — wire a text agent into the prompt plug, or type a prompt.' }
    try {
      const ratio = typeof params.aspect_ratio === 'string' && params.aspect_ratio.trim() ? params.aspect_ratio.trim() : undefined
      const ref   = typeof params.image_url === 'string' && params.image_url.trim() ? params.image_url.trim() : undefined
      if (modality === 'image') {
        const { artifacts } = await imgnaiGenerateImage({
          model, prompt: iprompt,
          ...(ratio ? { aspectRatio: ratio } : {}),
          ...(ref ? { imageUrls: [ref] } : {}),
          ...(autoSaveDir ? { autoSaveDir } : {}),
        })
        return { nodeId: media.id, label, modality, prompt: iprompt, ok: true, artifacts }
      }
      const durNum = typeof params.duration === 'number' ? params.duration
        : typeof params.duration === 'string' ? parseInt(params.duration, 10) : NaN
      const { artifacts } = await imgnaiGenerateVideo({
        model, prompt: iprompt,
        ...(Number.isFinite(durNum) && durNum > 0 ? { durationSeconds: Math.round(durNum) } : {}),
        ...(ratio ? { aspectRatio: ratio } : {}),
        ...(ref ? { firstFrameImageUrl: ref } : {}),
        ...(autoSaveDir ? { autoSaveDir } : {}),
      })
      return { nodeId: media.id, label, modality, prompt: iprompt, ok: true, artifacts }
    } catch (err) {
      return { nodeId: media.id, label, modality, prompt: iprompt, ok: false, artifacts: [],
        error: err instanceof Error ? err.message : String(err) }
    }
  }

  // ── Pollinations provider — KEYLESS cloud image (image.pollinations.ai).
  // A single paced GET in the standalone pollinations-media engine; ~45 s.
  // Its process-wide queue (1 request / 15 s, their anonymous limit) is shared
  // with the Media composer, so a canvas fan-out queues honestly instead of
  // racing their limiter. Cloud egress: PRIVATE MODE blocks it in the service. ──
  if (media.data.provider === 'pollinations') {
    const pprompt = resolveMediaPrompt(media, flow, outputsByNodeId)
    if (modality !== 'image') {
      return { nodeId: media.id, label, modality, prompt: pprompt, ok: false, artifacts: [],
        error: 'Pollinations generates images only — use Surplus/Venice for video/music/TTS/STT.' }
    }
    if (!pprompt) return { nodeId: media.id, label, modality, prompt: pprompt, ok: false, artifacts: [], error: 'No prompt — wire a text agent into the prompt plug, or type a prompt.' }
    try {
      // No model selected is fine here — keyless zero-config means the engine's
      // default ('sana') runs rather than the node erroring on an empty picker.
      const { artifacts } = await pollinationsGenerateImage({
        model: model || POLLINATIONS_DEFAULT_MODEL,
        prompt: pprompt,
        ...(typeof params.size === 'string' && params.size.trim() ? { size: params.size.trim() } : {}),
        ...(typeof params.seed === 'number' ? { seed: params.seed } : {}),
        ...(autoSaveDir ? { autoSaveDir } : {}),
      })
      return { nodeId: media.id, label, modality, prompt: pprompt, ok: true, artifacts }
    } catch (err) {
      return { nodeId: media.id, label, modality, prompt: pprompt, ok: false, artifacts: [],
        error: err instanceof Error ? err.message : String(err) }
    }
  }

  // STT resolves an audio path rather than a text prompt.
  if (modality === 'stt') {
    const audioPath = typeof params.audioPath === 'string' ? params.audioPath.trim() : ''
    if (!model || !audioPath) {
      return { nodeId: media.id, label, modality, prompt: '', ok: false, artifacts: [],
        error: !model ? 'No model selected.' : 'No audio file set on the STT node.' }
    }
    try {
      const { text } = await transcribe({
        model, audioPath,
        ...(Object.keys(extra).length > 0 ? { params: extra } : {}),
      })
      return { nodeId: media.id, label, modality, prompt: audioPath, ok: true, artifacts: [], text }
    } catch (err) {
      return { nodeId: media.id, label, modality, prompt: audioPath, ok: false, artifacts: [],
        error: err instanceof Error ? err.message : String(err) }
    }
  }

  const prompt = resolveMediaPrompt(media, flow, outputsByNodeId)
  if (!model) {
    return { nodeId: media.id, label, modality, prompt, ok: false, artifacts: [], error: 'No model selected.' }
  }
  if (!prompt) {
    return { nodeId: media.id, label, modality, prompt, ok: false, artifacts: [],
      error: 'No prompt — wire a text agent into the prompt plug, or type a prompt on the node.' }
  }

  try {
    if (modality === 'image') {
      const { artifacts } = await generateImage({
        model, prompt,
        ...(typeof params.size === 'string' ? { size: params.size } : {}),
        ...(typeof params.n === 'number' ? { n: params.n } : {}),
        ...(autoSaveDir ? { autoSaveDir } : {}),
        ...(Object.keys(extra).length > 0 ? { params: extra } : {}),
      })
      return { nodeId: media.id, label, modality, prompt, ok: true, artifacts }
    } else if (modality === 'tts') {
      const { artifacts } = await generateSpeech({
        model, input: prompt,
        ...(typeof params.voice === 'string' && params.voice ? { voice: params.voice } : {}),
        ...(typeof params.format === 'string' && params.format ? { format: params.format } : {}),
        ...(autoSaveDir ? { autoSaveDir } : {}),
        ...(Object.keys(extra).length > 0 ? { params: extra } : {}),
      })
      return { nodeId: media.id, label, modality, prompt, ok: true, artifacts }
    } else {
      // video / music — submit then poll until settled (same lifetime).
      const submitResult = modality === 'video'
        ? await submitVideo({
            model, prompt,
            ...(typeof params.duration === 'number' ? { duration: params.duration } : {}),
            ...(typeof params.resolution === 'string' && params.resolution ? { resolution: params.resolution } : {}),
            ...(Object.keys(extra).length > 0 ? { params: extra } : {}),
          })
        : await submitMusic({
            model, prompt,
            ...(typeof params.lyrics === 'string' && params.lyrics ? { lyrics: params.lyrics } : {}),
            ...(typeof params.duration === 'number' ? { duration: params.duration } : {}),
            ...(typeof params.resolution === 'string' && params.resolution ? { resolution: params.resolution } : {}),
            ...(Object.keys(extra).length > 0 ? { params: extra } : {}),
          })
      const settled = await pollMediaJobUntilSettled(submitResult.jobId, (s) => onProgress?.(media.id, s))
      if (settled.status === 'succeeded') {
        return { nodeId: media.id, label, modality, prompt, ok: true, artifacts: settled.artifacts ?? [] }
      }
      return { nodeId: media.id, label, modality, prompt, ok: false, artifacts: settled.artifacts ?? [],
        error: settled.error || `Job ${settled.status} (jobId ${settled.jobId}).` }
    }
  } catch (err) {
    return { nodeId: media.id, label, modality, prompt, ok: false, artifacts: [],
      error: err instanceof Error ? err.message : String(err) }
  }
}

// ── The RIFE stage ────────────────────────────────────────────────────────────
//
// The canvas's one POST-PROCESS node. It runs inside the media phase because it
// belongs to the same dependency graph — a rife node between two video segments
// has to run after the first and before the second, and mediaPhaseStages' topo
// sort is where that order already lives.
//
// IT TAKES THE CLIP, NOT A FRAME. resolveWiredLastFrame is the FLF hop for an
// i2v segment whose slot is an init frame; this stage opens the .mp4 itself, so
// it reads the wired video PATH directly (wiredVideoPathsInto — the same reader
// the card on the canvas uses, so what the node names is what ffmpeg opens).
//
// NO PRIVATE-MODE GATE, deliberately, matching rife.ipc: a local computation on
// a local file has nothing to leak, and the guard that matters
// (localVideoRefusal) is enforced inside the runner before the first spawn.

/**
 * Run ONE rife node and return its result in the media phase's own shape.
 * Shared by the full pass (runMediaPhase) and the per-node run IPC. Never
 * throws — every failure is captured in the returned MediaNodeResult.
 *
 * `win` is where the run pushes its `rife:progress` events; the activity strip
 * turns those into a row with real frame counts and a working Stop. Absent → the
 * run still happens, silently (a headless/scheduled run has no window to talk to).
 */
export async function runRifeNode(
  node: TachiRifeNode,
  flow: TachiFlow,
  win?: BrowserWindow | null,
): Promise<MediaNodeResult> {
  const label = node.data.label || 'interpolate'
  // The result IS a video, so it reports as one: downstream resolvers, the
  // gallery capture and the Output card all key off `modality`, and inventing a
  // sixth modality for a node that produces an .mp4 would only fork them.
  const modality: MediaNodeModality = 'video'
  const multiplier = resolveRifeMultiplier(node.data)

  const sourcePath = wiredVideoPathsInto(node.id, flow.nodes, flow.edges)[0]
  if (!sourcePath) {
    return {
      nodeId: node.id, label, modality, prompt: '', ok: false, artifacts: [],
      error: 'No video wired in — connect a local video result (a video node, its Output card, or another interpolate node) to this node\'s `video` plug.',
    }
  }

  try {
    // The runner owns every guard that matters from here: the path refusal that
    // keeps a URL away from ffmpeg, the not-installed message, one run per file,
    // kill-tree cancel, and the temp sweep. It resolves rather than throws for
    // all of them — `prompt` carries the source path, the way the STT branch
    // carries its audio path, so the run log says WHAT was interpolated.
    const res = await interpolateVideo({ sourcePath, multiplier, win: win ?? null })
    if (!res.ok || !res.outputPath) {
      return {
        nodeId: node.id, label, modality, prompt: sourcePath, ok: false, artifacts: [],
        error: res.error || 'Frame interpolation failed.',
      }
    }
    return {
      nodeId: node.id, label, modality, prompt: sourcePath, ok: true,
      artifacts: [{ kind: 'video', mimeType: 'video/mp4', path: res.outputPath }],
    }
  } catch (err) {
    return {
      nodeId: node.id, label, modality, prompt: sourcePath, ok: false, artifacts: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** A stage the media phase executes: a generating media node, or a rife pass. */
type MediaPhaseStage = TachiMediaNode | TachiRifeNode

/** True for any node the media phase owns. */
export function isMediaPhaseNode(node: { type?: string }): boolean {
  return node.type === 'media' || node.type === 'rife'
}

/**
 * Media nodes in DEPENDENCY order rather than `flow.nodes` order. The array is
 * the order nodes were DROPPED on the canvas, which says nothing about the order
 * they must RUN: wire an image node into a video node after dropping both and
 * the video used to run first, generating from an init frame that did not exist
 * yet. Kahn's sort over the canvas edges answers it, and it keeps a stable
 * result for graphs with several valid orders (ties fall back to array order),
 * so a diamond runs the same way twice. Cycle-safe by construction: topoOrder
 * appends nodes it could not order instead of dropping them, so every media node
 * still runs exactly once.
 */
function mediaPhaseStagesInRunOrder(flow: TachiFlow): MediaPhaseStage[] {
  const rank = new Map(topoOrder(flow.nodes, flow.edges).map((id, i) => [id, i] as const))
  // Filtering `flow.nodes` (not concatenating two lists) is what keeps the
  // documented tie-break intact: nodes with no dependency between them run in
  // CANVAS order, and a rife node dropped between two media nodes must not jump
  // the queue just because it is a different type.
  const stages = flow.nodes.filter((n): n is MediaPhaseStage => isMediaPhaseNode(n))
  return stages.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
}

/**
 * Fold ONE finished media node's artifacts back into the in-memory flow, so the
 * media nodes that run AFTER it in the SAME pass resolve THIS run's picture:
 *   • onto the node itself, under `lastArtifacts` — the same field the renderer
 *     stamps after a per-node run, so both surfaces read one field, and
 *   • onto the Output card(s) wired from it, which otherwise still carry the
 *     PREVIOUS run's artifacts (the renderer only refreshes a card once
 *     graph:run has returned — during the run they are stale by definition).
 *
 * Returns a NEW flow; the IPC payload is never mutated, and nothing is written
 * to disk — this is the run's own working copy, so no artifact is saved twice.
 * A failed or artifact-less stage changes nothing: a downstream node must run
 * WITHOUT an init frame rather than inherit a stale one.
 */
function withMediaResult(flow: TachiFlow, result: MediaNodeResult): TachiFlow {
  if (!result.ok || result.artifacts.length === 0) return flow
  const cards = new Set(flow.edges.filter(e => e.source === result.nodeId).map(e => e.target))
  const nodes = flow.nodes.map(n => {
    if (n.id === result.nodeId) {
      return { ...n, data: { ...n.data, lastArtifacts: result.artifacts } } as TachiNode
    }
    if (n.type === 'output' && (cards.has(n.id) || (n.data as { sourceId?: unknown }).sourceId === result.nodeId)) {
      return { ...n, data: { ...n.data, artifacts: result.artifacts } } as TachiNode
    }
    return n
  })
  return { ...flow, nodes }
}

/**
 * Run Phase 2: generate media for every media node in the flow. `agentResults`
 * maps agent CANVAS NODE ID → that agent's flattened text output (the caller
 * derives this from the agentName "<label>#<nodeId>" suffix). Never throws —
 * each node's failure is captured in its own MediaNodeResult.
 *
 * Stages run in dependency order and each result is threaded into the working
 * flow, so a media→media chain (image → i2v video) hands the picture forward
 * inside a single Run-all instead of relying on the renderer to persist it
 * between IPC calls the way the per-node path does.
 *
 * Each stage that carries no seed of its own also gets one derived from this
 * invocation's entropy (see deriveStageSeed) — otherwise every seedless local
 * stage samples sd.cpp's fixed default 42 and the whole chain is correlated.
 */
export async function runMediaPhase(
  flow: TachiFlow,
  agentResultsByNodeId: Map<string, string>,
  onProgress?: (nodeId: string, state: MediaJobResult) => void,
  opts?: {
    /** Where a rife stage pushes its `rife:progress` events (the activity rail). */
    win?: BrowserWindow | null
  },
): Promise<MediaNodeResult[]> {
  const results: MediaNodeResult[] = []
  let live = flow
  // ONE draw for the whole invocation — every stage's seed is derived from it,
  // so stages differ from each other and the next Run-all differs from this one.
  const runSeed = newRunSeed()
  for (const stage of mediaPhaseStagesInRunOrder(flow)) {
    // A rife stage has no prompt, no seed and no model — it consumes the clip the
    // stage before it just wrote (out of `live`, not the incoming payload) and
    // hands a smoother one to the stage after.
    const result = stage.type === 'rife'
      ? await runRifeNode(stage, live, opts?.win)
      : await runMediaNode(stage, live, agentResultsByNodeId, onProgress, runSeed)
    results.push(result)
    live = withMediaResult(live, result)
  }
  return results
}
