// apps/desktop/src/pages/nodes/canvas/FlowCanvas.tsx
//
// Wraps <ReactFlow> with brutalist styling and wires in the nodes.store.
// All node / edge mutation flows through the Zustand store — ReactFlow is
// a controlled component here.

import React, { useCallback, useState, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  ConnectionMode,
  useReactFlow,
  Panel,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
  BackgroundVariant,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useDialog } from '../../../hooks/useDialog'
import { useNodesStore } from '../store/nodes.store'
import { nodesInsideNote, shouldCarryMembers } from './noteGroup'
import { isMergeSource } from './mergeSelection'
import { NODE_DRAG_MIME, parseNodeDrag } from '../sidebar/paletteDrag'
import { STARTER_CARD_TEMPLATES, type FlowTemplate } from '../templates'
import { remapFlowIds } from '../templates/tachiflow'
import { ProviderNode } from './nodeTypes/ProviderNode'
import { AgentNode }    from './nodeTypes/AgentNode'
import { SkillNode }    from './nodeTypes/SkillNode'
import { FolderNode }   from './nodeTypes/FolderNode'
import { InternetNode } from './nodeTypes/InternetNode'
import { McpNode }      from './nodeTypes/McpNode'
import { MediaNode }    from './nodeTypes/MediaNode'
import { RifeNode }     from './nodeTypes/RifeNode'
import { PromptNode }   from './nodeTypes/PromptNode'
import { TextNode }     from './nodeTypes/TextNode'
import { ImageRefNode } from './nodeTypes/ImageRefNode'
import { OutputNode }   from './nodeTypes/OutputNode'
import { NoteNode }     from './nodeTypes/NoteNode'
import { SubflowNode }  from './nodeTypes/SubflowNode'
import { WebhookNode }  from './nodeTypes/WebhookNode'
import { UnknownNode }  from './nodeTypes/UnknownNode'
import { DeletableEdge } from './DeletableEdge'
import { LinkEdge }      from './LinkEdge'

// Register custom node types — object must be stable (defined outside render).
// Each component is wrapped in React.memo: ReactFlow re-renders the node layer
// on every store/position change, so without memoization dragging or updating
// ONE node re-renders ALL nodes (the main canvas-lag source). With memo, an
// unchanged node's props (stable `data` ref from the store) skip the re-render.
const nodeTypes = {
  provider: React.memo(ProviderNode),
  agent:    React.memo(AgentNode),
  skill:    React.memo(SkillNode),
  folder:   React.memo(FolderNode),
  internet: React.memo(InternetNode),
  mcp:      React.memo(McpNode),
  media:    React.memo(MediaNode),
  // The canvas's first POST-PROCESS tile: it consumes a finished .mp4 (not a
  // prompt, not a frame) and hands a smoother one onward. Local sidecar.
  rife:     React.memo(RifeNode),
  prompt:   React.memo(PromptNode),
  text:     React.memo(TextNode),
  imageref: React.memo(ImageRefNode),
  output:   React.memo(OutputNode),
  // NODES-RESEARCH #7: sticky note — annotation tile, no run semantics, sits
  // behind other nodes (zIndex -1). No handles; excluded from Run-all.
  note:     React.memo(NoteNode),
  // NODES-RESEARCH #8: subflow proxy — a collapsed group (VISUAL COLLAPSE ONLY).
  // Hides its children + their edges; expandable. No handles; skipped by Run-all.
  subflow:  React.memo(SubflowNode),
  // BATCH35 lane B: inbound TRIGGER tile — arms a loopback webhook route and
  // turns an alert body into its output. Source-only handles; not runnable.
  webhook:  React.memo(WebhookNode),
  // NODES-RESEARCH #3: self-healing fallback tile for a loaded node whose type
  // this build doesn't register — preserved + inert (sanitizeFlow → 'unknown').
  unknown:  React.memo(UnknownNode),
} as const

// Custom edge types. DeletableEdge is kept so old persisted flows that
// somehow retain type='deletable' still render correctly; LinkEdge is the
// new default (see B1.1 — edges-as-prose).
const edgeTypes = {
  deletable: DeletableEdge,
  link:      LinkEdge,
} as const

// Default edge config applied to every new connection — gives them all the
// link affordance (delete × + label edit).
const defaultEdgeOptions = {
  type: 'link',
} as const

// ── Quick node kinds shown in the pane context menu ───────────────────────────
// A minimal set — the full palette remains in the sidebar. We expose just the
// most-commonly-dropped types so a right-click → "Add …" is useful without
// being overwhelming.
const PANE_MENU_NODE_KINDS = [
  { typeKey: 'agent',    i18nKey: 'paneMenu.kindAgent',    data: { label: 'Agent',    harnessId: 'openclaude' } },
  { typeKey: 'prompt',   i18nKey: 'paneMenu.kindPrompt',   data: { label: 'Prompt',   providerId: 'freellmapi-local', endpoint: 'localhost:8080', model: 'auto', instruction: '' } },
  { typeKey: 'text',     i18nKey: 'paneMenu.kindText',     data: { label: 'Text',     text: '' } },
  { typeKey: 'media',    i18nKey: 'paneMenu.kindMedia',    data: { label: 'Image',    modality: 'image', params: { size: '1024x1024', n: 1 } } },
  { typeKey: 'provider', i18nKey: 'paneMenu.kindProvider', data: { label: 'Provider', providerId: 'bankr', endpoint: 'llm.bankr.bot/v1', model: 'claude-sonnet-4.6' } },
] as const

// ── PaneContextMenu ───────────────────────────────────────────────────────────
// Right-click context menu on the canvas pane (not on a node/edge).
// Positioned at the cursor; offers "Tidy Up" and quick "Add …" shortcuts.
// Uses a nested submenu for node kinds to keep the top-level menu short.

interface PaneContextMenuState {
  /** Viewport (screen) coordinates of the right-click. */
  x: number
  y: number
  /** Flow (canvas) coordinates — used for node placement. */
  flowX: number
  flowY: number
}

// ── NodeContextMenu ───────────────────────────────────────────────────────────
// Right-click on a NODE: Duplicate (with wiring inside a multi-selection) and
// Delete. Both actions already existed as shortcuts (Ctrl+D / Del) — this menu
// makes them discoverable and shows the shortcut next to each item.

interface NodeContextMenuState {
  x: number
  y: number
  nodeId: string
}

function NodeContextMenu({
  menu,
  onClose,
}: {
  menu: NodeContextMenuState
  onClose: () => void
}) {
  const { t } = useTranslation('nodes')
  const duplicateNodes = useNodesStore(s => s.duplicateNodes)
  const deleteNode     = useNodesStore(s => s.deleteNode)
  const collapseSelectionToSubflow = useNodesStore(s => s.collapseSelectionToSubflow)
  // A11Y (batch34): the menu is a focus region, not just a hover target —
  // useDialog moves focus onto the first item on open, cycles Tab inside the
  // menu, closes on Escape, and hands focus BACK to whatever had it (the
  // right-clicked node) on close. Same primitive the app's dialogs use.
  const menuRef = useDialog<HTMLDivElement>(onClose)

  // Close on any outside click (capture beats ReactFlow's handlers). Escape is
  // owned by useDialog above.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as HTMLElement)) onClose()
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [onClose, menuRef])

  // The clicked node — or the whole selection when it is part of one, so
  // right-click → Duplicate on a selected group copies the group + its wiring.
  const targetIds = () => {
    const nodes = useNodesStore.getState().nodes
    const clicked = nodes.find(n => n.id === menu.nodeId)
    const selected = nodes.filter(n => n.selected).map(n => n.id)
    return clicked?.selected && selected.length > 1 ? selected : [menu.nodeId]
  }

  // Portal to <body> + clamp: position:fixed resolves against the nearest
  // transformed ancestor, so rendering inside the route wrapper risks an
  // offset menu whenever anything up the tree gains a transform/filter.
  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    left: Math.min(menu.x, window.innerWidth - 200),
    top: Math.min(menu.y, window.innerHeight - 90),
    zIndex: 9999, minWidth: 180,
    border: '2px solid var(--border)', background: 'var(--bg-surface)',
    boxShadow: 'var(--shadow-hard)', fontFamily: 'JetBrains Mono, monospace',
  }
  const itemStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    width: '100%', padding: '7px 12px', border: 'none',
    borderBottom: '1px solid var(--border)', background: 'transparent',
    color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace',
    fontSize: 11, fontWeight: 600, letterSpacing: '0.04em',
    cursor: 'pointer', textAlign: 'left',
  }
  const hintStyle: React.CSSProperties = { fontSize: 9, color: 'var(--text-dim)', marginLeft: 12 }

  // NODES-RESEARCH #8: the collapsible selection for the right-clicked node —
  // only offered when the clicked node is part of a 2+ multi-selection.
  const groupIds = (() => {
    const nodes = useNodesStore.getState().nodes
    const clicked = nodes.find(n => n.id === menu.nodeId)
    const selected = nodes.filter(n => n.selected && n.type !== 'subflow').map(n => n.id)
    return clicked?.selected && selected.length >= 2 ? selected : []
  })()

  return createPortal(
    <div ref={menuRef} style={menuStyle} role="menu" aria-label={t('nodeMenu.aria')}>
      {groupIds.length >= 2 && (
        <button
          style={itemStyle}
          role="menuitem"
          onClick={() => { onClose(); collapseSelectionToSubflow(groupIds) }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-elevated)' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
        >
          <span>{t('nodeMenu.group', { defaultValue: 'Group into subflow' })}</span>
          <span style={hintStyle}>{groupIds.length}</span>
        </button>
      )}
      <button
        style={itemStyle}
        role="menuitem"
        onClick={() => { const ids = targetIds(); onClose(); duplicateNodes(ids) }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-elevated)' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
      >
        <span>{t('nodeMenu.duplicate')}</span>
        <span style={hintStyle}>Ctrl+D</span>
      </button>
      <button
        style={{ ...itemStyle, borderBottom: 'none', color: 'var(--destructive)' }}
        role="menuitem"
        onClick={() => { const ids = targetIds(); onClose(); ids.forEach(id => deleteNode(id)) }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-elevated)' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
      >
        <span>{t('nodeMenu.delete')}</span>
        <span style={hintStyle}>Del</span>
      </button>
    </div>,
    document.body,
  )
}

function PaneContextMenu({
  menu,
  onClose,
  onTidyUp,
}: {
  menu: PaneContextMenuState
  onClose: () => void
  onTidyUp: (() => void) | undefined
}) {
  const { t } = useTranslation('nodes')
  const addNode = useNodesStore(s => s.addNode)
  const nodeCount = useNodesStore(s => s.nodes.length)
  const [addSubmenuOpen, setAddSubmenuOpen] = useState(false)
  // A11Y (batch34): focus trap + restore + Escape, same as NodeContextMenu.
  // The "Add …" submenu renders INSIDE this container, so the trap covers it.
  const menuRef = useDialog<HTMLDivElement>(onClose)

  // Close on any click outside the menu. Escape is owned by useDialog above.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as HTMLElement)) {
        onClose()
      }
    }
    // Use capture so we beat ReactFlow's own click handlers.
    document.addEventListener('mousedown', handler, true)
    return () => document.removeEventListener('mousedown', handler, true)
  }, [onClose, menuRef])

  const handleTidyUp = useCallback(() => {
    onClose()
    onTidyUp?.()
  }, [onClose, onTidyUp])

  const handleAddNode = useCallback((typeKey: string, data: Record<string, unknown>) => {
    onClose()
    // Diagonal offset so successive quick-adds don't stack.
    const offset = nodeCount * 12
    addNode({
      type: typeKey,
      data: { ...data },
      position: { x: menu.flowX + offset, y: menu.flowY + offset },
    } as Parameters<typeof addNode>[0])
  }, [onClose, addNode, nodeCount, menu.flowX, menu.flowY])

  // Portalled to <body> (same containing-block hazard as NodeContextMenu).
  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    left: Math.min(menu.x, window.innerWidth - 200),
    top: Math.min(menu.y, window.innerHeight - 110),
    zIndex: 9999,
    minWidth: 180,
    border: '2px solid var(--border)',
    background: 'var(--bg-surface)',
    boxShadow: 'var(--shadow-hard)',
    fontFamily: 'JetBrains Mono, monospace',
  }

  const itemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    padding: '7px 12px',
    border: 'none',
    borderBottom: '1px solid var(--border)',
    background: 'transparent',
    color: 'var(--text-primary)',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.04em',
    cursor: 'pointer',
    textAlign: 'left',
  }

  return createPortal(
    <div ref={menuRef} style={menuStyle} role="menu" aria-label={t('paneMenu.aria')}>
      {/* Tidy Up */}
      <button
        style={itemStyle}
        onClick={handleTidyUp}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-elevated)' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
        role="menuitem"
        title={t('paneMenu.tidyUpTitle')}
      >
        {t('paneMenu.tidyUp')}
      </button>

      {/* Add node (nested submenu) */}
      <div style={{ position: 'relative' }}>
        <button
          style={{ ...itemStyle, borderBottom: 'none' }}
          onClick={() => setAddSubmenuOpen(o => !o)}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-elevated)' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
          role="menuitem"
          aria-haspopup="true"
          aria-expanded={addSubmenuOpen}
          title={t('paneMenu.addNodeTitle')}
        >
          <span>{t('paneMenu.addNode')}</span>
          <span style={{ fontSize: 9, color: 'var(--text-dim)', marginLeft: 8 }}>▶</span>
        </button>

        {addSubmenuOpen && (
          <div style={{
            position: 'absolute',
            top: 0,
            left: '100%',
            minWidth: 160,
            border: '2px solid var(--border)',
            background: 'var(--bg-surface)',
            boxShadow: 'var(--shadow-hard)',
          }}>
            {PANE_MENU_NODE_KINDS.map((kind, i) => (
              <button
                key={kind.typeKey}
                style={{
                  ...itemStyle,
                  borderBottom: i < PANE_MENU_NODE_KINDS.length - 1 ? '1px solid var(--border)' : 'none',
                }}
                onClick={() => handleAddNode(kind.typeKey, kind.data as Record<string, unknown>)}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-elevated)' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
                role="menuitem"
              >
                {t(kind.i18nKey)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

export function FlowCanvas({ onTidyUp }: { onTidyUp?: () => void }) {
  const { t } = useTranslation('nodes')
  const rawNodes      = useNodesStore(s => s.nodes)
  const rawEdges      = useNodesStore(s => s.edges)
  const onNodesChange = useNodesStore(s => s.onNodesChange)
  const onEdgesChange = useNodesStore(s => s.onEdgesChange)
  const onConnect     = useNodesStore(s => s.onConnect)
  const collapseSelectionToSubflow = useNodesStore(s => s.collapseSelectionToSubflow)
  const mergeSelectionToFollowUp   = useNodesStore(s => s.mergeSelectionToFollowUp)
  const addNode       = useNodesStore(s => s.addNode)
  const moveNodesBy   = useNodesStore(s => s.moveNodesBy)
  const rf            = useReactFlow()

  const [paneMenu, setPaneMenu] = useState<PaneContextMenuState | null>(null)
  const [nodeMenu, setNodeMenu] = useState<NodeContextMenuState | null>(null)
  // NODES-RESEARCH #12: true while a palette item is dragged over the canvas —
  // drives the subtle dashed drop affordance.
  const [dropActive, setDropActive] = useState(false)

  // NODES-RESEARCH #7 (parenting groups): while a note is being dragged, the ids
  // of the members riding along — they get an accent outline (the `.note-riding`
  // class injected below) so the user sees exactly what the note carries.
  const [ridingIds, setRidingIds] = useState<ReadonlySet<string>>(() => new Set())
  // Drag-carry snapshot (mutable, no re-render): the note being dragged, its last
  // seen position, and the member ids frozen at drag start.
  const carryRef = useRef<{ noteId: string; lastX: number; lastY: number; memberIds: Set<string> } | null>(null)

  // Cast our union types to the base types ReactFlow expects in its props.
  // The store's change handlers cast back internally. While a note carries its
  // members we tag those members with `.note-riding` (new object only for the few
  // members; everything else keeps its identity so React.memo still skips it).
  const nodes = useMemo<Node[]>(() => {
    if (ridingIds.size === 0) return rawNodes as Node[]
    return rawNodes.map(n =>
      ridingIds.has(n.id)
        ? ({ ...n, className: [n.className, 'note-riding'].filter(Boolean).join(' ') } as Node)
        : (n as Node),
    )
  }, [rawNodes, ridingIds])
  const edges = rawEdges as Edge[]

  // NODES-RESEARCH #9: node search — type to highlight, Enter cycles matches
  // and centers the viewport on each (spaghetti-at-scale escape hatch).
  const [searchQ, setSearchQ] = useState('')
  const [searchIdx, setSearchIdx] = useState(0)
  const searchMatches = useMemo(() => {
    const q = searchQ.trim().toLowerCase()
    if (!q) return []
    return rawNodes.filter(n => {
      const label = String((n.data as { label?: unknown })?.label ?? '').toLowerCase()
      return label.includes(q) || n.type?.toLowerCase().includes(q)
    })
  }, [searchQ, nodes])
  const jumpToMatch = (idx: number) => {
    const m = searchMatches[idx]
    if (!m) return
    rf.setCenter(m.position.x + 120, m.position.y + 60, { zoom: Math.max(rf.getZoom(), 0.9), duration: 350 })
    useNodesStore.getState().setNodes(useNodesStore.getState().nodes.map(n =>
      ({ ...n, selected: n.id === m.id }) as typeof n))
  }

  // NODES-RESEARCH #8: ids of the currently-selected, collapsible nodes (a
  // subflow proxy itself can't be folded again). The floating "GROUP → SUBFLOW"
  // affordance shows only when 2+ are selected (React Flow multi-select).
  const selectedGroupIds = useMemo(
    () => rawNodes.filter(n => n.selected && n.type !== 'subflow').map(n => n.id),
    [rawNodes],
  )

  // NODES-RESEARCH STEAL (flowith MERGE): the selected RUNNABLE-or-output nodes —
  // the eligible parents for a MERGE → FOLLOW-UP child. The floating affordance
  // shows only when 2+ are selected (config/static/note/subflow nodes excluded).
  const mergeSourceIds = useMemo(
    () => rawNodes.filter(n => n.selected && isMergeSource(n.type)).map(n => n.id),
    [rawNodes],
  )

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => onNodesChange(changes),
    [onNodesChange],
  )

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => onEdgesChange(changes),
    [onEdgesChange],
  )

  const handleConnect = useCallback(
    (connection: Connection) => onConnect(connection),
    [onConnect],
  )

  const handleNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: Node) => {
      e.preventDefault()
      setPaneMenu(null)
      setNodeMenu({ x: e.clientX, y: e.clientY, nodeId: node.id })
    },
    [],
  )

  const handlePaneContextMenu = useCallback(
    (e: MouseEvent | React.MouseEvent) => {
      e.preventDefault()
      setNodeMenu(null)
      // Convert viewport coords to canvas (flow) coords so the dropped node
      // appears exactly where the user right-clicked on the canvas.
      const flowPos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
      setPaneMenu({ x: e.clientX, y: e.clientY, flowX: flowPos.x, flowY: flowPos.y })
    },
    [rf],
  )

  // ── Palette drag-and-drop (NODES-RESEARCH #12) ──────────────────────────────
  // NodePalette items are drag sources; the canvas is the drop target. We only
  // react to OUR private mime type, so unrelated OS drags (files, text) are
  // ignored. What lands is identical to a palette click — only the position
  // differs (drop point vs. canvas-center offset).
  const isNodeDrag = useCallback(
    (e: React.DragEvent) => e.dataTransfer.types.includes(NODE_DRAG_MIME),
    [],
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!isNodeDrag(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropActive(true)
  }, [isNodeDrag])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // dragleave also fires when the cursor crosses into a child element, so only
    // clear the affordance once the pointer is truly outside the canvas bounds.
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    if (
      e.clientX <= r.left || e.clientX >= r.right ||
      e.clientY <= r.top  || e.clientY >= r.bottom
    ) {
      setDropActive(false)
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!isNodeDrag(e)) return
    e.preventDefault()
    setDropActive(false)
    const parsed = parseNodeDrag(e.dataTransfer.getData(NODE_DRAG_MIME))
    if (!parsed) return
    // Place the node's top-left at the drop point (the ghost was grabbed near
    // its own top-left, so the node lands under the cursor as expected).
    const position = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    addNode({ type: parsed.type, data: parsed.data, position } as Parameters<typeof addNode>[0])
  }, [isNodeDrag, rf, addNode])

  // ── Undo/redo (STEAL 2026-06-21 #3) ────────────────────────────────────────
  const pushHistory = useNodesStore(s => s.pushHistory)
  const undo        = useNodesStore(s => s.undo)
  const redo        = useNodesStore(s => s.redo)
  const canUndo     = useNodesStore(s => s.undoStack.length > 0)
  const canRedo     = useNodesStore(s => s.redoStack.length > 0)

  // Capture ONE checkpoint at the start of a node drag, so the whole drag
  // collapses to a single undo step (the position ticks themselves don't record).
  // NODES-RESEARCH #7 (parenting groups): if the drag is a lone NOTE and Alt is
  // NOT held, freeze the set of nodes whose center sits inside it — the note will
  // carry them by the same delta, and they light up with the `.note-riding`
  // outline. Alt-drag (or a multi-select drag) skips carry: the note moves alone.
  const handleNodeDragStart = useCallback(
    (event: MouseEvent | TouchEvent, node: Node, dragged: Node[]) => {
      pushHistory()
      carryRef.current = null
      const altKey = !!(event as { altKey?: boolean }).altKey
      if (!shouldCarryMembers({ nodeType: node.type, altKey, draggedCount: dragged.length })) {
        setRidingIds(prev => (prev.size === 0 ? prev : new Set()))
        return
      }
      const all = useNodesStore.getState().nodes
      const note = all.find(n => n.id === node.id)
      if (!note) return
      const memberIds = nodesInsideNote(note, all).map(n => n.id)
      if (memberIds.length === 0) return
      carryRef.current = { noteId: node.id, lastX: note.position.x, lastY: note.position.y, memberIds: new Set(memberIds) }
      setRidingIds(new Set(memberIds))
    },
    [pushHistory],
  )

  // Each drag tick, translate the carried members by the note's incremental
  // delta. Reading the delta off the event's node (already the new position) and
  // applying it through the store's functional set keeps the members exactly in
  // lockstep with the note without ever clobbering its own position update.
  const handleNodeDrag = useCallback(
    (_event: MouseEvent | TouchEvent, node: Node) => {
      const carry = carryRef.current
      if (!carry || carry.noteId !== node.id) return
      const dx = node.position.x - carry.lastX
      const dy = node.position.y - carry.lastY
      if (dx === 0 && dy === 0) return
      carry.lastX = node.position.x
      carry.lastY = node.position.y
      moveNodesBy(carry.memberIds, dx, dy)
    },
    [moveNodesBy],
  )

  // Settle any final sub-tick delta and drop the riding outline.
  const handleNodeDragStop = useCallback(
    (_event: MouseEvent | TouchEvent, node: Node) => {
      const carry = carryRef.current
      if (carry && carry.noteId === node.id) {
        const dx = node.position.x - carry.lastX
        const dy = node.position.y - carry.lastY
        if (dx !== 0 || dy !== 0) moveNodesBy(carry.memberIds, dx, dy)
      }
      carryRef.current = null
      setRidingIds(prev => (prev.size === 0 ? prev : new Set()))
    },
    [moveNodesBy],
  )

  // ── Empty-canvas starter cards (UX-benchmark #12b) ──────────────────────────
  // With zero nodes, blank space is replaced by 3 clickable template cards.
  // Clicking clones the template (fresh ids) into the current empty canvas.
  const storeLoadFlow = useNodesStore(s => s.loadFlow)
  const applyStarter = useCallback((tpl: FlowTemplate) => {
    const { nodes: tplNodes, edges: tplEdges } = remapFlowIds(tpl.file.flow.nodes, tpl.file.flow.edges)
    storeLoadFlow(tpl.file.flow.name, tplNodes, tplEdges)
    window.dispatchEvent(new CustomEvent('tachi:toast', {
      detail: {
        kind: 'success',
        text: t('toast.templateLoaded', { label: t(`templatesRail.items.${tpl.id}.label`, { defaultValue: tpl.label }) }),
      },
    }))
    // Bring the freshly-dropped graph into view once ReactFlow has measured it.
    setTimeout(() => { void rf.fitView({ padding: 0.3, duration: 300 }) }, 60)
  }, [storeLoadFlow, rf, t])

  // ── Copy / paste / duplicate (STEAL 2026-06-21 #3 sibling) ──────────────────
  const duplicateNodes = useNodesStore(s => s.duplicateNodes)
  const clipboardRef = useRef<string[]>([])

  // Ctrl/Cmd+Z = undo · +Shift / Ctrl+Y = redo · +C copy selection ·
  // +V paste (duplicate) · +D duplicate selection in place. Skipped while typing
  // in a node's input/textarea so inline text editing keeps its native shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      if (!['z', 'y', 'c', 'v', 'd'].includes(k)) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      const selectedIds = () => useNodesStore.getState().nodes.filter(n => n.selected).map(n => n.id)
      if (k === 'z' || k === 'y') {
        e.preventDefault()
        if (k === 'y' || (k === 'z' && e.shiftKey)) redo()
        else undo()
      } else if (k === 'c') {
        const ids = selectedIds()
        if (ids.length === 0) return // let the browser copy text elsewhere
        e.preventDefault()
        clipboardRef.current = ids
      } else if (k === 'v') {
        const ids = clipboardRef.current.length ? clipboardRef.current : selectedIds()
        if (ids.length === 0) return
        e.preventDefault()
        duplicateNodes(ids)
      } else if (k === 'd') {
        const ids = selectedIds()
        if (ids.length === 0) return
        e.preventDefault()
        duplicateNodes(ids)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, duplicateNodes])

  return (
    <div
      style={{ flex: 1, position: 'relative', overflow: 'hidden' }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      // A11Y (batch34): the graph is the page's main working surface — give it a
      // named landmark so assistive tech can jump straight to it instead of
      // walking the toolbar. `region` (not `application`) on purpose: the node
      // cards are ordinary form controls and must keep normal browse mode.
      role="region"
      aria-label={t('canvas.aria', { defaultValue: 'Flow canvas' })}
    >
      {/* Override ReactFlow default border-radius and font globally for this canvas */}
      <style>{`
        .react-flow__node { border-radius: 0 !important; }
        .react-flow__handle { border-radius: 0 !important; }
        /* NODES-RESEARCH #7: members riding along with a dragged note. */
        .react-flow__node.note-riding { outline: 2px solid var(--accent); outline-offset: 2px; }
        .react-flow__edge-path { stroke: var(--border); stroke-width: 2; }
        .react-flow__edge.selected .react-flow__edge-path { stroke: var(--accent); }
        .react-flow__controls { border: 2px solid var(--border); border-radius: 0; box-shadow: none; }
        .react-flow__controls-button {
          background: var(--bg-surface);
          border-bottom: 1px solid var(--border);
          border-radius: 0;
          color: var(--text-muted);
        }
        .react-flow__controls-button:hover { background: var(--bg-elevated); }
        .react-flow__controls-button svg { fill: var(--text-muted); }
        .react-flow__minimap {
          border: 2px solid var(--border);
          border-radius: 0;
          background: var(--bg-surface);
        }
        .react-flow__panel { font-family: 'JetBrains Mono', monospace; }
        .react-flow__attribution { display: none; }
      `}</style>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        // A4: loose mode lets a single handle accept both source + target
        // connections so the user can drag from any of our 8 invisible
        // handles into any other 8 without thinking about role.
        connectionMode={ConnectionMode.Loose}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        style={{ background: 'var(--bg-base)' }}
        deleteKeyCode={['Delete', 'Backspace']}
        edgesFocusable
        proOptions={{ hideAttribution: true }}
        onNodeDragStart={handleNodeDragStart}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        onPaneContextMenu={handlePaneContextMenu}
        onNodeContextMenu={handleNodeContextMenu}
        // Dismiss the context menus when the user clicks elsewhere on the pane.
        onPaneClick={() => { setPaneMenu(null); setNodeMenu(null) }}
        onMove={() => { setPaneMenu(null); setNodeMenu(null) }}
      >
        <Panel position="top-right">
          <div style={{ display: 'flex', gap: 0, border: '2px solid var(--border)' }}>
            <button
              onClick={() => undo()}
              disabled={!canUndo}
              title={t('canvas.undoTitle', { defaultValue: 'Undo (Ctrl+Z)' })}
              aria-label={t('canvas.undo', { defaultValue: 'Undo' })}
              style={{
                padding: '4px 9px', border: 'none', borderRight: '2px solid var(--border)',
                background: 'var(--bg-surface)', color: canUndo ? 'var(--text-muted)' : 'var(--text-dim)',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 13, fontWeight: 700,
                cursor: canUndo ? 'pointer' : 'default', opacity: canUndo ? 1 : 0.4,
              }}
            >↶</button>
            <button
              onClick={() => redo()}
              disabled={!canRedo}
              title={t('canvas.redoTitle', { defaultValue: 'Redo (Ctrl+Shift+Z)' })}
              aria-label={t('canvas.redo', { defaultValue: 'Redo' })}
              style={{
                padding: '4px 9px', border: 'none',
                background: 'var(--bg-surface)', color: canRedo ? 'var(--text-muted)' : 'var(--text-dim)',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 13, fontWeight: 700,
                cursor: canRedo ? 'pointer' : 'default', opacity: canRedo ? 1 : 0.4,
              }}
            >↷</button>
          </div>
        </Panel>
        {/* NODES-RESEARCH #9: node search (top-right). */}
        <Panel position="top-right">
          <div className="nodrag" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              value={searchQ}
              onChange={e => { setSearchQ(e.target.value); setSearchIdx(0) }}
              onKeyDown={e => {
                if (e.key === 'Enter' && searchMatches.length > 0) {
                  const next = (searchIdx + (e.shiftKey ? searchMatches.length - 1 : 1)) % searchMatches.length
                  setSearchIdx(next)
                  jumpToMatch(next)
                }
                if (e.key === 'Escape') { setSearchQ(''); (e.target as HTMLInputElement).blur() }
              }}
              placeholder={t('search.placeholder', { defaultValue: 'Find node…' })}
              aria-label={t('search.aria', { defaultValue: 'Search nodes' })}
              title={t('search.title', { defaultValue: 'Search nodes by label or type — Enter jumps to the next match, Shift+Enter previous' })}
              style={{
                width: 130, padding: '3px 7px', border: '2px solid var(--border)',
                background: 'var(--bg-elevated)', color: 'var(--text-primary)',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 10, outline: 'none',
              }}
            />
            {searchQ.trim() && (
              <span style={{
                fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 700,
                color: searchMatches.length ? 'var(--text-muted)' : 'var(--danger)',
                whiteSpace: 'nowrap',
              }}>
                {searchMatches.length ? `${(searchIdx % Math.max(searchMatches.length, 1)) + 1}/${searchMatches.length}` : '0'}
              </span>
            )}
          </div>
        </Panel>
        {/* Floating multi-select affordances (top-center). Same Panel hosts two
            gestures on a selection:
              · NODES-RESEARCH #8 — GROUP → SUBFLOW: collapse 2+ nodes into one
                subflow proxy (visual collapse; edges hidden, not re-wired).
              · NODES-RESEARCH STEAL (flowith) — MERGE → FOLLOW-UP: spawn ONE new
                agent below the centroid, wired FROM every selected RUNNABLE-or-
                output node, that synthesizes their outputs (a child with N
                parents). */}
        {(selectedGroupIds.length >= 2 || mergeSourceIds.length >= 2) && (
          <Panel position="top-center">
            <div style={{ display: 'flex', gap: 8 }}>
              {selectedGroupIds.length >= 2 && (
                <button
                  className="nodrag"
                  onClick={() => collapseSelectionToSubflow(selectedGroupIds)}
                  title={t('group.title', { n: selectedGroupIds.length, defaultValue: 'Collapse the {{n}} selected nodes into one subflow' })}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '5px 12px', border: '2px solid var(--accent)',
                    background: 'var(--accent)', color: '#ffffff',
                    fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 800,
                    letterSpacing: '0.08em', textTransform: 'uppercase', cursor: 'pointer',
                    boxShadow: 'var(--shadow-hard)',
                  }}
                >
                  <span>{t('group.toSubflow', { defaultValue: 'Group → Subflow' })}</span>
                  <span style={{
                    fontSize: 9, fontWeight: 800, padding: '0 5px',
                    border: '2px solid #ffffff',
                  }}>{selectedGroupIds.length}</span>
                </button>
              )}
              {mergeSourceIds.length >= 2 && (
                <button
                  className="nodrag"
                  onClick={() => mergeSelectionToFollowUp(mergeSourceIds, {
                    label:        t('merge.label', { defaultValue: 'Merge' }),
                    systemPrompt: t('merge.systemPrompt', { defaultValue: 'Synthesize the upstream results into one answer.' }),
                  })}
                  title={t('merge.title', { n: mergeSourceIds.length, defaultValue: 'Merge the {{n}} selected results into one follow-up agent that synthesizes them' })}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '5px 12px', border: '2px solid var(--accent)',
                    background: 'var(--bg-surface)', color: 'var(--accent)',
                    fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 800,
                    letterSpacing: '0.08em', textTransform: 'uppercase', cursor: 'pointer',
                    boxShadow: 'var(--shadow-hard)',
                  }}
                >
                  <span>⇥ {t('merge.toFollowUp', { defaultValue: 'Merge → Follow-up' })}</span>
                  <span style={{
                    fontSize: 9, fontWeight: 800, padding: '0 5px',
                    border: '2px solid var(--accent)',
                  }}>{mergeSourceIds.length}</span>
                </button>
              )}
            </div>
          </Panel>
        )}
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="var(--border)"
        />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(node) => {
            if (node.type === 'provider') return 'var(--accent)'
            if (node.type === 'agent')    return 'var(--warning)'
            if (node.type === 'skill')    return 'var(--success)'
            if (node.type === 'media')    return 'var(--accent)'
            if (node.type === 'rife')     return 'var(--accent)'
            if (node.type === 'prompt')   return 'var(--accent)'
            if (node.type === 'note')     return 'var(--warning)'
            if (node.type === 'webhook')  return 'var(--warning)'
            if (node.type === 'subflow')  return 'var(--accent)'
            return 'var(--border)'
          }}
          maskColor="rgba(0,0,0,0.4)"
        />
      </ReactFlow>

      {/* NODES-RESEARCH #12: subtle insertion affordance — a dashed accent frame
          + micro-label while a palette item is dragged over the canvas. Inert
          (pointerEvents: none) so it never eats the drop. */}
      {dropActive && (
        <div
          style={{
            position: 'absolute', inset: 6,
            border: '2px dashed var(--accent)',
            pointerEvents: 'none', zIndex: 5,
          }}
        >
          <div style={{
            position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)',
            padding: '3px 10px', background: 'var(--accent)', color: '#ffffff',
            fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 800,
            letterSpacing: '0.12em', textTransform: 'uppercase', whiteSpace: 'nowrap',
          }}>
            {t('palette.dropHint', { defaultValue: 'Drop to add node' })}
          </div>
        </div>
      )}

      {nodes.length === 0 && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 16,
            pointerEvents: 'none',
          }}
        >
          <div style={{
            border: '2px dashed var(--border)',
            padding: '16px 28px',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 11,
            color: 'var(--text-dim)',
            textAlign: 'center',
            letterSpacing: '0.04em',
          }}>
            <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 13 }}>{t('emptyCanvas.title')}</div>
            <div>{t('emptyCanvas.addNode')}</div>
            <div>{t('emptyCanvas.connect')}</div>
            <div>{t('emptyCanvas.delete')}</div>
          </div>

          {/* Starter cards — clone a curated template into this empty canvas. */}
          <div style={{
            fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 700,
            letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-dim)',
          }}>
            {t('emptyCanvas.starters')}
          </div>
          <div style={{ display: 'flex', gap: 12, pointerEvents: 'auto', flexWrap: 'wrap', justifyContent: 'center', maxWidth: 680 }}>
            {STARTER_CARD_TEMPLATES.map(tpl => (
              <button
                key={tpl.id}
                onClick={() => applyStarter(tpl)}
                title={t(`templatesRail.items.${tpl.id}.description`, { defaultValue: tpl.description })}
                style={{
                  width: 200, textAlign: 'left', padding: '12px 14px',
                  border: '2px solid var(--border)', background: 'var(--bg-surface)',
                  color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace',
                  cursor: 'pointer', boxShadow: 'var(--shadow-hard)',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)' }}
              >
                <span style={{
                  display: 'block', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
                  textTransform: 'uppercase', marginBottom: 6,
                }}>
                  {t(`templatesRail.items.${tpl.id}.label`, { defaultValue: tpl.label })}
                </span>
                <span style={{ display: 'block', fontSize: 9, lineHeight: 1.5, color: 'var(--text-dim)' }}>
                  {t(`templatesRail.items.${tpl.id}.description`, { defaultValue: tpl.description })}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {paneMenu && (
        <PaneContextMenu
          menu={paneMenu}
          onClose={() => setPaneMenu(null)}
          onTidyUp={onTidyUp}
        />
      )}

      {nodeMenu && (
        <NodeContextMenu
          menu={nodeMenu}
          onClose={() => setNodeMenu(null)}
        />
      )}
    </div>
  )
}
