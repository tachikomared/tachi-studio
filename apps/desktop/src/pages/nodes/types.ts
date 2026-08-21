// apps/desktop/src/pages/nodes/types.ts
//
// Shared type definitions for the Custom Nodes / Flow Canvas feature.

import type { Node, Edge } from '@xyflow/react'
import type { Artifact } from '../../types/electron'

/**
 * WHY a run-cost estimate is what it is. Lives here (not in run-cost.ts) because
 * it is PERSISTED node data — run-cost.ts imports this module, so the type has
 * to flow in that direction. See run-cost.ts for what each value claims.
 */
export type RunCostBasis = 'priced' | 'local' | 'free' | 'unknown'

// ── Node data shapes ──────────────────────────────────────────────────────────
// Each data interface must extend Record<string, unknown> to satisfy
// @xyflow/react's NodeBase constraint.

export interface ProviderNodeData extends Record<string, unknown> {
  label: string
  /** e.g. "bankr", "ollama", "anthropic", "freellmapi" */
  providerId: string
  endpoint?: string
  /** Selected model from the provider's catalog. Optional so old saves still load. */
  model?: string
}

export interface AgentNodeData extends Record<string, unknown> {
  label: string
  /** e.g. "openclaude", "codex". The model is now taken from the upstream
   *  ProviderNode, so we don't store it on the agent any more. */
  harnessId: string
  /**
   * Optional custom system prompt — "who this agent is and what it does".
   * When set, it replaces the auto-generated default prompt at compile time
   * (incoming edge hints are still appended). Lets the user give each agent a
   * distinct role/persona/instructions.
   */
  systemPrompt?: string
  /**
   * When true, THIS agent's output is treated as the flow's final answer
   * (instead of "whatever ran last"). Lets the user designate, e.g., the
   * Reviewer as the main result even if other agents run after it. At most one
   * node should be marked final; the run picks the first marked one.
   */
  final?: boolean
  /**
   * Last per-node run output text (the "execute step" result). Cached on the
   * node for inline preview AND to feed downstream `{{node:<id>}}` token / plug
   * resolution without re-running this node. Transient — not persisted to flow JSON.
   */
  lastOutput?: string
  /** Artifacts from the last per-node run (agents rarely produce these; reserved). */
  lastArtifacts?: Artifact[]
  /**
   * When true, this node's `lastOutput` is PINNED: downstream per-node runs use
   * it as-is instead of re-running this node. Lets the user iterate downstream
   * cheaply. Transient — not persisted to flow JSON.
   */
  pinned?: boolean
  /**
   * NODES-RESEARCH #6: the error message from this node's last FAILED run. Set
   * when Run-all (or a per-node run) fails; cleared on the next success. Fed to
   * any node wired to this node's ERROR output. Transient — not persisted.
   */
  lastError?: string
  /**
   * CODEX WRITE-MODE (harnessId 'codex' only). When true AND private mode is off
   * AND a Folder node is wired, the Codex node runs in its `workspace-write`
   * sandbox (may create/modify/delete files inside that folder only) instead of
   * the default read-only sandbox. Default OFF; gated by an explicit one-per-
   * session consent dialog in the renderer and re-checked fail-closed in main.
   * Persisted with the flow (a deliberate per-node capability, not transient).
   */
  codexAllowWrite?: boolean
  /**
   * RETRY-ON-FAIL (n8n pattern). Extra attempts after the first when a run fails
   * (0-3, default 0). See retryPolicy.ts. Persisted with the flow (config, not
   * transient — a deliberate per-node reliability knob).
   */
  retries?: number
  /** Delay between retry attempts in ms (default 1500). Persisted with the flow. */
  retryDelayMs?: number
}

/**
 * Prompt node — a SELF-CONTAINED text step: pick a provider + model, write an
 * instruction, and it generates / polishes a prompt. Wire its `out` into a media
 * node's `prompt` plug (or reference it via a {{node:<id>}} token) so the text
 * model authors the media prompt. At run/compile time a prompt node is EXPANDED
 * into a provider + agent pair (main-process), so it reuses the whole agent
 * pipeline (per-node run, token resolution, media prompt-feeding) with no
 * special-casing. The synthetic agent keeps this node's id.
 */
export interface PromptNodeData extends Record<string, unknown> {
  label: string
  /** Text provider: 'freellmapi' | 'bankr' | 'opengateway' | 'surplus' | 'ollama'. */
  providerId: string
  /** Provider endpoint hint (e.g. 'llm.bankr.bot/v1'). Optional. */
  endpoint?: string
  /** Selected model id for the provider. */
  model?: string
  /**
   * The instruction / task — what kind of prompt to write. May embed
   * {{node:<id>}} tokens to fold in upstream outputs. When run, the node emits
   * the generated prompt as its output.
   */
  instruction?: string
  /** Mark this node's output as the flow's final answer. */
  final?: boolean
  /** Last per-node run output (the generated prompt). Transient — not persisted. */
  lastOutput?: string
  lastArtifacts?: Artifact[]
  /** Pin lastOutput as a downstream reference source. Transient. */
  pinned?: boolean
  /** #6: error text from the last FAILED run; feeds this node's ERROR output.
   *  Cleared on the next success. Transient — not persisted. */
  lastError?: string
  /** RETRY-ON-FAIL: extra attempts after the first (0-3, def 0). See retryPolicy.ts.
   *  Persisted with the flow (config, not transient). */
  retries?: number
  /** Delay between retry attempts, ms (def 1500). Persisted with the flow. */
  retryDelayMs?: number
}

/**
 * Formerly "SkillNodeData" — re-purposed as a PERMISSION node. Each tile
 * represents the capability scope an agent runs with: read-only, edit, or
 * full (read + edit + execute + net). Schema-compatible with older saves
 * that used { skillId, description }.
 */
export interface SkillNodeData extends Record<string, unknown> {
  label: string
  /** Permission tier id: "read-only" | "edit" | "full" | "web-search" | ... */
  skillId: string
  description?: string
  /** Optional explicit tool allowlist when the tier presets aren't enough. */
  allowedTools?: string[]
}

/**
 * Sprint D5 — Role node data. Carries a role-id from the role registry and the
 * full label/toollist for rendering without a registry round-trip at drop time.
 * Extends SkillNodeData shape so old saves with { skillId } still parse safely.
 */
export interface RoleNodeData extends Record<string, unknown> {
  label:        string
  /** Role id from roles.yaml: "security-engineer" | "frontend-engineer" | ... */
  roleId:       string
  description?: string
  /** Snapshot of role.allowedTools at drop time — used by the agent harness. */
  allowedTools: string[]
}

/**
 * Tool nodes — wire one to an agent to grant it a real capability at run time:
 *   - folder   : a sandboxed workspace the agent can read/write files within
 *   - internet : web fetch (egress-policy gated; blocked in PRIVATE MODE)
 *   - mcp      : tools from a Model-Context-Protocol server
 */
export interface FolderNodeData extends Record<string, unknown> {
  label: string
  /** Absolute path to the workspace folder. File tools are sandboxed to it. */
  path: string
}
export interface InternetNodeData extends Record<string, unknown> {
  label: string
}
export interface McpNodeData extends Record<string, unknown> {
  label: string
  /** MCP server URL (streamable-http). Blank = the app's built-in server. */
  url?: string
}

/**
 * Media node — generates non-text media (image / video / music / TTS / STT)
 * through the Surplus media engine (Layer A: window.tachi.surplusMedia.*).
 *
 * Each node carries its modality (drives which composer + engine method runs),
 * the selected Surplus model id, a TYPED prompt used when no `prompt` plug is
 * wired (the connected upstream agent's output wins when present), and the
 * per-modality params. Artifacts produced by a run are cached on the node for
 * inline preview; they are NOT persisted to the flow JSON (transient).
 */
export type MediaNodeModality = 'image' | 'video' | 'music' | 'tts' | 'stt'

export interface MediaNodeParams extends Record<string, unknown> {
  /** image: e.g. "1024x1024". */
  size?:     string
  /** image: number of variations to request. */
  n?:        number
  /** tts: free-string upstream voice id. */
  voice?:    string
  /** tts: output container — mp3 (default) | opus | aac | flac | wav | pcm. */
  format?:   string
  /** video / music: requested length in seconds. */
  duration?: number
  /** video / music: requested resolution (Venice convention). */
  resolution?: string
  /** music: lyrics for lyrics_required models. */
  lyrics?:   string
  /** stt: absolute path to the audio file to transcribe (manual mode). */
  audioPath?: string
  /**
   * LOCAL image/video only: LoRA adapters to apply — the same shape
   * MediaPage's composer emits as `activeLoras` (7c42c26's localSelections):
   * `<lora:slug:weight>` tags are built from these, there is no `--lora` flag.
   * No canvas control writes this field yet; it is threaded through
   * graph-to-agentkit so a node CAN run with the same adapters the composer
   * selects the moment one does (audit 3D-2).
   */
  loras?: Array<{ slug: string; weight?: number; highNoise?: boolean }>
  /**
   * LOCAL image/video only: an installed VAE adapter's id to swap in — the
   * composer's VAE picker (7c42c26) emits this same field.
   */
  vaeAdapterId?: string
}

export interface MediaNodeData extends Record<string, unknown> {
  label: string
  /** Which media kind this node produces. Drives composer + engine routing. */
  modality: MediaNodeModality
  /** Media provider — 'surplus' (default), 'venice' (standalone, on the Venice key),
   *  'imgnai' (Katana, image + video on the imgnAI credential), 'pollinations'
   *  (keyless CLOUD image — no key, but the prompt leaves the machine), or
   *  'local' (stable-diffusion.cpp / piper — runs offline / in PRIVATE MODE). */
  provider?: 'surplus' | 'venice' | 'local' | 'imgnai' | 'pollinations'
  /** Selected model id (filtered to `modality`), from the chosen provider's catalog. */
  model?: string
  /**
   * Typed prompt TEMPLATE — used when no `prompt` plug is wired. May embed
   * `{{node:<id>}}` reference tokens that are resolved against upstream outputs
   * at run time (a token template can fuse MULTIPLE upstream outputs). A
   * connected upstream text agent's output supersedes a token-free template.
   */
  prompt?: string
  /**
   * Per-modality generation params. Carries the typed fields (size/n/voice/…)
   * AND arbitrary schema-driven extras (negative_prompt, seed, steps, cfg,
   * sampler, strength, image_url, …) keyed by ParamSpec.name. Open record:
   * adding a param is data, not code.
   */
  params?: MediaNodeParams & Record<string, unknown>
  /**
   * Fallback auto-save directory when no Folder node is wired to the `folder`
   * plug. Artifacts are copied here after a run.
   */
  autoSaveDir?: string
  /**
   * Last per-node run output text — for STT this is the transcript; for other
   * modalities it's reserved. Transient — not persisted to flow JSON.
   */
  lastOutput?: string
  /** Artifacts produced by the last run, for inline preview. Transient. */
  lastArtifacts?: Artifact[]
  /**
   * When true, this node's last output/artifacts are PINNED so downstream
   * per-node runs reuse them without re-running. Transient.
   */
  pinned?: boolean
  /** #6: error text from the last FAILED run; feeds this node's ERROR output.
   *  Cleared on the next success. Transient — not persisted. */
  lastError?: string
  /** RETRY-ON-FAIL: extra attempts after the first (0-3, def 0). See retryPolicy.ts.
   *  Persisted with the flow (config, not transient). */
  retries?: number
  /** Delay between retry attempts, ms (def 1500). Persisted with the flow. */
  retryDelayMs?: number
}

// ── Sprint E — static input nodes (no LLM, no generation) ─────────────────────

/**
 * Text input node — a STATIC piece of text the author types (a topic, brief, or
 * context block). It does NOT call a model; its text IS its output, mirrored to
 * `lastOutput` so downstream nodes resolve it through `@` / `{{node:<id>}}`
 * tokens (and the prompt-plug feeder) with no run. Use it to tell a Prompt node
 * what to write about, or to drop reusable context into many prompts.
 */
export interface TextNodeData extends Record<string, unknown> {
  label: string
  /** The literal text — this IS the node's output (mirrored to `lastOutput`). */
  text: string
  /** Mirror of `text`, so the lastOutput-based reference system picks it up. */
  lastOutput?: string
  pinned?: boolean
}

/**
 * Reference-image node — holds an image used as a REFERENCE (not generation):
 * the init frame for image-to-video, or a style/subject reference for image
 * models. Stores the image as a data URL; wired into a Media node it feeds that
 * node's `image_url` param (detected by source type, regardless of plug). Its
 * text `lastOutput` is only a short marker so it never pastes a giant data URL
 * into a text prompt.
 */
export interface ImageRefNodeData extends Record<string, unknown> {
  label: string
  /** LEGACY inline storage: the image as a base64 data URL. Multi-MB images
   *  here made every persist/drag tick stringify megabytes — new picks go to
   *  disk instead (filePath/displayUrl). Still read by the run engine. */
  dataUrl?: string
  /** Absolute path of the image on disk (userData/media/refs). The run engine
   *  inlines it to a data URL at run time (imageRefUrlsInto). */
  filePath?: string
  /** tachi-media:// URL for the <img> preview (renderer can't load file://). */
  displayUrl?: string
  /** Original filename, for display. */
  fileName?: string
  /** Short marker (e.g. "[image reference]") so it lists in the @ picker harmlessly. */
  lastOutput?: string
  pinned?: boolean
}

/**
 * Output card — a RESULT that lands on the canvas when a node runs (flowith-style
 * conversational canvas). Auto-spawned + wired from its source; one per source
 * (re-running refreshes it). Holds the produced text OR media artifacts and can
 * itself be wired onward — branch a new Prompt/Media node off a result to keep
 * the chain going, with the whole history preserved on the canvas.
 */
export interface OutputNodeData extends Record<string, unknown> {
  label: string
  /** True when auto-spawned by a run (so re-runs find + refresh the same card). */
  auto?: boolean
  /** 'text' (agent/prompt/STT) or 'media' (image/video/music/tts artifacts). */
  kind: 'text' | 'media'
  /** Produced text (text kind, or an STT transcript). Mirrored to lastOutput. */
  text?: string
  /** Produced media artifacts (media kind). */
  artifacts?: Artifact[]
  /** Label of the node that produced this result. */
  sourceLabel?: string
  /** Id of the node that produced this result — lets the card RE-RUN its source
   *  (a Regenerate button, chat-style) and refresh in place. */
  sourceId?: string
  /** Mirror of `text` so downstream nodes resolve it via @ / {{node:<id>}}. */
  lastOutput?: string
  pinned?: boolean
  /**
   * FAN-OUT xN: stable identity of a fan-out sibling card (`<sourceId>::v<i>`,
   * see fanout.ts). Present ONLY on cards produced by a fan-out (N>1) so a
   * REPEAT fan-out refreshes the same N cards instead of duplicating them, and
   * so a later x1 run never touches them. Absent on ordinary single-run cards.
   */
  variantKey?: string
  /** FAN-OUT xN: 1-based sibling number (v1..vN) — for the small card badge. */
  variant?: number
  /** Estimated USD cost of the run that produced THIS card (existing estimate
   *  path). Frozen per-card so fan-out siblings each show their own figure;
   *  null/absent → the card falls back to the source node's last estimate. */
  estUsd?: number
  /** WHY estUsd is what it is — 'local' | 'free' | 'unknown' | 'priced'. Frozen
   *  with the number so the chip can say what is true instead of calling every
   *  $0 "local" (2026-08-01). Absent on cards saved before that. */
  estBasis?: RunCostBasis
}

/**
 * Note node — NODES-RESEARCH #7 (anchored sticky notes). A brutalist sticky for
 * annotating / sectioning the canvas: a tinted tile with editable multiline text
 * and no run semantics. It has NO handles, never wires into a flow, is skipped by
 * Run-all / chains / cost estimation, and sits BEHIND other nodes (the node's
 * top-level `zIndex` is -1) so it reads as a background label. Resizable via the
 * @xyflow/react NodeResizer (the node's top-level width/height persist).
 */
export interface NoteNodeData extends Record<string, unknown> {
  /** Label kept for palette/registry symmetry; not shown as a header title. */
  label: string
  /** The sticky's multiline body text. */
  text: string
  /**
   * Tint preset key — one of NOTE_TINT_KEYS (see NoteNode.tsx). Cycled by the
   * swatch button in the note header. Defaults to the first preset on create.
   */
  color?: string
}

/**
 * Subflow node — NODES-RESEARCH #8 (subflows v1, VISUAL COLLAPSE only). A proxy
 * tile that stands in for a set of collapsed child nodes: `collapseSelectionToSubflow`
 * creates it at the selection centroid, sets `hidden: true` on every child node
 * (and on every edge touching a child), so the group reads as ONE box. It does
 * NOT re-wire edges — the original edges are only HIDDEN, so Run-all still runs
 * the hidden children through them normally. `expandSubflow` un-hides the children
 * + edges and drops this proxy. The proxy is not runnable and carries no output.
 */
export interface SubflowNodeData extends Record<string, unknown> {
  /** Editable group name shown on the proxy card. */
  label: string
  /** Ids of the nodes collapsed into this subflow (hidden while collapsed). */
  childIds: string[]
}

/**
 * Webhook trigger node — BATCH35 lane B (community idea: "TradingView-webhook
 * node"). An INBOUND SIGNAL source: while the node is armed, the local API
 * server (127.0.0.1:11435) answers `POST /webhooks/<source>/<hookId>?token=…`
 * and the alert body becomes this node's output, exactly like a Text node's
 * text — resolvable downstream through `@` / `{{node:<id>}}` and the prompt plug.
 *
 * It places NO trades and touches no money path: an alert is text. The token is
 * deliberately NOT part of this shape — flows are exported and shared, so the
 * secret lives in the main process (webhook-hooks.ts, encrypted at rest) and is
 * fetched for display only. Only the `hookId` travels with the flow, so the URL
 * a user pasted into their alert keeps working after a save/load round-trip.
 */
export interface WebhookNodeData extends Record<string, unknown> {
  label: string
  /** Alert provider. v1: 'tradingview'. */
  source: 'tradingview'
  /** Stable URL path segment for this node's hook (see HOOK_ID_RE in main). */
  hookId: string
  /**
   * Whether the node should arm its route when the canvas mounts. Persisted:
   * a flow saved "armed" comes back listening (the route is still default-closed
   * until this node actually mounts and asks main to arm it).
   */
  armed?: boolean
  /**
   * Run the flow automatically when an alert lands. Off by default — an inbound
   * webhook is an untrusted trigger and auto-running spends tokens unattended.
   */
  autoRun?: boolean
  /** Last alert body (normalized text) — this node's output. Transient. */
  lastOutput?: string
  /** Epoch ms of the last accepted alert (for the node's readout). Transient. */
  lastAlertAt?: number
  /** Alerts accepted this session. Transient. */
  hits?: number
  /** Pin lastOutput as a downstream reference source. Transient. */
  pinned?: boolean
  /** Last arming/delivery problem, shown on the node. Transient. */
  lastError?: string
}

/**
 * RIFE node — LOCAL frame interpolation as a canvas step (the nodes-tab half of
 * the vertical 48381ca shipped for the gallery). It is the canvas's first
 * POST-PROCESS node: its input is not a prompt but an ARTIFACT — the .mp4 a
 * media(video) node (or an Output card, or another rife node) already produced —
 * and its output is another .mp4, threaded downstream like any media artifact.
 *
 * Wire a local video result into the `video` plug and RUN: ffmpeg decodes the
 * frames, rife-ncnn-vulkan doubles (or quadruples) them on the GPU, ffmpeg
 * re-encodes at the matching rational fps. Fully local, so it runs in PRIVATE
 * MODE unchanged — blocking a computation that reads one file off disk and
 * spawns three local programs would be theatre.
 *
 * NOT the FLF last-frame hop. That hop exists because an i2v segment consumes a
 * FRAME; this node consumes the CLIP, so it deliberately never routes through
 * resolveWiredLastFrame.
 */
export interface RifeNodeData extends Record<string, unknown> {
  label: string
  /**
   * Interpolation factor: 2 or 4, one sidecar pass either way (rife-v4 is the
   * only model family that accepts a custom `-n`). Absent/invalid → 2; see
   * resolveRifeMultiplier, which is the ONE reader both surfaces use.
   * Persisted with the flow — a deliberate per-node knob, not transient.
   */
  multiplier?: 2 | 4
  /** The interpolated clip from the last run, for the inline preview and for
   *  downstream resolution. Transient — not persisted to flow JSON. */
  lastArtifacts?: Artifact[]
  /** Pin the last result as a downstream source (skips re-running). Transient. */
  pinned?: boolean
  /** #6: error text from the last FAILED run; feeds this node's ERROR output.
   *  Cleared on the next success. Transient — not persisted. */
  lastError?: string
  /** RETRY-ON-FAIL: extra attempts after the first (0-3, def 0). See retryPolicy.ts.
   *  Persisted with the flow (config, not transient). */
  retries?: number
  /** Delay between retry attempts, ms (def 1500). Persisted with the flow. */
  retryDelayMs?: number
}

/**
 * Unknown node — the SELF-HEALING fallback (NODES-RESEARCH #3). When a flow is
 * loaded whose node carries a `type` this build doesn't register (an old save, a
 * flow from a newer version, a hand-edited file), sanitizeFlow() remaps it to
 * 'unknown' and stashes the real type in `originalType`, keeping every other
 * field verbatim. The node renders as a preserved-but-inert tile and is skipped
 * by runs; on SAVE/EXPORT its original type is restored → lossless round-trip.
 */
export interface UnknownNodeData extends Record<string, unknown> {
  label?: string
  /** The unrecognised node type from the loaded file, preserved for restore. */
  originalType?: string
}

// ── Discriminated node union ──────────────────────────────────────────────────

export type TachiProviderNode = Node<ProviderNodeData, 'provider'>
export type TachiAgentNode    = Node<AgentNodeData,    'agent'>
export type TachiSkillNode    = Node<SkillNodeData,    'skill'>
export type TachiFolderNode   = Node<FolderNodeData,   'folder'>
export type TachiInternetNode = Node<InternetNodeData, 'internet'>
export type TachiMcpNode      = Node<McpNodeData,      'mcp'>
export type TachiMediaNode    = Node<MediaNodeData,    'media'>
export type TachiPromptNode   = Node<PromptNodeData,   'prompt'>
export type TachiTextNode     = Node<TextNodeData,     'text'>
export type TachiImageRefNode = Node<ImageRefNodeData, 'imageref'>
export type TachiOutputNode   = Node<OutputNodeData,   'output'>
export type TachiNoteNode     = Node<NoteNodeData,     'note'>
export type TachiSubflowNode  = Node<SubflowNodeData,  'subflow'>
export type TachiWebhookNode  = Node<WebhookNodeData,  'webhook'>
export type TachiRifeNode     = Node<RifeNodeData,     'rife'>
export type TachiUnknownNode  = Node<UnknownNodeData,  'unknown'>
/** Sprint D5: role nodes live in the 'skill' slot for backwards-compat with the canvas store. */
export type TachiRoleNode     = Node<RoleNodeData,     'skill'>

export type TachiNode =
  | TachiProviderNode
  | TachiAgentNode
  | TachiSkillNode
  | TachiFolderNode
  | TachiInternetNode
  | TachiMcpNode
  | TachiMediaNode
  | TachiPromptNode
  | TachiTextNode
  | TachiImageRefNode
  | TachiOutputNode
  | TachiNoteNode
  | TachiSubflowNode
  | TachiWebhookNode
  | TachiRifeNode
  | TachiUnknownNode

/**
 * Edge data shape carrying the optional `instruction` prose label.
 * Rendered as a badge on the edge path when set; editable via EdgeSidecar.
 */
export interface TachiEdgeData extends Record<string, unknown> {
  /** Short prose label describing what flows across this connection. */
  instruction?: string
}

export type TachiEdge = Edge<TachiEdgeData>

// ── Serialised flow file (.tachi-flow.json) ───────────────────────────────────

export interface TachiFlow {
  /** Schema version — bump when breaking changes are made. */
  version: 1
  name: string
  nodes: TachiNode[]
  edges: TachiEdge[]
  savedAt: string // ISO 8601
}

// ── Palette template descriptors ──────────────────────────────────────────────

export type PaletteNodeType = 'provider' | 'agent' | 'skill' | 'folder' | 'internet' | 'mcp' | 'media' | 'rife' | 'prompt' | 'text' | 'imageref' | 'note' | 'webhook'

export interface PaletteTemplate {
  type: PaletteNodeType
  label: string
  /** Pre-filled data merged into the new node's data field. */
  data:
    | ProviderNodeData
    | AgentNodeData
    | SkillNodeData
    | RoleNodeData
    | FolderNodeData
    | InternetNodeData
    | McpNodeData
    | MediaNodeData
    | RifeNodeData
    | PromptNodeData
    | TextNodeData
    | ImageRefNodeData
    | NoteNodeData
    | WebhookNodeData
}
