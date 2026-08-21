// apps/desktop/src/pages/design/DesignPage.tsx
//
// TACHI Design — the open-source Claude Design surface (referencing nexu-io/
// open-design + the openpencil projects). Faithful Claude-Design model: you
// describe a page, the model returns ONE self-contained HTML document, it renders
// live in a sandboxed iframe, and you ITERATE by chatting — each turn refines the
// latest document. No style-preset picker: the design comes from your words + a
// strong system prompt, exactly like Claude Design.
//
// You only choose PROVIDER + MODEL (from the SAME registry the rest of the app
// uses). Generation streams via window.tachi.design.* ; network/egress + PRIVATE
// MODE are enforced in the main process, so this surface filters to local-only
// providers while private.
//
// Sandbox invariant: the preview iframe is allow-scripts + allow-forms, NEVER
// allow-same-origin (same lock-down as PreviewPanel) — a generated page cannot
// reach window.tachi or any renderer state.
//
// Style: 2px brutalist borders, JetBrains Mono, semantic CSS vars, ASCII labels.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { assetChipLabel, buildAssetPromptBlock, probeMediaMeta, videoPosterFrame } from './attach-media'
import { PageTopbar } from '../../components/layout/PageTopbar'
import { getProvider, type ProviderDescriptor } from '@tachi/core/src/providers/registry'
import { isVisionModel } from '@tachi/core/src/providers/vision'
import { buildRemotionHtml } from '@tachi/core/src/design/remotion'
import { buildHyperframesPreviewHtml } from '@tachi/core/src/design/hyperframes'
import { DESIGN_SCAFFOLD_MARK } from '@tachi/core/src/design/scaffold'
import { BRAND_PRESETS } from '@tachi/core/src/design/presets'

// The preview loads vendored GSAP from this in-app scheme (offline/private-safe).
const HYPERFRAMES_GSAP_URL = 'tachi-preview://asset/gsap.min.js'
import { useProviderModels, modelOptionLabel } from '../nodes/useProviderModels'
import { usePrivacyStore } from '../../store/privacy.store'
import {
  useDesignStore, refineSourceHtml, refineSourceCode, extractDesignMd,
  looksLikeFullHtmlDocument, DESIGN_PREVIEW_MAX_CHARS, DRAFT_PRESET_KEY,
} from '../../store/design.store'
import { CodeEditor } from '../../components/CodeEditor'
import { SplitHandle } from '../../components/SplitHandle'
import { useResizablePanel } from '../../hooks/useResizablePanel'
import { attachWysiwygEditor, applyTextEdit } from '../../lib/wysiwyg'
import { friendlyError } from '../../lib/friendly-error'
import { packVoice, unpackVoice, KOKORO_HOST_A_DEFAULT, type TtsEngine } from '../media/audioOverviewHelpers'

// Providers the generator supports (fixed-baseUrl OpenAI-compatible gateways +
// local Ollama). Mirrors resolveEndpoint() in design-generate.ts.
const DESIGN_PROVIDER_IDS = ['bankr-gateway', 'surplus', 'opengateway', 'venice', 'imgnai', 'ollama-local']

const EXAMPLE_KEYS = ['examples.page1', 'examples.page2', 'examples.page3', 'examples.page4']
const ANIM_EXAMPLE_KEYS = ['examples.anim1', 'examples.anim2', 'examples.anim3', 'examples.anim4']

/** What a session builds: its explicit stamp, else inferred from content
 *  (legacy sessions predate the stamp — an assistant turn with `code` is an
 *  animation, engine told apart by the HyperFrames timeline marker). */
function sessionKind(s: { mode?: 'page' | 'animate'; engine?: 'remotion' | 'hyperframes'; messages: Array<{ role: string; html?: string; code?: string }> }):
  { mode: 'page' | 'animate'; engine?: 'remotion' | 'hyperframes' } | null {
  if (s.mode) return { mode: s.mode, engine: s.engine }
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i]
    if (m.role !== 'assistant') continue
    if (m.code) return { mode: 'animate', engine: /__timelines/.test(m.code) ? 'hyperframes' : 'remotion' }
    if (m.html) return { mode: 'page' }
  }
  return null
}

function uid(): string {
  try { return crypto.randomUUID() } catch { return `r_${Date.now()}_${Math.random().toString(36).slice(2)}` }
}

// Stable empty array for the project-context selector (a fresh [] per render
// would defeat zustand's reference equality and re-render every store tick).
const EMPTY_CTX: { id: string; label: string; text: string }[] = []

export function DesignPage() {
  const { t } = useTranslation('design')
  // Strings for the chat-artifact seed handoff live in the artifacts namespace.
  const { t: tArtifacts } = useTranslation('artifacts')
  const privateMode = usePrivacyStore(s => s.mode === 'private')

  const allSessions  = useDesignStore(s => s.sessions)
  const activeId     = useDesignStore(s => s.activeId)
  const addUser      = useDesignStore(s => s.addUser)
  const addAssistant = useDesignStore(s => s.addAssistant)
  const updateMessageDoc = useDesignStore(s => s.updateMessageDoc)
  const newSession   = useDesignStore(s => s.newSession)
  const loadSession  = useDesignStore(s => s.loadSession)
  const deleteSession= useDesignStore(s => s.deleteSession)
  const rewindTo     = useDesignStore(s => s.rewindTo)
  const restoreVersion = useDesignStore(s => s.restoreVersion)
  // Brand preset (10 curated design systems in core) — per session, persisted.
  const presetId     = useDesignStore(s => s.presetBySession[s.activeId ?? DRAFT_PRESET_KEY] ?? '')
  const setPreset    = useDesignStore(s => s.setPreset)
  const projects        = useDesignStore(s => s.projects)
  const activeProjectId = useDesignStore(s => s.activeProjectId)
  const ensureDefaultProject = useDesignStore(s => s.ensureDefaultProject)
  const newProject      = useDesignStore(s => s.newProject)
  const setActiveProject= useDesignStore(s => s.setActiveProject)
  const renameProject   = useDesignStore(s => s.renameProject)
  const providerId   = useDesignStore(s => s.providerId)
  const model        = useDesignStore(s => s.model)
  const setProvider  = useDesignStore(s => s.setProvider)
  const setModel     = useDesignStore(s => s.setModel)
  const engine       = useDesignStore(s => s.engine)
  const setEngine    = useDesignStore(s => s.setEngine)

  useEffect(() => { ensureDefaultProject() }, [ensureDefaultProject])
  const activeProject = projects.find(p => p.id === activeProjectId) ?? null
  const sessions = useMemo(() => allSessions.filter(x => x.projectId === activeProjectId), [allSessions, activeProjectId])
  const messages = useMemo(() => allSessions.find(x => x.id === activeId)?.messages ?? [], [allSessions, activeId])

  // ── Provider + model (from the shared registry) ───────────────────────────
  const providers = useMemo<ProviderDescriptor[]>(() => (
    DESIGN_PROVIDER_IDS
      .map(id => getProvider(id))
      .filter((d): d is ProviderDescriptor => !!d)
      .filter(d => !privateMode || d.egress === 'local')
  ), [privateMode])

  useEffect(() => {
    if (!providerId || !providers.some(p => p.id === providerId)) setProvider(providers[0]?.id ?? '')
  }, [providers, providerId, setProvider])

  const { models, loading: modelsLoading } = useProviderModels(providerId)
  useEffect(() => {
    if (!model || !models.some(m => m.id === model)) setModel(models[0]?.id ?? '')
  }, [models, model, setModel])

  // ── Composer + generation state ───────────────────────────────────────────
  const [mode, setMode]         = useState<'page' | 'animate'>('page')
  // Opening a session SYNCS the PAGE/ANIMATE + engine toggles to what that
  // session actually builds — continuing an animation must never silently run
  // in page mode (burns tokens on the wrong artifact and "refines" the wrong
  // thing). Explicit session.mode wins; legacy sessions infer from content.
  useEffect(() => {
    const sess = useDesignStore.getState().sessions.find(x => x.id === activeId)
    if (!sess) return
    const kind = sessionKind(sess)
    if (!kind) return
    setMode(kind.mode)
    if (kind.engine) setEngine(kind.engine)
  }, [activeId]) // eslint-disable-line react-hooks/exhaustive-deps — sync on open only, never fight a mid-session toggle
  const [interview, setInterview] = useState(true) // Claude-Design-style: ask clarifying questions first
  const [prompt, setPrompt]     = useState('')
  const [refImage, setRefImage] = useState<string | null>(null)
  // Attached context lives in the STORE, scoped to the ACTIVE PROJECT — attach
  // a folder/files/brand once and every prompt in this project rides with it,
  // across sessions and app restarts (was ephemeral component state: users
  // had to re-attach everything on each new prompt).
  const ctxItems = useDesignStore(s => (s.activeProjectId && s.projectCtx[s.activeProjectId]) || EMPTY_CTX)
  const addCtxItem = useDesignStore(s => s.addProjectCtx)
  const removeCtxItem = useDesignStore(s => s.removeProjectCtx)
  const [dragOver, setDragOver] = useState(false)
  // Dropped/picked FULL HTML documents awaiting the open-vs-attach choice.
  const [pendingHtml, setPendingHtml] = useState<{ id: string; name: string; content: string }[]>([])
  // rewindTo() deletes the tail — it only runs after a second, explicit click.
  const [confirmRewindId, setConfirmRewindId] = useState<string | null>(null)
  const [running, setRunning]   = useState(false)
  const [streamRaw, setStreamRaw] = useState('')
  const [error, setError]       = useState<string | null>(null)
  const [view, setView]         = useState<'preview' | 'code'>('preview')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [toast, setToast]       = useState<string | null>(null)
  const [showSessions, setShowSessions] = useState(false)
  const threadPane = useResizablePanel({ storageKey: 'tachi-split:design.thread', initial: 380, min: 280, max: 720, side: 'right', collapsible: true })

  // [OPEN IN DESIGN] seed: the chat artifacts pane hands a document over via a
  // one-shot sessionStorage key (same pattern as tachi:settings-scroll). Consume
  // it on mount: start a fresh session seeded with the artifact as the current
  // page, so the user iterates on it by chatting.
  useEffect(() => {
    let raw: string | null = null
    try {
      raw = sessionStorage.getItem('tachi:design-seed')
      if (raw) sessionStorage.removeItem('tachi:design-seed')
    } catch { /* sessionStorage unavailable — nothing to consume */ }
    if (!raw) return
    try {
      const seed = JSON.parse(raw) as { html?: unknown; title?: unknown }
      const html = typeof seed?.html === 'string' ? seed.html : ''
      if (!html) return
      const title = typeof seed?.title === 'string' && seed.title ? seed.title : 'artifact'
      const st = useDesignStore.getState()
      st.newSession()
      st.addUser(tArtifacts('pane.seedUser', { title, defaultValue: 'Imported from chat: {{title}}' }))
      st.addAssistant(tArtifacts('pane.seedAssistant', { defaultValue: 'Seeded from a chat artifact — iterate by chatting.' }), html)
      st.setSessionKind('page')
      setMode('page')
      setView('preview')
    } catch { /* malformed seed — ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot mount consumption
  }, [])
  const [renamingProject, setRenamingProject] = useState(false)
  const [projName, setProjName] = useState('')
  const [baseDir, setBaseDir] = useState('')
  const [renderMsg, setRenderMsg] = useState<string | null>(null) // non-null while exporting an MP4
  /**
   * THE VIDEO ENCODER, which is a download rather than a dependency.
   *
   * Remotion's compositor carries an FFmpeg whose own version string says
   * `nonfree and unredistributable`, so it is excluded from the installer and
   * fetched from Remotion's official npm package when the user asks. Until it is
   * here, the MP4 button IS the consent: it says what it costs and why.
   * `null` = not asked yet.
   */
  const [encoder, setEncoder] = useState<{ installed: boolean; approxBytes: number | null } | null>(null)
  const [encoderMsg, setEncoderMsg] = useState<string | null>(null)
  // Voiceover panel (animate·remotion only — HyperFrames v1 has no audio path):
  // synthesize piper lines into design-audio; the generator sees them via the
  // prompt's AUDIO allowlist and scores with <Audio src={staticFile(...)}>.
  const [showVo, setShowVo]   = useState(false)
  const [voText, setVoText]   = useState('')
  const [voVoice, setVoVoice] = useState('') // engine-packed: "kokoro:af_heart" / "piper:<id>"
  const [voVoices, setVoVoices] = useState<{ value: string; label: string; engine: TtsEngine }[]>([])
  const [voFiles, setVoFiles] = useState<{ name: string }[]>([])
  const [voBusy, setVoBusy]   = useState(false)
  const [voCopied, setVoCopied] = useState<string | null>(null)
  const refreshVo = () => {
    void (async () => {
      // STUDIO (kokoro) voices join the piper list when installed. The kokoro
      // surface may be absent on older builds — then this is the piper-only
      // list it always was. English default: af_heart (studio) when available.
      let studio: { value: string; label: string; engine: TtsEngine }[] = []
      try {
        const ks = await window.tachi.kokoro?.status()
        if (ks?.installed) studio = ks.voices.map(v => ({ value: packVoice('kokoro', v.id), label: v.label, engine: 'kokoro' as const }))
      } catch { /* kokoro absent → piper only */ }
      let piperOpts: { value: string; label: string; engine: TtsEngine }[] = []
      try {
        const ps = await window.tachi.piper.status()
        piperOpts = ps.voices.map((v: { id: string }) => ({ value: packVoice('piper', v.id), label: v.id, engine: 'piper' as const }))
      } catch { /* piper probe failed → studio only */ }
      const all = [...studio, ...piperOpts]
      setVoVoices(all)
      const preferred = studio.find(o => o.value === packVoice('kokoro', KOKORO_HOST_A_DEFAULT))?.value ?? all[0]?.value ?? ''
      setVoVoice(v => all.some(o => o.value === v) ? v : preferred)
    })()
    window.tachi.design.listAudio().then(r => { if (r.ok) setVoFiles(r.files) }).catch(() => {})
  }
  useEffect(() => { if (showVo) refreshVo() }, [showVo])
  // Import ANY audio file (SFX / music / pre-made VO) into design-audio — the
  // generation prompt's AUDIO allowlist then lets compositions score with it.
  const importAudioFile = async (f: File | undefined) => {
    // Electron exposes the real path on picked File objects.
    const p = (f as unknown as { path?: string } | undefined)?.path
    if (!p) {
      window.dispatchEvent(new CustomEvent('tachi:toast', { detail: { kind: 'error', text: t('audio.noPath') } }))
      return
    }
    setVoBusy(true)
    try {
      const r = await window.tachi.design.importAudio(p)
      if (r.ok) { refreshVo(); setToast(t('audio.imported', { file: r.file ?? '' })) }
      else window.dispatchEvent(new CustomEvent('tachi:toast', { detail: { kind: 'error', text: r.error ?? t('audio.importFailed') } }))
    } finally {
      setVoBusy(false)
    }
  }
  const synthesizeVoLine = async () => {
    if (!voVoice || !voText.trim() || voBusy) return
    setVoBusy(true)
    try {
      const { engine, id } = unpackVoice(voVoice)
      if (engine === 'kokoro') {
        // kokoro has no design-dir synth IPC — reuse the EXISTING chain instead:
        // synthesize (b64 WAV) → media library save → design:import-audio, so the
        // file lands in the same design-audio dir the piper path writes to.
        const media = window.tachi.media
        if (!window.tachi.kokoro || !media?.saveWav) throw new Error(t('voiceover.studioUnavailable'))
        const r = await window.tachi.kokoro.synthesize({ text: voText.trim(), voice: id })
        if (!r.ok || !r.b64) throw new Error(r.error || 'synthesize failed')
        const slug = voText.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'vo'
        const saved = await media.saveWav({ b64: r.b64, name: `vo-${slug}-${Date.now()}.wav` })
        if (!saved.ok || !saved.path) throw new Error(saved.error || 'save failed')
        const imp = await window.tachi.design.importAudio(saved.path)
        if (!imp.ok) throw new Error(imp.error ?? t('audio.importFailed'))
        setVoText(''); refreshVo()
      } else {
        const r = await window.tachi.design.synthesizeVo({ voiceId: id, text: voText.trim() })
        if (!r.ok) throw new Error(r.error ?? 'synthesize failed')
        setVoText(''); refreshVo()
      }
    } catch (err) {
      window.dispatchEvent(new CustomEvent('tachi:toast', { detail: { kind: 'error', text: err instanceof Error ? err.message : String(err) } }))
    } finally {
      setVoBusy(false)
    }
  }
  useEffect(() => { window.tachi.design.getBase().then(r => setBaseDir(r.baseDir)).catch(() => {}) }, [])
  const activeReqRef = useRef<string>('')
  const threadEndRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)

  // Rewind/edit: drop a user turn (and everything after) back into the composer.
  // DESTRUCTIVE — every later version is deleted, so the button asks for a second
  // click first (see confirmRewindId). To keep an old version WITHOUT losing the
  // tail, pin it and hit RESTORE (restoreVersion) instead.
  function rewindEdit(messageId: string) {
    if (running) stop()
    setConfirmRewindId(null)
    const text = rewindTo(messageId)
    setPrompt(text); setSelectedId(null); setError(null)
    requestAnimationFrame(() => { composerRef.current?.focus(); const el = composerRef.current; if (el) el.selectionStart = el.selectionEnd = el.value.length })
  }

  const hasThread = messages.length > 0
  const visionModel = isVisionModel(model)
  const canRun = !!providerId && !!model && !running

  // Which document is shown: a pinned older version, else the latest.
  const shownMsg = useMemo(() => {
    if (selectedId) { const m = messages.find(x => x.id === selectedId); if (m?.html) return m }
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'assistant' && messages[i].html) return messages[i]
    return null
  }, [messages, selectedId])
  const shownHtml = shownMsg?.html ?? ''
  const shownCode = shownMsg?.code  // animation source (Remotion TSX or HyperFrames HTML)
  // HyperFrames comps register a GSAP timeline on window.__timelines; Remotion
  // comps define a `Composition`. MP4 export only supports the Remotion path in v1.
  const shownIsHyperframes = !!shownCode && /__timelines/.test(shownCode)
  const shownIsRemotion = !!shownCode && !shownIsHyperframes
  // The runnable doc: prefer the document the MAIN process already built — for
  // animations that's now the Babel-free, precompiled scaffold (fast to load).
  // BUT the stored html bakes the scaffold of the app version that generated it,
  // so sessions from before a scaffold improvement (audio pool, origin shim,
  // clip windows…) would replay the stale one forever — when the version stamp
  // is missing/old and we still have the composition source, rebuild live.
  const shownPlayable = useMemo(() => {
    if (shownCode && !(shownHtml && shownHtml.includes(DESIGN_SCAFFOLD_MARK))) {
      return shownIsHyperframes
        ? buildHyperframesPreviewHtml(shownCode, HYPERFRAMES_GSAP_URL)
        : buildRemotionHtml(shownCode)
    }
    return shownHtml
  }, [shownCode, shownHtml, shownIsHyperframes])

  // Live preview blob URL (avoids data: CSP issues in the sandboxed iframe).
  const previewUrl = useMemo(() => (shownPlayable ? URL.createObjectURL(new Blob([shownPlayable], { type: 'text/html' })) : null), [shownPlayable])
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl) }, [previewUrl])

  // ── WYSIWYG: click-to-edit text directly in the preview (HTML pages only) ──
  const [wysiwyg, setWysiwyg] = useState(false)
  const canWysiwyg = !!shownHtml && !shownCode
  // Latest shown doc — read by the editor's edit callback via refs so it never
  // goes stale as edits land.
  const shownHtmlRef = useRef(shownHtml); shownHtmlRef.current = shownHtml
  const shownMsgIdRef = useRef(shownMsg?.id); shownMsgIdRef.current = shownMsg?.id
  const wysiwygCleanup = useRef<(() => void) | null>(null)

  // Normal preview is served from tachi-preview:// (its OWN CSP runs the page's
  // inline scripts — incl. the Remotion <Player> bootstrap; a blob iframe would
  // inherit the strict renderer CSP and silently block them in packaged builds).
  // WYSIWYG keeps the same-origin blob path (parent edits via contentDocument).
  const [schemeSrc, setSchemeSrc] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    if (!shownPlayable || (wysiwyg && canWysiwyg)) { setSchemeSrc(null); return }
    const id = shownMsg?.id ?? 'live'
    let h = 0; for (let i = 0; i < shownPlayable.length; i++) h = (Math.imul(h, 31) + shownPlayable.charCodeAt(i)) | 0
    const v = (h >>> 0).toString(36)
    window.tachi.design.setPreview(id, shownPlayable)
      .then(() => { if (!cancelled) setSchemeSrc(`tachi-preview://doc/${encodeURIComponent(id)}?v=${v}`) })
      .catch(() => { if (!cancelled) setSchemeSrc(null) })
    return () => { cancelled = true }
  }, [shownPlayable, wysiwyg, canWysiwyg, shownMsg?.id])

  // ── Edit the code → live preview + persist (debounced) ────────────────────
  const editTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingEdit = useRef<{ id: string; value: string; isCode: boolean; hyperframes: boolean } | null>(null)
  function commitEdit() {
    const p = pendingEdit.current
    if (!p) return
    pendingEdit.current = null
    // Update the shown document → preview re-renders from the store. For an
    // animation, rebuild the playable html from the edited composition source
    // (Remotion scaffold, or HyperFrames preview wrapper).
    if (p.isCode) {
      const html = p.hyperframes ? buildHyperframesPreviewHtml(p.value, HYPERFRAMES_GSAP_URL) : buildRemotionHtml(p.value)
      updateMessageDoc(p.id, { code: p.value, html })
    } else {
      updateMessageDoc(p.id, { html: p.value })
    }
    // Best-effort: keep the on-disk file in sync with hand-edits.
    try {
      const st = useDesignStore.getState()
      const sess = st.sessions.find(x => x.id === st.activeId)
      const proj = st.projects.find(pp => pp.id === st.activeProjectId)?.name
      const ver = sess ? sess.messages.filter(mm => mm.role === 'assistant' && mm.html).length : 1
      const base = (sess?.title || 'design').replace(/[\\/:*?"<>|]/g, '-').slice(0, 60)
      const ext = p.isCode && !p.hyperframes ? 'tsx' : 'html'
      window.tachi.design.saveFile({ project: proj, name: `${base} v${ver}.${ext}`, content: p.value }).catch(() => {})
    } catch { /* persistence is best-effort */ }
  }
  function onEditChange(v: string) {
    if (!shownMsg) return
    const hyperframes = !!shownMsg.code && /__timelines/.test(shownMsg.code)
    pendingEdit.current = { id: shownMsg.id, value: v, isCode: !!shownMsg.code, hyperframes }
    if (editTimer.current) clearTimeout(editTimer.current)
    editTimer.current = setTimeout(commitEdit, 450)
  }
  // Flush any pending edit on unmount so a quick view-switch doesn't drop it.
  useEffect(() => () => { if (editTimer.current) clearTimeout(editTimer.current); commitEdit() }, [])

  // Apply an in-preview text edit onto the CLEAN source, then commit through the
  // same path as hand-edits (store + on-disk re-save). Reads refs so it stays
  // current as edits land.
  function onWysiwygEdit(index: number, text: string) {
    const id = shownMsgIdRef.current
    const html = shownHtmlRef.current
    if (!id || !html) return
    const next = applyTextEdit(html, index, text)
    if (!next) return
    // WYSIWYG only runs on static HTML pages (canWysiwyg = html && !code).
    pendingEdit.current = { id, value: next, isCode: false, hyperframes: false }
    commitEdit()
  }
  // (Re)attach the parent-side editor each time the WYSIWYG preview loads.
  function onPreviewLoad(e: React.SyntheticEvent<HTMLIFrameElement>) {
    wysiwygCleanup.current?.(); wysiwygCleanup.current = null
    if (!wysiwyg || !canWysiwyg) return
    const doc = e.currentTarget.contentDocument
    if (doc) wysiwygCleanup.current = attachWysiwygEditor(doc, onWysiwygEdit)
  }
  // Tear down the editor when WYSIWYG turns off or the page unmounts.
  useEffect(() => () => { wysiwygCleanup.current?.(); wysiwygCleanup.current = null }, [wysiwyg])

  // Stream deltas for the active request into the live code view.
  useEffect(() => {
    const off = window.tachi.design.onDelta(({ requestId, chunk }) => {
      if (requestId !== activeReqRef.current) return
      setStreamRaw(prev => prev + chunk)
    })
    return off
  }, [])

  useEffect(() => { threadEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages.length, running])
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 1800); return () => clearTimeout(t) }, [toast])
  // An unconfirmed destructive rewind lapses back to a safe button.
  useEffect(() => { if (!confirmRewindId) return; const t = setTimeout(() => setConfirmRewindId(null), 4000); return () => clearTimeout(t) }, [confirmRewindId])

  // Assistant version index (1-based) for the "Design vN" labels.
  const versionOf = useMemo(() => {
    const map = new Map<string, number>(); let n = 0
    for (const m of messages) if (m.role === 'assistant' && m.html) map.set(m.id, ++n)
    return map
  }, [messages])

  // First turn of a fresh thread with Interview on → ask questions, don't build yet.
  const willAsk = interview && !messages.some(m => m.role === 'assistant')

  // ── Send (discovery / generate / refine) ──────────────────────────────────
  // send() consumes the composer; sendText() is the raw path the interactive
  // interview card also drives (composed answers → build).
  async function send() { await sendText(prompt.trim()) }
  async function sendText(text: string) {
    if (!text || !canRun) return
    // Refine target depends on mode: a page refines the prior HTML; an animation
    // refines the prior composition source. It is the SHOWN version — pinning v2
    // and asking for a change must edit v2, not the latest (that mismatch used to
    // apply your edit to a document you were not even looking at).
    const prev = mode === 'animate' ? refineSourceCode(messages, selectedId) : refineSourceHtml(messages, selectedId)
    // Thread so far (the discovery Q&A / earlier asks) — threaded into the build.
    const history = messages.map(m => ({ role: m.role, text: m.text })).filter(h => h.text && h.text.trim())
    const isDiscovery = willAsk
    // Stamp the sent message with its attachment chips (ref image + context
    // items) so the thread always shows WHAT rode along with the request —
    // the composer chips alone left users unsure the file was actually sent.
    const attachLabels = [
      ...(visionModel && refImage ? [t('composer.imageChip')] : []),
      ...ctxItems.map(c => c.label),
    ]
    addUser(text, attachLabels); setPrompt(''); setSelectedId(null)
    const rid = uid(); activeReqRef.current = rid
    setRunning(true); setError(null); setStreamRaw('')

    // AUTO brand-from-URL: a URL in the prompt (or in an interview answer) is a
    // brand reference — pull the site's real palette/fonts/copy into context
    // BEFORE the interview/build sees it, no separate Extract click needed.
    let liveCtx = ctxItems
    const urlMatch = text.match(/https?:\/\/[^\s)"'<>\]]+/)
    if (urlMatch) {
      const url = urlMatch[0].replace(/[.,;:!?]+$/, '')
      const host = url.replace(/^https?:\/\//, '').split('/')[0]
      const covered = ctxItems.some(c => c.text.includes(host))
      if (!covered) {
        setToast(t('composer.brandAuto', { host }))
        try {
          const r = await window.tachi.design.extractBrand(url)
          if (r.ok && r.markdown && r.brand) {
            const item = { id: uid(), label: `⛭ ${r.brand.siteName}`.slice(0, 26), text: r.markdown }
            liveCtx = [...ctxItems, item]
            addCtxItem(item)
          }
        } catch { /* best-effort — the URL still reaches the model as text */ }
        setToast(null)
      }
    }
    const context = liveCtx.map(c => `### ${c.label}\n${c.text}`).join('\n\n')
    // DESIGN.md in the attached project folder is the team's design direction —
    // it rides in its own prompt slot (stronger than generic context), the way
    // Atlassian/google-labs treat the file. Root-level only.
    const designMd = liveCtx.map(c => extractDesignMd(c.text)).find(Boolean) || undefined
    const preset = presetId || undefined

    // DISCOVERY: return clarifying questions as an assistant turn; the user's next
    // message answers them and triggers the build (history carries the Q&A).
    if (isDiscovery) {
      setView('preview')
      try {
        const res = await window.tachi.design.clarify({
          providerId, model, prompt: text, mode,
          presetId: preset, designMd,
          refImage: visionModel && refImage ? refImage : undefined,
          context: context || undefined,
        })
        if (res.ok && res.questions) addAssistant(res.questions, undefined, undefined, res.structured ?? undefined)
        else addAssistant(t('msg.discoveryFailed', { detail: res.error ? ` (${res.error})` : '' }))
      } catch (e) {
        addAssistant(t('msg.tellMore'))
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (activeReqRef.current === rid) activeReqRef.current = ''
        setRunning(false)
      }
      return
    }

    setView('code')
    try {
      const res = await window.tachi.design.generate({
        requestId: rid, providerId, model, prompt: text, mode,
        engine: mode === 'animate' ? engine : undefined,
        presetId: preset, designMd,
        currentHtml: prev || undefined,
        refImage: visionModel && refImage ? refImage : undefined,
        context: context || undefined,
        history: history.length ? history : undefined,
      })
      if (res.ok) {
        const done = mode === 'animate'
          ? (prev ? t('msg.updatedAnimation') : t('msg.hereAnimation'))
          : (prev ? t('msg.updatedPage') : t('msg.herePage'))
        addAssistant(done, res.html, res.code)
        // Stamp the session with what it builds so reopening it restores the
        // right PAGE/ANIMATE + engine toggles.
        useDesignStore.getState().setSessionKind(mode, mode === 'animate' ? engine : undefined)
        setRefImage(null); setView('preview')
        // Auto-save to the active project's on-disk folder (best-effort).
        const st = useDesignStore.getState()
        const sess = st.sessions.find(x => x.id === st.activeId)
        const proj = st.projects.find(p => p.id === st.activeProjectId)?.name
        const ver = sess ? sess.messages.filter(mm => mm.role === 'assistant' && mm.html).length : 1
        const base = (sess?.title || 'design').replace(/[\\/:*?"<>|]/g, '-').slice(0, 60)
        if (mode === 'animate' && res.code) {
          window.tachi.design.saveFile({ project: proj, name: `${base} v${ver}.tsx`, content: res.code }).catch(() => {})
          window.tachi.design.saveFile({ project: proj, name: `${base} v${ver}.html`, content: buildRemotionHtml(res.code) }).catch(() => {})
        } else if (res.html) {
          window.tachi.design.saveFile({ project: proj, name: `${base} v${ver}.html`, content: res.html }).catch(() => {})
        }
      } else if (!res.aborted) {
        // Gateway timeouts come back as a raw HTML page — replace that noise
        // with an actionable one-liner (the auto-retry already ran 3 attempts).
        const friendly = res.error && /<html|gateway time-?out|\b50[24]\b/i.test(res.error)
          ? t('msg.gatewayTimeout')
          : res.error
        setError(friendly); addAssistant(t('msg.error', { error: friendly })); setView(prev ? 'preview' : 'code')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (activeReqRef.current === rid) activeReqRef.current = ''
      setRunning(false)
    }
  }

  function stop() {
    if (activeReqRef.current) window.tachi.design.abort(activeReqRef.current).catch(() => {})
    activeReqRef.current = ''
    setRunning(false)
  }
  function newThread() {
    if (running) stop()
    newSession(); setShowSessions(false); setSelectedId(null); setError(null); setStreamRaw(''); setPrompt(''); setRefImage(null); setView('preview')
  }
  function exportHtml() {
    if (!shownPlayable) return
    const url = URL.createObjectURL(new Blob([shownPlayable], { type: 'text/html' }))
    const a = document.createElement('a'); a.href = url; a.download = `tachi-design-${Date.now()}.html`
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000)
  }
  // Export quality target: 1080p default, 2K/4K selectable (both engines scale
  // by re-rendering, not pixel upscale).
  const [exportRes, setExportRes] = useState<1080 | 1440 | 2160>(1080)
  // Ask ONCE what the encoder situation is. Cheap (two statSync in main) and it
  // decides which of two buttons the user sees, so it must land before the first
  // paint of the toolbar rather than after a click.
  useEffect(() => {
    let alive = true
    void window.tachi.design.encoderState()
      .then(st => { if (alive) setEncoder({ installed: st.installed || st.fromDevTree, approxBytes: st.approxBytes }) })
      .catch(() => { if (alive) setEncoder({ installed: false, approxBytes: null }) })
    return () => { alive = false }
  }, [])

  /** Fetch the official encoder, on an explicit click and never otherwise. */
  async function installEncoder() {
    if (encoderMsg) return
    setEncoderMsg(t('artifact.encoderInstalling', { percent: 0 }))
    const off = window.tachi.design.onEncoderProgress(p => {
      setEncoderMsg(t('artifact.encoderInstalling', { percent: Math.max(0, Math.round(p.percent)) }))
    })
    try {
      const r = await window.tachi.design.installEncoder()
      if (r.ok) {
        setEncoder({ installed: true, approxBytes: null })
        setToast(t('artifact.encoderReady'))
      } else {
        setToast(r.error ?? t('artifact.encoderFailed'))
      }
    } catch (e) {
      setToast(e instanceof Error ? e.message : t('artifact.encoderFailed'))
    } finally {
      off(); setEncoderMsg(null)
    }
  }

  // Export the shown animation to a real H.264 MP4 via the managed Chromium +
  // Remotion renderer (frame-accurate — replaces lossy screen capture). First
  // run downloads Chromium; progress (incl. that download) streams onto the button.
  async function exportMp4() {
    if (!shownCode || renderMsg) return
    setRenderMsg(t('render.starting'))
    const off = window.tachi.design.onRenderProgress(p => {
      const pct = typeof p.percent === 'number' && p.percent >= 0 ? ` ${p.percent}%` : ''
      setRenderMsg(`${p.message}${pct}`)
    })
    try {
      const r = await window.tachi.design.renderMp4({ code: shownCode, name: activeProject?.name || 'animation', targetHeight: exportRes })
      setToast(r.ok ? t('toast.mp4Exported') : (r.error ?? t('toast.exportFailed')))
    } catch (e) {
      setToast(e instanceof Error ? e.message : t('toast.exportFailed'))
    } finally {
      off(); setRenderMsg(null)
    }
  }
  // Export a page design to PNG or PDF (hidden BrowserWindow capture — free, instant).
  async function exportImage(format: 'png' | 'pdf') {
    if (!shownHtml || renderMsg) return
    setRenderMsg(format === 'pdf' ? 'Exporting PDF…' : 'Exporting PNG…')
    try {
      const r = await window.tachi.design.exportImage({ html: shownHtml, name: activeProject?.name || 'design', format })
      setToast(r.ok ? t('toast.imgExported', { format: format.toUpperCase() }) : (r.error ?? t('toast.exportFailed')))
    } catch (e) {
      setToast(e instanceof Error ? e.message : t('toast.exportFailed'))
    } finally {
      setRenderMsg(null)
    }
  }
  async function copyCode() {
    // Copy the source: composition code for animations, HTML for pages.
    const text = shownCode ?? shownHtml
    if (!text) return
    try { await navigator.clipboard.writeText(text); setToast(t('toast.copied')) } catch { setToast(t('toast.copyFailed')) }
  }
  function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; e.target.value = '' // allow re-picking the same file
    if (!file) return
    const r = new FileReader(); r.onload = () => setRefImage(typeof r.result === 'string' ? r.result : null); r.readAsDataURL(file)
  }

  // Dropped / attached files: images → reference image; video/audio/gif →
  // design ASSET (copied into DesignAssets, referenced as assets/<name>);
  // text/code → context the model designs for. Capped per file so a big paste
  // can't blow up the prompt. NOTHING is dropped silently — an unsupported
  // file always surfaces an error naming it (a video that vanished with no
  // trace is exactly the bug this replaced).
  const TEXT_EXT = ['.md', '.txt', '.json', '.js', '.jsx', '.ts', '.tsx', '.css', '.scss', '.html', '.vue', '.svelte', '.py', '.go', '.rs', '.yml', '.yaml', '.toml', '.csv', '.xml']
  const MEDIA_EXT = ['.mp4', '.webm', '.mov', '.m4v', '.gif', '.mp3', '.wav', '.m4a', '.ogg']
  async function attachMediaAsset(f: File) {
    // Preferred: hand main the absolute path (zero-copy). Electron 32+ removed
    // File.path, so this goes through the webUtils preload bridge; a synthetic
    // File (no disk backing) falls back to sending the bytes (capped in main).
    const path = window.tachi.files?.pathFor?.(f) || ''
    const payload = path ? { path } : { name: f.name, bytes: await f.arrayBuffer() }
    const r = await window.tachi.design.addAsset(payload)
    if (!r.ok) { setError(t('errors.assetFailed', { name: f.name, error: r.error, defaultValue: '{{name}}: {{error}}' })); return }
    const meta = await probeMediaMeta(f)
    // Vision models get a mid-clip poster frame as the reference image so the
    // model SEES the footage it is designing around (same slot as + Image).
    if (visionModel && f.type.startsWith('video/') && !refImage) {
      const poster = await videoPosterFrame(f)
      if (poster) setRefImage(poster)
    }
    const mime = f.type || 'application/octet-stream'
    addCtxItem({ id: uid(), label: assetChipLabel(r.name, meta), text: buildAssetPromptBlock(r.name, mime, meta) })
    setToast(t('composer.assetAdded', { name: r.name, defaultValue: 'Attached {{name}} — the page will reference assets/{{name}}' }))
  }
  /** Open a dropped/picked FULL HTML document AS the current design: it becomes
   *  the latest assistant version of the active session (a fresh one when there
   *  is none), so preview, WYSIWYG, refine and every export work on it for free. */
  function openHtmlAsDesign(name: string, content: string) {
    const st = useDesignStore.getState()
    if (!st.activeId || !st.sessions.some(x => x.id === st.activeId)) {
      // addAssistant only writes into an EXISTING active session — seed one.
      st.addUser(t('dropOpen.seedUser', { name }))
    }
    st.addAssistant(t('dropOpen.seedAssistant', { name }), content)
    st.setSessionKind('page')
    setMode('page'); setSelectedId(null); setView('preview'); setError(null)
    setToast(t('dropOpen.opened', { name }))
  }
  /** Today's behaviour: the file rides along as trimmed prompt context. */
  function attachHtmlAsContext(name: string, content: string) {
    addCtxItem({ id: uid(), label: name, text: content.slice(0, 6000) })
  }
  function resolvePendingHtml(id: string, choice: 'open' | 'attach') {
    const item = pendingHtml.find(p => p.id === id)
    setPendingHtml(list => list.filter(p => p.id !== id))
    if (!item) return
    if (choice === 'open') openHtmlAsDesign(item.name, item.content)
    else attachHtmlAsContext(item.name, item.content)
  }
  async function addFiles(files: File[]) {
    const additions: { id: string; label: string; text: string }[] = []
    const docs: { id: string; name: string; content: string }[] = []
    for (const f of files) {
      const ext = `.${(f.name.split('.').pop() || '').toLowerCase()}`
      // A complete HTML document is ambiguous: it can be a DESIGN to open and
      // keep iterating on, or reference material for the next prompt. Ask.
      if (ext === '.html' || ext === '.htm') {
        let text = ''
        try { text = await f.text() } catch { continue }
        if (looksLikeFullHtmlDocument(text)) {
          if (text.length > DESIGN_PREVIEW_MAX_CHARS) {
            // The preview channel refuses documents over 8 MB — attaching is the
            // only honest option, and the toast says why.
            additions.push({ id: uid(), label: f.name, text: text.slice(0, 6000) })
            setToast(t('dropOpen.tooBig', { name: f.name, cap: '8 MB' }))
          } else {
            docs.push({ id: uid(), name: f.name, content: text })
          }
        } else {
          additions.push({ id: uid(), label: f.name, text: text.slice(0, 6000) })
        }
        continue
      }
      if (f.type.startsWith('image/') && ext !== '.gif') {
        if (!visionModel) { setError(t('errors.visionModel')); continue }
        const dataUrl = await new Promise<string>(res => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(f) })
        setRefImage(dataUrl); continue
      }
      if (f.type.startsWith('video/') || f.type.startsWith('audio/') || MEDIA_EXT.includes(ext)) {
        try { await attachMediaAsset(f) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
        continue
      }
      if (!(f.type.startsWith('text/') || f.type === 'application/json' || TEXT_EXT.includes(ext))) {
        setError(t('errors.fileUnsupported', { name: f.name, defaultValue: '{{name}}: unsupported file type — attach images, video/audio, or text/code files' }))
        continue
      }
      try { additions.push({ id: uid(), label: f.name, text: (await f.text()).slice(0, 6000) }) } catch { /* unreadable */ }
    }
    additions.forEach(addCtxItem)
    if (docs.length) setPendingHtml(list => [...list, ...docs])
  }
  async function pickFolder() {
    try {
      const r = await window.tachi.design.pickFolder()
      if (r.ok && r.context) {
        const name = (r.folder ?? 'folder').split(/[\\/]/).filter(Boolean).pop() ?? 'folder'
        addCtxItem({ id: uid(), label: `${name}/ (${r.fileCount} files)`, text: r.context! })
      } else if (r.error && r.error !== 'cancelled') {
        setError(r.error)
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  // Brand-from-URL: harvest a site's real design tokens and drop the markdown
  // brand direction in as a context chip the generation prompt already reads.
  // NOTE: window.prompt() is unsupported in Electron (throws) — the old code
  // died silently on click, so this is an inline URL input instead.
  const [brandBusy, setBrandBusy] = useState(false)
  const [brandOpen, setBrandOpen] = useState(false)
  const [brandUrl, setBrandUrl]   = useState('')
  // Pasting a URL starts extraction on its own — the Extract button stays as a
  // manual trigger for slow typists, but the paste path needs zero clicks.
  useEffect(() => {
    if (!brandOpen || brandBusy) return
    const u = brandUrl.trim()
    if (!/^https?:\/\/\S+\.\S{2,}/.test(u)) return
    const timer = setTimeout(() => { void extractBrand(u) }, 700)
    return () => clearTimeout(timer)
  }, [brandUrl, brandOpen]) // eslint-disable-line react-hooks/exhaustive-deps
  async function extractBrand(url: string) {
    const u = url.trim()
    if (!u || brandBusy) return
    setBrandBusy(true); setError(null)
    try {
      const r = await window.tachi.design.extractBrand(u)
      if (r.ok && r.markdown && r.brand) {
        addCtxItem({ id: uid(), label: `⛭ ${r.brand!.siteName}`.slice(0, 26), text: r.markdown! })
        setBrandOpen(false); setBrandUrl('')
      } else {
        setError(r.error ?? t('composer.brandFailed'))
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBrandBusy(false) }
  }
  /** Attach a folder the user DROPPED onto the composer — the app reads it off
   *  disk (design:read-folder) so the generator designs in that codebase's real
   *  style. Plain files still go through addFiles(); folders never reach it. */
  async function addFolder(folderPath: string) {
    try {
      const r = await window.tachi.design.readFolder(folderPath)
      if (r.ok && r.context) {
        const name = folderPath.split(/[\\/]/).filter(Boolean).pop() ?? 'folder'
        addCtxItem({ id: uid(), label: `${name}/ (${r.fileCount} files)`, text: r.context! })
      } else if (r.error && r.error !== 'cancelled') { setError(r.error) }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setDragOver(false)
    const items = Array.from(e.dataTransfer.items ?? [])
    const files = Array.from(e.dataTransfer.files ?? [])
    // A dropped DIRECTORY reports isDirectory via webkitGetAsEntry; its path is
    // on the aligned File (Electron exposes File.path). Route folders to the FS
    // reader, everything else to addFiles().
    const folderIdx = new Set<number>()
    items.forEach((it, i) => {
      const entry = (it as unknown as { webkitGetAsEntry?: () => { isDirectory?: boolean } | null }).webkitGetAsEntry?.()
      if (entry?.isDirectory) {
        // Electron 32+ removed File.path — resolve via the webUtils preload
        // bridge (the old `.path` read returned undefined and folder drops
        // silently did nothing).
        const p = window.tachi.files?.pathFor?.(files[i]) || (files[i] as unknown as { path?: string })?.path
        if (p) { folderIdx.add(i); void addFolder(p) }
      }
    })
    const plain = files.filter((_, i) => !folderIdx.has(i))
    if (plain.length) void addFiles(plain)
  }

  // ── Composer (shared by hero + thread) ────────────────────────────────────
  // A DESIGN.md at the root of the attached folder is picked up automatically and
  // sent in its own prompt slot — the chip is how you know it landed.
  const designMdAttached = useMemo(() => ctxItems.some(c => !!extractDesignMd(c.text)), [ctxItems])
  // Which version a refine will edit (the pinned one, else the latest).
  const pinnedVersion = selectedId ? versionOf.get(selectedId) : undefined
  const attachChips = (ctxItems.length > 0 || refImage || designMdAttached) ? (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {refImage && <span style={ctxChip}>{t('composer.imageChip')}<button onClick={() => setRefImage(null)} style={xBtn}>×</button></span>}
      {designMdAttached && (
        <span style={ctxChip} data-testid="design-md-chip" title={t('composer.designMdTitle')}>
          {t('composer.designMdChip')}
        </span>
      )}
      {ctxItems.map(c => (
        <span key={c.id} style={ctxChip} title={c.label}>
          {c.label.length > 24 ? `${c.label.slice(0, 22)}…` : c.label}
          <button onClick={() => removeCtxItem(c.id)} style={xBtn}>×</button>
        </span>
      ))}
    </div>
  ) : null

  const composer = (
    <div
      data-tour="design-composer"
      onDragOver={e => { e.preventDefault(); if (!dragOver) setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      style={{ display: 'flex', flexDirection: 'column', gap: 8, outline: dragOver ? '2px dashed var(--accent)' : 'none', outlineOffset: 4 }}
    >
      {attachChips}
      {/* Dropped a complete HTML document → open it as a design, or keep it as
          context. Inline (no modal) so the drop never blocks the composer. */}
      {pendingHtml.map(p => (
        <div key={p.id} data-testid="design-html-choice" style={{
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '6px 8px',
          border: '2px solid var(--accent)', background: 'var(--accent-muted)',
        }}>
          <span style={{ fontSize: 11, color: 'var(--text-primary)', flex: 1, minWidth: 160 }}>
            {t('dropOpen.title', { name: p.name })}
          </span>
          <button data-testid="design-html-open" onClick={() => resolvePendingHtml(p.id, 'open')}
            style={{ ...chip, borderColor: 'var(--accent)', color: 'var(--accent-text)', fontWeight: 700 }}
            title={t('dropOpen.openTitle')}>{t('dropOpen.open')}</button>
          <button data-testid="design-html-attach" onClick={() => resolvePendingHtml(p.id, 'attach')}
            style={chip} title={t('dropOpen.attachTitle')}>{t('dropOpen.attach')}</button>
        </div>
      ))}
      <textarea
        ref={composerRef}
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() } }}
        placeholder={pinnedVersion ? t('composer.placeholderEditingV', { n: pinnedVersion }) : hasThread ? t('composer.placeholderChange') : t('composer.placeholderNew')}
        rows={hasThread ? 3 : 4}
        style={{
          width: '100%', boxSizing: 'border-box', resize: 'vertical', padding: 10,
          border: '2px solid var(--border)', background: 'var(--bg-inset)', color: 'var(--text-primary)',
          fontFamily: 'JetBrains Mono, monospace', fontSize: 13, lineHeight: 1.5, outline: 'none',
        }}
      />
      {/* Inline Brand-URL input — visible feedback instead of the (unsupported) window.prompt. */}
      {brandOpen && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            autoFocus
            value={brandUrl}
            onChange={e => setBrandUrl(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') void extractBrand(brandUrl)
              if (e.key === 'Escape') { setBrandOpen(false); setBrandUrl('') }
            }}
            placeholder={t('composer.brandPrompt')}
            style={{
              flex: 1, padding: '6px 8px', border: '2px solid var(--accent)', background: 'var(--bg-inset)',
              color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, outline: 'none',
            }}
          />
          <button onClick={() => void extractBrand(brandUrl)} disabled={brandBusy || !brandUrl.trim()} style={{ ...chip, borderColor: 'var(--accent)', color: 'var(--accent-text)' }}>
            {brandBusy ? t('composer.brandBusy') : t('composer.brandGo')}
          </button>
          <button onClick={() => { setBrandOpen(false); setBrandUrl('') }} style={chip} title={t('composer.brandClose')}>✕</button>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <label style={chip} title={t('composer.filesTitle')}>
          {t('composer.files')}
          <input type="file" multiple onChange={e => { const f = Array.from(e.target.files ?? []); if (f.length) void addFiles(f); e.currentTarget.value = '' }} style={{ display: 'none' }} />
        </label>
        <button onClick={pickFolder} style={chip} title={t('composer.folderTitle')}>{t('composer.folder')}</button>
        {/* Brand preset — 10 curated design systems (core presets.ts) rendered
            into the system prompt, so the output is DESIGNED, not generic. */}
        <select
          value={presetId}
          onChange={e => setPreset(e.target.value)}
          data-testid="design-preset"
          aria-label={t('composer.presetTitle')}
          title={BRAND_PRESETS.find(p => p.id === presetId)?.description ?? t('composer.presetTitle')}
          style={{ ...chip, padding: '4px 6px', maxWidth: 190, ...(presetId ? { borderColor: 'var(--accent)', color: 'var(--accent-text)', background: 'var(--accent-muted)' } : {}) }}
        >
          <option value="">{t('composer.presetNone')}</option>
          {BRAND_PRESETS.map(p => <option key={p.id} value={p.id}>{`${t('composer.preset')}: ${p.label}`}</option>)}
        </select>
        <button
          onClick={() => setBrandOpen(v => !v)}
          disabled={brandBusy}
          data-testid="design-brand-url"
          data-tour="design-brand"
          style={{ ...chip, ...(brandOpen ? { borderColor: 'var(--accent)', color: 'var(--accent-text)', background: 'var(--accent-muted)' } : {}) }}
          title={t('composer.brandTitle')}
        >{brandBusy ? t('composer.brandBusy') : t('composer.brand')}</button>
        <label style={{ ...chip, opacity: visionModel ? 1 : 0.45, cursor: visionModel ? 'pointer' : 'not-allowed' }} title={visionModel ? t('composer.imageTitleOn') : t('composer.imageTitleOff')}>
          {t('composer.image')}
          <input type="file" accept="image/*" disabled={!visionModel} onChange={onPickImage} style={{ display: 'none' }} />
        </label>
        <button
          onClick={() => setInterview(v => !v)}
          style={{ ...chip, ...(interview ? { borderColor: 'var(--accent)', color: 'var(--accent-text)', background: 'var(--accent-muted)' } : {}) }}
          title={t('composer.interviewTitle')}
        >{interview ? `✓ ${t('composer.interview')}` : t('composer.interview')}</button>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>⌘/Ctrl+Enter</span>
        {running
          ? <button onClick={stop} style={{ ...primaryBtn, background: 'var(--destructive, #c0392b)', border: '2px solid var(--destructive, #c0392b)' }}>{t('composer.stop')}</button>
          : <button onClick={send} disabled={!canRun || !prompt.trim()} style={primaryBtn} title={willAsk ? t('composer.askTitle') : undefined}>{willAsk ? t('composer.ask') : hasThread ? t('composer.send') : t('composer.generate')}</button>}
      </div>
      {error && (
        <div style={{ padding: 8, border: '2px solid var(--destructive, #c0392b)', background: 'color-mix(in srgb, var(--destructive, #c0392b) 12%, transparent)', color: 'var(--text-primary)', fontSize: 11, lineHeight: 1.5 }}>{friendlyError(t, error).title}</div>
      )}
    </div>
  )

  const providerBar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <div data-tour="design-mode" style={{ display: 'flex', border: '2px solid var(--border)' }} title={t('mode.title')}>
        {(['page', 'animate'] as const).map(md => (
          <button key={md} onClick={() => setMode(md)} style={{ ...toggleBtn, padding: '5px 10px', background: mode === md ? 'var(--accent-muted)' : 'transparent', color: mode === md ? 'var(--accent-text)' : 'var(--text-muted)', fontWeight: mode === md ? 700 : 400 }}>{t(`mode.${md}`)}</button>
        ))}
      </div>
      {mode === 'animate' && (
        <div style={{ display: 'flex', border: '2px solid var(--border)' }} title={t('engine.title')}>
          {(['remotion', 'hyperframes'] as const).map(en => (
            <button key={en} onClick={() => setEngine(en)}
              style={{ ...toggleBtn, padding: '5px 10px', background: engine === en ? 'var(--accent-muted)' : 'transparent', color: engine === en ? 'var(--accent-text)' : 'var(--text-muted)', fontWeight: engine === en ? 700 : 400 }}>
              {t(`engine.${en}`)}
            </button>
          ))}
        </div>
      )}
      {mode === 'animate' && engine === 'remotion' && (
        <button onClick={() => setShowVo(v => !v)} title={t('voiceover.title')}
          style={{ ...toggleBtn, padding: '5px 10px', border: '2px solid var(--border)', background: showVo ? 'var(--accent-muted)' : 'transparent', color: showVo ? 'var(--accent-text)' : 'var(--text-muted)', fontWeight: showVo ? 700 : 400 }}>
          {t('voiceover.button')} {showVo ? '▴' : '▾'}
        </button>
      )}
      {mode === 'animate' && engine === 'remotion' && showVo && (
        <div style={{ flexBasis: '100%', border: '2px solid var(--border)', background: 'var(--bg-elevated)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 9, letterSpacing: '0.08em', color: 'var(--text-dim)', textTransform: 'uppercase', flex: 1 }}>{t('voiceover.title')}</div>
            {/* Sounds, not just voice: import wav/mp3 SFX or music — compositions
                score with them via staticFile just like synthesized VO. */}
            <label style={{ ...chip, opacity: voBusy ? 0.6 : 1 }} title={t('audio.importTitle')}>
              {t('audio.import')}
              <input type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac" disabled={voBusy}
                onChange={e => { const f = e.target.files?.[0]; e.currentTarget.value = ''; void importAudioFile(f) }}
                style={{ display: 'none' }} />
            </label>
          </div>
          {voVoices.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-muted)' }}>
              {t('voiceover.noVoices')}
              <button style={chip} onClick={() => window.dispatchEvent(new CustomEvent('tachi:toast', { detail: { kind: 'info', text: t('voiceover.installTts') } }))}>{t('voiceover.installTts')}</button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select value={voVoice} onChange={e => setVoVoice(e.target.value)} style={selectStyle} title={t('voiceover.voice')}>
                {voVoices.some(v => v.engine === 'kokoro') && (
                  <optgroup label={t('voiceover.groupStudio')}>
                    {voVoices.filter(v => v.engine === 'kokoro').map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
                  </optgroup>
                )}
                {voVoices.some(v => v.engine === 'piper') && (
                  <optgroup label={t('voiceover.groupPiper')}>
                    {voVoices.filter(v => v.engine === 'piper').map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
                  </optgroup>
                )}
              </select>
              <input value={voText} onChange={e => setVoText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && voText.trim() && !voBusy) { void synthesizeVoLine() } }}
                placeholder={t('voiceover.placeholder')}
                style={{ ...selectStyle, flex: 1, minWidth: 220 }} />
              <button onClick={() => void synthesizeVoLine()} disabled={voBusy || !voText.trim()}
                style={{ ...chip, background: 'var(--accent)', color: '#fff', opacity: voBusy || !voText.trim() ? 0.6 : 1 }}>
                {voBusy ? t('voiceover.busy') : t('voiceover.synthesize')}
              </button>
            </div>
          )}
          {voFiles.length > 0 && (
            <>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t('voiceover.files')}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {voFiles.slice(0, 12).map(f => (
                  <button key={f.name} style={chip}
                    title={t('voiceover.copy')}
                    onClick={() => { navigator.clipboard.writeText(`staticFile('${f.name}')`).catch(() => {}); setVoCopied(f.name); setTimeout(() => setVoCopied(null), 1500) }}>
                    {voCopied === f.name ? t('voiceover.copied') : f.name}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{t('voiceover.hint')}</div>
            </>
          )}
        </div>
      )}
      <select value={providerId} onChange={e => setProvider(e.target.value)} style={selectStyle}>
        {providers.length === 0 && <option value="">{privateMode ? t('provider.noLocal') : t('provider.none')}</option>}
        {providers.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      <select value={model} onChange={e => setModel(e.target.value)} style={{ ...selectStyle, minWidth: 200 }} disabled={models.length === 0}>
        {models.length === 0 && <option value="">{modelsLoading ? t('provider.loading') : t('provider.noModels')}</option>}
        {models.map(m => <option key={m.id} value={m.id}>{modelOptionLabel(m)}</option>)}
      </select>
    </div>
  )

  const projectBar = renamingProject ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input autoFocus value={projName} onChange={e => setProjName(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && projName.trim() && activeProjectId) { renameProject(activeProjectId, projName.trim()); setRenamingProject(false) }
          if (e.key === 'Escape') setRenamingProject(false)
        }}
        placeholder={t('project.namePlaceholder')} style={{ ...selectStyle, minWidth: 140 }} />
      <button onClick={() => { if (projName.trim() && activeProjectId) renameProject(activeProjectId, projName.trim()); setRenamingProject(false) }} style={chip}>{t('project.ok')}</button>
    </div>
  ) : (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{t('project.label')}</span>
      <select
        value={activeProjectId ?? ''}
        onChange={e => { if (e.target.value === '__new') newProject(t('project.defaultName', { n: projects.length + 1 })); else setActiveProject(e.target.value) }}
        style={selectStyle} title={t('project.title')}>
        {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        <option value="__new">{t('project.new')}</option>
      </select>
      <button onClick={() => { setProjName(activeProject?.name ?? ''); setRenamingProject(true) }} style={chip} title={t('project.renameTitle')}>✎</button>
      <button onClick={() => window.tachi.design.reveal(activeProject?.name).then(r => setToast(r.ok ? t('toast.openedFolder') : (r.error ?? t('toast.failed'))))} style={chip} title={t('project.openFolderTitle', { dir: baseDir || '…' })}>{t('project.folderBtn')}</button>
      <button onClick={async () => { const r = await window.tachi.design.setBase(); if (r.ok && r.baseDir) { setBaseDir(r.baseDir); setToast(t('toast.saveTo', { dir: r.baseDir })) } }} style={chip} title={t('project.setFolderTitle', { dir: baseDir || '…' })}>{t('project.setFolderBtn')}</button>
    </div>
  )

  const sessionsList = (onPick?: () => void) => (
    <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 220, overflowY: 'auto', border: '2px solid var(--border)', background: 'var(--bg-inset)' }}>
      {sessions.length === 0 && <div style={{ padding: 8, fontSize: 11, color: 'var(--text-dim)' }}>{t('sessions.none')}</div>}
      {sessions.map(s => {
        const shots = s.messages.filter(m => m.role === 'assistant' && m.html).length
        return (
          <div key={s.id}
            onClick={() => { loadSession(s.id); setSelectedId(null); setView('preview'); onPick?.() }}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', cursor: 'pointer',
              borderLeft: `3px solid ${s.id === activeId ? 'var(--accent)' : 'transparent'}`,
              background: s.id === activeId ? 'var(--accent-muted)' : 'transparent',
            }}>
            <span style={{ flex: 1, fontSize: 11, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.title}>{s.title}</span>
            {(() => {
              const k = sessionKind(s)
              return k ? (
                <span style={{
                  fontSize: 8, fontWeight: 700, letterSpacing: '0.06em', flexShrink: 0,
                  color: k.mode === 'animate' ? 'var(--accent-text)' : 'var(--text-dim)',
                  border: `1px solid ${k.mode === 'animate' ? 'var(--accent)' : 'var(--border)'}`,
                  padding: '0 4px', textTransform: 'uppercase',
                }} title={k.engine ?? k.mode}>
                  {k.mode === 'animate' ? t('sessions.kindAnim') : t('sessions.kindPage')}
                </span>
              ) : null
            })()}
            {shots > 0 && <span style={{ fontSize: 9, color: 'var(--text-dim)' }} title={t('sessions.versionsTitle', { count: shots })}>{shots}×</span>}
            <button onClick={(e) => { e.stopPropagation(); deleteSession(s.id) }} title={t('sessions.deleteTitle')} style={{ ...chip, padding: '1px 6px' }}>×</button>
          </div>
        )
      })}
    </div>
  )

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', fontFamily: 'JetBrains Mono, monospace' }}>
      <PageTopbar section="Design" />

      {!hasThread ? (
        // Empty state — centered hero composer (Claude Design "what do you want to build").
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'var(--bg-base)' }}>
          <div style={{ width: '100%', maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontFamily: 'Space Grotesk, sans-serif', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', color: 'var(--text-primary)' }}>TACHI DESIGN</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.6 }}>
                {mode === 'animate' ? t('hero.subtitleAnimate') : t('hero.subtitlePage')}
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: 8 }}>{projectBar}{providerBar}</div>
            {composer}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
              {(mode === 'animate' ? ANIM_EXAMPLE_KEYS : EXAMPLE_KEYS).map((key) => {
                const ex = t(key)
                return <button key={key} onClick={() => setPrompt(ex)} title={ex} style={{ ...chip, maxWidth: 280, textAlign: 'left', whiteSpace: 'normal' }}>{ex}</button>
              })}
            </div>
            {sessions.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={sectionLabel}>{t('hero.recentDesigns')}</div>
                {sessionsList()}
              </div>
            )}
          </div>
        </div>
      ) : (
        // Working state — chat thread (left) + live artifact (right).
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* LEFT: conversation */}
          <div style={{ width: threadPane.width, flexShrink: 0, borderRight: '2px solid var(--border)', background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ borderBottom: '2px solid var(--border)' }}>
              <div style={{ padding: '8px 12px 0', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>{projectBar}</div>
              <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <button onClick={() => setShowSessions(v => !v)} style={chip} title={t('sessions.prevTitle')}>{t('sessions.button', { count: sessions.length })} {showSessions ? '▴' : '▾'}</button>
                <span style={{ flex: 1 }} />
                <button onClick={newThread} style={chip} title={t('sessions.newTitle')}>{t('sessions.new')}</button>
              </div>
              {showSessions && <div style={{ padding: '0 12px 8px' }}>{sessionsList(() => setShowSessions(false))}</div>}
              <div style={{ padding: '0 12px 8px' }}>{providerBar}</div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {messages.map(m => {
                if (m.role === 'user') {
                  return (
                    <div key={m.id} style={{ alignSelf: 'flex-end', maxWidth: '92%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                      <div style={{ padding: '8px 10px', border: '2px solid var(--accent)', background: 'var(--accent-muted)', color: 'var(--text-primary)', fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                        {m.text}
                      </div>
                      {(m.attachments?.length ?? 0) > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: 'flex-end' }}>
                          {m.attachments!.map((a, i) => (
                            <span key={i} title={t('thread.sentWith', { defaultValue: 'Sent with this message' })} style={{
                              fontSize: 9, padding: '1px 6px', border: '1px solid var(--border)',
                              color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace',
                            }}>⌀ {a.length > 26 ? `${a.slice(0, 24)}…` : a}</span>
                          ))}
                        </div>
                      )}
                      {/* Destructive: deletes this turn and everything after it,
                          so it takes a second, explicit click. */}
                      <button
                        onClick={() => { if (confirmRewindId === m.id) rewindEdit(m.id); else setConfirmRewindId(m.id) }}
                        title={confirmRewindId === m.id ? t('thread.editConfirmTitle') : t('thread.editTitle')}
                        data-testid="design-rewind"
                        style={{ ...chip, padding: '1px 6px', fontSize: 9, ...(confirmRewindId === m.id ? { borderColor: 'var(--destructive, #c0392b)', color: 'var(--text-primary)', fontWeight: 700 } : {}) }}
                      >↺ {confirmRewindId === m.id ? t('thread.editConfirm') : t('thread.edit')}</button>
                    </div>
                  )
                }
                const v = versionOf.get(m.id)
                const isShown = m.html ? (selectedId ? selectedId === m.id : v === versionOf.size) : false
                // Discovery questions render as an INTERACTIVE card (option chips)
                // while they're the live turn; afterwards they collapse to text.
                if (m.interview && m.interview.length > 0 && !m.html) {
                  const isLive = messages[messages.length - 1]?.id === m.id && !running
                  if (isLive) {
                    return (
                      <InterviewCard
                        key={m.id}
                        questions={m.interview}
                        disabled={!canRun}
                        onSubmit={(answers) => void sendText(answers)}
                      />
                    )
                  }
                }
                return (
                  <div
                    key={m.id}
                    onClick={() => { if (m.html) { setSelectedId(m.id); setView('preview') } }}
                    style={{
                      alignSelf: 'flex-start', maxWidth: '92%', padding: '8px 10px',
                      border: `2px solid ${isShown ? 'var(--accent)' : 'var(--border)'}`,
                      background: isShown ? 'var(--accent-muted)' : 'var(--bg-elevated)',
                      color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5,
                      cursor: m.html ? 'pointer' : 'default',
                    }}
                  >
                    {m.html ? <><strong style={{ color: 'var(--text-primary)' }}>● {t('thread.designV', { n: v })}</strong> — {m.text} {isShown && <span style={{ fontSize: 9, color: 'var(--accent-text)' }}>{t('thread.showing')}</span>}</> : m.text}
                    {/* Restore = git revert, not rewind: vN's document is appended
                        as a NEW version and nothing in the tail is deleted. */}
                    {m.html && v !== versionOf.size && (
                      <button
                        data-testid="design-restore"
                        onClick={e => {
                          e.stopPropagation()
                          restoreVersion(m.id, t('thread.restoredV', { n: v }))
                          setSelectedId(null); setView('preview'); setToast(t('thread.restoredToast', { n: v }))
                        }}
                        title={t('thread.restoreTitle')}
                        style={{ ...chip, padding: '1px 6px', fontSize: 9, marginLeft: 8 }}
                      >↩ {t('thread.restore')}</button>
                    )}
                  </div>
                )
              })}
              {running && (
                <div style={{ alignSelf: 'flex-start', padding: '8px 10px', border: '2px dashed var(--border)', color: 'var(--text-dim)', fontSize: 11 }}>
                  {t('thread.designing')} <span className="tachi-run-dot" style={{ display: 'inline-block', width: 7, height: 7, background: 'var(--accent)', marginLeft: 4 }} />
                </div>
              )}
              <div ref={threadEndRef} />
            </div>

            <div style={{ padding: 12, borderTop: '2px solid var(--border)' }}>{composer}</div>
          </div>
          <SplitHandle panel={threadPane} side="right" dataId="design.thread" />

          {/* RIGHT: live artifact */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-base)' }}>
            <div data-tour="design-export" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderBottom: '2px solid var(--border)', background: 'var(--bg-surface)', flexShrink: 0 }}>
              <div style={{ display: 'flex', border: '2px solid var(--border)' }}>
                {(['preview', 'code'] as const).map(v => (
                  <button key={v} onClick={() => setView(v)} style={{ ...toggleBtn, background: view === v ? 'var(--accent-muted)' : 'transparent', color: view === v ? 'var(--accent-text)' : 'var(--text-muted)', fontWeight: view === v ? 700 : 400 }}>{t(`view.${v}`)}</button>
                ))}
              </div>
              {selectedId && <button onClick={() => setSelectedId(null)} style={toolBtn} title={t('artifact.latestTitle')}>{t('artifact.latest')}</button>}
              {canWysiwyg && (
                <button
                  onClick={() => { setWysiwyg(w => !w); setView('preview') }}
                  style={{ ...toolBtn, ...(wysiwyg ? { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' } : {}) }}
                  title={t('artifact.editTitle')}
                >{wysiwyg ? `✎ ${t('artifact.editing')}` : t('artifact.editText')}</button>
              )}
              <span style={{ flex: 1 }} />
              <button onClick={copyCode} disabled={!shownHtml} style={toolBtn}>{t('artifact.copy')}</button>
              <button onClick={exportHtml} disabled={!shownHtml} style={toolBtn}>{t('artifact.export')}</button>
              {/* MP4 for BOTH animate engines (Remotion renderer / HyperFrames
                  seek+capture — the main process picks by content). */}
              {shownCode ? (
                <>
                  <select
                    value={exportRes}
                    onChange={e => setExportRes(Number(e.target.value) as 1080 | 1440 | 2160)}
                    disabled={!!renderMsg}
                    data-testid="export-res"
                    title={t('artifact.mp4ResTitle')}
                    aria-label={t('artifact.mp4ResTitle')}
                    style={{ ...toolBtn, padding: '4px 2px', cursor: 'pointer' }}
                  >
                    <option value={1080}>1080p</option>
                    <option value={1440}>2K</option>
                    <option value={2160}>4K</option>
                  </select>
                  {/* Until the encoder is here, THIS button is the consent
                      moment: it states the size and, in its tooltip, why the
                      download exists at all. No render is attempted first —
                      spending a bundle and a browser launch to then say "you
                      need a download" is the wrong order. */}
                  {encoder && !encoder.installed ? (
                    <button
                      onClick={installEncoder}
                      disabled={!!encoderMsg}
                      data-testid="install-encoder"
                      style={{ ...toolBtn, ...(encoderMsg ? { background: 'var(--accent-muted)', color: 'var(--accent-text)' } : {}) }}
                      title={t('artifact.encoderInstallTitle')}
                    >{encoderMsg ?? t('artifact.encoderInstall', {
                      size: encoder.approxBytes ? `${Math.round(encoder.approxBytes / (1024 * 1024))} MB` : '~47 MB',
                    })}</button>
                  ) : (
                  <button
                    onClick={exportMp4}
                    disabled={!!renderMsg || !encoder}
                    data-testid="export-mp4"
                    style={{ ...toolBtn, ...(renderMsg ? { background: 'var(--accent-muted)', color: 'var(--accent-text)' } : {}) }}
                    title={t('artifact.mp4Title')}
                  >{renderMsg ? `… ${renderMsg}` : t('artifact.exportMp4')}</button>
                  )}
                </>
              ) : null}
              {/* PNG/PDF for pages AND HyperFrames (kept from HF v1) — Remotion
                  comps have no meaningful static capture. */}
              {shownHtml && !shownIsRemotion ? (
                <>
                  <button onClick={() => exportImage('png')} disabled={!!renderMsg} style={toolBtn} title={t('artifact.pngTitle')}>{renderMsg === 'Exporting PNG…' ? '…' : 'PNG'}</button>
                  <button onClick={() => exportImage('pdf')} disabled={!!renderMsg} style={toolBtn} title={t('artifact.pdfTitle')}>{renderMsg === 'Exporting PDF…' ? '…' : 'PDF'}</button>
                </>
              ) : null}
            </div>

            {wysiwyg && canWysiwyg && view === 'preview' && (
              <div style={{ padding: '3px 12px', fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--accent-text)', background: 'var(--accent-muted)', borderBottom: '2px solid var(--border)', flexShrink: 0 }}>
                ✎ {t('artifact.wysiwygBar')}
              </div>
            )}

            <div style={{ flex: 1, overflow: 'hidden', position: 'relative', display: 'flex' }}>
              {running && view === 'code' ? (
                <pre style={codePre}>{streamRaw || t('artifact.generating')}</pre>
              ) : !shownHtml ? (
                <div style={{ margin: 'auto', color: 'var(--text-dim)', fontSize: 12 }}>{t('artifact.noDoc')}</div>
              ) : view === 'preview' ? (
                <iframe
                  key={`${wysiwyg && canWysiwyg ? 'edit' : 'view'}:${(wysiwyg && canWysiwyg ? previewUrl : schemeSrc) ?? 'empty'}`}
                  src={(wysiwyg && canWysiwyg ? previewUrl : schemeSrc) ?? undefined}
                  title="design preview"
                  onLoad={onPreviewLoad}
                  // WYSIWYG: same-origin blob so the parent can drive editing via
                  // contentDocument; NO allow-scripts (page JS inert — no escape).
                  // Normal preview: tachi-preview:// (own CSP) with the script
                  // sandbox so the page/Remotion player runs.
                  sandbox={wysiwyg && canWysiwyg ? 'allow-same-origin' : 'allow-scripts allow-forms allow-popups allow-modals'}
                  style={{ flex: 1, border: 'none', width: '100%', background: '#fff' }}
                />
              ) : (
                <div style={{ flex: 1, minWidth: 0, height: '100%' }}>
                  {/* Editable IDE-grade code view — edits drive the live preview + persist.
                      Uncontrolled + keyed by message id so it never fights your typing
                      and reloads when you switch versions/sessions. */}
                  <CodeEditor
                    key={shownMsg?.id ?? 'none'}
                    defaultValue={shownCode ?? shownHtml}
                    language={shownIsRemotion ? 'typescript' : 'html'}
                    onChange={onEditChange}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div style={{ position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)', zIndex: 1200, padding: '6px 14px', border: '2px solid var(--accent)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: 11, fontWeight: 700 }}>{toast}</div>
      )}
    </div>
  )
}

// ── styles ──────────────────────────────────────────────────────────────────────
const selectStyle: React.CSSProperties = {
  padding: '6px 8px', border: '2px solid var(--border)', background: 'var(--bg-inset)', color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 11, cursor: 'pointer', outline: 'none',
}
// ── Interactive interview card (Claude-Design-style discovery) ────────────────
// Renders the structured clarify questions as clickable option chips: pick per
// question (defaults pre-selected), or type your own; unanswered = "you decide".
// Submit composes "Q — A" lines and hands them to the normal build path.
function InterviewCard({ questions, disabled, onSubmit }: {
  questions: Array<{ q: string; options: string[]; default?: string }>
  disabled: boolean
  onSubmit: (answers: string) => void
}) {
  const { t } = useTranslation('design')
  // Recommended options come pre-selected so "Design it" is one click away.
  const [picks, setPicks] = useState<Record<number, string>>(() =>
    Object.fromEntries(questions.map((x, i) => [i, x.default && x.options.includes(x.default) ? x.default : ''])))
  const [custom, setCustom] = useState<Record<number, string>>({})

  const answerFor = (i: number) => (custom[i]?.trim() || picks[i] || '')
  const submit = () => {
    const lines = questions.map((x, i) => `${x.q} — ${answerFor(i) || t('interview.youDecide')}`)
    onSubmit(lines.join('\n'))
  }

  return (
    <div style={{
      alignSelf: 'flex-start', maxWidth: '92%', padding: 10,
      border: '2px solid var(--accent)', background: 'var(--bg-elevated)',
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--accent-text)' }}>
        {t('interview.title')}
      </div>
      {questions.map((x, i) => (
        <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.4 }}>{i + 1}. {x.q}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {x.options.map(opt => {
              const active = picks[i] === opt && !custom[i]?.trim()
              return (
                <button
                  key={opt}
                  onClick={() => setPicks(p => ({ ...p, [i]: p[i] === opt ? '' : opt }))}
                  style={{
                    ...chip,
                    ...(active ? { borderColor: 'var(--accent)', background: 'var(--accent-muted)', color: 'var(--accent-text)', fontWeight: 700 } : {}),
                  }}
                >
                  {opt}{x.default === opt && !active ? <span style={{ color: 'var(--text-dim)' }}> ·{t('interview.suggested')}</span> : null}
                </button>
              )
            })}
          </div>
          <input
            value={custom[i] ?? ''}
            onChange={e => setCustom(c => ({ ...c, [i]: e.target.value }))}
            placeholder={t('interview.otherPlaceholder')}
            style={{
              padding: '4px 8px', border: '2px solid var(--border)', background: 'var(--bg-inset)',
              color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, outline: 'none',
            }}
          />
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={submit} disabled={disabled} style={{ ...primaryBtn, opacity: disabled ? 0.6 : 1 }}>
          {t('interview.designIt')} →
        </button>
        <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>{t('interview.hint')}</span>
      </div>
    </div>
  )
}

const primaryBtn: React.CSSProperties = {
  padding: '8px 16px', border: '2px solid var(--accent)', background: 'var(--accent)', color: '#fff',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', cursor: 'pointer', boxShadow: 'var(--shadow-hard)',
}
const toolBtn: React.CSSProperties = {
  padding: '4px 10px', border: '2px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-muted)',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer',
}
const toggleBtn: React.CSSProperties = {
  padding: '4px 14px', border: 'none', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
  letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
}
const chip: React.CSSProperties = {
  padding: '4px 10px', border: '2px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-muted)',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 10, cursor: 'pointer',
}
const ctxChip: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 4px 3px 8px',
  border: '2px solid var(--accent)', background: 'var(--accent-muted)', color: 'var(--accent-text)',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
}
const xBtn: React.CSSProperties = {
  border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 12, lineHeight: 1, padding: '0 2px',
}
const codePre: React.CSSProperties = {
  margin: 0, flex: 1, overflow: 'auto', padding: '10px 12px', fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11, lineHeight: 1.5, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--bg-inset)',
}
const sectionLabel: React.CSSProperties = {
  padding: '2px 2px 4px', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text-dim)', textTransform: 'uppercase',
}
