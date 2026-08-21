// apps/desktop/src/pages/nodes/sidebar/NodePalette.tsx
//
// Left sidebar that lists built-in node templates. Clicking a template
// inserts a new node near canvas center.
//
// Sprint D5: the static "Permissions" group replaced by a "Roles" section
// loaded from the role registry via IPC (roles:list).

import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNodesStore } from '../store/nodes.store'
import type { PaletteTemplate, RoleNodeData } from '../types'
import type { RoleInfo } from '../../../types/electron'
import { graphProviderSeeds } from '../providerCompat'
import { NODE_DRAG_MIME, serializeNodeDrag, dragPreviewLabel, paletteCategoryColor } from './paletteDrag'

// ── A5 — cascading fuzzy search ──────────────────────────────────────────────
//
// Inspired by codegraph's `searchNodes()` FTS5 → LIKE → Levenshtein cascade.
// Three tiers:
//   1. exact substring match on label OR template id  (zero-distance)
//   2. word-prefix match (first chars of any token)
//   3. Levenshtein distance ≤ 2 against label as last-resort fuzz
//
// We compute all three buckets eagerly and concat, deduping by reference.
// Higher tiers come first so "bank" → Bankr appears above any fuzzy hits.

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const al = a.length, bl = b.length
  if (al === 0) return bl
  if (bl === 0) return al
  // Single-row DP — O(min(a, b)) memory.
  let prev = new Array(bl + 1).fill(0).map((_, i) => i)
  let curr = new Array(bl + 1).fill(0)
  for (let i = 1; i <= al; i++) {
    curr[0] = i
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[bl]
}

interface SearchTarget {
  template: PaletteTemplate
  haystack: string
}

function buildHaystack(t: PaletteTemplate): string {
  // Collect every word a user might type — label, type, and the providerId /
  // harnessId / skillId on the data.
  const d = t.data as Record<string, unknown>
  return [t.label, t.type, d.providerId, d.harnessId, d.skillId, d.modality, d.source]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase()
}

function cascadingSearch(query: string, all: SearchTarget[]): PaletteTemplate[] {
  const q = query.trim().toLowerCase()
  if (q === '') return all.map(t => t.template)

  const tier1: PaletteTemplate[] = []  // exact substring
  const tier2: PaletteTemplate[] = []  // word prefix
  const tier3: { t: PaletteTemplate; d: number }[] = []  // levenshtein ≤ 2

  const seen = new Set<PaletteTemplate>()

  for (const item of all) {
    if (item.haystack.includes(q)) {
      tier1.push(item.template)
      seen.add(item.template)
      continue
    }
    const tokens = item.haystack.split(/\s+/).filter(Boolean)
    if (tokens.some(tok => tok.startsWith(q))) {
      tier2.push(item.template)
      seen.add(item.template)
      continue
    }
    // Fuzz only if query is at least 3 chars to avoid noise.
    if (q.length >= 3) {
      const closest = Math.min(...tokens.map(tok => levenshtein(tok, q)))
      if (closest <= 2 && !seen.has(item.template)) {
        tier3.push({ t: item.template, d: closest })
      }
    }
  }

  tier3.sort((a, b) => a.d - b.d)
  return [...tier1, ...tier2, ...tier3.map(x => x.t)]
}

// ── Built-in palette templates ────────────────────────────────────────────────

// Provider nodes — DERIVED from the unified provider registry (packages/core),
// filtered to the providers the agent-kit graph runtime can compile
// (GRAPH_PROVIDER_IDS). One source of truth shared with chat + agents, so this
// list never drifts from the rest of the app.
//
// NOTE: Anthropic / OpenRouter / free-claude-code are intentionally excluded —
// the compiler (graph-to-agentkit.ts) has no agent-kit adapter for them, so such
// nodes would fail to compile. Use Bankr/OpenGateway/Surplus for Claude/GPT in a
// graph (they route through an OpenAI-compatible endpoint the compiler supports).
const PROVIDER_TEMPLATES: PaletteTemplate[] = graphProviderSeeds().map(s => ({
  type: 'provider',
  label: s.label,
  data: { label: s.label, providerId: s.providerId, endpoint: s.endpoint, model: s.model },
}))

const AGENT_TEMPLATES: PaletteTemplate[] = [
  // Model is taken from the upstream provider node; agent only declares the harness.
  {
    type: 'agent',
    label: 'OpenClaude',
    data: { label: 'OpenClaude', harnessId: 'openclaude' },
  },
  {
    // Codex harness node: executes via the REAL Codex CLI (read-only analysis
    // — canvas runs are unattended, so no write sandbox without an approval
    // loop). Needs the Codex agent installed + ON; workspace comes from a
    // wired Folder node (falls back to the storage root).
    type: 'agent',
    label: 'Codex',
    data: { label: 'Codex', harnessId: 'codex' },
  },
]

// Tool nodes — wire one to an agent (plus a Role node for file permissions) to
// give that agent a real capability at run time.
const TOOL_TEMPLATES: PaletteTemplate[] = [
  { type: 'folder',   label: 'Folder',   data: { label: 'Workspace', path: '' } },
  { type: 'internet', label: 'Internet', data: { label: 'Internet' } },
  { type: 'mcp',      label: 'MCP',      data: { label: 'MCP', url: '' } },
]

// Media nodes — generate non-text media via the Surplus media engine. Wire a
// text provider→agent chain into the `prompt` plug to author the prompt, or
// type one directly on the node. The model picker on each node is filtered to
// the node's modality (fetched live via window.tachi.surplusMedia.listModels).
const MEDIA_TEMPLATES: PaletteTemplate[] = [
  { type: 'media', label: 'Image', data: { label: 'Image', modality: 'image', params: { size: '1024x1024', n: 1 } } },
  { type: 'media', label: 'Video', data: { label: 'Video', modality: 'video', params: {} } },
  { type: 'media', label: 'Music', data: { label: 'Music', modality: 'music', params: {} } },
  { type: 'media', label: 'TTS',   data: { label: 'TTS',   modality: 'tts',   params: {} } },
  { type: 'media', label: 'STT',   data: { label: 'STT',   modality: 'stt',   params: {} } },
  // POST-PROCESS, not generation: wire a local video result into its `video`
  // plug and it interpolates the frames (rife-ncnn-vulkan, x2 or x4) into a new
  // clip. Lives in the Media group because that is where the clip it smooths
  // comes from. The engine is a 431 MB one-time install, offered on the node.
  { type: 'rife',  label: 'Interpolate (RIFE)', data: { label: 'Interpolate', multiplier: 2 } },
]

// Prompt node — a self-contained text step (provider + model + instruction) that
// authors/polishes a prompt and plugs into a Media node's prompt plug. Defaults
// to the free local router so it runs with no key; everything is editable on the node.
const PROMPT_TEMPLATES: PaletteTemplate[] = [
  { type: 'prompt', label: 'Prompt', data: { label: 'Prompt', providerId: 'freellmapi-local', endpoint: 'localhost:8080', model: 'auto', instruction: '' } },
]

// Input nodes — STATIC sources with NO model call and NO generation:
//   • Text — type a topic / brief; its text IS the output, referenced downstream
//     via @ / {{node:<id>}} so a Prompt node knows what to write about.
//   • Reference Image — attach an image to use as a Media node's reference
//     (image-to-video init frame / image-model style ref), fed by wiring it in.
const INPUT_TEMPLATES: PaletteTemplate[] = [
  { type: 'text',     label: 'Text',            data: { label: 'Text', text: '' } },
  { type: 'imageref', label: 'Reference Image', data: { label: 'Reference Image' } },
]

// Trigger nodes (BATCH35 lane B) — INBOUND signal sources. A TradingView alert
// POSTed to the local API server becomes the node's output text, referenced
// downstream like a Text node. Inbound only: a trigger never places a trade.
// The hookId is minted per node on drop (see WebhookNode), so two copies of the
// template never share a URL.
const TRIGGER_TEMPLATES: PaletteTemplate[] = [
  { type: 'webhook', label: 'TradingView webhook', data: { label: 'TradingView alert', source: 'tradingview', hookId: '', armed: true } },
]

// Annotation nodes (NODES-RESEARCH #7) — a sticky NOTE for labelling / sectioning
// the canvas. No model call, no wiring, no run: it sits behind other nodes as a
// tinted background label. The store defaults its zIndex + sticky size on create.
const ANNOTATE_TEMPLATES: PaletteTemplate[] = [
  { type: 'note', label: 'Note', data: { label: 'Note', text: '', color: 'amber' } },
]

// ── Role boundary strictness → border color ──────────────────────────────────
//
// Sprint D5: color by restriction level.
//   generalist   (no denyWritePaths) → --success  (green)
//   backend/frontend (some denyWritePaths) → --warning (amber)
//   security-engineer (read-only-ish, denyWritePaths ≥ 1 + denyToolPatterns ≥ 1) → --danger  (red)

function roleBorderColor(role: RoleInfo): string {
  const hasDenyTools = role.boundaries.denyToolPatterns.length > 0
  const hasDenyPaths = role.boundaries.denyWritePaths.length > 0
  if (hasDenyTools && hasDenyPaths) return 'var(--danger)'
  if (hasDenyPaths) return 'var(--warning)'
  return 'var(--success)'
}

// Convert a RoleInfo to a PaletteTemplate for the existing drag-drop machinery.
function roleToTemplate(role: RoleInfo): PaletteTemplate {
  const data: RoleNodeData = {
    label:        role.label,
    roleId:       role.id,
    description:  role.description,
    allowedTools: role.allowedTools,
  }
  return { type: 'skill', label: role.label, data }
}

// ── Drag source (NODES-RESEARCH #12) ─────────────────────────────────────────
//
// Palette items double as drag sources: drag one onto the canvas to drop a node
// exactly where you release (FlowCanvas is the drop target). Click-to-insert is
// unchanged — a click and a drag are mutually exclusive gestures, so both live
// on the same button. What gets inserted is identical either way; only the
// position differs (drop point vs. canvas-center offset).
//
// The browser's default drag ghost (a translucent snapshot of the button) is
// replaced with a styled brutalist mini-card matching the node's category colour
// via setDragImage. The ghost is a detached element parked off-screen, snapshot
// by the browser, then removed on the next tick (the canonical setDragImage
// cleanup — the raster is taken synchronously, so a 0ms timeout is safe).

function buildDragGhost(template: PaletteTemplate): HTMLElement {
  const color = paletteCategoryColor(template.type)
  const card = document.createElement('div')
  card.setAttribute('aria-hidden', 'true')
  Object.assign(card.style, {
    position: 'fixed', top: '-9999px', left: '-9999px',
    display: 'flex', alignItems: 'center', gap: '8px',
    padding: '8px 12px',
    border: `2px solid ${color}`,
    background: 'var(--bg-surface)',
    color: 'var(--text-primary)',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: '12px', fontWeight: '700', letterSpacing: '0.04em',
    boxShadow: 'var(--shadow-hard)',
    whiteSpace: 'nowrap', pointerEvents: 'none',
  } as Partial<CSSStyleDeclaration>)
  const swatch = document.createElement('span')
  Object.assign(swatch.style, {
    width: '8px', height: '8px', background: color,
    flexShrink: '0', display: 'inline-block',
  } as Partial<CSSStyleDeclaration>)
  const text = document.createElement('span')
  text.textContent = dragPreviewLabel(template.label)
  card.append(swatch, text)
  return card
}

function startPaletteDrag(e: React.DragEvent<HTMLElement>, template: PaletteTemplate): void {
  e.dataTransfer.setData(NODE_DRAG_MIME, serializeNodeDrag(template))
  e.dataTransfer.effectAllowed = 'copy'
  const ghost = buildDragGhost(template)
  document.body.appendChild(ghost)
  // Grab the ghost near its top-left so it tracks under the cursor like the node.
  e.dataTransfer.setDragImage(ghost, 14, 14)
  window.setTimeout(() => ghost.remove(), 0)
}

// ── Component helpers ─────────────────────────────────────────────────────────

interface PaletteGroupProps {
  title: string
  templates: PaletteTemplate[]
  onAdd: (t: PaletteTemplate) => void
}

function PaletteGroup({ title, templates, onAdd }: PaletteGroupProps) {
  const { t: tr } = useTranslation('nodes')
  const color = paletteCategoryColor(templates[0]?.type ?? 'provider')
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        padding: '4px 10px',
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color,
        borderLeft: `2px solid ${color}`,
        marginBottom: 4,
      }}>
        {title}
      </div>
      {templates.map((t) => (
        <button
          key={t.label}
          onClick={() => onAdd(t)}
          draggable
          onDragStart={(e) => startPaletteDrag(e, t)}
          title={tr('palette.addNode', { label: t.label })}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            padding: '6px 10px',
            border: 'none',
            borderBottom: 'var(--border-width) solid var(--border)',
            background: 'transparent',
            color: 'var(--text-primary)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12,
            cursor: 'grab',
            textAlign: 'left',
          }}
          onMouseEnter={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-elevated)'
          }}
          onMouseLeave={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
          }}
        >
          <span style={{
            width: 8,
            height: 8,
            background: color,
            flexShrink: 0,
            display: 'inline-block',
          }} />
          {t.label}
        </button>
      ))}
    </div>
  )
}

// ── Sprint D5: Roles group — loaded from role registry via IPC ────────────────
//
// Each role card: label (bold), 1-line description, color border by boundary
// strictness, allowed-tool chips inline, and draggable into the canvas.
//
// Color semantics:
//   --success  = generalist (no restrictions)
//   --warning  = frontend/backend (write-restricted)
//   --danger   = security-engineer (read-only + deny-tool patterns)

interface RolesGroupProps {
  roles:  RoleInfo[]
  onAdd:  (t: PaletteTemplate) => void
  query:  string
}

function RolesGroup({ roles, onAdd, query }: RolesGroupProps) {
  const { t } = useTranslation('nodes')
  const headerColor = 'var(--accent)'

  const filtered = query.trim() === ''
    ? roles
    : roles.filter(r =>
        r.label.toLowerCase().includes(query.toLowerCase()) ||
        r.id.toLowerCase().includes(query.toLowerCase()) ||
        r.description.toLowerCase().includes(query.toLowerCase())
      )

  if (filtered.length === 0) return null

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        padding: '4px 10px',
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: headerColor,
        borderLeft: `2px solid ${headerColor}`,
        marginBottom: 4,
      }}>
        {t('palette.groups.roles')}
      </div>
      {filtered.map((role) => {
        const borderColor = roleBorderColor(role)
        const template = roleToTemplate(role)
        return (
          <button
            key={role.id}
            onClick={() => onAdd(template)}
            draggable
            onDragStart={(e) => startPaletteDrag(e, template)}
            title={t('palette.addRole', { label: role.label })}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              width: '100%',
              padding: '6px 10px',
              border: 'none',
              borderBottom: 'var(--border-width) solid var(--border)',
              borderLeft: `2px solid ${borderColor}`,
              background: 'transparent',
              color: 'var(--text-primary)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 11,
              cursor: 'grab',
              textAlign: 'left',
            }}
            onMouseEnter={(e) => {
              ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-elevated)'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
            }}
          >
            {/* Label row */}
            <span style={{ fontWeight: 700, fontSize: 11 }}>{role.label}</span>
            {/* Description */}
            <span style={{
              fontSize: 9,
              color: 'var(--text-dim)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: '100%',
            }}>
              {role.description}
            </span>
            {/* Allowed-tool chips */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
              {role.allowedTools.map(tool => (
                <span
                  key={tool}
                  style={{
                    fontSize: 8,
                    padding: '1px 4px',
                    border: `var(--border-width) solid ${borderColor}`,
                    color: borderColor,
                    fontFamily: 'JetBrains Mono, monospace',
                  }}
                >
                  {tool}
                </span>
              ))}
            </div>
          </button>
        )
      })}
    </div>
  )
}

export function NodePalette() {
  const { t } = useTranslation('nodes')
  const addNode   = useNodesStore(s => s.addNode)
  const nodeCount = useNodesStore(s => s.nodes.length)

  const [query, setQuery] = useState('')

  // Sprint D5: load roles from registry via IPC on mount.
  const [roles, setRoles] = useState<RoleInfo[]>([])
  useEffect(() => {
    window.tachi.roles.list()
      .then(setRoles)
      .catch((err: unknown) => console.warn('[NodePalette] roles:list failed', err))
  }, [])

  // Pre-compute the haystack once per template — no rebuild on every keystroke.
  // Roles are handled by RolesGroup's own filter (they have richer card layouts).
  const allTargets = useMemo<SearchTarget[]>(() =>
    [...PROVIDER_TEMPLATES, ...PROMPT_TEMPLATES, ...INPUT_TEMPLATES, ...TRIGGER_TEMPLATES, ...AGENT_TEMPLATES, ...TOOL_TEMPLATES, ...MEDIA_TEMPLATES, ...ANNOTATE_TEMPLATES]
      .map(t => ({ template: t, haystack: buildHaystack(t) })),
    [],
  )

  const filtered = useMemo(() => cascadingSearch(query, allTargets), [query, allTargets])

  // Re-group results into the original sections so filtered display still
  // shows the section headers (skip a section when it has zero hits).
  const filteredProviders = filtered.filter(t => t.type === 'provider')
  const filteredPrompt    = filtered.filter(t => t.type === 'prompt')
  const filteredInput     = filtered.filter(t => t.type === 'text' || t.type === 'imageref')
  const filteredTriggers  = filtered.filter(t => t.type === 'webhook')
  const filteredAgents    = filtered.filter(t => t.type === 'agent')
  const filteredTools     = filtered.filter(t => t.type === 'folder' || t.type === 'internet' || t.type === 'mcp')
  const filteredMedia     = filtered.filter(t => t.type === 'media' || t.type === 'rife')
  const filteredAnnotate  = filtered.filter(t => t.type === 'note')

  // Spread nodes diagonally so they don't stack
  const handleAdd = (t: PaletteTemplate) => {
    const offset = nodeCount * 20
    addNode({
      type: t.type,
      data: t.data,
      position: { x: 200 + offset, y: 150 + offset },
    } as Parameters<typeof addNode>[0])
  }

  return (
    // A11Y (batch34): named landmark so the palette is reachable directly
    // instead of by tabbing the whole toolbar first.
    <div
      role="complementary"
      aria-label={t('palette.aria', { defaultValue: 'Node palette' })}
      style={{
        width: 200,
        flexShrink: 0,
        borderRight: '2px solid var(--border)',
        background: 'var(--bg-surface)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{
        padding: '8px 10px',
        borderBottom: '2px solid var(--border)',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: 'var(--text-dim)',
        flexShrink: 0,
      }}>
        {t('palette.title')}
      </div>

      {/* A5 — search box */}
      <div style={{
        padding: '6px 8px',
        borderBottom: '2px solid var(--border)',
        flexShrink: 0,
      }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('palette.searchPlaceholder')}
          aria-label={t('palette.searchAria')}
          style={{
            width: '100%',
            padding: '4px 8px',
            border: '2px solid var(--border)',
            background: 'var(--bg-elevated)',
            color: 'var(--text-primary)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 11,
            outline: 'none',
          }}
        />
        {query && filtered.length === 0 && roles.filter(r =>
            r.label.toLowerCase().includes(query.toLowerCase()) ||
            r.id.toLowerCase().includes(query.toLowerCase())
          ).length === 0 && (
          <div style={{
            marginTop: 6,
            fontSize: 9,
            color: 'var(--text-dim)',
            fontFamily: 'JetBrains Mono, monospace',
            textAlign: 'center',
          }}>
            {t('palette.noMatches')}
          </div>
        )}
      </div>

      {/* Template groups (only render sections that have hits) */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {filteredProviders.length > 0 && (
          <PaletteGroup title={t('palette.groups.providers')} templates={filteredProviders} onAdd={handleAdd} />
        )}
        {filteredPrompt.length > 0 && (
          <PaletteGroup title={t('palette.groups.prompt')}    templates={filteredPrompt}    onAdd={handleAdd} />
        )}
        {filteredInput.length > 0 && (
          <PaletteGroup title={t('palette.groups.inputs')}    templates={filteredInput}     onAdd={handleAdd} />
        )}
        {filteredTriggers.length > 0 && (
          <PaletteGroup title={t('palette.groups.triggers')}  templates={filteredTriggers}  onAdd={handleAdd} />
        )}
        {filteredAgents.length > 0 && (
          <PaletteGroup title={t('palette.groups.agents')}    templates={filteredAgents}    onAdd={handleAdd} />
        )}
        {filteredTools.length > 0 && (
          <PaletteGroup title={t('palette.groups.tools')}     templates={filteredTools}     onAdd={handleAdd} />
        )}
        {filteredMedia.length > 0 && (
          <PaletteGroup title={t('palette.groups.media')}     templates={filteredMedia}     onAdd={handleAdd} />
        )}
        {filteredAnnotate.length > 0 && (
          <PaletteGroup title={t('palette.groups.annotate')}  templates={filteredAnnotate}  onAdd={handleAdd} />
        )}
        {/* Sprint D5: "Roles" replaces the static "Permissions" group.
            Loaded live from roles.yaml via the roles:list IPC channel.
            RolesGroup handles its own query filtering. */}
        <RolesGroup roles={roles} onAdd={handleAdd} query={query} />
      </div>

      {/* Footer hint */}
      <div style={{
        padding: '6px 10px',
        borderTop: 'var(--border-width) solid var(--border)',
        fontSize: 9,
        color: 'var(--text-dim)',
        fontFamily: 'JetBrains Mono, monospace',
        flexShrink: 0,
      }}>
        {t('palette.footer', { defaultValue: 'Drag onto the canvas, or click to insert.' })}
      </div>
    </div>
  )
}
