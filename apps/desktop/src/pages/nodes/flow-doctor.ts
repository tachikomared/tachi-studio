// apps/desktop/src/pages/nodes/flow-doctor.ts
//
// NODES-RESEARCH #4 — SELF-HEALING TEMPLATES ("Install Missing X" one-click
// repair, the ComfyUI-validated mechanic that fixed ~85% of broken shares).
//
// serialization.ts::sanitizeFlow already does STRUCTURAL self-heal (unknown
// node types, dangling edges). THIS module is the SEMANTIC pass: a flow that is
// structurally fine can still reference a provider with no key, a local model
// that isn't downloaded, a folder that doesn't exist, or a codex/skill that
// isn't installed — and today it opens silently and only fails at RUN time.
//
// analyzeFlow() is a PURE, deterministic function: (nodes, edges, env) -> issues.
// `env` is a plain snapshot the caller gathers (flow-doctor-env.ts). It NEVER
// touches window.tachi, never does i18n (the banner localizes by `kind`), and is
// strictly FAIL-OPEN: an unrecognised node shape, or a missing env field, yields
// NO issue. A working flow must never be blocked by a false alarm — a template
// that opens broken is worse than none, and so is a template that cries wolf.

import { canonicalProviderId } from './providerCompat'
import { getProvider } from '@tachi/core/src/providers/registry'
import { requestedWanFrames, WAN_FRAMES_MAX, localVideoFpsFor } from '../media/localGenParams'
// The rife node's structural "could a clip ever reach this?" — the same reader
// the card and the graph phase use, so the banner cannot warn about a wire the
// run would happily follow (or stay silent about one it would not).
import { hasVideoCapableUpstream } from './rifeNode'
import type { TachiNode, TachiEdge } from './types'

// ── Public shapes ─────────────────────────────────────────────────────────────

export type FlowIssueKind =
  | 'provider-key'   // a provider/prompt/media node references a provider with no key
  | 'local-model'    // a local-engine model that isn't downloaded
  | 'engine-off'     // a downloaded local model whose engine isn't running it
  | 'folder-missing' // a folder node with no path, or a path that isn't on disk
  | 'skill-missing'  // a skill node referencing a skill that isn't installed
  | 'codex-missing'  // a codex agent node while codex isn't installed
  | 'segment-length' // a CHAINED local video segment asking for more than 81 frames
  | 'rife-no-input'  // an interpolate node with nothing that could hand it a clip
  | 'rife-missing'   // an interpolate node while the rife sidecar isn't installed

/** Where the ONE repair button sends the user. `pick-folder` opens the folder
 *  picker for that node in place; `navigate` jumps to a fix surface. */
export type FlowIssueFix =
  | { kind: 'navigate'; to: 'providers' | 'catalog' | 'settings' | 'skills' }
  | { kind: 'pick-folder' }
  | { kind: 'none' }

export interface FlowIssue {
  /** Id of the offending node (row heading resolves to it; FIX can target it). */
  nodeId: string
  kind: FlowIssueKind
  /** The offending node's display label — shown as the row heading. */
  label: string
  /**
   * Structured values for the banner's localized problem message
   * (e.g. { model }, { path }, { reason }, { provider }). Never user-facing on
   * its own — the banner renders t('repair.problem.<kind>', detail).
   */
  detail?: Record<string, string>
  fix: FlowIssueFix
}

/**
 * Environment snapshot. EVERY field is optional: a field left `undefined` means
 * "couldn't determine" and DISABLES the checks that depend on it (fail-open).
 * The gatherer (flow-doctor-env.ts) populates only what it can read.
 */
export interface LocalModelsEnv {
  /** Local model ids that are downloaded/available (llama.cpp downloadedModels). */
  installed: string[]
  /** Local model ids currently loaded in a running engine. */
  loaded: string[]
}

export interface FlowDoctorEnv {
  /** Canonical provider ids that are ready to use (keyless OR key present). */
  connectedProviders?: string[]
  /** Keychain ids currently stored (settings:list-keys). */
  storedKeys?: string[]
  /** Local-engine model state. Undefined → local-model / engine-off checks skip. */
  localModels?: LocalModelsEnv
  /** Whether the codex CLI is installed. Undefined → codex check skips. */
  codexInstalled?: boolean
  /** Map of folder-node path -> exists-on-disk. Undefined → on-disk check skips. */
  existingFolders?: Record<string, boolean>
  /** Skill ids available (installed SKILL.md + roles + permission tiers).
   *  Undefined → skill check skips. */
  availableSkills?: string[]
  /** Whether the rife-ncnn-vulkan sidecar is installed. Undefined → the
   *  rife-missing check skips (fail-open, like every other probe here). */
  rifeInstalled?: boolean
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Canonical ids of the app's first-party LOCAL LLM engines. local-model /
 * engine-off checks are scoped to these: Ollama is a user-managed external tool
 * (auto-starts, pulls its own models) so we deliberately fail-open on it rather
 * than mis-route a repair.
 */
const LOCAL_ENGINE_PROVIDERS: ReadonlySet<string> = new Set(['llama-cpp', 'ollama-local'])

/** Only llama.cpp has an explicit "load this model into the running server" step
 *  that an engine-off warning maps to. */
const LOADABLE_ENGINE_PROVIDERS: ReadonlySet<string> = new Set(['llama-cpp'])

/** A model value that means "let the engine pick" — never a specific-model gap. */
function isAutoModel(model: string): boolean {
  const m = model.trim().toLowerCase()
  return m === '' || m === 'auto'
}

/**
 * SELF-CONTAINED skill/role permission ids: these carry their own behaviour and
 * need nothing installed, so a skill node using one is NEVER flagged. Roles and
 * template permission nodes additionally carry `allowedTools` / `roleId`, which
 * are treated as self-contained too (see below).
 */
const KNOWN_PERMISSION_TIERS: ReadonlySet<string> = new Set([
  'read-only', 'readonly', 'read', 'edit', 'write', 'full', 'web-search', 'plan', 'generalist',
])

/**
 * Node types that CARRY a media result down a wire: a media node holds its own
 * `lastArtifacts`, an Output card mirrors them. A chain is media → (card?) →
 * media, so both count as links in it.
 */
const CHAIN_CARRIERS: ReadonlySet<string> = new Set(['media', 'output'])

// ── Small typed readers (defensive — the whole point is fail-open) ────────────

function str(v: unknown): string { return typeof v === 'string' ? v : '' }

/**
 * The canonical provider id a node depends on, or null when the node has no
 * provider dependency (or an unreadable one). Media nodes map their `provider`
 * field to a keychain-bearing provider; `local` media (sd.cpp/piper) needs no
 * key, so it returns null.
 */
function nodeProviderCanonical(node: TachiNode): string | null {
  const data = node.data as Record<string, unknown>
  if (node.type === 'provider' || node.type === 'prompt') {
    const raw = str(data.providerId)
    return raw ? canonicalProviderId(raw) : null
  }
  if (node.type === 'media') {
    // Media default provider is 'surplus' (see MediaNodeData) — an unset
    // provider still needs the Surplus key, which is the point of the check.
    const raw = data.provider === undefined ? 'surplus' : str(data.provider)
    if (raw === 'surplus' || raw === 'venice' || raw === 'imgnai') return raw
    return null // 'local' / 'pollinations' (keyless) or an unknown value → no key dependency
  }
  return null
}

type Readiness = 'ready' | 'needs-key' | 'unknown'

/**
 * Is `canonical` connected? 'ready' (keyless or key present / explicitly
 * connected), 'needs-key' (requires a key that isn't there), or 'unknown' (we
 * have no readiness info at all → caller must fail-open).
 */
function providerReadiness(canonical: string, env: FlowDoctorEnv): Readiness {
  const desc = getProvider(canonical)
  const requiredKey = desc?.keychainId
  if (!requiredKey) return 'ready' // keyless / local provider
  if (env.connectedProviders?.includes(canonical)) return 'ready'
  if (env.storedKeys) return env.storedKeys.includes(requiredKey) ? 'ready' : 'needs-key'
  if (env.connectedProviders) return 'needs-key' // had readiness info, provider absent from it
  return 'unknown' // no key info at all
}

/**
 * Ids of the media nodes that are LINKS IN A CHAIN — one media result feeding
 * another media node, directly or through the Output card that mirrors it.
 * BOTH ends qualify: the segment that feeds and the segment that is fed are
 * equally part of the chain whose coherence the frame ceiling protects.
 *
 * Fail-open like everything else here: an unreadable edge list yields an empty
 * set, which silences the check rather than guessing.
 */
function chainedMediaIds(nodes: readonly TachiNode[], edges: readonly TachiEdge[]): ReadonlySet<string> {
  const chained = new Set<string>()
  if (!Array.isArray(edges) || edges.length === 0) return chained
  const typeOf = new Map<string, string>()
  for (const n of nodes) if (n && typeof n.id === 'string') typeOf.set(n.id, String(n.type ?? ''))

  // media → carrier → … → media. One hop through carriers is all the canvas can
  // express today (a card mirrors exactly one source), so a two-pass walk over
  // the edge list resolves every chain without a graph traversal.
  const carrierSource = new Map<string, string>()   // carrier id → the media id behind it
  for (const e of edges) {
    if (!e || typeof e.source !== 'string' || typeof e.target !== 'string') continue
    if (typeOf.get(e.source) === 'media' && typeOf.get(e.target) === 'output') carrierSource.set(e.target, e.source)
  }
  for (const e of edges) {
    if (!e || typeof e.source !== 'string' || typeof e.target !== 'string') continue
    if (typeOf.get(e.target) !== 'media') continue
    const srcType = typeOf.get(e.source)
    if (!srcType || !CHAIN_CARRIERS.has(srcType)) continue
    const upstream = srcType === 'media' ? e.source : carrierSource.get(e.source)
    if (!upstream) continue
    chained.add(upstream)
    chained.add(e.target)
  }
  return chained
}

// ── The analyzer ──────────────────────────────────────────────────────────────

/**
 * Semantic health check for a loaded flow. Deterministic (issues in node order);
 * pure; fail-open. One issue per offending node.
 */
export function analyzeFlow(
  nodes: readonly TachiNode[],
  edges: readonly TachiEdge[],
  env: FlowDoctorEnv,
): FlowIssue[] {
  if (!Array.isArray(nodes)) return []
  const issues: FlowIssue[] = []
  const chained = chainedMediaIds(nodes, edges)

  for (const node of nodes) {
    if (!node || typeof node !== 'object' || typeof node.id !== 'string') continue
    const data = (node.data ?? {}) as Record<string, unknown>
    const label = str(data.label) || str(node.type) || node.id

    // ── provider-key (provider / prompt / media) ──────────────────────────────
    const canonical = nodeProviderCanonical(node)
    if (canonical) {
      const readiness = providerReadiness(canonical, env)
      if (readiness === 'needs-key') {
        issues.push({
          nodeId: node.id, kind: 'provider-key', label,
          detail: { provider: canonical },
          fix: { kind: 'navigate', to: 'providers' },
        })
      }
    }

    // ── local-model / engine-off (llama.cpp provider nodes) ───────────────────
    if (node.type === 'provider' && canonical && LOCAL_ENGINE_PROVIDERS.has(canonical)) {
      const model = str(data.model)
      if (!isAutoModel(model) && env.localModels) {
        const installed = env.localModels.installed ?? []
        const loaded = env.localModels.loaded ?? []
        if (!installed.includes(model)) {
          issues.push({
            nodeId: node.id, kind: 'local-model', label,
            detail: { model },
            fix: { kind: 'navigate', to: 'catalog' },
          })
        } else if (LOADABLE_ENGINE_PROVIDERS.has(canonical) && !loaded.includes(model)) {
          issues.push({
            nodeId: node.id, kind: 'engine-off', label,
            detail: { model },
            fix: { kind: 'navigate', to: 'catalog' },
          })
        }
      }
    }

    // ── folder-missing (folder nodes) ─────────────────────────────────────────
    if (node.type === 'folder') {
      const path = str(data.path).trim()
      if (path === '') {
        // No folder picked yet — a structural fact, independent of env, so it's
        // always safe to surface (the template's "pick your docs" moment).
        issues.push({
          nodeId: node.id, kind: 'folder-missing', label,
          detail: { reason: 'empty' },
          fix: { kind: 'pick-folder' },
        })
      } else if (env.existingFolders && env.existingFolders[path] === false) {
        // A concrete path that isn't on THIS machine (a shared/old flow).
        issues.push({
          nodeId: node.id, kind: 'folder-missing', label,
          detail: { reason: 'missing', path },
          fix: { kind: 'pick-folder' },
        })
      }
    }

    // ── codex-missing (codex agent nodes) ─────────────────────────────────────
    if (node.type === 'agent' && str(data.harnessId) === 'codex' && env.codexInstalled === false) {
      issues.push({
        nodeId: node.id, kind: 'codex-missing', label,
        fix: { kind: 'navigate', to: 'settings' },
      })
    }

    // ── segment-length (a chained LOCAL video segment over Wan's ceiling) ─────
    //
    // The FLF chaining policy (LOWVRAM-META-RESEARCH DELTA ADDENDUM): a chain is
    // built from ~5 s scenes because an unpatched Wan loses coherence past ~80
    // frames, and 81 (4n+1) is upstream's own trained length. The engine path
    // already CLAMPS to it — so a segment set to 12 s does not fail, it silently
    // renders 5 s. That silence is what this row breaks. It is a WARNING with no
    // repair button: the fix is an editorial decision (another scene, not a
    // longer one), and nothing here should ever block a run.
    //
    // Scoped hard, per the fail-open ethos: LOCAL (the ceiling is Wan's, not a
    // law of video) VIDEO nodes that are actually part of a media→media chain.
    if (node.type === 'media' && str(data.modality) === 'video' && str(data.provider) === 'local'
        && chained.has(node.id)) {
      const params = (data.params ?? {}) as Record<string, unknown>
      const asked = typeof params === 'object' && params !== null
        ? requestedWanFrames(params, localVideoFpsFor(str(data.model))) : null
      if (asked !== null && asked > WAN_FRAMES_MAX) {
        issues.push({
          nodeId: node.id, kind: 'segment-length', label,
          detail: { frames: String(asked), cap: String(WAN_FRAMES_MAX) },
          fix: { kind: 'none' },
        })
      }
    }

    // ── rife nodes: no clip wired, and no engine ──────────────────────────────
    //
    // Both are WARNINGS with no repair button, and for different reasons:
    //
    //  • rife-no-input — the fix is a WIRE, and nothing this banner can press
    //    will draw it. Asked of the GRAPH, before anything runs, so it must be
    //    the structural question ("could a clip ever arrive?") rather than
    //    "is there one right now": a wired video node that has not been run yet
    //    is a perfectly healthy flow. hasVideoCapableUpstream is deliberately
    //    forgiving — an Output card with no artifacts yet counts — and says no
    //    only where the wire can NEVER carry a clip (an image node, a text node).
    //
    //  • rife-missing — the install is 431 MB and lives ON the node, where the
    //    button can say the size before it spends the user's data. There is
    //    nowhere to navigate to, so the row carries no button either; it exists
    //    because a Run-all that will stop at an uninstalled engine should say so
    //    when the flow OPENS, not forty minutes in.
    if (node.type === 'rife') {
      if (!hasVideoCapableUpstream(node.id, nodes, edges)) {
        issues.push({ nodeId: node.id, kind: 'rife-no-input', label, fix: { kind: 'none' } })
      }
      if (env.rifeInstalled === false) {
        issues.push({ nodeId: node.id, kind: 'rife-missing', label, fix: { kind: 'none' } })
      }
    }

    // ── skill-missing (skill nodes referencing an uninstalled skill) ──────────
    if (node.type === 'skill') {
      const skillId = str(data.skillId).trim()
      const roleId = str(data.roleId).trim()
      const allowed = data.allowedTools
      const selfContained =
        roleId !== '' ||
        (Array.isArray(allowed) && allowed.length > 0) ||
        KNOWN_PERMISSION_TIERS.has(skillId)
      if (!selfContained && skillId !== '' && env.availableSkills && !env.availableSkills.includes(skillId)) {
        issues.push({
          nodeId: node.id, kind: 'skill-missing', label,
          detail: { skill: skillId },
          fix: { kind: 'navigate', to: 'skills' },
        })
      }
    }
  }

  return issues
}
