// apps/desktop/src/store/artifacts.store.ts
//
// Zustand store for per-conversation extracted artifacts.
// Mirrors the chat.store.ts persist pattern (name: tachi-artifacts-v1).

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { createEncryptedStorage } from './encryptedStorage'
import { decideMerge, applyManualEdit, applyRestore } from './artifact-versioning'

function randomUUID() { return globalThis.crypto.randomUUID() }

export type ArtifactKind = 'code' | 'html' | 'svg' | 'mermaid'

/** One stashed revision. createdAt = when it was stashed (not authored). */
export interface ArtifactVersion {
  content: string
  createdAt: string
  /** Message that authored this content — the replay-dedupe key that keeps a
   *  reload's re-extraction of older messages from rolling content backwards. */
  messageId?: string
}

export interface Artifact {
  id: string
  messageId: string
  title: string
  kind: ArtifactKind
  language?: string
  content: string
  createdAt: string
  /** Bumped whenever content changes after creation (regen merge / edit / restore). */
  updatedAt?: string
  /** Older contents, oldest → newest. Optional (additive) — records persisted
   *  before versioning rehydrate without it and gain it on first revision. */
  versions?: ArtifactVersion[]
}

interface ArtifactsStore {
  /** conversationId -> Artifact[] */
  artifacts: Record<string, Artifact[]>
  activeArtifactId: string | null

  addArtifact: (
    conversationId: string,
    artifact: Omit<Artifact, 'id' | 'createdAt' | 'updatedAt' | 'versions'>,
  ) => string
  /** Apply a hand-edit (from the editable code view) to an artifact's content. */
  updateArtifact: (conversationId: string, id: string, content: string) => void
  /** Make versions[versionIndex] current again (current content is stashed). */
  restoreVersion: (conversationId: string, id: string, versionIndex: number) => void
  setActive: (id: string | null) => void
  clearForConversation: (conversationId: string) => void
  getForConversation: (conversationId: string) => Artifact[]
}

export const useArtifactsStore = create<ArtifactsStore>()(
  persist(
    (set, get) => ({
      artifacts: {},
      activeArtifactId: null,

      addArtifact(conversationId, artifact) {
        const nowIso = new Date().toISOString()
        // Regeneration semantics: same conversation + title + kind reuses the
        // existing tab — identical content is a no-op, different content stashes
        // the current content as a version (never a silent overwrite, never a
        // duplicate tab). Anything else appends as before.
        const decision = decideMerge(get().artifacts[conversationId] ?? [], artifact, nowIso)
        if (decision.action === 'noop') {
          set({ activeArtifactId: decision.id })
          return decision.id
        }
        if (decision.action === 'newVersion') {
          set(s => ({
            artifacts: {
              ...s.artifacts,
              [conversationId]: (s.artifacts[conversationId] ?? []).map(a =>
                a.id === decision.id ? decision.artifact : a,
              ),
            },
            activeArtifactId: decision.id,
          }))
          return decision.id
        }
        const id = randomUUID()
        const full: Artifact = {
          ...artifact,
          id,
          createdAt: nowIso,
        }
        set(s => ({
          artifacts: {
            ...s.artifacts,
            [conversationId]: [...(s.artifacts[conversationId] ?? []), full],
          },
          activeArtifactId: id,
        }))
        return id
      },

      updateArtifact(conversationId, id, content) {
        const nowIso = new Date().toISOString()
        set(s => {
          const list = s.artifacts[conversationId]
          if (!list) return s
          return {
            artifacts: {
              ...s.artifacts,
              // Debounce-friendly versioning: the previous content is stashed
              // only when the last stash is >60s old (see applyManualEdit).
              [conversationId]: list.map(a => (a.id === id ? applyManualEdit(a, content, nowIso) : a)),
            },
          }
        })
      },

      restoreVersion(conversationId, id, versionIndex) {
        const nowIso = new Date().toISOString()
        set(s => {
          const list = s.artifacts[conversationId]
          if (!list) return s
          return {
            artifacts: {
              ...s.artifacts,
              [conversationId]: list.map(a => (a.id === id ? applyRestore(a, versionIndex, nowIso) : a)),
            },
          }
        })
      },

      setActive(id) {
        set({ activeArtifactId: id })
      },

      clearForConversation(conversationId) {
        set(s => {
          const next = { ...s.artifacts }
          delete next[conversationId]
          return { artifacts: next }
        })
      },

      getForConversation(conversationId) {
        return get().artifacts[conversationId] ?? []
      },
    }),
    {
      name: 'tachi-artifacts-v1',
      storage: createJSONStorage(() => createEncryptedStorage('artifacts')),
      partialize: (s) => ({
        artifacts: s.artifacts,
        activeArtifactId: s.activeArtifactId,
      }) as Partial<ArtifactsStore>,
    },
  ),
)
