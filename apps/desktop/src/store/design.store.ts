// apps/desktop/src/store/design.store.ts
//
// Persistent state for the Design tab (TACHI Design). Two levels, like Claude
// Design's Projects:
//   • PROJECT  — a named workspace that maps to a folder on disk; holds sessions.
//   • SESSION  — a design thread inside a project; its assistant turns carry the
//                generated document (HTML for pages; HTML + Remotion source for
//                animations). You iterate within a session by chatting.
// Generated files are also auto-saved to the project's on-disk folder (see
// DesignPage → window.tachi.design.saveFile) so nothing is trapped in the app.
//
// zustand + persist over localStorage ('tachi-design-v2'). Projects were added
// additively; ensureDefaultProject() adopts any pre-projects sessions on first
// load so existing work is preserved.

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export interface DesignMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  html?: string
  code?: string
  /** Structured interview questions (discovery pass) — renders as an
   *  interactive option-chip card instead of raw text. */
  interview?: Array<{ q: string; options: string[]; default?: string }>
  /** Attachment chip labels that rode along with a USER message (ref image /
   *  media assets / files / brand) — rendered on the bubble so it is always
   *  visible WHAT was sent with the request. */
  attachments?: string[]
  createdAt: number
}

export interface DesignSession {
  id: string
  /** Owning project. */
  projectId: string
  title: string
  messages: DesignMessage[]
  /** What this session builds — stamped on each successful generation. The UI
   *  syncs its PAGE/ANIMATE + engine toggles to this when the session opens,
   *  so continuing a session always refines the right artifact kind. */
  mode?: 'page' | 'animate'
  engine?: 'remotion' | 'hyperframes'
  createdAt: number
  updatedAt: number
}

export interface DesignProject {
  id: string
  name: string
  createdAt: number
}

/** One attached context chip (folder / files / brand / media asset). Owned by
 *  a PROJECT, not the composer: attach once, and every prompt in that project
 *  rides with it — across sessions and app restarts. */
export interface DesignCtxItem {
  id: string
  label: string
  text: string
}

const SESSION_CAP = 30
const MSG_CAP = 40

/** Preset slot for the session that does not exist yet (the composer before the
 *  first send). addUser() migrates it onto the session it creates. */
export const DRAFT_PRESET_KEY = '__draft'

interface DesignStore {
  projects: DesignProject[]
  activeProjectId: string | null
  /** PROJECT-scoped attached context (folder/files/brand/assets), persisted —
   *  the fix for "I attach a folder and the next prompt has forgotten it". */
  projectCtx: Record<string, DesignCtxItem[]>
  addProjectCtx(item: DesignCtxItem): void
  removeProjectCtx(itemId: string): void
  sessions: DesignSession[]
  activeId: string | null
  /** Brand preset per SESSION (id from @tachi/core design presets; '' = none).
   *  The composer picker writes here so reopening a design keeps its direction.
   *  Keyed by session id, plus DRAFT_PRESET_KEY for the not-yet-created one. */
  presetBySession: Record<string, string>
  setPreset(presetId: string): void
  providerId: string
  model: string
  /** Animation engine for animate mode. Persisted so the choice sticks. */
  engine: 'remotion' | 'hyperframes'
  setEngine(e: 'remotion' | 'hyperframes'): void
  ensureDefaultProject(): void
  newProject(name: string): string
  setActiveProject(id: string): void
  renameProject(id: string, name: string): void
  deleteProject(id: string): void
  newSession(): void
  loadSession(id: string): void
  deleteSession(id: string): void
  /** DESTRUCTIVE rewind of the active session: drop `messageId` and everything
   *  after it; returns its text. The UI gates this behind an explicit confirm —
   *  the non-destructive path is restoreVersion(). */
  rewindTo(messageId: string): string
  /** Git-revert-style restore: append a NEW assistant version carrying the
   *  document of `messageId` instead of deleting the tail. Returns the new
   *  message, or null when the id is not a document turn of the active session. */
  restoreVersion(messageId: string, text?: string): DesignMessage | null
  addUser(text: string, attachments?: string[]): DesignMessage
  addAssistant(text: string, html?: string, code?: string, interview?: DesignMessage['interview']): DesignMessage
  /** Stamp the ACTIVE session's artifact kind (called on successful builds). */
  setSessionKind(mode: 'page' | 'animate', engine?: 'remotion' | 'hyperframes'): void
  /** Apply a hand-edit (from the code editor) to a message's doc — drives live preview + persists. */
  updateMessageDoc(messageId: string, patch: { html?: string; code?: string }): void
  setProvider(id: string): void
  setModel(id: string): void
}

function uid(): string {
  try { return crypto.randomUUID() } catch { return `m_${Date.now()}_${Math.random().toString(36).slice(2)}` }
}

export const useDesignStore = create<DesignStore>()(
  persist(
    (set, get) => ({
      projects: [],
      activeProjectId: null,
      projectCtx: {},
      // Attach to the ACTIVE project (self-creating a default project when none
      // exists yet, so an attach before the first send is never lost). A
      // same-label re-attach REPLACES the old item (fresh content wins).
      addProjectCtx: (item) =>
        set((s) => {
          let projects = s.projects
          let activeProjectId = s.activeProjectId
          if (!activeProjectId || !projects.some((p) => p.id === activeProjectId)) {
            const proj: DesignProject = { id: uid(), name: 'My Designs', createdAt: Date.now() }
            projects = projects.length > 0 ? projects : [proj]
            activeProjectId = projects[0].id
          }
          const cur = s.projectCtx[activeProjectId] ?? []
          const next = [...cur.filter((c) => c.label !== item.label), item]
          return { projects, activeProjectId, projectCtx: { ...s.projectCtx, [activeProjectId]: next } }
        }),
      removeProjectCtx: (itemId) =>
        set((s) => {
          const pid = s.activeProjectId
          if (!pid || !s.projectCtx[pid]) return {}
          return { projectCtx: { ...s.projectCtx, [pid]: s.projectCtx[pid].filter((c) => c.id !== itemId) } }
        }),
      sessions: [],
      activeId: null,
      presetBySession: {},
      // Preset is per-session: with no session yet it parks on the draft slot,
      // and addUser() carries it onto the session it creates.
      setPreset: (presetId) =>
        set((s) => ({ presetBySession: { ...s.presetBySession, [s.activeId ?? DRAFT_PRESET_KEY]: presetId } })),
      providerId: '',
      model: '',
      engine: 'remotion',

      // Guarantee at least one project; adopt any project-less sessions into it.
      ensureDefaultProject: () =>
        set((s) => {
          if (s.projects.length > 0 && s.projects.some((p) => p.id === s.activeProjectId)) {
            // Still adopt orphans (e.g. from an older build) into the active project.
            const sessions = s.sessions.map((x) => (x.projectId ? x : { ...x, projectId: s.activeProjectId! }))
            return { sessions }
          }
          const proj: DesignProject = { id: uid(), name: 'My Designs', createdAt: Date.now() }
          const projects = s.projects.length > 0 ? s.projects : [proj]
          const activeProjectId = projects[0].id
          const sessions = s.sessions.map((x) => (x.projectId ? x : { ...x, projectId: activeProjectId }))
          return { projects, activeProjectId, sessions }
        }),

      newProject: (name) => {
        const proj: DesignProject = { id: uid(), name: name.trim() || 'Untitled Project', createdAt: Date.now() }
        set((s) => ({ projects: [proj, ...s.projects], activeProjectId: proj.id, activeId: null }))
        return proj.id
      },
      setActiveProject: (id) => set({ activeProjectId: id, activeId: null }),
      renameProject: (id, name) => set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p)) })),
      deleteProject: (id) =>
        set((s) => {
          const projects = s.projects.filter((p) => p.id !== id)
          const sessions = s.sessions.filter((x) => x.projectId !== id)
          const activeProjectId = s.activeProjectId === id ? (projects[0]?.id ?? null) : s.activeProjectId
          const projectCtx = { ...s.projectCtx }
          delete projectCtx[id]
          return { projects, sessions, activeProjectId, activeId: null, projectCtx }
        }),

      newSession: () => set({ activeId: null }),
      // Also activate the session's OWNING project — the sidebar rail lists
      // sessions across projects; without this, loading a Project-B session
      // while Project A is active mismatches the page state and auto-saves
      // into A's on-disk folder.
      loadSession: (id) => set((s) => {
        const sess = s.sessions.find(x => x.id === id)
        return sess ? { activeId: id, activeProjectId: sess.projectId } : { activeId: id }
      }),
      rewindTo: (messageId) => {
        let text = ''
        set((s) => ({
          sessions: s.sessions.map((x) => {
            if (x.id !== s.activeId) return x
            const idx = x.messages.findIndex((mm) => mm.id === messageId)
            if (idx < 0) return x
            text = x.messages[idx].text
            return { ...x, messages: x.messages.slice(0, idx), updatedAt: Date.now() }
          }),
        }))
        return text
      },
      // Non-destructive alternative to rewindTo: pinning v2 and hitting RESTORE
      // appends v2's document as a NEW latest version (git revert), so the tail
      // — and every version in it — stays in the thread.
      restoreVersion: (messageId, text) => {
        let created: DesignMessage | null = null
        set((s) => {
          const sess = s.sessions.find((x) => x.id === s.activeId)
          if (!sess) return {}
          const src = sess.messages.find((m) => m.id === messageId)
          if (!src || src.role !== 'assistant' || !(src.html || src.code)) return {}
          const m: DesignMessage = {
            id: uid(),
            role: 'assistant',
            text: text ?? 'Restored an earlier version.',
            ...(src.html ? { html: src.html } : {}),
            ...(src.code ? { code: src.code } : {}),
            createdAt: Date.now(),
          }
          created = m
          return {
            sessions: s.sessions.map((x) =>
              x.id === s.activeId ? { ...x, messages: [...x.messages, m].slice(-MSG_CAP), updatedAt: Date.now() } : x,
            ),
          }
        })
        return created
      },
      deleteSession: (id) =>
        set((s) => ({
          sessions: s.sessions.filter((x) => x.id !== id),
          activeId: s.activeId === id ? null : s.activeId,
        })),

      addUser: (text, attachments) => {
        const m: DesignMessage = { id: uid(), role: 'user', text, ...(attachments && attachments.length ? { attachments } : {}), createdAt: Date.now() }
        set((s) => {
          // Ensure a project exists to own the session.
          let projects = s.projects
          let activeProjectId = s.activeProjectId
          if (!activeProjectId || !projects.some((p) => p.id === activeProjectId)) {
            const proj: DesignProject = { id: uid(), name: 'My Designs', createdAt: Date.now() }
            projects = projects.length > 0 ? projects : [proj]
            activeProjectId = projects[0].id
          }
          let sessions = s.sessions
          let activeId = s.activeId
          let presetBySession = s.presetBySession
          if (!activeId || !sessions.some((x) => x.id === activeId)) {
            const ns: DesignSession = { id: uid(), projectId: activeProjectId, title: text.slice(0, 48) || 'Untitled design', messages: [], createdAt: Date.now(), updatedAt: Date.now() }
            sessions = [ns, ...sessions]
            activeId = ns.id
            // Carry the preset picked before the first send onto the real session.
            const draft = presetBySession[DRAFT_PRESET_KEY]
            if (draft) {
              presetBySession = { ...presetBySession, [ns.id]: draft }
              delete presetBySession[DRAFT_PRESET_KEY]
            }
          }
          const updated = sessions.map((x) =>
            x.id === activeId
              ? { ...x, messages: [...x.messages, m].slice(-MSG_CAP), updatedAt: Date.now(), title: x.messages.length === 0 ? (text.slice(0, 48) || x.title) : x.title }
              : x,
          )
          updated.sort((a, b) => b.updatedAt - a.updatedAt)
          return { projects, activeProjectId, sessions: updated.slice(0, SESSION_CAP), activeId, presetBySession }
        })
        return m
      },

      setSessionKind: (mode, engine) => {
        set((s) => ({
          sessions: s.sessions.map((x) => (x.id === s.activeId ? { ...x, mode, engine: engine ?? x.engine } : x)),
        }))
      },

      addAssistant: (text, html, code, interview) => {
        const m: DesignMessage = { id: uid(), role: 'assistant', text, html, code, interview, createdAt: Date.now() }
        set((s) => ({
          sessions: s.sessions.map((x) => (x.id === s.activeId ? { ...x, messages: [...x.messages, m].slice(-MSG_CAP), updatedAt: Date.now() } : x)),
        }))
        return m
      },

      updateMessageDoc: (messageId, patch) =>
        set((s) => ({
          sessions: s.sessions.map((x) =>
            x.id === s.activeId
              ? { ...x, updatedAt: Date.now(), messages: x.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m)) }
              : x,
          ),
        })),

      setProvider: (id) => set({ providerId: id }),
      setModel: (id) => set({ model: id }),
      setEngine: (e) => set({ engine: e }),
    }),
    { name: 'tachi-design-v2', storage: createJSONStorage(() => localStorage) },
  ),
)

/** The latest assistant document in a thread (the "current" page), or ''. */
export function latestHtml(messages: DesignMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].html) return messages[i].html!
  }
  return ''
}

/** The latest Remotion composition source in a thread (for refine/export), or ''. */
export function latestCode(messages: DesignMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].code) return messages[i].code!
  }
  return ''
}

// ── Refine source (the pinning fix) ───────────────────────────────────────────
// A refine must edit the version you are LOOKING AT. Pinning v2 in the thread and
// asking for a change used to hand the model latestHtml() (v5) — the edit landed
// on the wrong document. These resolve the pinned version first and fall back to
// the latest, mirroring the preview's own selection rule.

/** HTML a page refine must operate on: the PINNED version, else the latest. */
export function refineSourceHtml(messages: DesignMessage[], selectedId?: string | null): string {
  if (selectedId) {
    const m = messages.find((x) => x.id === selectedId)
    if (m?.html) return m.html
  }
  return latestHtml(messages)
}

/** Composition source an animation refine must operate on: pinned, else latest. */
export function refineSourceCode(messages: DesignMessage[], selectedId?: string | null): string {
  if (selectedId) {
    const m = messages.find((x) => x.id === selectedId)
    if (m?.code) return m.code
  }
  return latestCode(messages)
}

// ── Dropped-HTML helpers (drop-to-open) ───────────────────────────────────────

/** design:set-preview refuses documents over 8 MB — the same ceiling decides
 *  whether a dropped HTML file can be opened as a design at all. */
export const DESIGN_PREVIEW_MAX_CHARS = 8 * 1024 * 1024

/** True when a dropped .html/.htm file is a FULL document (doctype or <html>)
 *  rather than a fragment/partial worth attaching as context. */
export function looksLikeFullHtmlDocument(text: string): boolean {
  const head = text.slice(0, 4000)
  return /<!doctype\s+html/i.test(head) || /<html[\s>]/i.test(head)
}

/** Pull a ROOT-level DESIGN.md out of a folder-context chip (design:read-folder
 *  emits "### <relative path>\n<text>" blocks). Root only: a nested
 *  docs/DESIGN.md carries a path separator and is deliberately ignored. */
export function extractDesignMd(contextText: string): string {
  const m = /(?:^|\n)### DESIGN\.md\r?\n([\s\S]*?)(?=\r?\n### |$)/i.exec(contextText || '')
  return m ? m[1].trim() : ''
}
