// apps/desktop/src/store/workflow.store.ts
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { createEncryptedStorage } from './encryptedStorage'

function randomId() {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
}

export type NodeKind = 'input' | 'provider' | 'agent' | 'output'

export type ProviderId =
  | 'freellmapi-local'
  | 'opengateway'
  | 'anthropic-oauth'
  | 'openrouter-oauth'
  | 'free-claude-code'

// 'goose' was removed with the Goose harness. This store is persisted, but the
// field is display/config data only (nothing dispatches on it), so a legacy node
// that still says "goose" simply renders its stored string.
export type HarnessId = 'openclaude' | 'freeclaudecode'

/**
 * Per-kind configuration. Each kind has its own `data` shape; we keep it loose
 * so the persisted store can rehydrate without strict type-narrowing.
 */
export interface WorkflowNodeData {
  /** input — the user-entered text seed */
  text?: string
  /** provider — chosen provider + optional model name */
  providerId?: ProviderId
  model?: string
  /** agent — chosen harness */
  harness?: HarnessId
  /** output — last rendered result (purely client-side; not part of execution wiring yet) */
  result?: string
  /** Optional human label that overrides the kind label in the node header */
  label?: string
}

export interface WorkflowNode {
  id: string
  kind: NodeKind
  position: { x: number; y: number }
  data: WorkflowNodeData
}

export interface WorkflowEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
}

interface WorkflowStore {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  addNode: (kind: NodeKind) => string
  removeNode: (id: string) => void
  updateNode: (id: string, patch: Partial<WorkflowNode> | { data: Partial<WorkflowNodeData> }) => void
  setNodes: (nodes: WorkflowNode[]) => void
  setEdges: (edges: WorkflowEdge[]) => void
  reset: () => void
}

const DEFAULT_DATA: Record<NodeKind, WorkflowNodeData> = {
  input:    { text: '' },
  provider: { providerId: 'freellmapi-local', model: '' },
  agent:    { harness: 'openclaude' },
  output:   { result: '' },
}

let _spawnCount = 0
function spawnPosition(): { x: number; y: number } {
  // Spread nodes out so they don't sit on top of each other. Generous spacing
  // because brutalist node cards are ~220-260px wide.
  const i = _spawnCount++
  const col = i % 4
  const row = Math.floor(i / 4)
  return { x: 40 + col * 280, y: 40 + row * 200 }
}

export const useWorkflowStore = create<WorkflowStore>()(
  persist(
    (set) => ({
      nodes: [],
      edges: [],

      addNode(kind) {
        const id = randomId()
        const node: WorkflowNode = {
          id,
          kind,
          position: spawnPosition(),
          data: { ...DEFAULT_DATA[kind] },
        }
        set((s) => ({ nodes: [...s.nodes, node] }))
        return id
      },

      removeNode(id) {
        set((s) => ({
          nodes: s.nodes.filter((n) => n.id !== id),
          edges: s.edges.filter((e) => e.source !== id && e.target !== id),
        }))
      },

      updateNode(id, patch) {
        set((s) => ({
          nodes: s.nodes.map((n) => {
            if (n.id !== id) return n
            // Allow patching .data alone, or position, or both.
            const next: WorkflowNode = { ...n }
            if ('data' in patch && patch.data) {
              next.data = { ...n.data, ...(patch.data as Partial<WorkflowNodeData>) }
            }
            if ('position' in patch && patch.position) {
              next.position = patch.position
            }
            if ('kind' in patch && patch.kind) {
              next.kind = patch.kind
            }
            return next
          }),
        }))
      },

      setNodes(nodes) { set({ nodes }) },
      setEdges(edges) { set({ edges }) },

      reset() {
        _spawnCount = 0
        set({ nodes: [], edges: [] })
      },
    }),
    {
      name: 'tachi-workflows-v1',
      storage: createJSONStorage(() => createEncryptedStorage('workflows')),
      partialize: (s) => ({ nodes: s.nodes, edges: s.edges }) as Partial<WorkflowStore>,
    },
  ),
)
