// apps/desktop/src/store/swarm.store.ts
//
// gnap swarm store. Mirrors the live state of a single gnap-managed repo:
// the agent roster, task list, run log, and message stream. Backed entirely
// by IPC calls into the main-side GnapClient — the store itself never
// touches the filesystem.
//
// Persisted slice: just the list of recently opened repos and the active
// one. The actual agent/task/run/message arrays are in-memory only and get
// repopulated on every load via loadAll(). The watch wiring lives in
// SwarmPage (so unsubscribe is tied to component unmount) — this store
// only exposes `ingestEvent` as the sink.
//
// Encrypted localStorage is consistent with chat/agent/privacy persistence.

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { createEncryptedStorage } from './encryptedStorage'
import type {
  GnapAgent,
  GnapMessage,
  GnapRun,
  GnapTask,
  GnapWatchEvent,
} from '../types/electron'

// ─── Public re-exports ───────────────────────────────────────────────────────
// Keep the GnapXxx names exported under simpler aliases so consumers in
// pages/swarm/* don't have to reach across into types/electron.d.ts.

export type SwarmAgent   = GnapAgent
export type SwarmTask    = GnapTask
export type SwarmRun     = GnapRun
export type SwarmMessage = GnapMessage

/**
 * A single commit observed via gnap.watch. We store the local epoch ms when
 * the event was *received* (not parsed from the git author date) so the feed
 * always sorts in arrival order, which is what the UI wants.
 */
export interface SwarmEvent {
  sha:          string
  subject:      string
  touchedFiles: string[]
  at:           number
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Hard cap on feed length — old events fall off the end. */
const FEED_MAX_ENTRIES = 100

/** Cap on persisted recent-repos list. */
const RECENT_REPOS_MAX = 12

// ─── Store ───────────────────────────────────────────────────────────────────

interface SwarmStore {
  // ── Persisted ──────────────────────────────────────────────────────────────
  recentRepos:  string[]
  activeRepo:   string | null
  setActiveRepo:  (repo: string | null) => void
  addRecentRepo:  (repo: string) => void

  // ── In-memory (refreshed via IPC + watch) ──────────────────────────────────
  agents:    SwarmAgent[]
  tasks:     SwarmTask[]
  runs:      SwarmRun[]
  messages:  SwarmMessage[]
  /** Most-recent-first commit feed. Capped at FEED_MAX_ENTRIES entries. */
  feed:      SwarmEvent[]
  loading:   boolean
  error:     string | null

  // ── Actions ────────────────────────────────────────────────────────────────
  /**
   * Refresh every list slice in parallel for the given repo. Safe to call
   * multiple times — overlapping calls just race to set the same final
   * state. Errors from individual list calls do not throw; instead they
   * leave that slice empty and set `error` to the first failure message.
   */
  loadAll:       (repo: string) => Promise<void>
  /** Re-fetch only the agents slice (used by watch-driven selective invalidation). */
  loadAgentsOnly:   (repo: string) => Promise<void>
  /** Re-fetch only the tasks slice. */
  loadTasksOnly:    (repo: string) => Promise<void>
  /** Re-fetch only the runs slice. */
  loadRunsOnly:     (repo: string) => Promise<void>
  /** Re-fetch only the messages slice. */
  loadMessagesOnly: (repo: string) => Promise<void>
  /** Push a commit event onto the feed (capped). Caller decides whether to also re-fetch. */
  ingestEvent:   (event: SwarmEvent) => void
  /** Wipe everything in-memory. Used when navigating away or switching repos. */
  reset:         () => void
}

const initialInMemory = {
  agents:   [] as SwarmAgent[],
  tasks:    [] as SwarmTask[],
  runs:     [] as SwarmRun[],
  messages: [] as SwarmMessage[],
  feed:     [] as SwarmEvent[],
  loading:  false,
  error:    null as string | null,
}

export const useSwarmStore = create<SwarmStore>()(
  persist(
    (set, get) => ({
      recentRepos: [],
      activeRepo:  null,
      ...initialInMemory,

      setActiveRepo(repo) {
        // Clear in-memory state whenever we change repos so a stale list
        // doesn't briefly render before loadAll repopulates.
        if (repo !== get().activeRepo) {
          set({ ...initialInMemory, activeRepo: repo })
        } else {
          set({ activeRepo: repo })
        }
      },

      addRecentRepo(repo) {
        if (!repo) return
        set((s) => {
          // Move-to-front semantics: dedupe and reinsert at index 0.
          const filtered = s.recentRepos.filter((r) => r !== repo)
          const next     = [repo, ...filtered].slice(0, RECENT_REPOS_MAX)
          return { recentRepos: next }
        })
      },

      async loadAll(repo) {
        if (!repo) return
        set({ loading: true, error: null })
        try {
          const [agentsRes, tasksRes, runsRes, messagesRes] = await Promise.all([
            window.tachi.gnap.listAgents(repo),
            window.tachi.gnap.listTasks(repo),
            window.tachi.gnap.listRuns(repo),
            window.tachi.gnap.listMessages(repo),
          ])

          // Each list route returns { ok, ... } with the slice always present
          // (empty array on failure) plus an optional `error`. We surface the
          // first error we see but still keep loading any slices that worked.
          const firstError =
            (!agentsRes.ok   ? agentsRes.error   : null) ||
            (!tasksRes.ok    ? tasksRes.error    : null) ||
            (!runsRes.ok     ? runsRes.error     : null) ||
            (!messagesRes.ok ? messagesRes.error : null) ||
            null

          set({
            agents:   agentsRes.agents,
            tasks:    tasksRes.tasks,
            runs:     runsRes.runs,
            messages: messagesRes.messages,
            loading:  false,
            error:    firstError,
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          set({ loading: false, error: msg })
        }
      },

      async loadAgentsOnly(repo) {
        if (!repo) return
        try {
          const res = await window.tachi.gnap.listAgents(repo)
          set({
            agents: res.agents,
            error:  res.ok ? null : res.error,
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          set({ error: msg })
        }
      },

      async loadTasksOnly(repo) {
        if (!repo) return
        try {
          const res = await window.tachi.gnap.listTasks(repo)
          set({
            tasks: res.tasks,
            error: res.ok ? null : res.error,
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          set({ error: msg })
        }
      },

      async loadRunsOnly(repo) {
        if (!repo) return
        try {
          const res = await window.tachi.gnap.listRuns(repo)
          set({
            runs:  res.runs,
            error: res.ok ? null : res.error,
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          set({ error: msg })
        }
      },

      async loadMessagesOnly(repo) {
        if (!repo) return
        try {
          const res = await window.tachi.gnap.listMessages(repo)
          set({
            messages: res.messages,
            error:    res.ok ? null : res.error,
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          set({ error: msg })
        }
      },

      ingestEvent(event) {
        set((s) => {
          // Dedupe by sha — fs.watch can fire twice per write on some platforms,
          // and we already have lastSha gating on the main side, but belt-and-
          // suspenders here keeps the renderer from rendering ghost rows.
          if (s.feed.some((e) => e.sha === event.sha)) return {}
          const next = [event, ...s.feed].slice(0, FEED_MAX_ENTRIES)
          return { feed: next }
        })
      },

      reset() {
        set({ ...initialInMemory })
      },
    }),
    {
      name:    'tachi-swarm-v1',
      storage: createJSONStorage(() => createEncryptedStorage('swarm')),
      // Only persist the user-facing "recent" list and the active repo so a
      // restart returns to the same workspace. Live state is always re-fetched.
      partialize: (s) => ({
        recentRepos: s.recentRepos,
        activeRepo:  s.activeRepo,
      }) as Partial<SwarmStore>,
    },
  ),
)
