// apps/desktop/src/pages/chat/InputBar.tsx
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useChatStore, ContentPart, contentToText, conversationTokens } from '../../store/chat.store'
import { useTtsStore } from '../../store/tts.store'
import { usePrivacyStore } from '../../store/privacy.store'
import { ProviderPicker, AUTO_PROVIDER_ID, PROVIDER_OPTIONS } from './ProviderPicker'
import { resolveAutoModel } from '../../utils/autoModel'
import { gatherAutoModelInputs } from './autoModelGather'
import { TokenMeter } from './TokenMeter'
import { OllamaModelPicker } from './OllamaModelPicker'
import { LlamaCppModelPicker } from './LlamaCppModelPicker'
import { BankrModelPicker } from './BankrModelPicker'
import { SurplusModelPicker } from './SurplusModelPicker'
import { VeniceModelPicker } from './VeniceModelPicker'
import { ImgnaiModelPicker } from './ImgnaiModelPicker'
import { OpenRouterModelPicker } from './OpenRouterModelPicker'
import { CustomModelPicker } from './CustomModelPicker'
import { SurplusMediaModelPicker } from './SurplusMediaModelPicker'
import { ComparePanelPicker } from './ComparePanelPicker'
import { SamplerChip } from './SamplerChip'
import { samplerPayload } from './samplerPresets'
import { listSkills, parseSlashCommand } from '../../skills/skills'
// R9 — the chat mic runs on LOCAL whisper.cpp. webkitSpeechRecognition needs a
// Google Speech API key that Electron builds do not carry (electron#46143), so
// in the packaged app it only ever fired `network` errors. useSpeechRecognition
// stays as the fallback for the dev-browser path (whisper.supported === false).
import { useWhisperRecognition } from '../../hooks/useWhisperRecognition'
import { useSpeechRecognition } from '../../hooks/useSpeechRecognition'
import { showToast } from '../../components/Toaster'
import { PromptPicker } from '../../components/PromptPicker'
// Fill-in-the-blanks: a prompt template's unfilled {{vars}} are painted as chips
// UNDER the untouched textarea. See TemplateSlotLayer.tsx for why this is not a
// rich-text editor (tiptap+prosemirror measured 134 KB gzip and was rejected).
import { TemplateSlotLayer, SLOT_TYPE_METRICS } from './TemplateSlotLayer'
import { findSlots, nextSlot } from '@tachi/core/src/prompts/template'
import type { SurplusMediaModelInfo, SurplusMediaModality, Artifact } from '../../types/electron'
import { artifactToContentPart, AUDIO_ACCEPT, fileToBytes } from '../media/mediaHelpers'
// Smart-attach (UX #7): [FULL] inline vs [RAG] retrieval for the attached folder.
import { resolveContextWindow } from '@tachi/core/src/tachi/models'
// The window the ROUTED MODEL actually has, from the one place that knows it.
import { publishedContextTokens, formatContextTokens } from '../../store/modelWindow.store'
import {
  decideAttachMode, getCachedScan, resolveSmartAttach, scanAttachedFolder,
  type FolderScan,
} from './smartAttach'
// F16 — per-folder (project) settings: explicit > folder > global default.
import { composeSystemMessage, effectiveRagFolder, toFolderSendSettings } from './folder-settings'
import { resolveSendWorkingDir } from './messageWorkingDir'
import { planChatContext } from './chat-context'
// Slash-command layer (Claude-Code / Hermes idiom): one registry, two composers.
import {
  commandQueryFromText, matchCommands, parseCommandInput, unknownCommandHint,
  type CommandCaps,
} from '../../lib/commands/registry'
import { navigatePopup } from '../../lib/commands/popup-nav'
import { CommandPopup, type CommandPopupItem } from '../../components/CommandPopup'
import { CommandNote, type CommandNoteData } from '../../components/CommandNote'
import { KEEP_TAIL, buildCompactionInput, requestCompactSummary } from './compact'

// Media parts (audio/video) live in the chat store's ContentPart union but are
// never sent over chat.send (which only understands text/image/file). Narrow a
// message's content to the text-chat-sendable shape, dropping media parts.
type SendableContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'file'; data: string; mimeType: string; filename: string }

function toSendableContent(content: string | ContentPart[]): string | SendableContentPart[] {
  if (typeof content === 'string') return content
  return content.filter(
    (p): p is SendableContentPart => p.type === 'text' || p.type === 'image' || p.type === 'file',
  )
}

// Smart-attach FULL mode: prepend the inlined-folder block to the OUTBOUND
// message only (the stored/displayed message stays clean). When the result is
// text-only we collapse to a plain string — several free providers 400 on a
// multi-part content array that carries no image (same collapse the main
// process does after PDF hydration).
function composeOutbound(
  content: string | SendableContentPart[],
  block?: string,
): string | SendableContentPart[] {
  if (!block) return content
  if (typeof content === 'string') return content ? `${block}\n\n${content}` : block
  const withBlock: SendableContentPart[] = [{ type: 'text', text: block }, ...content]
  if (withBlock.every(p => p.type === 'text')) {
    return withBlock.map(p => (p as { type: 'text'; text: string }).text).join('\n\n')
  }
  return withBlock
}

// ── File → ContentPart helper ────────────────────────────────────────────────

async function fileToContentPart(file: File): Promise<ContentPart> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader()
    fr.onload  = () => resolve(fr.result as string)
    fr.onerror = () => reject(fr.error)
    fr.readAsDataURL(file)
  })
  if (file.type.startsWith('image/')) {
    if (file.size > 5 * 1024 * 1024) throw new Error(`Image too large (${(file.size / 1024 / 1024).toFixed(1)} MB > 5 MB cap)`)
    return { type: 'image', data: dataUrl, mimeType: file.type }
  }
  return { type: 'file', data: dataUrl, mimeType: file.type || 'text/plain', filename: file.name }
}

// ── AUTO provider router ───────────────────────────────────────────────────
// When a conversation's provider is 'auto', resolve the concrete provider+model
// at SEND time via the AUTO ladder (local-fit → free → paid-default) and record
// the decision so the resulting assistant message can show "AUTO → <model>".
// Non-auto providers pass straight through unchanged. Module-level so both the
// composer send() and the regenerate handler share one code path.
async function resolveAutoIfNeeded(
  providerId: string,
  model: string,
  conversationId: string,
): Promise<{ providerId: string; model: string }> {
  if (providerId !== AUTO_PROVIDER_ID) return { providerId, model }
  const fb = useChatStore.getState().autoFallback
  const privateMode = usePrivacyStore.getState().mode === 'private'
  const decision = resolveAutoModel(
    await gatherAutoModelInputs({ provider: fb.providerId, model: fb.model }, { privateMode }),
  )
  useChatStore.getState().setPendingAutoRoute(conversationId, { reason: decision.reason, provider: decision.provider })
  return { providerId: decision.provider, model: decision.model }
}

// ── Types ────────────────────────────────────────────────────────────────────

type ModeType = 'chat' | 'agent'

// NOTE: the old chat "mode/persona" picker (Chat/Coder/Brainstorm) was removed —
// setMode was never wired, so chat had no selector and the system prompt was
// always empty. Personas live on the Agents tab; chat's system prompt now comes
// from slash skills or the active profile.

// ── Surplus media controls strip — shared brutalist input styles ──────────────
const mediaCtrlLabelStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em',
}
const mediaCtrlInputStyle: React.CSSProperties = {
  padding: '2px 4px',
  border: '2px solid var(--border)',
  background: 'var(--bg-inset)',
  color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  outline: 'none',
}
const mediaCtrlBtnStyle: React.CSSProperties = {
  padding: '2px 8px',
  border: '2px solid var(--border)',
  background: 'var(--bg-inset)',
  color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  cursor: 'pointer',
}

// Tiny uppercase caption rendered next to the composer glyphs ("{ }", "[/]",
// "[+]") — the marquee features they open were invisible behind bare glyphs
// (UX #3/A6). The glyph stays the brand; the word does the teaching.
const glyphLabelStyle: React.CSSProperties = {
  marginLeft: 5,
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  verticalAlign: 'middle',
}

export function InputBar() {
  const { t, i18n } = useTranslation('chat')
  // Slash-command strings live in the shared 'common' namespace so the Chat and
  // Code composers read one set of keys instead of two divergent copies.
  const { t: tc } = useTranslation('common')
  const navigate = useNavigate()
  const [text, setText]             = useState('')
  const [showPrompts, setShowPrompts] = useState(false) // prompt-library picker
  // ── Fill-in-the-blanks state ────────────────────────────────────────────────
  // ONE boolean. `slotsArmed` means "a template with blanks was just inserted
  // and the user has not dismissed the gate"; everything else is DERIVED from
  // the text below, so there is no chip model that can drift from the textarea.
  //
  // Armed only by a deliberate template insert — never by typing. That is what
  // keeps the gate free of false positives: a user asking about Jinja or
  // Handlebars can type {{ anything }} all day and nothing arms, nothing paints
  // and nothing blocks.
  const [slotsArmed, setSlotsArmed] = useState(false)
  const [slotScrollTop, setSlotScrollTop] = useState(0)
  // Attached knowledge folder (chat RAG) for the ACTIVE conversation.
  const activeRagFolder = useChatStore(s => s.conversations.find(c => c.id === s.activeConversationId)?.ragFolder)
  const setConversationRagFolder = useChatStore(s => s.setConversationRagFolder)
  // Chat folder (project) the active conversation lives in — its systemPrompt
  // is prepended to sends, its ragFolder is the knowledge default.
  const activeChatFolder = useChatStore(s => {
    const conv = s.conversations.find(c => c.id === s.activeConversationId)
    return conv?.folderId ? s.folders.find(f => f.id === conv.folderId) : undefined
  })

  const attachFolder = async () => {
    const convId = useChatStore.getState().activeConversationId
    if (!convId) return
    const dir = await window.tachi.agent.pickFolder()
    if (!dir) return
    setConversationRagFolder(convId, dir)
    // Fresh attach → fresh size scan for the [FULL]/[RAG] chip (content may
    // have changed since a previous attach of the same folder).
    void scanAttachedFolder(dir, { force: true })
    showToast({ kind: 'info', text: t('composer.folderIndexing') })
    window.tachi.rag.index(dir)
      .then(r => showToast(r.ok
        ? { kind: 'success', text: t('composer.folderIndexed', { count: r.chunks ?? 0 }) }
        : { kind: 'error', text: r.error ?? t('composer.folderIndexError') }))
      .catch(() => showToast({ kind: 'error', text: t('composer.folderIndexError') }))
  }
  // Smart-attach scan of the attached folder: undefined = scanning, null =
  // scan failed (chip falls back to truthful [RAG]), FolderScan = measured.
  const [folderScan, setFolderScan] = useState<FolderScan | null | undefined>(undefined)
  useEffect(() => {
    if (!activeRagFolder) { setFolderScan(undefined); return }
    let alive = true
    const cached = getCachedScan(activeRagFolder)
    setFolderScan(cached) // undefined while a scan is (still) pending
    scanAttachedFolder(activeRagFolder).then(s => { if (alive) setFolderScan(s) })
    return () => { alive = false }
  }, [activeRagFolder])
  const [sendHovered, setSendHovered] = useState(false)
  const [attachments, setAttachments] = useState<ContentPart[]>([])
  const [slashOpen, setSlashOpen]     = useState(false)
  const [slashCursor, setSlashCursor] = useState(0)
  // Local-only output strip for /help, /cost, /memory and the unknown-command
  // hint. Nothing in here is ever sent to a model.
  const [cmdNote, setCmdNote]         = useState<CommandNoteData | null>(null)
  const allSkills = listSkills()
  // Unified "/" autocomplete: registry COMMANDS first, then the chat SKILLS that
  // already existed (/tdd, /web, /gh …) — skills keep working untouched.
  const slashQuery = commandQueryFromText(text)
  const slashRows = useMemo(() => {
    if (slashQuery === null) return []
    const q = slashQuery.toLowerCase()
    const cmds = matchCommands(q, 'chat').map(c => ({
      insert: `/${c.id} `,
      item: {
        key:   `cmd-${c.id}`,
        label: `/${c.id}`,
        args:  c.argsKey ? tc(c.argsKey) : undefined,
        desc:  tc(c.descKey),
        group: tc('commands.groupCommands'),
      } satisfies CommandPopupItem,
    }))
    const skills = allSkills
      .filter(s => s.id.toLowerCase().startsWith(q))
      .map(s => ({
        insert: `/${s.id} `,
        item: {
          key:   `skill-${s.id}`,
          label: `/${s.id}`,
          desc:  s.hint,
          group: tc('commands.groupSkills'),
        } satisfies CommandPopupItem,
      }))
    return [...cmds, ...skills]
  }, [slashQuery, allSkills, tc])
  useEffect(() => {
    setSlashOpen(slashQuery !== null && slashRows.length > 0)
    setSlashCursor(0)
  }, [slashQuery, slashRows.length])
  const activeConversationId    = useChatStore(s => s.activeConversationId)
  const streamingConversationId = useChatStore(s => s.streamingConversationId)
  const streamingMessageId      = useChatStore(s => s.streamingMessageId)
  const pendingMessage          = useChatStore(s => s.pendingMessage)
  const getActive               = useChatStore(s => s.getActive)
  const addUserMessage          = useChatStore(s => s.addUserMessage)
  const setConversationContextFrom = useChatStore(s => s.setConversationContextFrom)
  const setStreamingConversation = useChatStore(s => s.setStreamingConversation)
  const setPendingMessage       = useChatStore(s => s.setPendingMessage)
  const setProvider             = useChatStore(s => s.setProvider)
  const appendAssistantMedia    = useChatStore(s => s.appendAssistantMedia)
  // Subscribe to the active conversation's provider/model so the picker re-renders on change
  const activeProviderId        = useChatStore(s => s.conversations.find(c => c.id === s.activeConversationId)?.providerId ?? 'freellmapi-local')
  const activeModel             = useChatStore(s => s.conversations.find(c => c.id === s.activeConversationId)?.model ?? 'auto')
  // freellmapi model pin + sort mode
  const pinnedFreellmapiModel    = useChatStore(s => s.pinnedFreellmapiModel)
  const freellmapiSortMode       = useChatStore(s => s.freellmapiSortMode)
  const setPinnedFreellmapiModel = useChatStore(s => s.setPinnedFreellmapiModel)
  const setFreellmapiSortMode    = useChatStore(s => s.setFreellmapiSortMode)
  // The model id the next send will actually use (freellmapi pin wins) — feeds
  // both chat.send below and the smart-attach [FULL]/[RAG] context-window check.
  const effectiveModelId = (activeProviderId === 'freellmapi-local' && pinnedFreellmapiModel)
    ? pinnedFreellmapiModel
    : (activeModel || 'auto')
  const surplusSmartRouting       = useChatStore(s => s.surplusSmartRouting)
  const setSurplusSmartRouting    = useChatStore(s => s.setSurplusSmartRouting)
  const fusionMode                = useChatStore(s => s.fusionMode)
  const setFusionMode             = useChatStore(s => s.setFusionMode)
  const fusionPreset              = useChatStore(s => s.fusionPreset)
  const setFusionPreset           = useChatStore(s => s.setFusionPreset)
  const fusionArbiter             = useChatStore(s => s.fusionArbiter)
  const setFusionArbiter          = useChatStore(s => s.setFusionArbiter)
  // UX #6 — custom Fusion/COMPARE panel (may mix cloud + ollama:/llamacpp: ids).
  const fusionCustomPanel         = useChatStore(s => s.fusionCustomPanel)
  const setFusionCustomPanel      = useChatStore(s => s.setFusionCustomPanel)
  // AUTO model on a routed provider = smart routing engages with no toggle dance
  // (the chip then shows the AUTO ROUTE state; picking a model pins it instead).
  const autoRouted = !surplusSmartRouting && activeModel === 'auto'
  // Router boundary tuning (mini-popover on the routing chip — no settings panel).
  const [tuneOpen, setTuneOpen]         = useState(false)
  const [routerBounds, setRouterBounds] = useState<{ simpleMax: number; midMax: number } | null>(null)
  useEffect(() => {
    if (!tuneOpen || routerBounds) return
    window.tachi.settings.load()
      .then(s => setRouterBounds({ simpleMax: s.routerSimpleMax ?? 0.05, midMax: s.routerMidMax ?? 0.35 }))
      .catch(() => setRouterBounds({ simpleMax: 0.05, midMax: 0.35 }))
  }, [tuneOpen, routerBounds])
  const saveRouterBounds = (b: { simpleMax: number; midMax: number }) => {
    // Keep the invariant simpleMax < midMax — swap-proof clamp.
    const fixed = b.simpleMax >= b.midMax ? { simpleMax: b.midMax - 0.05, midMax: b.midMax } : b
    setRouterBounds(fixed)
    void window.tachi.settings.save({ routerSimpleMax: fixed.simpleMax, routerMidMax: fixed.midMax }).catch(() => { /* non-fatal */ })
  }
  const ttsEnabled                = useTtsStore(s => s.enabled)
  const setTtsEnabled             = useTtsStore(s => s.setEnabled)
  const setTtsVoiceId             = useTtsStore(s => s.setVoiceId)
  // Read-aloud toggle. On enable, auto-pick the first installed piper voice;
  // if none is installed, guide the user instead of silently doing nothing.
  const toggleTts = useCallback(async () => {
    if (ttsEnabled) { setTtsEnabled(false); return }
    let voiceId = useTtsStore.getState().voiceId
    try {
      const st = await window.tachi.piper.status()
      const installed = (st?.voices ?? []).map(v => v.id)
      if (!voiceId || !installed.includes(voiceId)) voiceId = installed[0] ?? ''
      if (!voiceId) { showToast({ text: 'Install a piper voice in Catalog to enable read-aloud.' }); return }
      setTtsVoiceId(voiceId)
      setTtsEnabled(true)
    } catch { showToast({ text: 'Could not start piper TTS.' }) }
  }, [ttsEnabled, setTtsEnabled, setTtsVoiceId])
  const allowWorkflowEscalation   = useChatStore(s => s.allowWorkflowEscalation)
  const setAllowWorkflowEscalation = useChatStore(s => s.setAllowWorkflowEscalation)

  const textareaRef  = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const audioInputRef = useRef<HTMLInputElement>(null)

  // ── Surplus MEDIA mode ─────────────────────────────────────────────────────
  // When the active Surplus model is a media model (image/tts/stt/video/music),
  // the composer adapts and Send routes to the media engine instead of chat.
  const [mediaModels, setMediaModels]   = useState<SurplusMediaModelInfo[]>([])
  const [mediaBusy, setMediaBusy]       = useState(false)
  const [mediaProgress, setMediaProgress] = useState<string | null>(null)
  // Per-modality controls.
  const [imgSize, setImgSize]   = useState('1024x1024')
  const [imgN, setImgN]         = useState(1)
  const [ttsVoice, setTtsVoice] = useState('')
  const [duration, setDuration] = useState(5)
  const [lyrics, setLyrics]     = useState('')
  const [sttFile, setSttFile]   = useState<File | null>(null)

  const loadMediaModels = useCallback(async () => {
    try {
      const res = await window.tachi.surplusMedia.listModels({})
      setMediaModels(res.ok ? res.models : [])
    } catch {
      setMediaModels([])
    }
  }, [])

  useEffect(() => {
    if (activeProviderId === 'surplus') loadMediaModels()
    else setMediaModels([])
  }, [activeProviderId, loadMediaModels])

  const activeMediaModel = mediaModels.find(m => m.id === activeModel)
  const mediaModality: SurplusMediaModality | null = activeMediaModel?.modality ?? null
  const isMediaMode = activeProviderId === 'surplus' && !!mediaModality && mediaModality !== 'text' && mediaModality !== 'embedding'

  // ── freellmapi model list ─────────────────────────────────────────────────
  const [freellmapiModels, setFreellmapiModels] = useState<Array<{ platform: string; modelId: string; name: string }>>([])
  const [freellmapiAvailable, setFreellmapiAvailable] = useState(false)
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false)
  const modelDropdownRef = useRef<HTMLDivElement>(null)

  const loadFreellmapiModels = useCallback(async () => {
    try {
      const result = await window.tachi.freellmapi.listFallbackModels()
      if (result.ok && result.models.length > 0) {
        setFreellmapiModels(result.models)
        setFreellmapiAvailable(true)
      } else {
        setFreellmapiAvailable(false)
      }
    } catch {
      setFreellmapiAvailable(false)
    }
  }, [])

  // Load once on mount when provider is freellmapi-local
  useEffect(() => {
    if (activeProviderId === 'freellmapi-local') {
      loadFreellmapiModels()
    } else {
      setFreellmapiAvailable(false)
      setModelDropdownOpen(false)
    }
  }, [activeProviderId, loadFreellmapiModels])

  // Close model dropdown when clicking outside
  useEffect(() => {
    if (!modelDropdownOpen) return
    const handler = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setModelDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [modelDropdownOpen])

  const cycleSortMode = async () => {
    if (!freellmapiAvailable) return
    const order: Array<'intelligence' | 'speed' | 'budget'> = ['intelligence', 'speed', 'budget']
    const next = order[(order.indexOf(freellmapiSortMode) + 1) % 3]
    setFreellmapiSortMode(next)
    // Map to freellmapi API name
    const apiMode = next === 'intelligence' ? 'intelligence' : next === 'speed' ? 'speed' : 'budget'
    try {
      await window.tachi.freellmapi.setSortMode(apiMode)
    } catch { /* non-fatal */ }
  }

  // Speech recognition — appends final transcripts to the composer.
  // Primary = local whisper.cpp (works offline, multilingual, no API key);
  // fallback = the Web Speech API for the dev-browser path where the whisper IPC
  // surface / getUserMedia are missing. Both controllers expose the same shape.
  const appendTranscript = useCallback(
    (final: string) => setText(prev => (prev ? prev + ' ' : '') + final),
    [],
  )
  const whisperVoice  = useWhisperRecognition({ lang: i18n.language, onFinal: appendTranscript })
  const webSpeechVoice = useSpeechRecognition({ onFinal: appendTranscript })
  const voice = whisperVoice.supported ? whisperVoice : webSpeechVoice
  const { listening, supported: voiceSupported, start: startVoice, stop: stopVoice, interim: voiceInterim, error: voiceError } = voice
  // Whisper is not streaming: after stop() it spends a beat transcribing. Surface
  // that instead of leaving the button in a lying "REC" state.
  const voiceProcessing = whisperVoice.supported ? whisperVoice.processing : false
  useEffect(() => {
    if (voiceError) showToast({ kind: 'error', text: t('voice.error', { error: voiceError }) })
  }, [voiceError, t])

  // Pre-fill from HomePage quick-start cards — reactive, handles post-mount updates too.
  useEffect(() => {
    if (pendingMessage) {
      setText(pendingMessage)
      setPendingMessage(null)
      textareaRef.current?.focus()
    }
  }, [pendingMessage, setPendingMessage])

  // Listen for "regenerate last response" from MessageBubble action bar.
  useEffect(() => {
    const onRegen = async (e: Event) => {
      const detail = (e as CustomEvent).detail as { messageId: string; conversationId: string } | undefined
      if (!detail) return
      const conv = useChatStore.getState().conversations.find(c => c.id === detail.conversationId)
      if (!conv) return
      // Find the user message that precedes this assistant message.
      const idx = conv.messages.findIndex(m => m.id === detail.messageId)
      if (idx <= 0) return
      const prevUser = [...conv.messages].slice(0, idx).reverse().find(m => m.role === 'user')
      if (!prevUser) return
      // Folder (project) powers apply to regenerates too.
      const regenFolder = conv.folderId
        ? useChatStore.getState().folders.find(f => f.id === conv.folderId)
        : undefined
      // AUTO router: an auto chat re-resolves its provider+model on regenerate
      // too (same seam as a fresh send), stamping the new reply's meta.
      useChatStore.getState().setStreamingConversation(detail.conversationId)
      const { providerId: regenProviderId, model: regenModel } =
        await resolveAutoIfNeeded(conv.providerId || 'freellmapi-local', conv.model || 'auto', detail.conversationId)
      // Smart-attach applies to regenerates as well — same FULL/RAG decision
      // as a fresh send so the composer chip stays truthful. Explicit attach
      // wins over the folder default (F16 precedence helper).
      const regenFolderSettings = toFolderSendSettings(regenFolder)
      const regenAttachedFolder = effectiveRagFolder(conv.ragFolder, regenFolderSettings)
      const regenWindowTokens = publishedContextTokens(regenProviderId, regenModel)
      const regenSmartAttach = resolveSmartAttach(regenAttachedFolder, regenModel, regenWindowTokens)
      // A regenerate mints a NEW assistant message, so it needs its own parked
      // working dir — otherwise the alternative answer would render no chips.
      useChatStore.getState().setPendingWorkingDir(
        detail.conversationId,
        resolveSendWorkingDir({ workspaceDir: conv.workspaceDir, attachedFolder: regenAttachedFolder }),
      )
      // Re-send: just dispatch chat.send again with the same content. Don't delete
      // the previous assistant reply — give user multiple alternatives, like Claude Desktop.
      window.tachi.chat.send({
        conversationId: detail.conversationId,
        message:        composeOutbound(toSendableContent(prevUser.content), regenSmartAttach.block),
        model:          regenModel,
        providerId:     regenProviderId,
        systemMessage:  composeSystemMessage(regenFolderSettings),
        surplusSmartRouting:     (conv.providerId === 'surplus' || conv.providerId === 'bankr-gateway' || conv.providerId === 'venice') ? useChatStore.getState().surplusSmartRouting : undefined,
        allowWorkflowEscalation: conv.providerId === 'surplus' ? useChatStore.getState().allowWorkflowEscalation : undefined,
        ragFolder:               regenSmartAttach.mode === 'full' ? undefined : regenAttachedFolder,
        // Per-chat sampler (T19): regenerate honors the conversation's preset too.
        sampler:                 samplerPayload(conv.sampler),
        // The routed model's own window, when its provider published one. Main
        // budgets the red-zone against it; absent = main falls back to the
        // static resolver rather than to a per-provider guess.
        contextTokens:           regenWindowTokens,
      }).catch((err) => {
        console.warn('[chat] regenerate failed:', err)
      })
    }
    window.addEventListener('tachi:regenerate-message', onRegen as EventListener)
    return () => window.removeEventListener('tachi:regenerate-message', onRegen as EventListener)
  }, [])

  // Rewind/edit: pull a past user message back into the composer and drop it +
  // everything after, so the next send regenerates from that point.
  useEffect(() => {
    const onEdit = (e: Event) => {
      const detail = (e as CustomEvent).detail as { messageId: string; conversationId: string } | undefined
      if (!detail) return
      const conv = useChatStore.getState().conversations.find(c => c.id === detail.conversationId)
      const msg = conv?.messages.find(m => m.id === detail.messageId)
      if (!msg) return
      const text = contentToText(msg.content)
      // Stop any in-flight stream first — otherwise it keeps writing into a
      // now-removed message and collides with the re-send.
      window.tachi.chat.abort(detail.conversationId).catch(() => {})
      // UX #5: an edit that would DROP assistant answers first snapshots the
      // whole conversation as a silent sibling branch — nothing is ever lost.
      const idx = conv!.messages.findIndex(m => m.id === detail.messageId)
      const losesAnswers = conv!.messages.slice(idx).some(m => m.role === 'assistant')
      if (losesAnswers && conv!.messages.length > 0) {
        const lastMsg = conv!.messages[conv!.messages.length - 1]
        useChatStore.getState().forkConversation(detail.conversationId, lastMsg.id, { activate: false, titleSuffix: '(branch)' })
        showToast({ kind: 'info', text: t('composer.editBranchSaved', 'Old thread kept as a "(branch)" chat in History') })
      }
      useChatStore.getState().truncateFrom(detail.conversationId, detail.messageId)
      setText(text)
      requestAnimationFrame(() => textareaRef.current?.focus())
    }
    window.addEventListener('tachi:edit-message', onEdit as EventListener)
    return () => window.removeEventListener('tachi:edit-message', onEdit as EventListener)
  }, [])

  // ── Surplus media send ──────────────────────────────────────────────────────
  // Routes the composer to the media engine when a media model is active. STT
  // returns text (rendered as an assistant text message); the rest return
  // artifacts appended as media parts. Async video/music submit + poll inline.
  const sendMedia = async () => {
    if (mediaBusy || !activeConversationId || !activeMediaModel) return
    const prompt = text.trim()
    const model = activeMediaModel.id
    const modality = activeMediaModel.modality

    // STT needs an audio file, not a prompt.
    if (modality === 'stt') {
      if (!sttFile) { showToast({ kind: 'error', text: t('media.attachAudioToTranscribe') }); return }
    } else if (!prompt) {
      return
    }

    setMediaBusy(true)
    setMediaProgress(null)

    // Echo the user's request into the conversation (prompt or "transcribe <file>").
    const userEcho = modality === 'stt' ? t('media.transcribeEcho', { name: sttFile!.name }) : prompt
    addUserMessage(activeConversationId, userEcho)
    if (modality !== 'stt') setText('')

    try {
      if (modality === 'image') {
        const { artifacts } = await window.tachi.surplusMedia.generateImage({ model, prompt, size: imgSize, n: imgN })
        appendMediaArtifacts(activeConversationId, artifacts, model)
      } else if (modality === 'tts') {
        const { artifacts } = await window.tachi.surplusMedia.generateSpeech({ model, input: prompt, voice: ttsVoice || undefined })
        appendMediaArtifacts(activeConversationId, artifacts, model)
      } else if (modality === 'stt') {
        const bytes = await fileToBytes(sttFile!)
        const { text: transcript } = await window.tachi.surplusMedia.transcribe({ model, audioBytes: bytes, fileName: sttFile!.name })
        appendAssistantMedia(activeConversationId, [{ type: 'text', text: transcript }], model)
        setSttFile(null)
      } else if (modality === 'video' || modality === 'music') {
        const submit = modality === 'video'
          ? await window.tachi.surplusMedia.submitVideo({ model, prompt, duration })
          : await window.tachi.surplusMedia.submitMusic({ model, prompt, lyrics: lyrics || undefined, duration })
        const artifacts = await pollUntilSettled(submit.jobId)
        if (artifacts) appendMediaArtifacts(activeConversationId, artifacts, model)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendAssistantMedia(activeConversationId, [{ type: 'text', text: t('media.generationFailed', { error: msg }) }], model)
    } finally {
      setMediaBusy(false)
      setMediaProgress(null)
    }
  }

  // Append media artifacts as a single assistant message (with a fallback note
  // if the engine returned nothing renderable).
  const appendMediaArtifacts = (convId: string, artifacts: Artifact[], model: string) => {
    const parts = artifacts
      .map(a => artifactToContentPart(a))
      .filter((p): p is NonNullable<typeof p> => p !== null)
    if (parts.length === 0) {
      appendAssistantMedia(convId, [{ type: 'text', text: t('media.noArtifactsReturned') }], model)
      return
    }
    appendAssistantMedia(convId, parts, model)
  }

  // Drive the async poll loop with a ~5-min cap. Returns artifacts on success,
  // null on failure/timeout (and surfaces a toast).
  const pollUntilSettled = async (jobId: string): Promise<Artifact[] | null> => {
    const deadline = Date.now() + 5 * 60 * 1000
    while (Date.now() < deadline) {
      const res = await window.tachi.surplusMedia.pollJob({ jobId })
      if (res.status === 'succeeded') return res.artifacts ?? []
      if (res.status === 'failed') { showToast({ kind: 'error', text: res.error ?? t('media.jobFailed') }); return null }
      setMediaProgress(typeof res.progress === 'number' ? `${Math.round(res.progress * 100)}%` : res.status)
      await new Promise(r => setTimeout(r, 3000))
    }
    showToast({ kind: 'warning', text: t('media.pollTimeout') })
    return null
  }

  // ── Slash commands ─────────────────────────────────────────────────────────
  // Every capability below points at machinery this surface ALREADY has: chat
  // compaction, newConversation, the provider/model store, the cost ledger, the
  // memory-fact store, edit-and-rewind, and the web_search tool. No stubs.
  const commandCaps: CommandCaps = useMemo(() => ({
    surface: 'chat',
    t: tc,
    compact: async () => {
      const st = useChatStore.getState()
      const conv = st.conversations.find(c => c.id === st.activeConversationId)
      if (!conv) return false
      const compactedUpTo = conv.compactedUpTo ?? 0
      const keepFrom = Math.max(0, conv.messages.length - KEEP_TAIL)
      if (keepFrom <= compactedUpTo) return false
      const input = buildCompactionInput(conv, keepFrom)
      if (!input.trim()) return false
      const summary = await requestCompactSummary(conv, input)
      if (!summary) return false
      useChatStore.getState().setConversationCompaction(conv.id, keepFrom, summary)
      return true
    },
    newConversation: () => {
      const st = useChatStore.getState()
      const id = st.newConversation()
      st.setActive(id)
      navigate(`/chat/${id}`)
    },
    describeModel: () => `${activeProviderId} · ${effectiveModelId}`,
    setModel: async (name: string) => {
      const convId = useChatStore.getState().activeConversationId
      if (!convId) return { ok: false }
      const raw = name.trim()
      const n = raw.toLowerCase()
      const prov = PROVIDER_OPTIONS.find(p => p.id.toLowerCase() === n || p.label.toLowerCase() === n)
      if (prov) {
        setProvider(convId, prov.id, prov.defaultModel)
        return { ok: true, label: prov.defaultModel ? `${prov.label} · ${prov.defaultModel}` : prov.label }
      }
      // Not a provider name → treat it as a model id on the ACTIVE provider.
      // That is exactly the write every model picker performs, so a typed name
      // and a picked row end up in the same place.
      if (!/^[\w.:@/-]+$/.test(raw)) return { ok: false }
      setProvider(convId, activeProviderId, raw)
      return { ok: true, label: `${activeProviderId} · ${raw}` }
    },
    openModelPicker: () => window.dispatchEvent(new CustomEvent('tachi:toggle-palette')),
    costSummary: () => window.tachi.cost.summary(),
    sessionSpend: () => {
      const st = useChatStore.getState()
      const conv = st.conversations.find(c => c.id === st.activeConversationId)
      if (!conv || conv.messages.length === 0) return null
      return tc('commands.cost.sessionTokens', { count: conversationTokens(conv).toLocaleString() })
    },
    listFacts: () => window.tachi.memoryFacts.list(),
    addFact: async (factText: string) => Boolean(await window.tachi.memoryFacts.add(factText, 'user')),
    rewindLast: () => {
      const st = useChatStore.getState()
      const conv = st.conversations.find(c => c.id === st.activeConversationId)
      const last = conv ? [...conv.messages].reverse().find(m => m.role === 'user') : undefined
      if (!conv || !last) return false
      // Same event MessageBubble's edit action fires — the listener above pulls
      // the message back into the composer and truncates from there.
      window.dispatchEvent(new CustomEvent('tachi:edit-message', {
        detail: { messageId: last.id, conversationId: conv.id },
      }))
      return true
    },
    webSearch: async (query: string) => {
      // The chat tool-loop only attaches the web_search schema when the setting
      // is on, and the call itself needs a Brave/Tavily key — check both so the
      // note is truthful instead of the model reporting the failure later.
      const [settings, keys] = await Promise.all([
        window.tachi.settings.load().catch(() => null),
        window.tachi.settings.listKeys().catch(() => [] as string[]),
      ])
      const hasKey = keys.includes('brave-search') || keys.includes('tavily')
      if (!settings?.webSearchEnabled || !hasKey) return { ok: false }
      void send({
        text: query,
        systemExtra:
          'You have a web_search tool. Call it for this request BEFORE answering, then answer from the results and cite the source URLs.',
      })
      return { ok: true }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- send() is stable enough here; it reads live store state.
  }), [tc, navigate, activeProviderId, effectiveModelId, setProvider])

  const runSlashCommand = useCallback(async (parsed: ReturnType<typeof parseCommandInput>) => {
    if (parsed.kind === 'unknown') {
      setCmdNote({ kind: 'error', text: unknownCommandHint(parsed, commandCaps) })
      return
    }
    if (parsed.kind !== 'command' || !parsed.def) return
    try {
      const res = await parsed.def.run(parsed.args ?? '', commandCaps)
      if (res.kind === 'note')       setCmdNote({ kind: 'note',  text: res.text })
      else if (res.kind === 'error') setCmdNote({ kind: 'error', text: res.text })
      else                           setCmdNote(null)
    } catch (err) {
      setCmdNote({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }, [commandCaps])

  const pickSlashRow = (row: { insert: string }) => {
    setText(row.insert)
    setSlashOpen(false)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  // ── Fill-in-the-blanks: everything derived, nothing stored ──────────────────
  // A blank is filled exactly when its braces stop existing, so `slots` recomputes
  // from the live text and `blanksActive` falls to false on its own the moment
  // the last one is typed over. No effect, no cleanup, nothing to desync.
  const slots = useMemo(() => (slotsArmed ? findSlots(text) : []), [slotsArmed, text])
  const blanksActive = slots.length > 0

  /** Select a blank's range in the textarea so the next keystroke replaces it. */
  const selectSlot = useCallback((caret: number, dir: 1 | -1 = 1) => {
    const el = textareaRef.current
    if (!el) return
    const target = nextSlot(findSlots(el.value), caret, dir)
    if (!target) return
    el.focus()
    el.setSelectionRange(target.start, target.end)
  }, [])

  /**
   * The ONLY path that arms the blanks. Appends the rendered template exactly
   * as before, then arms iff anything is still unfilled and parks the caret on
   * the first blank so the user can just start typing.
   */
  const insertTemplate = (tpl: string) => {
    const next = text.trim() ? `${text.trimEnd()}\n\n${tpl}` : tpl
    setText(next)
    // The picker already resolved the auto-vars ({{date}}/{{model}}/…); braces
    // that survived that render are genuinely unfilled.
    const armed = findSlots(next).length > 0
    setSlotsArmed(armed)
    // rAF so the new value is in the DOM before we select a range inside it —
    // the same idiom pickSlashRow uses to focus after a setText.
    if (armed) requestAnimationFrame(() => selectSlot(-1))
  }

  const send = async (override?: { text?: string; systemExtra?: string }) => {
    if (isMediaMode) { sendMedia(); return }
    // Agent mode no longer lives in this bar — Chat is for Chat. Users
    // switch to the Agent surface via the sidebar's CODE tab.
    //
    // Guard on streamingConversationId (set synchronously) so a rapid double-send
    // before the first 'start' chunk arrives is also blocked.
    const composed = (override?.text ?? text).trim()

    // ── Unfilled-blank gate ───────────────────────────────────────────────────
    // BLOCKS rather than sending the literal, and the reason is that a `{{text}}`
    // reaching the model is never what anyone meant — it silently wastes a turn
    // and, on a paid provider, real money. The usual argument for sending the
    // literal is false positives ({{ }} is legal prose), and that argument is
    // answered by ARMING instead of by permissiveness: this branch is reachable
    // only when the user just inserted a template that still has blanks.
    //
    // It is a gate, not a wall — the caret jumps to the blank so the fix is one
    // keystroke away, and the hint under the composer says Escape sends as-is.
    // `override` sends are internal (e.g. /search) and never armed.
    if (!override && blanksActive) {
      selectSlot(-1)
      return
    }

    // ── Slash-command interception ────────────────────────────────────────────
    // Runs BEFORE any guard so /help, /cost … work on an empty conversation and
    // while a stream is running. An UNKNOWN /command never reaches the model:
    // the text stays in the composer and an inline hint points at /help.
    // `//literal` unwraps to a single leading slash and sends normally.
    // `override` sends are internal (e.g. /search) and are never re-parsed.
    const commandParse = override
      ? null
      : parseCommandInput(composed, 'chat', { knownOther: n => allSkills.some(s => s.id === n) })
    if (commandParse && (commandParse.kind === 'command' || commandParse.kind === 'unknown')) {
      setSlashOpen(false)
      if (commandParse.kind === 'command') setText('')
      void runSlashCommand(commandParse)
      return
    }
    const literal = commandParse?.text ?? composed
    // `//tdd …` must reach the model as the literal text "/tdd …" — it must NOT
    // fall into the skills parser below, or the escape would be pointless.
    const wasEscaped = commandParse?.kind === 'text' && commandParse.text !== composed

    const hasContent = literal || attachments.length > 0
    if (!hasContent || streamingConversationId || streamingMessageId || !activeConversationId) return
    const conv = getActive()
    if (!conv) return
    // Conversation memory: send prior turns so the model remembers the chat.
    // getActive() was captured BEFORE addUserMessage below, so conv.messages is
    // exactly the prior history (excludes the current turn). planChatContext
    // text-flattens, drops streaming/error/empty turns, and — when the
    // conversation has been COMPACTED — replaces the head with the stored
    // summary note (non-destructive: the transcript itself is untouched).
    //
    // It also holds the cut point STILL. The old call passed `{ cap: 20 }`,
    // whose sliding window moved the request's first byte on every send past
    // turn 20 — so llama-server re-read the whole prompt and every cloud prefix
    // cache missed, every turn. The cut now moves only when the tail outgrows
    // the cap, and then by half of it.
    const plan = planChatContext(conv.messages, conv.compactedUpTo, conv.compactSummary, {
      cap: 20,
      pinnedFrom: conv.contextFrom,
    })
    const history = plan.messages
    // Persist only on an actual move: the whole point is that the common turn
    // changes nothing.
    if (plan.recut) setConversationContextFrom(activeConversationId, plan.from)
    const rawMsg = literal
    setText('')
    // The composer is empty: whatever template was armed is gone with it.
    setSlotsArmed(false)

    // Slash-command: extract skill if message starts with /<skillId>
    const parsed = wasEscaped ? null : parseSlashCommand(rawMsg)
    const msg = parsed ? parsed.body : rawMsg
    const skillSystemPrompt = parsed ? parsed.skill.systemPrompt : ''
    const githubToolsEnabled = parsed?.skill.mode === 'github-tools'

    // Compose content: pure string when no attachments, parts array otherwise
    const userContent: string | ContentPart[] = attachments.length === 0
      ? msg
      : [...attachments, ...(msg ? [{ type: 'text' as const, text: msg }] : [])]

    setAttachments([])
    addUserMessage(activeConversationId, userContent)
    setStreamingConversation(activeConversationId)

    // Compose final system prompt: folder (project) instructions first, then
    // the skill prompt — both are the user's own trusted text (F16 helper).
    const activeFolderSettings = toFolderSendSettings(activeChatFolder)
    // `override.systemExtra` is the slash layer's only prompt seam (/search adds
    // a "call web_search first" directive) — same trusted-text join as skills.
    const finalSystem = composeSystemMessage(activeFolderSettings, skillSystemPrompt, override?.systemExtra)

    // When using freellmapi-local with a pinned model, send it so the proxy
    // routes to that specific model instead of running the fallback chain.
    const resolvedModel = effectiveModelId

    // AUTO router: resolve the concrete provider+model at the narrowest seam —
    // right where provider+model are read for the send. The send path below is
    // otherwise unchanged; only these two values differ when AUTO is active.
    // (streamingConversation is already armed above, so the double-send guard
    // holds across this await.)
    const { providerId: sendProviderId, model: sendModel } =
      await resolveAutoIfNeeded(activeProviderId || 'freellmapi-local', resolvedModel, activeConversationId)

    // Smart-attach: when the attached folder's full text fits in 60% of the
    // model's context window, inline it with THIS message (block prepended to
    // the outbound content only — the stored message stays clean) and skip
    // retrieval; otherwise keep per-message RAG retrieval.
    const attachedFolder = effectiveRagFolder(activeRagFolder, activeFolderSettings)
    // The window comes from the one place that knows it (modelWindow.store →
    // resolveContextWindow), so FULL-vs-RAG, the CTX chip and the main-process
    // red-zone all size against the same number for the same model.
    const sendWindowTokens = publishedContextTokens(sendProviderId, sendModel)
    const smartAttach = resolveSmartAttach(attachedFolder, sendModel, sendWindowTokens)

    // FILE-PATH CHIPS: park the dir that is ACTIVE for this send (explicit
    // workspace, else the folder we just resolved) so appendChunk('start') can
    // stamp it onto the reply. Independent of smartAttach.mode — inlining the
    // folder text vs. retrieving from it does not change WHERE the files are.
    useChatStore.getState().setPendingWorkingDir(
      activeConversationId,
      resolveSendWorkingDir({ workspaceDir: conv.workspaceDir, attachedFolder }),
    )

    // PROVENANCE: park the provider this send is ACTUALLY routed to (post-AUTO
    // resolution, so it is concrete) so appendChunk('start') can stamp it onto
    // the reply. Same park-then-stamp idiom as the working dir above, and for
    // the same reason: switching the picker later must not relabel an
    // already-delivered answer (driver-proven 2026-08-01 — a Kilo reply
    // re-badged itself "[OPENROUTER-OAUTH · Free]" on a provider switch).
    useChatStore.getState().setPendingProvider(activeConversationId, sendProviderId)

    window.tachi.chat.send({
      conversationId:    activeConversationId,
      message:           composeOutbound(toSendableContent(userContent), smartAttach.block),
      history,
      model:             sendModel,
      providerId:        sendProviderId,
      systemMessage:     finalSystem,
      ragFolder:         smartAttach.mode === 'full' ? undefined : attachedFolder,
      // The routed model's own window, when its provider published one — main
      // has no access to the renderer's catalog cache and used to fall back to
      // a per-provider constant for the red-zone check.
      contextTokens:     sendWindowTokens,
      // Per-chat sampler (T19): resolved temperature/top_p, or undefined for
      // BALANCED so the provider's own defaults apply untouched.
      sampler:           samplerPayload(conv.sampler),
      githubToolsEnabled: githubToolsEnabled || undefined,
      surplusSmartRouting:     (activeProviderId === 'surplus' || activeProviderId === 'bankr-gateway' || activeProviderId === 'venice') ? surplusSmartRouting : undefined,
      allowWorkflowEscalation: activeProviderId === 'surplus' ? allowWorkflowEscalation : undefined,
      // Fusion works for the three OpenAI-compat routed providers; the backend
      // derives the panel + judge from (provider, preset) against the live catalog.
      fusionMode:              (activeProviderId === 'bankr-gateway' || activeProviderId === 'venice' || activeProviderId === 'surplus') ? fusionMode : undefined,
      fusionPreset:            (activeProviderId === 'bankr-gateway' || activeProviderId === 'venice' || activeProviderId === 'surplus') ? fusionPreset : undefined,
      fusionArbiter:           (activeProviderId === 'bankr-gateway' || activeProviderId === 'venice' || activeProviderId === 'surplus') ? fusionArbiter : undefined,
      // UX #6: custom panel (cloud ids + local ollama:/llamacpp: ids). Empty = preset.
      fusionPanel:             (activeProviderId === 'bankr-gateway' || activeProviderId === 'venice' || activeProviderId === 'surplus') && fusionMode && fusionCustomPanel.length > 0 ? fusionCustomPanel : undefined,
    }).catch((err) => {
      setStreamingConversation(null)
      console.warn('[chat] send failed:', err)
    })
  }

  // Drag-drop handler
  const onDragOver = (e: React.DragEvent) => { e.preventDefault() }
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    try {
      const parts = await Promise.all(files.map(fileToContentPart))
      setAttachments(prev => [...prev, ...parts])
    } catch (err) {
      console.warn('[chat] drag-drop file error:', err)
    }
  }

  // Paste image from clipboard
  const onPaste = async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items)
    const files: File[] = []
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile()
        if (f) files.push(f)
      }
    }
    if (files.length > 0) {
      e.preventDefault()
      try {
        const parts = await Promise.all(files.map(fileToContentPart))
        setAttachments(prev => [...prev, ...parts])
      } catch (err) {
        console.warn('[chat] paste file error:', err)
      }
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    // ── Fill-in-the-blanks navigation ─────────────────────────────────────────
    // Guarded by isComposing so an IME candidate window keeps every key: while
    // composing Japanese/Chinese/Korean, Tab and Escape belong to the IME, not
    // to us. Guarded by blanksActive so that when nothing is armed this whole
    // block is dead and Tab/Escape behave exactly as they always did.
    if (blanksActive && !e.nativeEvent.isComposing) {
      if (e.key === 'Tab') {
        // Tab is the fill-in-the-blanks verb while armed. It is borrowed, not
        // stolen: Escape below disarms and hands Tab back to focus traversal.
        e.preventDefault()
        const el = textareaRef.current
        const dir = e.shiftKey ? -1 : 1
        selectSlot(dir === 1 ? (el?.selectionStart ?? -1) : (el?.selectionStart ?? 0), dir)
        return
      }
      if (e.key === 'Escape') {
        // "Send it as-is": drop the gate and the chips, keep the text verbatim.
        e.preventDefault()
        setSlotsArmed(false)
        return
      }
    }
    // Slash autocomplete navigation — shared state machine (commands/popup-nav).
    if (slashOpen && slashRows.length > 0) {
      const nav = navigatePopup(e.key, slashCursor, slashRows.length, { shiftKey: e.shiftKey })
      if (nav.preventDefault) e.preventDefault()
      if (nav.action === 'move')   { setSlashCursor(nav.cursor); return }
      if (nav.action === 'close')  { setSlashOpen(false); return }
      if (nav.action === 'select') { pickSlashRow(slashRows[nav.cursor]); return }
    }
    // isComposing: on ja/zh/ko IMEs, Enter COMMITS the candidate — that Enter
    // must never also send the message. (keyCode 229 covers the legacy-IME
    // events some Windows IMEs still deliver after compositionend.)
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void send() }
  }

  // Auto-grow textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 180) + 'px'
    }
  }, [text])

  // Rough token estimate: ~4 chars per token; images ~1000 tokens each
  const tokenCount = Math.ceil(text.length / 4)
    + attachments.filter(a => a.type === 'image').length * 1000
    + attachments.reduce((sum, a) => a.type === 'file' ? sum + Math.ceil(a.data.length / 16) : sum, 0)

  const canSend = isMediaMode
    ? (mediaModality === 'stt' ? !!sttFile : !!text.trim()) && !mediaBusy
    : (!!text.trim() || attachments.length > 0) && !streamingConversationId && !streamingMessageId

  return (
    <div
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{
        borderTop: '2px solid var(--border)',
        background: 'var(--bg-surface)',
        padding: '8px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        fontFamily: 'JetBrains Mono, monospace',
        flexShrink: 0,
      }}
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,.txt,.md,.json,.yaml,.ts,.tsx,.js,.jsx,.py,.sh,.toml,.csv,.html,.css,.pdf"
        style={{ display: 'none' }}
        onChange={async e => {
          const files = Array.from(e.target.files ?? [])
          if (files.length === 0) return
          try {
            const parts = await Promise.all(files.map(fileToContentPart))
            setAttachments(prev => [...prev, ...parts])
          } catch (err) {
            console.warn('[chat] file pick error:', err)
          }
          e.target.value = ''
        }}
      />

      {/* Hidden audio input (STT) */}
      <input
        ref={audioInputRef}
        type="file"
        accept={AUDIO_ACCEPT}
        style={{ display: 'none' }}
        onChange={e => {
          const f = e.target.files?.[0] ?? null
          setSttFile(f)
          e.target.value = ''
        }}
      />

      {/* Surplus media controls strip (per modality) */}
      {isMediaMode && (
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 6,
          padding: '6px 8px',
          border: '2px solid var(--accent)',
          background: 'var(--accent-muted)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 10,
        }}>
          <span style={{
            color: 'var(--accent-text)', fontWeight: 700, letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}>
            {mediaModality ? t(`mediaControls.modality.${mediaModality}`) : ''}
          </span>

          {mediaModality === 'image' && (
            <>
              <label style={mediaCtrlLabelStyle}>{t('mediaControls.size')}
                <select value={imgSize} onChange={e => setImgSize(e.target.value)} style={mediaCtrlInputStyle}>
                  {['512x512', '768x768', '1024x1024', '1024x1792', '1792x1024'].map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label style={mediaCtrlLabelStyle}>{t('mediaControls.count')}
                <input type="number" min={1} max={4} value={imgN}
                  onChange={e => setImgN(Math.max(1, Math.min(4, Number(e.target.value) || 1)))}
                  style={{ ...mediaCtrlInputStyle, width: 44 }} />
              </label>
            </>
          )}

          {mediaModality === 'tts' && (
            <label style={mediaCtrlLabelStyle}>{t('mediaControls.voice')}
              <input type="text" value={ttsVoice} placeholder={t('mediaControls.defaultPlaceholder')}
                onChange={e => setTtsVoice(e.target.value)}
                style={{ ...mediaCtrlInputStyle, width: 120 }} />
            </label>
          )}

          {(mediaModality === 'video' || mediaModality === 'music') && (
            <label style={mediaCtrlLabelStyle}>{t('mediaControls.seconds')}
              <input type="number" min={1} max={60} value={duration}
                onChange={e => setDuration(Math.max(1, Math.min(60, Number(e.target.value) || 1)))}
                style={{ ...mediaCtrlInputStyle, width: 52 }} />
            </label>
          )}

          {mediaModality === 'music' && (
            <label style={mediaCtrlLabelStyle}>{t('mediaControls.lyrics')}
              <input type="text" value={lyrics} placeholder={t('mediaControls.optionalPlaceholder')}
                onChange={e => setLyrics(e.target.value)}
                style={{ ...mediaCtrlInputStyle, width: 160 }} />
            </label>
          )}

          {mediaModality === 'stt' && (
            <>
              <button type="button" onClick={() => audioInputRef.current?.click()} style={mediaCtrlBtnStyle}>
                {sttFile ? t('mediaControls.changeAudio') : t('mediaControls.attachAudio')}
              </button>
              {sttFile && (
                <span style={{ color: 'var(--text-muted)' }}>
                  {sttFile.name}
                  <button type="button" onClick={() => setSttFile(null)}
                    title={t('attachments.remove', { defaultValue: 'Remove' })}
                    aria-label={t('attachments.remove', { defaultValue: 'Remove' })}
                    style={{ marginLeft: 6, background: 'transparent', border: 'none', color: 'var(--text-dim)', cursor: 'pointer' }}>×</button>
                </span>
              )}
            </>
          )}

          {mediaBusy && (
            <span style={{ color: 'var(--accent-text)', marginLeft: 'auto' }}>
              {mediaProgress ? t('mediaControls.workingProgress', { progress: mediaProgress }) : t('mediaControls.working')}
            </span>
          )}
        </div>
      )}

      {/* Interim voice transcript (live partial) */}
      {/* Whisper has no partial transcript (it returns final text only), so the
          banner falls back to a translated status word rather than staying blank. */}
      {listening && (voiceInterim || whisperVoice.supported) && (
        <div style={{
          padding: '4px 8px',
          border: '2px dashed var(--accent)',
          background: 'var(--accent-muted)',
          color: 'var(--accent-text)',
          fontSize: 11,
          fontStyle: 'italic',
          marginBottom: 2,
        }}>
          🎙 {voiceInterim || (voiceProcessing ? t('composer.transcribing') : t('composer.rec'))}<span className="tachi-caret">_</span>
        </div>
      )}

      {/* Attachment pills */}
      {attachments.length > 0 && (
        <div
          role="group"
          aria-label={t('composer.attachmentsAria', { defaultValue: 'Attachments ({{count}})', count: attachments.length })}
          style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}
        >
          {attachments.map((a, i) => {
            const name = a.type === 'file' ? a.filename : t('attachments.image')
            return (
              <span
                key={i}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '2px 6px',
                  border: 'var(--border-width) solid var(--border)',
                  background: 'var(--bg-elevated)',
                  fontSize: 9, fontFamily: 'JetBrains Mono, monospace',
                  color: 'var(--text-muted)',
                }}
              >
                <span aria-hidden="true">{a.type === 'image' ? '[img]' : '[file]'}</span>{' '}
                {name}
                <button
                  type="button"
                  onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))}
                  title={t('attachments.remove', { defaultValue: 'Remove' })}
                  /* N pills all labelled "Remove" are indistinguishable in a
                     screen reader's control list — name each one by its file. */
                  aria-label={t('attachments.removeNamed', { defaultValue: 'Remove attachment {{name}}', name })}
                  style={{
                    fontSize: 10, background: 'transparent', border: 'none',
                    cursor: 'pointer', color: 'var(--text-dim)', padding: 0, lineHeight: 1,
                  }}
                >×</button>
              </span>
            )
          })}
        </div>
      )}

      {/* Slash autocomplete — registry commands + chat skills, one popup */}
      {slashOpen && slashRows.length > 0 && (
        <CommandPopup
          items={slashRows.map(r => r.item)}
          cursor={slashCursor}
          onHover={setSlashCursor}
          onPick={(_item, i) => pickSlashRow(slashRows[i])}
        />
      )}

      {/* Inline command output — LOCAL ONLY, never sent to a model */}
      <CommandNote note={cmdNote} onDismiss={() => setCmdNote(null)} />

      {/* Attached knowledge-folder chip (chat RAG) */}
      {activeRagFolder && (() => {
        // Smart-attach mode chip (UX #7): [FULL] = whole folder inlined into
        // the next send; [RAG] = per-message retrieval; '…' = still sizing.
        // The window we size the folder against. resolveContextWindow tells us
        // whether it is EVIDENCE about this model or a guess: the wildcard row
        // used to assert a flat 32k for any uncatalogued id, so a 200k model got
        // pushed to RAG and was told "32,000" as if that were its window. We
        // still budget against the assumed number (something has to decide
        // FULL-vs-RAG), but we only PRINT a window when it is known — an unknown
        // one falls through to the copy that names no number at all.
        const ctxWindow = resolveContextWindow(effectiveModelId, publishedContextTokens(activeProviderId, effectiveModelId))
        const decision = folderScan
          ? decideAttachMode(folderScan, ctxWindow.tokens)
          : null
        const mode: 'full' | 'rag' | 'pending' =
          folderScan === undefined ? 'pending' : decision?.mode === 'full' ? 'full' : 'rag'
        const modeColor =
          mode === 'full' ? 'var(--accent)' : mode === 'rag' ? 'var(--text-muted)' : 'var(--text-dim)'
        const modeTitle =
          mode === 'pending' ? t('composer.attachScanningTitle')
          : decision && ctxWindow.known
            ? t(mode === 'full' ? 'composer.attachFullTitle' : 'composer.attachRagTitle', {
                tokens: decision.estTokens.toLocaleString(),
                // The window carries its own provenance INTO the interpolation
                // ("1,000,000 (catalog)"), so the translated sentence stays a
                // sentence about a number and no locale has to learn a new key.
                window: formatContextTokens(ctxWindow) ?? '',
              })
            : t('composer.attachRagFallbackTitle')
        return (
        <div
          data-testid="rag-folder-chip"
          role="group"
          aria-label={t('composer.folderChipAria', { defaultValue: 'Attached folder: {{folder}}', folder: activeRagFolder })}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '3px 8px', marginBottom: 2, width: 'fit-content',
            border: '2px solid var(--border)', background: 'var(--bg-inset)',
            fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'var(--text-muted)',
          }}
        >
          <span aria-hidden="true" style={{ color: 'var(--accent)', fontWeight: 700 }}>[/]</span>
          <span title={activeRagFolder}>{activeRagFolder.split(/[\\/]/).pop()}</span>
          <span
            data-testid="attach-mode-chip"
            title={modeTitle}
            style={{
              padding: '0 5px',
              border: `var(--border-width) solid ${modeColor}`,
              color: modeColor,
              fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
              textTransform: 'uppercase', whiteSpace: 'nowrap',
            }}
          >
            {mode === 'pending' ? '…' : mode === 'full' ? t('composer.attachFull') : t('composer.attachRag')}
          </span>
          <button
            onClick={() => { const id = useChatStore.getState().activeConversationId; if (id) setConversationRagFolder(id, null) }}
            title={t('composer.folderDetach')}
            aria-label={t('composer.folderDetach')}
            style={{ border: 'none', background: 'transparent', color: 'var(--text-dim)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, padding: 0 }}
          >×</button>
        </div>
        )
      })()}

      {/* Input row */}
      <div style={{ display: 'flex', gap: 0, position: 'relative' }}>
        {showPrompts && (
          <PromptPicker
            currentText={text}
            activeModel={activeModel || 'auto'}
            onClose={() => setShowPrompts(false)}
            /* The composer can fill blanks in place, so the picker hands the
               template over WITH its {{vars}} intact instead of cramming an
               input per variable into a 380px popup. The Nodes Prompt node
               passes no such flag and keeps the inline form. */
            supportsBlanks
            onInsert={insertTemplate}
          />
        )}
        {/* Prompt-library picker */}
        <button
          onClick={() => setShowPrompts(v => !v)}
          title={t('composer.promptsTitle')}
          aria-label={t('composer.promptsLabel', { defaultValue: 'Prompts' })}
          style={{
            padding: '8px 10px',
            border: '2px solid var(--border)',
            borderRight: 'none',
            background: showPrompts ? 'var(--accent-muted)' : 'var(--bg-inset)',
            color: showPrompts ? 'var(--accent-text)' : 'var(--text-muted)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 11,
            cursor: 'pointer',
            alignSelf: 'stretch',
          }}
        >{t('composer.prompts')}<span style={glyphLabelStyle}>{t('composer.promptsLabel', { defaultValue: 'Prompts' })}</span></button>

        {/* Attach-folder (chat RAG over the local per-folder index) */}
        <button
          onClick={attachFolder}
          title={t('composer.attachFolderTitle')}
          aria-label={t('composer.attachFolderLabel', { defaultValue: 'Folder' })}
          data-testid="attach-folder-btn"
          style={{
            padding: '8px 10px',
            border: '2px solid var(--border)',
            borderRight: 'none',
            background: activeRagFolder ? 'var(--accent-muted)' : 'var(--bg-inset)',
            color: activeRagFolder ? 'var(--accent-text)' : 'var(--text-muted)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 11,
            cursor: 'pointer',
            alignSelf: 'stretch',
          }}
        >[/]<span style={glyphLabelStyle}>{t('composer.attachFolderLabel', { defaultValue: 'Folder' })}</span></button>

        {/* Paperclip button */}
        <button
          onClick={() => fileInputRef.current?.click()}
          title={t('composer.attachTitle')}
          aria-label={t('composer.attachLabel', { defaultValue: 'Attach' })}
          style={{
            padding: '8px 10px',
            border: '2px solid var(--border)',
            borderRight: 'none',
            background: 'var(--bg-inset)',
            color: 'var(--text-muted)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 14,
            cursor: 'pointer',
            alignSelf: 'stretch',
          }}
        >[+]<span style={{ ...glyphLabelStyle, fontSize: 8 }}>{t('composer.attachLabel', { defaultValue: 'Attach' })}</span></button>

        {/* Mic / voice-input button — three states: idle → recording → transcribing.
            `listening` already folds in whisper's post-stop processing beat, so
            "recording" is the narrower listening-but-not-yet-transcribing case. */}
        {voiceSupported && (() => {
          const recording = listening && !voiceProcessing
          const micColor  = voiceProcessing ? 'var(--warning)' : recording ? 'var(--danger)' : 'var(--text-muted)'
          const micLabel  = voiceProcessing ? t('composer.transcribing') : recording ? t('composer.rec') : t('composer.mic')
          const micTitle  = voiceProcessing ? t('composer.transcribing') : recording ? t('composer.micStop') : t('composer.micStart')
          return (
            <button
              onClick={() => { if (voiceProcessing) return; recording ? stopVoice() : startVoice() }}
              disabled={voiceProcessing}
              title={micTitle}
              aria-label={voiceProcessing ? t('composer.transcribing') : recording ? t('composer.micStopAria') : t('composer.micStartAria')}
              aria-busy={voiceProcessing}
              aria-pressed={recording}
              style={{
                padding: '8px 10px',
                border: `2px solid ${voiceProcessing || recording ? micColor : 'var(--border)'}`,
                borderRight: 'none',
                background: 'var(--bg-inset)',
                color:      micColor,
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 13,
                cursor: voiceProcessing ? 'progress' : 'pointer',
                alignSelf: 'stretch',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <span className={listening ? 'tachi-pulse-dot' : undefined} style={{ display: 'inline-block', width: 8, height: 8, background: micColor }} />
              <span style={{ fontSize: 11 }}>{micLabel}</span>
            </button>
          )
        })()}

        {/* Positioning context for the blanks layer. alignSelf:'flex-start' is
            load-bearing: as a stretched flex item this wrapper could grow taller
            than the textarea it wraps, and the layer (inset:0) would then paint
            its background past the textarea's bottom border. */}
        <div style={{ flex: 1, position: 'relative', alignSelf: 'flex-start' }}>
          {blanksActive && <TemplateSlotLayer text={text} scrollTop={slotScrollTop} />}
        <textarea
          ref={textareaRef}
          data-tour="chat-input"
          /* A placeholder is NOT an accessible name (it disappears the moment
             you type, and several screen readers ignore it outright) — and this
             one also swaps wording per media modality. The label is stable. */
          aria-label={t('composer.inputAria', { defaultValue: 'Message input' })}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          /* Keeps the blanks layer under a scrolled message aligned. Only ever
             fires work while armed — unarmed, the layer is not mounted. */
          onScroll={blanksActive ? e => setSlotScrollTop(e.currentTarget.scrollTop) : undefined}
          placeholder={
            isMediaMode
              ? (mediaModality === 'stt'
                  ? t('composer.placeholderStt')
                  : t('composer.placeholderMedia', { modality: mediaModality ? t(`mediaControls.modalityWord.${mediaModality}`) : '' }))
              : t('composer.placeholderDefault')
          }
          rows={3}
          style={{
            /* flex:1 moved to the wrapper; this fills it. Same painted box. */
            width: '100%',
            display: 'block',
            /* MUST be positioned: the slot layer is position:absolute with an
               opaque background, and an absolutely-positioned box paints OVER
               a static sibling regardless of DOM order — under bankr this hid
               every composer glyph the moment blanks armed. Positioned + later
               in the DOM = textarea paints above the layer, as the layer's own
               header contract requires. */
            position: 'relative' as const,
            padding: SLOT_TYPE_METRICS.padding,
            border: '2px solid var(--border)',
            borderRight: 'none',
            /* Transparent ONLY while the layer is mounted to paint the chips
               behind the glyphs — otherwise byte-for-byte the old background. */
            background: blanksActive ? 'transparent' : 'var(--bg-inset)',
            color: 'var(--text-primary)',
            fontFamily: SLOT_TYPE_METRICS.fontFamily,
            fontSize: SLOT_TYPE_METRICS.fontSize,
            resize: 'none' as const,
            outline: 'none',
            lineHeight: SLOT_TYPE_METRICS.lineHeight,
          }}
        />
        </div>
        {streamingMessageId
          ? <button
              onClick={() => { if (streamingConversationId) window.tachi.chat.abort(streamingConversationId) }}
              title={t('composer.stopTitle')}
              aria-label={t('composer.stopTitle')}
              style={{
                padding: '8px 14px',
                border: '2px solid var(--border)',
                background: 'var(--bg-elevated)',
                color: 'var(--danger)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
                boxShadow: '2px 2px 0 rgba(0,0,0,0.3)',
                alignSelf: 'stretch',
                whiteSpace: 'nowrap' as const,
              }}
            >
              {t('composer.stop')}
            </button>
          : <button
              data-tour="chat-send"
              /* Stable styling hook for theme structure layers: both chassis
                 themes cut a notch out of the SEND key, which is the one control
                 the mocks single out. Separate from data-tour on purpose — a tour
                 anchor can be moved or removed, a styling hook should not. */
              data-send-key=""
              /* PINCER HOOK — the two leaf spans below are the jaws the OPUS-5
                 structure sheet dresses into a closing claw (mock option 1e).
                 They are STYLING HOOKS ONLY: with no chassis sheet loaded the
                 top jaw is an unstyled inline span carrying exactly the text
                 that used to be here and the bottom jaw is empty, so every
                 other theme renders this button pixel-identically. */
              data-pincer-send=""
              onClick={() => void send()}
              disabled={!canSend}
              onMouseEnter={() => setSendHovered(true)}
              onMouseLeave={() => setSendHovered(false)}
              title={t('composer.send')}
              aria-label={t('composer.sendAria')}
              style={{
                padding: '8px 14px',
                border: '2px solid var(--accent)',
                background: sendHovered ? 'var(--accent-hover)' : 'var(--accent)',
                color: '#ffffff',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 12,
                fontWeight: 700,
                cursor: !canSend ? 'not-allowed' : 'pointer',
                boxShadow: sendHovered ? 'none' : '2px 2px 0 rgba(0,0,0,0.3)',
                transform: sendHovered ? 'translate(1px, 1px)' : 'none',
                opacity: !canSend ? 0.5 : 1,
                alignSelf: 'stretch',
                whiteSpace: 'nowrap' as const,
              }}
            >
              <span data-jaw="t">{t('composer.send')} ↵</span>
              <span data-jaw="b" />
            </button>
        }
      </div>

      {/* Fill-in-the-blanks hint. role="status" (polite) rather than an alert:
          it appears the moment a template lands, which is expected, not an
          emergency. It is the ONLY place the Escape escape-hatch is taught, so
          it must never be decoration — hence a live region, not a tooltip. */}
      {blanksActive && (
        <div
          role="status"
          data-testid="slot-hint"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '4px 2px 0',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 10,
            color: 'var(--accent-text)',
          }}
        >
          {/* `n`, not `count`: passing `count` switches i18next into plural
              resolution and would need _one/_few/_many variants per language.
              A colon phrasing carries the number with no plural rule at all,
              which is the honest thing to ask of 8 locales for a status line. */}
          <span>{t('composer.blanksHint', {
            n: slots.length,
            defaultValue: 'Blanks to fill: {{n}} — Tab to jump, Esc to send as-is',
          })}</span>
          <button
            onClick={() => setSlotsArmed(false)}
            style={{
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--text-muted)',
              fontFamily: 'inherit',
              fontSize: 9,
              padding: '1px 6px',
              cursor: 'pointer',
            }}
          >{t('composer.blanksDismiss', { defaultValue: 'send as-is' })}</button>
        </div>
      )}

      {/* Bottom row: mode chips + provider + token count */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}>
        {/* CHAT-only chip (agent toggle removed — Agent has its own page). */}
        <span
          style={{
            padding: '3px 10px',
            border: '2px solid var(--accent)',
            background: 'var(--accent-muted)',
            color: 'var(--accent-text)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}
        >
          {t('composer.modeChip')}
        </span>

        <span data-tour="chat-provider" style={{ display: 'inline-flex' }}>
          <ProviderPicker
            value={activeProviderId}
            disabled={!!streamingMessageId}
            onChange={(providerId, defaultModel) => {
              if (activeConversationId) {
                setProvider(activeConversationId, providerId, defaultModel)
              }
            }}
          />
        </span>

        {activeProviderId === 'ollama-local' && (
          <OllamaModelPicker
            value={activeModel}
            disabled={!!streamingMessageId}
            onChange={(model) => {
              if (activeConversationId) {
                setProvider(activeConversationId, 'ollama-local', model)
              }
            }}
          />
        )}

        {activeProviderId === 'llama-cpp' && (
          <LlamaCppModelPicker
            value={activeModel}
            disabled={!!streamingMessageId}
            onChange={(model) => {
              if (activeConversationId) {
                setProvider(activeConversationId, 'llama-cpp', model)
              }
            }}
          />
        )}

        {activeProviderId === 'bankr-gateway' && (
          fusionMode ? (
            <span
              title="Fusion: a panel of Bankr models answers in parallel, a judge synthesizes the best reply"
              style={{
                height: 26, display: 'inline-flex', alignItems: 'center', padding: '0 8px',
                border: '2px solid var(--border)', background: 'var(--bg-inset)', color: 'var(--text-dim)',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
                letterSpacing: '0.06em', whiteSpace: 'nowrap',
              }}
            >{fusionPreset === 'frontier' ? 'FUSION · FRONTIER' : 'FUSION · BUDGET'}</span>
          ) : surplusSmartRouting ? (
            <span
              title={t('surplus.modelAutoTitle')}
              style={{
                height: 26, display: 'inline-flex', alignItems: 'center', padding: '0 8px',
                border: '2px solid var(--border)', background: 'var(--bg-inset)', color: 'var(--text-dim)',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
                letterSpacing: '0.06em', whiteSpace: 'nowrap',
              }}
            >{t('surplus.modelAuto')}</span>
          ) : (
            <BankrModelPicker
              value={activeModel === 'auto' ? 'claude-sonnet-4.6' : activeModel}
              disabled={!!streamingMessageId}
              openUp
              onChange={(model) => {
                if (activeConversationId) {
                  setProvider(activeConversationId, 'bankr-gateway', model)
                }
              }}
            />
          )
        )}

        {activeProviderId === 'venice' && (
          fusionMode ? (
            <span
              title="Fusion: a panel of Venice models answers in parallel, a judge synthesizes the best reply"
              style={{
                height: 26, display: 'inline-flex', alignItems: 'center', padding: '0 8px',
                border: '2px solid var(--border)', background: 'var(--bg-inset)', color: 'var(--text-dim)',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
                letterSpacing: '0.06em', whiteSpace: 'nowrap',
              }}
            >{fusionPreset === 'frontier' ? 'FUSION · FRONTIER' : 'FUSION · BUDGET'}</span>
          ) : surplusSmartRouting ? (
            <span
              title={t('surplus.modelAutoTitle')}
              style={{
                height: 26, display: 'inline-flex', alignItems: 'center', padding: '0 8px',
                border: '2px solid var(--border)', background: 'var(--bg-inset)', color: 'var(--text-dim)',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
                letterSpacing: '0.06em', whiteSpace: 'nowrap',
              }}
            >{t('surplus.modelAuto')}</span>
          ) : (
            <VeniceModelPicker
              value={activeModel === 'auto' ? 'zai-org-glm-4.7' : activeModel}
              disabled={!!streamingMessageId}
              openUp
              onChange={(model) => {
                if (activeConversationId) {
                  setProvider(activeConversationId, 'venice', model)
                }
              }}
            />
          )
        )}

        {activeProviderId === 'imgnai' && (
          <ImgnaiModelPicker
            value={activeModel === 'auto' ? 'glm-5-2' : activeModel}
            disabled={!!streamingMessageId}
            openUp
            onChange={(model) => {
              if (activeConversationId) {
                setProvider(activeConversationId, 'imgnai', model)
              }
            }}
          />
        )}


        {activeProviderId === 'openrouter-oauth' && (
          <OpenRouterModelPicker
            value={activeModel === 'auto' ? 'openrouter/auto' : activeModel}
            disabled={!!streamingMessageId}
            openUp
            onChange={(model) => {
              if (activeConversationId) {
                setProvider(activeConversationId, 'openrouter-oauth', model)
              }
            }}
          />
        )}

        {activeProviderId.startsWith('custom:') && (
          <CustomModelPicker
            providerId={activeProviderId}
            value={activeModel}
            disabled={!!streamingMessageId}
            openUp
            onChange={(model) => {
              if (activeConversationId) {
                setProvider(activeConversationId, activeProviderId, model)
              }
            }}
          />
        )}

        {activeProviderId === 'surplus' && (
          (fusionMode && !isMediaMode) ? (
            <span
              title="Fusion: a panel of Surplus models answers in parallel, a judge synthesizes the best reply"
              style={{
                height: 26, display: 'inline-flex', alignItems: 'center', padding: '0 8px',
                border: '2px solid var(--border)', background: 'var(--bg-inset)', color: 'var(--text-dim)',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
                letterSpacing: '0.06em', whiteSpace: 'nowrap',
              }}
            >{fusionPreset === 'frontier' ? 'FUSION · FRONTIER' : 'FUSION · BUDGET'}</span>
          ) : (surplusSmartRouting && !isMediaMode) ? (
            <span
              title={t('surplus.modelAutoTitle')}
              style={{
                height: 26, display: 'inline-flex', alignItems: 'center', padding: '0 8px',
                border: '2px solid var(--border)', background: 'var(--bg-inset)', color: 'var(--text-dim)',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
                letterSpacing: '0.06em', whiteSpace: 'nowrap',
              }}
            >{t('surplus.modelAuto')}</span>
          ) : (
            <SurplusModelPicker
              value={isMediaMode ? '' : (activeModel === 'auto' ? 'claude-sonnet-4.5' : activeModel)}
              disabled={!!streamingMessageId || mediaBusy}
              openUp
              onChange={(model) => {
                if (activeConversationId) {
                  setProvider(activeConversationId, 'surplus', model)
                }
              }}
            />
          )
        )}

        {(activeProviderId === 'bankr-gateway' || activeProviderId === 'venice' || activeProviderId === 'surplus') && !isMediaMode && (
          <>
            <button
              onClick={() => { const next = !fusionMode; setFusionMode(next); if (next) setSurplusSmartRouting(false) }}
              disabled={!!streamingMessageId}
              title={fusionMode
                ? 'Fusion ON — a panel of models answers in parallel and a judge synthesizes the best reply'
                : 'Fusion — fan the prompt out to a panel of Bankr models + judge synthesis'}
              style={{
                height: 26, padding: '0 8px', border: '2px solid var(--border)',
                background: fusionMode ? 'var(--accent)' : 'var(--bg-inset)',
                color: fusionMode ? 'var(--bg-base)' : 'var(--text-muted)',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
                letterSpacing: '0.06em', cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >{fusionMode ? 'FUSION ON' : 'FUSION'}</button>
            {fusionMode && (
              <button
                onClick={() => setFusionPreset(fusionPreset === 'budget' ? 'frontier' : 'budget')}
                disabled={!!streamingMessageId}
                title={fusionPreset === 'frontier'
                  ? 'FRONTIER panel: claude-opus-5 + gpt-5.5 + glm-5.2, judged by claude-opus-5 (top quality, higher cost). Click for BUDGET.'
                  : 'BUDGET panel: claude-haiku + gemini-3-flash + gpt-5-mini, judged by claude-sonnet-4.6 (cheap + diverse). Click for FRONTIER.'}
                style={{
                  height: 26, padding: '0 8px', border: '2px solid var(--border)',
                  background: fusionPreset === 'frontier' ? 'var(--accent-alt)' : 'var(--bg-inset)',
                  color: fusionPreset === 'frontier' ? 'var(--bg-base)' : 'var(--text-muted)',
                  fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
                  letterSpacing: '0.06em', cursor: 'pointer', whiteSpace: 'nowrap',
                }}
              >{fusionPreset === 'frontier' ? 'FRONTIER' : 'BUDGET'}</button>
            )}
            {fusionMode && (
              <button
                data-testid="fusion-arbiter"
                onClick={() => setFusionArbiter(fusionArbiter === 'synthesize' ? 'best_of_n' : fusionArbiter === 'best_of_n' ? 'majority' : fusionArbiter === 'majority' ? 'compare' : 'synthesize')}
                disabled={!!streamingMessageId}
                title={
                  fusionArbiter === 'best_of_n'
                    ? 'best_of_n: a judge picks the single strongest answer, served verbatim (best for code / facts). Click for MAJORITY.'
                    : fusionArbiter === 'majority'
                    ? 'majority: serve the answer most models agree on — no extra LLM (best for extraction / classification). Click for COMPARE.'
                    : fusionArbiter === 'compare'
                    ? 'compare: every panel answer side-by-side with timing/tokens — YOU pick the winner, no judge. Click for SYNTH.'
                    : 'synthesize: a judge fuses the whole panel into one new answer (best for long-form / reasoning). Click for BEST·N.'
                }
                style={{
                  height: 26, padding: '0 8px', border: '2px solid var(--border)',
                  background: fusionArbiter === 'synthesize' ? 'var(--bg-inset)' : 'var(--accent-muted)',
                  color: fusionArbiter === 'synthesize' ? 'var(--text-muted)' : 'var(--accent-text)',
                  fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
                  letterSpacing: '0.06em', cursor: 'pointer', whiteSpace: 'nowrap',
                }}
              >{fusionArbiter === 'best_of_n' ? 'BEST·N' : fusionArbiter === 'majority' ? 'MAJORITY' : fusionArbiter === 'compare' ? 'COMPARE' : 'SYNTH'}</button>
            )}
            {fusionMode && (
              <ComparePanelPicker
                providerId={activeProviderId}
                value={fusionCustomPanel}
                onChange={setFusionCustomPanel}
                disabled={!!streamingMessageId}
              />
            )}
          </>
        )}

        {(activeProviderId === 'surplus' || activeProviderId === 'bankr-gateway' || activeProviderId === 'venice') && !isMediaMode && (
          <>
            <button
              onClick={() => { const next = !surplusSmartRouting; setSurplusSmartRouting(next); if (next) setFusionMode(false) }}
              disabled={!!streamingMessageId}
              title={surplusSmartRouting
                ? t('surplus.smartOnTitle')
                : autoRouted ? t('surplus.smartAutoTitle') : t('surplus.smartOffTitle')}
              style={{
                height: 26, padding: '0 8px', border: '2px solid var(--border)',
                background: surplusSmartRouting ? 'var(--accent)' : autoRouted ? 'var(--accent-muted)' : 'var(--bg-inset)',
                color: surplusSmartRouting ? 'var(--bg-base)' : autoRouted ? 'var(--accent-text)' : 'var(--text-muted)',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
                letterSpacing: '0.06em', cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >{surplusSmartRouting ? t('surplus.smartOn') : autoRouted ? t('surplus.smartAuto') : t('surplus.smartOff')}</button>
            {(surplusSmartRouting || autoRouted) && (
              <span style={{ position: 'relative', display: 'inline-flex' }}>
                <button
                  onClick={() => setTuneOpen(o => !o)}
                  disabled={!!streamingMessageId}
                  title={t('surplus.tuneTitle')}
                  aria-label={t('surplus.tuneTitle')}
                  style={{
                    height: 26, padding: '0 7px', border: '2px solid var(--border)',
                    background: tuneOpen ? 'var(--bg-elevated)' : 'var(--bg-inset)',
                    color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 10, fontWeight: 700, cursor: 'pointer',
                  }}
                >±</button>
                {tuneOpen && routerBounds && (
                  <div style={{
                    // --bg-surface exists in every theme (--bg-raised did NOT —
                    // the popover rendered transparent over the composer).
                    position: 'absolute', bottom: 32, right: 0, zIndex: 1000, width: 240,
                    border: '2px solid var(--border-strong)', background: 'var(--bg-surface)',
                    boxShadow: '4px 4px 0 var(--border)',
                    padding: 10, display: 'flex', flexDirection: 'column', gap: 8,
                    fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'var(--text-muted)',
                  }}>
                    <span style={{ color: 'var(--text-dim)' }}>{t('surplus.tuneHint')}</span>
                    <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <span>{t('surplus.tuneSimple')}</span>
                      <input
                        type="number" step={0.05} min={-1} max={0.9}
                        value={routerBounds.simpleMax}
                        onChange={e => {
                          const v = Number(e.target.value)
                          if (Number.isFinite(v)) saveRouterBounds({ ...routerBounds, simpleMax: v })
                        }}
                        style={{
                          width: 70, background: 'var(--bg-inset)', color: 'var(--text-primary)',
                          border: '2px solid var(--border)', fontFamily: 'inherit', fontSize: 10, padding: '2px 4px',
                        }}
                      />
                    </label>
                    <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <span>{t('surplus.tuneMid')}</span>
                      <input
                        type="number" step={0.05} min={-0.95} max={1}
                        value={routerBounds.midMax}
                        onChange={e => {
                          const v = Number(e.target.value)
                          if (Number.isFinite(v)) saveRouterBounds({ ...routerBounds, midMax: v })
                        }}
                        style={{
                          width: 70, background: 'var(--bg-inset)', color: 'var(--text-primary)',
                          border: '2px solid var(--border)', fontFamily: 'inherit', fontSize: 10, padding: '2px 4px',
                        }}
                      />
                    </label>
                    <button
                      onClick={() => saveRouterBounds({ simpleMax: 0.05, midMax: 0.35 })}
                      style={{
                        alignSelf: 'flex-end', padding: '2px 8px', border: '2px solid var(--border)',
                        background: 'var(--bg-inset)', color: 'var(--text-muted)',
                        fontFamily: 'inherit', fontSize: 10, fontWeight: 700, cursor: 'pointer',
                      }}
                    >{t('surplus.tuneReset')}</button>
                  </div>
                )}
              </span>
            )}
            {surplusSmartRouting && activeProviderId === 'surplus' && (
              <button
                onClick={() => setAllowWorkflowEscalation(!allowWorkflowEscalation)}
                disabled={!!streamingMessageId}
                title={allowWorkflowEscalation
                  ? t('surplus.workflowOnTitle')
                  : t('surplus.workflowOffTitle')}
                style={{
                  height: 26, padding: '0 8px', border: '2px solid var(--border)',
                  background: allowWorkflowEscalation ? 'var(--accent-muted)' : 'var(--bg-inset)',
                  color: allowWorkflowEscalation ? 'var(--accent-text)' : 'var(--text-muted)',
                  fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
                  letterSpacing: '0.06em', cursor: 'pointer', whiteSpace: 'nowrap',
                }}
              >{allowWorkflowEscalation ? t('surplus.workflowOn') : t('surplus.workflowOff')}</button>
            )}
          </>
        )}

        {activeProviderId === 'surplus' && (
          <SurplusMediaModelPicker
            value={isMediaMode ? activeModel : ''}
            disabled={!!streamingMessageId || mediaBusy}
            openUp
            onChange={(model) => {
              if (activeConversationId) {
                setProvider(activeConversationId, 'surplus', model)
              }
            }}
          />
        )}

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* ── Per-chat SAMPLER preset (T19) — provider-agnostic, hidden in media mode ── */}
        {!isMediaMode && <SamplerChip disabled={!!streamingMessageId} />}

        {/* ── Read-aloud (piper TTS) toggle — provider-agnostic ── */}
        <button
          onClick={toggleTts}
          disabled={!!streamingMessageId}
          title={ttsEnabled
            ? 'Read-aloud ON — replies are spoken via local piper TTS. Click to mute.'
            : 'Read assistant replies aloud (local piper TTS).'}
          style={{
            height: 26, padding: '0 8px', border: '2px solid var(--border)',
            background: ttsEnabled ? 'var(--accent)' : 'var(--bg-inset)',
            color: ttsEnabled ? 'var(--bg-base)' : 'var(--text-muted)',
            fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
            letterSpacing: '0.06em', cursor: 'pointer', whiteSpace: 'nowrap',
          }}
        >{ttsEnabled ? 'SPEAK ON' : 'SPEAK'}</button>

        {/* freellmapi-only controls: model picker + sort toggle */}
        {activeProviderId === 'freellmapi-local' && (
          <>
            {/* ── Model picker ─────────────────────────────────────────────── */}
            <div ref={modelDropdownRef} style={{ position: 'relative' }}>
              <button
                onClick={() => {
                  if (!freellmapiAvailable) return
                  if (!modelDropdownOpen) loadFreellmapiModels()
                  setModelDropdownOpen(o => !o)
                }}
                disabled={!freellmapiAvailable}
                title={freellmapiAvailable ? t('freellmapi.pickTitle') : t('freellmapi.unavailable')}
                style={{
                  padding: '3px 10px',
                  border: '2px solid var(--border)',
                  background: pinnedFreellmapiModel ? 'var(--accent-muted)' : 'var(--bg-inset)',
                  color: freellmapiAvailable
                    ? (pinnedFreellmapiModel ? 'var(--accent-text)' : 'var(--text-muted)')
                    : 'var(--text-dim)',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase' as const,
                  cursor: freellmapiAvailable ? 'pointer' : 'not-allowed',
                  opacity: freellmapiAvailable ? 1 : 0.45,
                  whiteSpace: 'nowrap' as const,
                  maxWidth: 220,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {freellmapiAvailable
                  ? (pinnedFreellmapiModel
                      ? t('freellmapi.modelPinned', { model: pinnedFreellmapiModel.length > 22 ? pinnedFreellmapiModel.slice(-22) : pinnedFreellmapiModel })
                      : t('freellmapi.modelAuto'))
                  : t('freellmapi.modelUnavail')
                }
              </button>

              {/* Dropdown panel */}
              {modelDropdownOpen && freellmapiAvailable && (
                <div style={{
                  position: 'absolute',
                  bottom: 'calc(100% + 4px)',
                  right: 0,
                  minWidth: 280,
                  maxHeight: 280,
                  overflowY: 'auto',
                  border: '2px solid var(--border)',
                  background: 'var(--bg-surface)',
                  boxShadow: 'var(--shadow-hard)',
                  zIndex: 200,
                  fontFamily: 'JetBrains Mono, monospace',
                }}>
                  {/* AUTO option */}
                  <button
                    onClick={() => { setPinnedFreellmapiModel(null); setModelDropdownOpen(false) }}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '7px 12px',
                      border: 'none',
                      borderLeft: pinnedFreellmapiModel === null ? '3px solid var(--accent)' : '3px solid transparent',
                      background: pinnedFreellmapiModel === null ? 'var(--accent-muted)' : 'transparent',
                      color: 'var(--text-primary)',
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 11,
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{ color: 'var(--accent)', fontWeight: 700 }}>AUTO</span>
                    <span style={{ color: 'var(--text-dim)', marginLeft: 8, fontSize: 10 }}>{t('freellmapi.fallbackChain')}</span>
                  </button>
                  <div style={{ borderTop: 'var(--border-width) solid var(--border)' }} />
                  {freellmapiModels.map(m => {
                    // THE PIN ID IS PLATFORM-QUALIFIED, and that is the contract
                    // now — not an accident. A bare model id is ambiguous:
                    // `nvidia/nemotron-3-super-120b-a12b:free` is served by BOTH
                    // openrouter and kilo, and the relay's bare lookup returns
                    // whichever row was inserted first, so the Kilo copy could
                    // not be reached by any string this dropdown could send.
                    //
                    // For a while this form simply 400'd ("is not in the
                    // catalog") because the relay only understood bare ids —
                    // every pinned relay model was unusable. The relay resolver
                    // now accepts both, bare first (so vendor-prefixed ids keep
                    // working) then split on the FIRST slash. See
                    // scripts/patches/freellmapi-kilo-zen-freeroute.patch,
                    // resolveRequestedModel(), pinned by
                    // server/src/__tests__/routes/proxy-model-addressing.test.ts.
                    const modelKey = `${m.platform}/${m.modelId}`
                    const selected = pinnedFreellmapiModel === modelKey
                    return (
                      <button
                        key={modelKey}
                        onClick={() => { setPinnedFreellmapiModel(modelKey); setModelDropdownOpen(false) }}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left',
                          padding: '6px 12px',
                          border: 'none',
                          borderLeft: selected ? '3px solid var(--accent)' : '3px solid transparent',
                          background: selected ? 'var(--accent-muted)' : 'transparent',
                          color: 'var(--text-primary)',
                          fontFamily: 'JetBrains Mono, monospace',
                          fontSize: 11,
                          cursor: 'pointer',
                        }}
                      >
                        <span style={{ color: 'var(--text-muted)', fontSize: 9, textTransform: 'uppercase' as const, letterSpacing: '0.08em' }}>{m.platform}</span>
                        <br />
                        <span style={{ fontWeight: selected ? 700 : 400 }}>{m.name}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {/* ── Routing mode toggle (UX F17) ─────────────────────────────
                Was "SORT: INTEL" — jargon. Plain language now: "Routing: smart".
                Same cycleSortMode behavior (intelligence → speed → budget);
                only the label + tooltip changed. No uppercase transform so the
                label reads exactly as written. */}
            <button
              onClick={cycleSortMode}
              disabled={!freellmapiAvailable}
              title={freellmapiAvailable
                ? t('freellmapi.routingTitle', { defaultValue: 'Chooses which free model answers first: smart = most capable, fast = quickest, cheap = lowest cost (click to cycle).' })
                : t('freellmapi.unavailable')}
              style={{
                padding: '3px 10px',
                border: '2px solid var(--border)',
                background: 'var(--bg-inset)',
                color: freellmapiAvailable ? 'var(--text-muted)' : 'var(--text-dim)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.06em',
                cursor: freellmapiAvailable ? 'pointer' : 'not-allowed',
                opacity: freellmapiAvailable ? 1 : 0.45,
                whiteSpace: 'nowrap' as const,
              }}
            >
              {freellmapiAvailable
                ? t('freellmapi.routing', {
                    mode: t(`freellmapi.routingMode.${freellmapiSortMode}`, { defaultValue: freellmapiSortMode }),
                    defaultValue: 'Routing: {{mode}}',
                  })
                : t('freellmapi.routingUnavail', { defaultValue: 'Routing: [unavail]' })
              }
            </button>
          </>
        )}

        {/* Conversation token meter — accumulated usage this chat, color-stepped.
            Resets automatically on New (new conversation has zero messages). */}
        <TokenMeter />

        {/* Draft token count for the message currently being composed */}
        {text.length > 0 && (
          <span style={{
            color: 'var(--text-dim)',
            fontSize: 10,
            fontFamily: 'JetBrains Mono, monospace',
          }}>
            {t('composer.draftTokens', { count: tokenCount.toLocaleString() })}
          </span>
        )}
      </div>
    </div>
  )
}
