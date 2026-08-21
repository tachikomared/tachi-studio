// apps/desktop/src/pages/catalog/CatalogPage.tsx
import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { CatalogEntry, QuantOption, InstalledModel, RuntimeId, Capability } from '@tachi/core'
// Import the function via its direct subpath — importing it from the '@tachi/core'
// barrel would pull node-only modules (e.g. bankr-provider's `crypto`) into the
// browser bundle and break the renderer build. Types above are `import type` and
// are erased, so the barrel is safe for them.
import { estimateFit } from '@tachi/core/src/catalog/fit'
import { useCatalogStore } from './catalog.store'
import { searchEntries } from './search'
import { useChatStore } from '../../store/chat.store'
import { HardwareBanner } from './HardwareBanner'
import { ModelCard, RUN_LABEL_KEY, type RunState } from './ModelCard'
import { blockedLocalReasonFor } from './blockedLocalRows'
import { QuantPicker } from './QuantPicker'
import { CivitaiDetailPanel } from './CivitaiDetailPanel'
import { fmtBytesPerSec, fmtEta } from '../../utils/progressFormat'
import { useVisibilityGatedInterval } from '../../hooks/useVisibilityGatedInterval'
import { formatModelSize, stopAvailability } from './rowMeta'
import {
  CIVITAI_CHIP_FAMILIES,
  CIVITAI_PERIOD_OPTIONS,
  CIVITAI_SEARCH_DEBOUNCE_MS,
  CIVITAI_SORT_OPTIONS,
  CIVITAI_TYPE_GROUPS,
  civitaiCatalogEntry,
  civitaiChipsForFamily,
  civitaiFiltersActive,
  civitaiForMyModelsUsable,
  civitaiModeNotice,
  civitaiTypeFiltersIn,
  civitaiTypeOutlook,
  shouldShowFilteredNotice,
  type CivitaiModeNotice,
  type CivitaiTypeGroup,
} from './civitaiRow'
import type { CivitaiSearchRow } from '../../types/electron'
import { useConfirm } from '../../components/ConfirmProvider'
import { mediaModalityForEntry, selectLocalMediaModel, type MediaRunModality } from './mediaHandoff'
import { useTranslation } from 'react-i18next'

// Filter chips — media modalities first (the new local-media story), then text caps.
const ALL_TAGS: Capability[] = ['image-gen', 'video-gen', 'music', 'tts', 'stt', 'chat', 'reasoning', 'vision', 'code', 'tools']

/** The one filter-chip look, shared by the capability tags and the Civitai
 *  type filter — the two chip rows occupy the same slot and must not drift. */
function chip(active: boolean): React.CSSProperties {
  return {
    padding: '2px 8px',
    border: `var(--border-width) solid ${active ? 'var(--accent)' : 'var(--border)'}`,
    background: active ? 'var(--accent-muted)' : 'transparent',
    color: active ? 'var(--accent-text)' : 'var(--text-muted)',
    fontFamily: 'JetBrains Mono, monospace', fontSize: 10, cursor: 'pointer',
  }
}

/** The small dim caption that names a chip group / a filter row. */
const FILTER_LABEL: React.CSSProperties = {
  color: 'var(--text-dim)', fontSize: 10, letterSpacing: '0.06em',
  textTransform: 'uppercase', whiteSpace: 'nowrap',
}

/**
 * Which sentence the tab prints about the mode the rows on screen came back in.
 *
 * `sfw` reuses the shipped `sfwNote` rather than a second string that says the
 * same thing in different words. The other two are new because they did not
 * exist before phase 3: 'adult' names the host the page really came from, and
 * 'adult-inert' is the contradiction — switch lit, grid safe — that the whole
 * `result.adult` round-trip exists to be able to say out loud.
 */
const MODE_KEY: Record<CivitaiModeNotice, string> = {
  sfw: 'civitai.sfwNote',
  adult: 'civitai.mode.adult',
  'adult-inert': 'civitai.mode.adultInert',
}

const MODE_COLOR: Record<CivitaiModeNotice, string> = {
  sfw: 'var(--text-dim)',
  adult: 'var(--accent)',
  'adult-inert': 'var(--danger, #c00)',
}

/** Preferred llama.cpp quant for the one-verb RUN button: the recommended one,
 *  else the smallest (best chance to fit). Null = entry is not llama.cpp-servable. */
function llamaQuant(entry: CatalogEntry): QuantOption | null {
  const qs = (entry.quants ?? []).filter(q => q.runtime === 'llamacpp')
  if (qs.length === 0) return null
  return qs.find(q => q.recommended) ?? [...qs].sort((a, b) => a.sizeBytes - b.sizeBytes)[0]
}

export function CatalogPage() {
  const navigate = useNavigate()
  const s = useCatalogStore()
  const { t } = useTranslation('catalog')
  // In-app confirm (ConfirmProvider). NOT window.confirm: in a PACKAGED
  // Electron build that opens a NATIVE modal which blocks the renderer's whole
  // event loop until it is dismissed — the window stops painting, the CDP
  // target goes dark (and the dialog isn't even CDP-visible, so
  // Page.handleJavaScriptDialog reports "no dialog"), and to anyone slower than
  // instant on the mouse — or to any automation — the app has simply hung.
  const confirm = useConfirm()
  const [picking, setPicking] = useState<CatalogEntry | null>(null)
  /** First entry into the Civitai tab kicks page one immediately; after that the
   *  query field is debounced. */
  const [civitaiBooted, setCivitaiBooted] = useState(false)
  /**
   * Which type GROUP has its chips unfolded.
   *
   * 23 chips in one row is a wall nobody reads, and hiding the 19 we cannot
   * install would be the more flattering lie (see civitaiRow's note) — so the
   * row is two levels: three group chips always visible, one group's types
   * unfolded under them. `models` is open by default because Checkpoint is the
   * filter people actually come here for; every other type is one click away,
   * and none is hidden.
   */
  const [openGroup, setOpenGroup] = useState<CivitaiTypeGroup | null>('models')

  useEffect(() => { void s.init() }, [])

  // ── Civitai: debounced search ─────────────────────────────────────────────
  // The HF tab is Enter/button-driven; this one searches as you type, and each
  // returned row costs main one thumbnail fetch — so the field is debounced and
  // the store's coordinator discards whatever answers out of order.
  useEffect(() => {
    if (s.sourceTab !== 'civitai') return
    if (!civitaiBooted) {
      setCivitaiBooted(true)
      void useCatalogStore.getState().runCivitaiSearch()
      return
    }
    // Typing on another tab still moves this query; only re-search when the
    // rows on screen were fetched for a DIFFERENT one.
    if (s.query.trim() === useCatalogStore.getState().civitaiLastQuery) return
    const h = setTimeout(() => { void useCatalogStore.getState().runCivitaiSearch() }, CIVITAI_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(h)
  }, [s.sourceTab, s.query, civitaiBooted])

  useEffect(() => {
    // Sidecar payload shape: { stage, message, percent, bytes?, totalBytes? }
    // percent is 0..100 (-1 = indeterminate). llama.cpp, sd.cpp, piper and
    // whisper all share this shape, so one handler drives the progress bar for
    // every local-engine download.
    const sidecarProg = (e: any) => {
      if (!e) return
      const pct = typeof e.percent === 'number' && e.percent >= 0 ? e.percent : 0
      const label = typeof e.message === 'string' ? e.message : t('downloading')
      if (e.stage === 'done') {
        s.setDownload(null)
        void s.refreshInstalled()
      } else if (e.stage === 'error') {
        s.setDownload(null)
      } else {
        // Preserve the ref + runtime set by download() (so Stop knows what to
        // cancel); the sidecar progress event only carries pct/speed/eta.
        const prev = useCatalogStore.getState().download
        s.setDownload({
          ref: prev?.ref ?? '', runtime: prev?.runtime, pct, label,
          speedBytesPerSec: typeof e.speedBytesPerSec === 'number' ? e.speedBytesPerSec : undefined,
          etaSec: typeof e.etaSec === 'number' ? e.etaSec : undefined,
        })
      }
    }
    const off = window.tachi.llamaCpp.onInstallProgress(sidecarProg)
    const offSd = window.tachi.sdCpp.onInstallProgress(sidecarProg)
    const offPiper = window.tachi.piper.onInstallProgress(sidecarProg)
    const offWhisper = window.tachi.whisper.onProgress(sidecarProg)
    const offPull = window.tachi.ollama.onPullProgress((e: any) => {
      const pct = e.total ? Math.round(((e.completed ?? 0) / e.total) * 100) : 0
      s.setDownload({ ref: e.name, pct, label: e.status })
      if (e.status === 'success') { s.setDownload(null); void s.refreshInstalled() }
    })
    return () => { off(); offSd(); offPiper(); offWhisper(); offPull() }
  }, [])

  // One-verb RUN (UX #9): poll the llama.cpp status surface so the button
  // states stay honest — OPEN CHAT is only ever shown while the server is
  // actually up with that model (it can be started/stopped from the Status
  // page or the Chat model picker too).
  //
  // Visibility-gated (lane V): 2.5s is the hottest poller in the app, and it
  // exists purely to keep a BUTTON LABEL honest — there is no label to keep
  // honest on a minimised window. The hook fires a catch-up tick on restore, so
  // the button is correct before it can be clicked.
  useVisibilityGatedInterval(() => { void useCatalogStore.getState().refreshLlamaStatus() }, 2500)

  /** Download entry point for the card button: a single-quant model downloads
   *  straight away — the "Choose a quant" dialog with exactly one option was a
   *  pointless extra click (every piper voice / whisper model hit it). */
  function openDownload(entry: CatalogEntry) {
    if (entry.quants.length === 1) { void download(entry, entry.quants[0]); return }
    setPicking(entry)
  }

  /** Download one quant. Returns true on success (the one-verb RUN pipeline
   *  continues to serve+chat only when this succeeds). */
  async function download(entry: CatalogEntry, q: QuantOption): Promise<boolean> {
    setPicking(null)
    s.setNotice(null)
    s.recordRecent(entry.id)
    s.setDownload({ ref: q.ref, pct: 0, label: t('starting'), runtime: q.runtime })
    console.log('[catalog] download', q.runtime, q.ref)
    try {
      const res = q.runtime === 'llamacpp'
        ? (q.url
            ? await window.tachi.llamaCpp.downloadUrl(q.ref, q.url) // arbitrary HF GGUF
            : await window.tachi.llamaCpp.downloadModel(q.ref))     // curated registry id
        : q.runtime === 'sdcpp'
          ? await window.tachi.sdCpp.downloadModel(q.ref)           // local image/video (sd.cpp)
          : q.runtime === 'piper'
            ? await window.tachi.piper.downloadVoice(q.ref)         // local TTS voice (piper)
            : q.runtime === 'whisper'
              ? await window.tachi.whisper.downloadModel(q.ref as never) // local STT model (whisper.cpp)
              : await window.tachi.ollama.pull(q.ref)
      console.log('[catalog] download result', res)
      // Both IPCs return { ok, error? } rather than throwing — surface it.
      const failed = res && typeof res === 'object' && (res as { ok?: boolean }).ok === false
      if (failed) {
        const raw = ((res as { error?: string }).error ?? '').trim()
        // Ollama's hf.co puller often returns a bare status (e.g. "400:") for
        // repos it can't handle — replace that with actionable guidance.
        const msg = q.runtime === 'ollama' && (raw === '' || /^\d{3}:?$/.test(raw))
          ? `${t('pullIncompatible')}${raw ? ` (${raw})` : ''}`
          : (raw || t('notice.downloadFailed'))
        s.setNotice({ kind: 'error', msg })
        return false
      } else {
        s.setNotice({ kind: 'ok', msg: `✓ ${entry.name} · ${q.label}` })
        await s.refreshInstalled()
        return true
      }
    } catch (err) {
      console.error('[catalog] download threw', err)
      s.setNotice({ kind: 'error', msg: err instanceof Error ? err.message : String(err) })
      return false
    } finally {
      s.setDownload(null)
    }
  }

  /**
   * Install one Civitai row.
   *
   * The row is a HINT: main re-fetches the model, re-runs the gate and re-reads
   * the download url / hash / size before a byte is written, so nothing sent
   * from here can talk main into fetching something else. What this function
   * owns is the UI truth around it.
   *
   * `runtime: 'sdcpp'` + `ref: row.id` on the shared progress strip is not
   * cosmetic: `row.id` IS the user-registry model id lane C mints
   * (`civitai-<versionId>`), so the strip's Stop routes to
   * sdCpp.cancelDownload(row.id) and pauses exactly this model's component
   * tasks — pause-and-keep, same contract as every other local weight.
   */
  async function installCivitai(row: CivitaiSearchRow) {
    if (useCatalogStore.getState().civitaiInstalling) return // one transfer, one strip
    s.setNotice(null)
    s.setCivitaiInstalling(row.id)
    s.setDownload({ ref: row.id, pct: 0, label: t('starting'), runtime: 'sdcpp' })
    console.log('[catalog] civitai install', row.id)
    try {
      const res = await window.tachi.civitai.install(row)
      console.log('[catalog] civitai install result', res)
      if (res && res.ok === false) {
        s.setNotice({ kind: 'error', msg: (res.error ?? '').trim() || t('notice.downloadFailed') })
      } else {
        s.setNotice({ kind: 'ok', msg: `✓ ${row.name}` })
      }
    } catch (err) {
      console.error('[catalog] civitai install threw', err)
      s.setNotice({ kind: 'error', msg: err instanceof Error ? err.message : String(err) })
    } finally {
      s.setCivitaiInstalling(null)
      s.setDownload(null)
      await s.refreshInstalled()
    }
  }

  /**
   * @param mediaKind The Media-studio modality for a LOCAL media row. Omitted
   *   (or null) when the caller cannot answer it honestly — then RUN opens the
   *   tab without touching the composer, which is what it always did.
   */
  async function runRuntime(
    runtime: RuntimeId, ref: string, name: string, sizeBytes: number,
    mediaKind?: MediaRunModality | null,
  ) {
    // Local media (sd.cpp image/video, piper TTS) isn't a chat model — open the
    // Media studio and SELECT it there, so RUN lands one click from GENERATE
    // instead of on whatever the last session left in the composer (mediaHandoff).
    if (runtime === 'sdcpp' || runtime === 'piper') {
      const modality = mediaKind ?? (runtime === 'piper' ? 'tts' : null)
      if (modality) selectLocalMediaModel(modality, ref)
      navigate('/media'); return
    }
    // Whisper STT has no generation surface — it's consumed by the mic in Chat.
    if (runtime === 'whisper') {
      s.setNotice({ kind: 'ok', msg: '✓ ' + t('notice.whisperReady', { name }) })
      navigate('/chat'); return
    }
    if (runtime === 'llamacpp') {
      // llama.cpp needs its server binary installed before it can serve a model.
      try {
        const st = await window.tachi.llamaCpp.status()
        if (!(st as { installed?: boolean }).installed) {
          s.setNotice({ kind: 'ok', msg: '⏳ ' + t('notice.installingLlama') })
          const ins = await window.tachi.llamaCpp.install()
          if (ins && (ins as { ok?: boolean }).ok === false) {
            s.setNotice({ kind: 'error', msg: (ins as { error?: string }).error ?? t('notice.llamaInstallFailed') })
            return
          }
        }
        s.setNotice({ kind: 'ok', msg: '⏳ ' + t('notice.loading', { name }) })
        const res = await window.tachi.llamaCpp.start({ modelId: ref, nGpuLayers: fitLayers(sizeBytes) })
        if (res && (res as { ok?: boolean }).ok === false) {
          s.setNotice({ kind: 'error', msg: (res as { error?: string }).error ?? t('notice.failedToStart') })
          return
        }
        s.setNotice(null)
      } catch (err) {
        s.setNotice({ kind: 'error', msg: err instanceof Error ? err.message : String(err) })
        return
      }
      openLlamaChat(name)
      return
    }
    const convId = useChatStore.getState().newConversation()
    useChatStore.getState().setProvider(convId, 'ollama-local', ref)
    navigate('/chat')
  }

  /** New conversation on the llama.cpp provider with this model, then → /chat. */
  function openLlamaChat(modelName: string) {
    const chat = useChatStore.getState()
    const convId = chat.newConversation()
    chat.setProvider(convId, 'llama-cpp', modelName)
    navigate('/chat')
  }

  function fitLayers(sizeBytes: number): number | undefined {
    const hw = s.hardware
    if (!hw) return undefined
    return estimateFit({ sizeBytes, hardware: hw }).suggestedGpuLayers ?? undefined
  }

  function run(entry: CatalogEntry) {
    const q = entry.quants[0]
    if (!q) return
    s.recordRecent(entry.id)
    // The entry's capability tag is where its modality lives — the card grid is
    // the one RUN surface that has the whole entry in hand.
    void runRuntime(q.runtime, q.ref, entry.name, q.sizeBytes, mediaModalityForEntry(entry))
  }

  // ── One-verb RUN (UX-benchmark #9): download → serve → chat in one click ───

  /**
   * The full pipeline for a llama.cpp-servable model:
   *   server already running with this model → straight to chat;
   *   not downloaded → download the recommended quant (existing progress UI);
   *   then install-binary-if-needed + start (runRuntime) → chat.
   * Errors surface through the existing notice banner; the button state is
   * driven by runBusyRef + the polled llamaStatus.
   */
  async function oneClickLlamaRun(opts: {
    name: string; ref: string; sizeBytes: number
    /** Needed only for the not-yet-downloaded path. */
    entry?: CatalogEntry; quant?: QuantOption
  }) {
    const store = useCatalogStore.getState()
    if (store.llamaStatus?.state === 'running' && store.llamaStatus.modelId === opts.ref) {
      openLlamaChat(opts.name)
      return
    }
    if (store.runBusyRef) return // one pipeline at a time
    s.setRunBusy(opts.ref)
    try {
      if (!store.isInstalled('llamacpp', opts.ref)) {
        if (!opts.entry || !opts.quant) return
        const ok = await download(opts.entry, opts.quant)
        if (!ok) return
      }
      await runRuntime('llamacpp', opts.ref, opts.name, opts.sizeBytes)
    } finally {
      s.setRunBusy(null)
      void useCatalogStore.getState().refreshLlamaStatus()
    }
  }

  /** Card RUN click — llama.cpp-servable entries take the one-verb pipeline,
   *  everything else keeps the legacy per-runtime behavior. */
  function onRunEntry(entry: CatalogEntry) {
    const q = llamaQuant(entry)
    if (!q) { run(entry); return }
    s.recordRecent(entry.id)
    void oneClickLlamaRun({ name: entry.name, ref: q.ref, sizeBytes: q.sizeBytes, entry, quant: q })
  }

  /** Installed-tab RUN click — same pipeline (models here are already on disk).
   *  `mediaKind` rides in on the row itself (catalog-service knows whether an sd
   *  checkpoint is image or video; the renderer must not re-guess it). */
  function onRunInstalled(m: InstalledModel) {
    if (m.runtime !== 'llamacpp') { void runRuntime(m.runtime, m.ref, m.name, m.sizeBytes, m.mediaKind); return }
    void oneClickLlamaRun({ name: m.name, ref: m.ref, sizeBytes: m.sizeBytes })
  }

  /** Button state for a llama.cpp ref, honest against the polled server status. */
  function llamaRunState(ref: string): RunState {
    if (s.runBusyRef === ref) return s.download ? 'downloading' : 'starting'
    const st = s.llamaStatus
    if (st?.modelId === ref) {
      if (st.state === 'running') return 'openChat'
      if (st.state === 'starting' || st.state === 'loading') return 'starting'
    }
    return 'run'
  }

  /** RunState for a catalog entry, or null when it isn't llama.cpp-servable. */
  function runStateFor(entry: CatalogEntry): RunState | null {
    const q = llamaQuant(entry)
    return q ? llamaRunState(q.ref) : null
  }

  /**
   * What the REMOVE dialog says, and for a multi-file sd row that is more than
   * the name.
   *
   * An sd checkpoint is a DIRECTORY whose components are hard-linked between
   * rows (one 5.6 GB umt5 encoder, three names). Deleting this row deletes THIS
   * row's names for them: the shared bytes stay, because another row still
   * holds a name for the same inode. A dialog that quoted the row's full
   * download size would promise back gigabytes the disk is going to keep, so it
   * quotes `freeableBytes` — what the delete actually returns — and then names
   * the rows that keep the rest, which is also the answer to the question the
   * number provokes ("where did the other 11 GB go?").
   */
  function removeMessage(m: InstalledModel): string {
    const lines = [t('confirmRemove'), '', m.name]
    if (m.runtime === 'sdcpp') {
      const freed = formatModelSize(m.freeableBytes ?? m.sizeBytes)
      if (freed) lines.push(t('sdRemove.frees', { size: freed }))
      if (m.sharedWith && m.sharedWith.length > 0) {
        lines.push(t('sdRemove.sharedStay', { models: m.sharedWith.join(', ') }))
      }
    }
    return lines.join('\n')
  }

  async function removeModel(m: InstalledModel) {
    const ok = await confirm({
      message: removeMessage(m),
      okLabel: t('remove'),
      danger:  true,
    })
    if (!ok) return
    // Use a sticky notice (not the % progress bar) — delete has no progress and
    // a frozen "0%" looked like a hang.
    s.setNotice({ kind: 'ok', msg: '⏳ ' + t('removing') + ' ' + m.name })
    console.log('[catalog] remove', m.runtime, m.ref)
    try {
      const res = m.runtime === 'llamacpp'
        ? await window.tachi.llamaCpp.removeModel(m.ref)
        // Speech weights now list on the Installed tab (catalog-service), so
        // REMOVE has to route per runtime — deleting a piper voice through
        // ollama.delete() would have been a confident no-op error.
        : m.runtime === 'piper'
          ? await window.tachi.piper.removeVoice(m.ref)
          : m.runtime === 'whisper'
            ? await window.tachi.whisper.removeModel(m.ref as never)
            // sd.cpp image/video weights. This IPC has been complete since the
            // engine landed and had ZERO renderer callers — the multi-GB rows
            // were listed nowhere, so nothing could ask it to free them. It
            // drops the row's own component directory, which is exactly the
            // right blast radius: a shared component's OTHER hard link lives in
            // the other row's directory and survives untouched, which is why the
            // dialog above quotes freeableBytes rather than the row size.
            //
            // KNOWN ASYMMETRY, stated rather than hidden: `sd-cpp:remove-model`
            // drops the WEIGHTS only. `sd-cpp:remove-adapter` also drops the
            // user-registry row (removeUserSdAdapter), and the model twin
            // (removeUserSdModel) exists and is not called. A user checkpoint
            // therefore leaves a few hundred bytes of recipe behind — it stops
            // being installed everywhere that matters (isSdModelInstalled reads
            // the disk), and its Civitai card goes back to offering INSTALL. The
            // gigabytes, which is what this lane is about, are gone.
            : m.runtime === 'sdcpp'
              ? await window.tachi.sdCpp.removeModel(m.ref)
              : await window.tachi.ollama.delete(m.ref)
      console.log('[catalog] remove result', res)
      const failed = res && typeof res === 'object' && (res as { ok?: boolean }).ok === false
      if (failed) {
        s.setNotice({ kind: 'error', msg: (res as { error?: string }).error ?? t('notice.removeFailed') })
      } else {
        s.setNotice({ kind: 'ok', msg: `🗑 ${m.name}` })
      }
      await s.refreshInstalled()
    } catch (err) {
      console.error('[catalog] remove threw', err)
      s.setNotice({ kind: 'error', msg: err instanceof Error ? err.message : String(err) })
    }
  }

  // Opening the Installed tab is an explicit "manage my models" action, so it's
  // OK to start Ollama here (its serve process may be down — on Windows it dies
  // with the app — leaving on-disk models invisible until /api/tags responds).
  async function openInstalled() {
    s.setSourceTab('installed')
    try {
      const st = await window.tachi.ollama.status()
      if (!st.running) {
        s.setNotice({ kind: 'ok', msg: t('notice.startingOllama') })
        await window.tachi.ollama.ensureRunning()
        s.setNotice(null)
      }
    } catch { /* Ollama not installed — llama.cpp models still listed */ }
    await s.refreshInstalled()
  }

  const baseList = s.sourceTab === 'curated' ? s.curated : s.hfResults
  // On the HF tab the query is the remote search term — results are already
  // filtered/ranked by the API; only apply the capability tag pre-filter locally.
  // On the Curated tab use the weighted multi-factor scorer (search.ts).
  const list = s.sourceTab === 'hf'
    ? (s.activeTags.length === 0
        ? s.hfResults
        : s.hfResults.filter(e => (e.capabilities ?? []).some(c => s.activeTags.includes(c))))
    : searchEntries(baseList, s.query, s.activeTags)

  // Build lookup maps for quick access in the curated tab sections.
  // Favorites section: all favorited entries that are in the curated list.
  // Recents section: last RECENTS_CAP run/downloaded entries from the curated list.
  // Only show these sections on the Curated tab when there is no active search
  // query AND no capability chip: the band ignored activeTags, so clicking
  // "image gen" still showed a favorited piper voice ABOVE a correctly-filtered
  // grid — the checkpoint-B driver read that as the filter not working at all.
  const allCuratedById = new Map(s.curated.map(e => [e.id, e]))
  const showSections = s.sourceTab === 'curated' && s.query.trim() === '' && s.activeTags.length === 0

  const favEntries: CatalogEntry[] = showSections
    ? s.favorites.map(id => allCuratedById.get(id)).filter((e): e is CatalogEntry => e !== undefined)
    : []

  const recentEntries: CatalogEntry[] = showSections
    ? s.recents.map(id => allCuratedById.get(id)).filter((e): e is CatalogEntry => e !== undefined)
    : []

  // In the main grid, sort favorites to the top (stable: favorites first, then rest).
  const sortedList = showSections && s.favorites.length > 0
    ? [
        ...list.filter(e => s.favorites.includes(e.id)),
        ...list.filter(e => !s.favorites.includes(e.id)),
      ]
    : list

  return (
    <div style={{ height: '100%', overflow: 'auto', fontFamily: 'JetBrains Mono, monospace' }}>
      <HardwareBanner hw={s.hardware} />

      <div data-tour="catalog-search" style={{ display: 'flex', gap: 8, padding: '10px 16px', alignItems: 'center' }}>
        <button onClick={() => s.setSourceTab('curated')} style={tab(s.sourceTab === 'curated')}>{t('tabCurated')}</button>
        <button onClick={() => s.setSourceTab('hf')} style={tab(s.sourceTab === 'hf')}>{t('tabSearchHf')}</button>
        <button onClick={() => s.setSourceTab('civitai')} style={tab(s.sourceTab === 'civitai')}>{t('tabCivitai')}</button>
        <button onClick={() => void openInstalled()} style={tab(s.sourceTab === 'installed')}>
          {t('tabInstalled')}{s.installed.length > 0 ? ` (${s.installed.length})` : ''}
        </button>
        {s.sourceTab !== 'installed' && (
          <>
            <input value={s.query} onChange={e => s.setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && s.sourceTab === 'hf') void s.runHfSearch() }}
              placeholder={s.sourceTab === 'hf' ? t('searchPlaceholder')
                : s.sourceTab === 'civitai' ? t('civitai.searchPlaceholder')
                : t('filterByName')}
              style={{ flex: 1, padding: '6px 8px', background: 'var(--bg-base)',
                border: 'var(--border-width) solid var(--border)', color: 'var(--text-primary)',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }} />
            {s.sourceTab === 'hf' && <button onClick={() => void s.runHfSearch()} style={tab(false)}>{t('searchButton')}</button>}
          </>
        )}
      </div>

      {/* Capability-tag filter (multi-select) — find image/video/local models fast */}
      {(s.sourceTab === 'curated' || s.sourceTab === 'hf') && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 16px 8px', alignItems: 'center' }}>
          {ALL_TAGS.map(tag => (
            <button key={tag} onClick={() => s.toggleTag(tag)} style={chip(s.activeTags.includes(tag))}>
              {t(`capabilities.${tag}`)}
            </button>
          ))}
          {s.activeTags.length > 0 && (
            <button onClick={() => s.clearTags()} style={{
              padding: '2px 8px', border: 'none', background: 'transparent',
              color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, cursor: 'pointer',
            }}>{t('clear')}</button>
          )}
        </div>
      )}

      {/* Civitai filters — the SAME chip look as the capability tags, mapped to
          the API's own `types=` / `sort=` / `period=` / `baseModels=` values.
          Not the capability tags themselves: every Civitai row is an
          image-model artifact, so a modality filter would have exactly one chip
          and would never narrow anything.

          FOUR CONTROLS, THREE SELECTION RULES: type is single-select (types=
          narrows, it does not widen), sort and period are single-select
          because the API takes one of each, and baseModels is MULTI because it
          is a repeatable param — two chips is a union server-side and still
          one request. */}
      {s.sourceTab === 'civitai' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '0 16px 8px' }}>
          {/* Level 1 — All + the three groups. A group chip is a DISCLOSURE
              control, not a filter: it unfolds that group's types and never
              changes what is searched. It lights up when the active type lives
              inside it, so the current filter is locatable even while folded. */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <button onClick={() => s.setCivitaiType('all')} style={chip(s.civitaiType === 'all')}>
              {t('civitai.types.all')}
            </button>
            {CIVITAI_TYPE_GROUPS.map(g => {
              const holdsActive = civitaiTypeFiltersIn(g).some(f => f.id === s.civitaiType)
              return (
                <button
                  key={g}
                  onClick={() => setOpenGroup(openGroup === g ? null : g)}
                  aria-expanded={openGroup === g}
                  style={{ ...chip(holdsActive), fontWeight: 700 }}
                >{t(`civitai.groups.${g}`)}{openGroup === g ? ' ▾' : ' ▸'}</button>
              )
            })}
          </div>

          {/* Level 2 — the unfolded group's types. */}
          {openGroup && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              {civitaiTypeFiltersIn(openGroup).map(f => (
                <button key={f.id} onClick={() => s.setCivitaiType(f.id)} style={chip(s.civitaiType === f.id)}>
                  {t(`civitai.types.${f.id}`)}
                </button>
              ))}
            </div>
          )}

          {/* What picking this type will actually get you, said BEFORE the
              search runs. The card already refuses per row with main's own
              reason; without this line a user who picks DoRA gets 24 refusals
              and no explanation of the pattern. */}
          {civitaiTypeOutlook(s.civitaiType) && (
            <div style={{ color: 'var(--text-dim)', fontSize: 10 }}>
              {t(`civitai.outlook.${civitaiTypeOutlook(s.civitaiType)}`)}
            </div>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <span style={FILTER_LABEL}>{t('civitai.sortLabel')}</span>
            {CIVITAI_SORT_OPTIONS.map(o => (
              <button key={o.id} onClick={() => s.setCivitaiSort(o.id)} style={chip(s.civitaiSort === o.id)}>
                {t(`civitai.sort.${o.id}`)}
              </button>
            ))}
            <span style={{ ...FILTER_LABEL, marginLeft: 6 }}>{t('civitai.periodLabel')}</span>
            {CIVITAI_PERIOD_OPTIONS.map(o => (
              <button key={o.id} onClick={() => s.setCivitaiPeriod(o.id)} style={chip(s.civitaiPeriod === o.id)}>
                {t(`civitai.period.${o.id}`)}
              </button>
            ))}
          </div>

          {/* ── FOR MY MODELS ──────────────────────────────────────────────
              The one control that answers "is any of this useful to ME". ON,
              it constrains `baseModels=` to the families actually installed
              and points the type chip at LoRA.

              DISABLED, never hidden, when nothing is installed: an empty
              constraint sends no filter and would behave exactly like OFF, so
              the switch would lie about having done something. A disabled chip
              says the true thing instead — install a model and this works. */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {(() => {
              const usable = civitaiForMyModelsUsable(s.civitaiInstalledFamilies)
              return (
                <button
                  onClick={() => s.setCivitaiForMyModels(!s.civitaiForMyModels)}
                  disabled={!usable}
                  aria-pressed={s.civitaiForMyModels}
                  title={usable ? t('civitai.forMyModelsHint') : t('civitai.forMyModelsEmpty')}
                  style={{
                    ...chip(s.civitaiForMyModels),
                    fontWeight: 700,
                    opacity: usable ? 1 : 0.45,
                    cursor: usable ? 'pointer' : 'not-allowed',
                  }}
                >{t('civitai.forMyModels')}</button>
              )
            })()}
            {s.civitaiForMyModels && (
              <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>
                {t('civitai.forMyModelsActive', { families: s.civitaiInstalledFamilies.join(', ') })}
              </span>
            )}
          </div>

          {/* Base model — the filter that narrows to rows for a family we run.
              Shown in Civitai's own spelling in every locale: these are the
              exact strings sent as `baseModels=`, and a localised "SDXL 1.0"
              would be a different filter than the one on the wire.

              GROUPED BY FAMILY, one labelled sub-row each. Thirteen chips in a
              single flow is a menu; four short named rows is a filter. The
              rows are dimmed while "for my models" owns the constraint, since
              clicking one there would silently take it over. */}
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 4,
            opacity: s.civitaiForMyModels ? 0.5 : 1,
          }}>
            {CIVITAI_CHIP_FAMILIES.map(fam => (
              <div key={fam} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                <span style={FILTER_LABEL}>
                  {fam === CIVITAI_CHIP_FAMILIES[0] ? t('civitai.baseLabel') : ''}
                </span>
                <span style={{ ...FILTER_LABEL, minWidth: 46 }}>{t(`civitai.families.${fam}`)}</span>
                {civitaiChipsForFamily(fam).map(c => (
                  <button
                    key={c.value}
                    onClick={() => s.toggleCivitaiBase(c.value)}
                    style={chip(s.civitaiBaseModels.includes(c.value))}
                  >
                    {c.value}
                  </button>
                ))}
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {civitaiFiltersActive({
              type: s.civitaiType, sort: s.civitaiSort,
              period: s.civitaiPeriod, baseModels: s.civitaiBaseModels,
              forMyModels: s.civitaiForMyModels,
            }) && (
              <button onClick={() => s.clearCivitaiFilters()} style={{
                padding: '2px 8px', border: 'none', background: 'transparent',
                color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, cursor: 'pointer',
              }}>{t('civitai.clearFilters')}</button>
            )}
          </div>

          {/* The mode the rows on screen were ACTUALLY served in — main's
              `result.adult`, not the local setting. 'adult-inert' (switch on,
              page safe) is the state this line exists for. */}
          {(() => {
            const notice = civitaiModeNotice({
              served: s.civitaiAdultServed,
              adultMode: s.civitaiAdultState?.adultMode,
              unlocked: s.civitaiAdultState?.unlocked,
            })
            return <div style={{ color: MODE_COLOR[notice], fontSize: 10 }}>{t(MODE_KEY[notice])}</div>
          })()}
        </div>
      )}

      {s.hfError && s.sourceTab === 'hf' && (
        <div style={{ padding: '0 16px 8px', color: 'var(--danger, #c00)', fontSize: 11 }}>{s.hfError}</div>
      )}
      {/* Civitai failure: the message AND a way out. Driver-measured ~8
          intermittent 503s in 35 minutes; main now retries a 5xx once by
          itself, and this is the human-paced second opinion for the times that
          was not enough — without it the only recovery was retyping the query,
          which reads as "the feature is broken". */}
      {s.civitaiError && s.sourceTab === 'civitai' && (
        <div style={{
          padding: '0 16px 8px', color: 'var(--danger, #c00)', fontSize: 11,
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        }}>
          <span>{s.civitaiError}</span>
          <button
            onClick={() => void s.runCivitaiSearch()}
            disabled={s.civitaiLoading}
            style={{ ...tab(false), fontSize: 10, padding: '2px 8px', ...(s.civitaiLoading ? { opacity: 0.6, cursor: 'default' } : null) }}
          >{t('civitai.tryAgain')}</button>
          {/* WHERE THE KEY LIVES. A stored key raises the rate limit, and rate
              limiting is what most of these failures are — but the card that
              takes one was filed under "Search" in Settings and the owner's
              report was that it could not be found at all. An error with no
              next step is what trains people to conclude a feature is broken,
              so the next step ships next to the error. */}
          <button
            onClick={() => {
              sessionStorage.setItem('tachi:settings-scroll', 'api-keys')
              navigate('/settings?tab=connections')
            }}
            style={{ ...tab(false), fontSize: 10, padding: '2px 8px' }}
          >{t('civitai.keyHint')}</button>
        </div>
      )}
      {/* The SFW gate is not silent any more: a 24-row page that renders 2
          cards says why. The gate itself is untouched — this is the count, not
          a knob. */}
      {s.sourceTab === 'civitai' && shouldShowFilteredNotice(s.civitaiFilteredCount, { loading: s.civitaiLoading }) && (
        <div style={{ padding: '0 16px 8px', color: 'var(--text-dim)', fontSize: 10 }}>
          {t('civitai.filteredNotice', { count: s.civitaiFilteredCount })}
        </div>
      )}
      {s.download && (
        <div style={{ padding: '0 16px 8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 11, color: 'var(--text-primary)', marginBottom: 4 }}>
            <span>
              ⏳ {s.download.label} — {s.download.pct}%
              {s.download.speedBytesPerSec ? ` — ${fmtBytesPerSec(s.download.speedBytesPerSec)}` : ''}
              {s.download.etaSec && s.download.etaSec > 0 ? ` — ETA ${fmtEta(s.download.etaSec)}` : ''}
            </span>
            {/* Stop for every runtime whose weights the download-manager can
                PAUSE. Stop keeps the .part files — the strip and a re-click
                both resume from the same offset.
                  llamacpp — GGUF weights (multi-GB)
                  sdcpp    — model components (multi-GB)
                  whisper  — ggml weights (75 MB … 1.5 GB for medium.en)
                  piper    — the voice .onnx (~60 MiB, every curated voice)
                piper/whisper used to be ungated on a "small enough that Stop is
                noise" call; medium.en at ~1.5 GB is not noise, and both route
                through the manager exactly like the other two. The piper
                `.onnx.json` sidecar (a few KB, legacy path) is NOT pausable —
                a Stop inside that window is a no-op, which the IPC reports as
                cancelled:false rather than pretending.

                DISABLED while stopAvailability() is 'pending' — this strip goes
                up on the DOWNLOAD click, before the IPC has even reached main,
                so for the first moment there is no manager task to pause and
                the click did nothing at all, silently. See rowMeta. */}
            {stopAvailability(s.download) !== 'hidden' && (() => {
              const pending = stopAvailability(s.download) === 'pending'
              const label = t('stopDownload', { defaultValue: 'Stop' })
              return (
              <button
                disabled={pending}
                aria-disabled={pending}
                onClick={() => {
                  const d = s.download
                  if (!d?.ref || stopAvailability(d) !== 'ready') return
                  const stop = d.runtime === 'sdcpp'
                    ? window.tachi.sdCpp.cancelDownload(d.ref)
                    : d.runtime === 'piper'
                      ? window.tachi.piper.cancelDownload(d.ref)
                      : d.runtime === 'whisper'
                        ? window.tachi.whisper.cancelDownload(d.ref as never)
                        : window.tachi.llamaCpp.cancelDownload(d.ref)
                  // Say so when nothing was pausable (already verifying, or the
                  // non-managed piper sidecar step) instead of leaving the user
                  // to read a still-moving bar as a failed click.
                  stop.then(r => {
                    if (r && typeof r === 'object' && 'cancelled' in r && r.cancelled === false) {
                      s.setNotice({ kind: 'ok', msg: t('notice.nothingToStop') })
                    }
                  }).catch(() => {})
                }}
                title={pending ? t('notice.stopNotYet') : label}
                style={{
                  padding: '2px 8px',
                  border: `var(--border-width) solid ${pending ? 'var(--border)' : 'var(--danger, #c00)'}`,
                  background: 'transparent',
                  color: pending ? 'var(--text-dim)' : 'var(--danger, #c00)',
                  fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
                  cursor: pending ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
                  opacity: pending ? 0.6 : 1,
                }}
              >{label}</button>
              )
            })()}
          </div>
          <div style={{ height: 4, background: 'var(--border)' }}>
            <div style={{ height: '100%', width: `${s.download.pct}%`, background: 'var(--accent)', transition: 'width .2s' }} />
          </div>
        </div>
      )}
      {s.notice && (
        <div style={{
          margin: '0 16px 8px', padding: '6px 10px', fontSize: 11,
          border: `var(--border-width) solid ${s.notice.kind === 'error' ? 'var(--danger, #c00)' : 'var(--accent)'}`,
          color: s.notice.kind === 'error' ? 'var(--danger, #c00)' : 'var(--text-primary)',
        }}>
          {s.notice.msg}
        </div>
      )}

      {s.sourceTab === 'installed' ? (
        s.installed.length === 0 ? (
          <div style={{ padding: '16px', color: 'var(--text-muted)', fontSize: 11 }}>{t('emptyInstalled')}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 16px 24px' }}>
            {s.installed.map(m => (
              <InstalledRow key={`${m.runtime}:${m.ref}`} m={m}
                runState={m.runtime === 'llamacpp' ? llamaRunState(m.ref) : null}
                onRun={() => onRunInstalled(m)}
                onRemove={() => void removeModel(m)} />
            ))}
          </div>
        )
      ) : s.sourceTab === 'civitai' ? (
        <div style={{ padding: '0 0 24px' }}>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: 10, padding: '0 16px',
          }}>
            {s.civitaiLoading && s.civitaiRows.length === 0 && Array.from({ length: 8 }, (_, i) => (
              <div key={`cvsk${i}`} className="tachi-skeleton" style={{
                height: 220, border: 'var(--border-width) solid var(--border)',
                background: 'var(--bg-elevated)',
              }} />
            ))}
            {s.civitaiRows.map(row => (
              <ModelCard
                key={row.id}
                entry={civitaiCatalogEntry(row)}
                hw={s.hardware}
                civitai={row}
                /* The mode the PAGE was served in, never the local setting: a
                   user whose key was removed mid-session is browsing .com, and
                   their previews must behave like it (no theatre blur). */
                adultServed={s.civitaiAdultServed === true}
                installed={s.isInstalled('sdcpp', row.id)}
                installing={s.civitaiInstalling === row.id}
                favorite={false}
                runState={null}
                onInstall={() => void installCivitai(row)}
                onDownload={() => void installCivitai(row)}
                /* The read. The card says what the model IS only through chips;
                   this is where the uploader's own words live. */
                onOpenDetail={() => s.openCivitaiDetail(row)}
                /* Same one-verb handoff as the curated cards. Only a CHECKPOINT
                   gets a model write: an installed LoRA/VAE row is not a model
                   the composer can select — it is offered by the adapter picker
                   INSIDE the image composer — so RUN takes it to the local image
                   route and stops there rather than naming it as the model and
                   watching the studio silently re-default. Every Civitai
                   checkpoint we install is an image row (user-registry rows are
                   `kind: 'image'` by construction). */
                onRun={() => {
                  if (row.type === 'Checkpoint') selectLocalMediaModel('image', row.id)
                  else selectLocalMediaModel('image', '')
                  navigate('/media')
                }}
                onToggleFavorite={() => { /* favorites are curated-only — no star on these cards */ }}
              />
            ))}
          </div>
          {/* Cursor paging. The button exists ONLY while the server handed back
              a nextCursor — there is no page number to fabricate, and no "load
              more" offered when there is provably nothing more. */}
          {s.civitaiCursor && !s.civitaiLoading && (
            <div style={{ padding: '12px 16px 0', display: 'flex', justifyContent: 'center' }}>
              <button
                onClick={() => void s.loadMoreCivitai()}
                disabled={s.civitaiLoadingMore}
                style={{
                  ...tab(false), fontWeight: 700,
                  ...(s.civitaiLoadingMore ? { opacity: 0.6, cursor: 'default' } : null),
                }}
              >{s.civitaiLoadingMore ? t('civitai.loadingMore') : t('civitai.loadMore')}</button>
            </div>
          )}
          {!s.civitaiLoading && s.civitaiRows.length === 0 && (
            <div style={{ padding: '32px 16px', textAlign: 'center', fontSize: 11, color: 'var(--text-muted)' }}>
              {s.civitaiError ? t('civitai.emptyAfterError') : t('civitai.empty')}
            </div>
          )}
        </div>
      ) : (
        <div style={{ padding: '0 0 24px' }}>
          {/* Favorites section — only on Curated tab with no active query */}
          {favEntries.length > 0 && (
            <div style={{ padding: '0 16px 16px' }}>
              <div style={{ fontSize: 10, color: 'var(--text-dim)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>
                {t('sectionFavorites')}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
                {favEntries.map(entry => (
                  <ModelCard key={`fav:${entry.id}`} entry={entry} hw={s.hardware} catalog={[...s.curated, ...s.hfResults]}
                    installed={entry.quants.some(q => s.isInstalled(q.runtime, q.ref))}
                    favorite={s.favorites.includes(entry.id)}
                    runState={runStateFor(entry)}
                    blockedReason={blockedLocalReasonFor(entry.id)}
                    onDownload={() => openDownload(entry)}
                    onRun={() => onRunEntry(entry)}
                    onToggleFavorite={() => s.toggleFavorite(entry.id)} />
                ))}
              </div>
            </div>
          )}

          {/* Recents section — only on Curated tab with no active query */}
          {recentEntries.length > 0 && (
            <div style={{ padding: '0 16px 16px' }}>
              <div style={{ fontSize: 10, color: 'var(--text-dim)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>
                {t('sectionRecent')}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
                {recentEntries.map(entry => (
                  <ModelCard key={`recent:${entry.id}`} entry={entry} hw={s.hardware} catalog={[...s.curated, ...s.hfResults]}
                    installed={entry.quants.some(q => s.isInstalled(q.runtime, q.ref))}
                    favorite={s.favorites.includes(entry.id)}
                    runState={runStateFor(entry)}
                    blockedReason={blockedLocalReasonFor(entry.id)}
                    onDownload={() => openDownload(entry)}
                    onRun={() => onRunEntry(entry)}
                    onToggleFavorite={() => s.toggleFavorite(entry.id)} />
                ))}
              </div>
            </div>
          )}

          {/* Main grid */}
          {(favEntries.length > 0 || recentEntries.length > 0) && (
            <div style={{ fontSize: 10, color: 'var(--text-dim)', letterSpacing: '0.08em', textTransform: 'uppercase', padding: '0 16px 8px' }}>
              {t('sectionAll')}
            </div>
          )}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: 10, padding: '0 16px',
          }}>
            {/* Skeleton while the registry loads — never a silent blank grid. */}
            {s.loading && sortedList.length === 0 && Array.from({ length: 8 }, (_, i) => (
              <div key={`sk${i}`} className="tachi-skeleton" style={{
                height: 120, border: 'var(--border-width) solid var(--border)',
                background: 'var(--bg-elevated)',
              }} />
            ))}
            {sortedList.map(entry => (
              <ModelCard key={entry.id} entry={entry} hw={s.hardware} catalog={[...s.curated, ...s.hfResults]}
                installed={entry.quants.some(q => s.isInstalled(q.runtime, q.ref))}
                favorite={s.favorites.includes(entry.id)}
                runState={runStateFor(entry)}
                /* A row we refuse to ship renders its REASON instead of any
                   button — see blockedLocalRows / ModelCard's honesty branch. */
                blockedReason={blockedLocalReasonFor(entry.id)}
                onDownload={() => openDownload(entry)}
                onRun={() => onRunEntry(entry)}
                onToggleFavorite={() => s.toggleFavorite(entry.id)} />
            ))}
          </div>
          {/* Explicit empty states — a failed registry load gets a RETRY, a
              too-narrow filter gets a "clear filters" hint. */}
          {!s.loading && sortedList.length === 0 && (
            s.sourceTab === 'curated' && s.query.trim() === '' && s.activeTags.length === 0 ? (
              <div style={{ padding: '32px 16px', textAlign: 'center', fontSize: 11, color: 'var(--text-muted)' }}>
                <div style={{ marginBottom: 10 }}>{t('emptyCurated', { defaultValue: 'The model registry could not be loaded.' })}</div>
                <button onClick={() => void s.init()} style={{ ...tab(false), fontWeight: 700 }}>
                  {t('retry', { defaultValue: 'Retry' })}
                </button>
              </div>
            ) : s.sourceTab === 'curated' ? (
              <div style={{ padding: '32px 16px', textAlign: 'center', fontSize: 11, color: 'var(--text-muted)' }}>
                {t('noMatches', { defaultValue: 'No models match — adjust the search or clear the filters.' })}
              </div>
            ) : null
          )}
        </div>
      )}

      {picking && (
        <QuantPicker entry={picking} hw={s.hardware}
          onPick={(q) => void download(picking, q)}
          onClose={() => setPicking(null)} />
      )}

      {/* THE READ — "user should be able to open and read what about that
          checkpoint or lora".
          Rendered from the STORED ROW rather than looked back up out of
          `civitaiRows`: a re-search (or a "load more") replaces that array, and a
          panel that emptied itself because the grid behind it changed would be a
          bug the user cannot explain. Escape, the focus trap and focus restore
          all come from <Modal>/useDialog — the app's own dialog precedent. */}
      {s.civitaiDetail && s.civitaiDetailRow && (
        <CivitaiDetailPanel
          row={s.civitaiDetailRow}
          state={s.civitaiDetail}
          installed={s.isInstalled('sdcpp', s.civitaiDetailRow.id)}
          installing={s.civitaiInstalling === s.civitaiDetailRow.id}
          adultServed={s.civitaiAdultServed === true}
          onClose={() => s.closeCivitaiDetail()}
          onRetry={() => void s.retryCivitaiDetail()}
          onInstall={() => {
            const row = s.civitaiDetailRow
            if (!row) return
            // The panel closes on Install: the progress lives in the shared strip
            // above the grid, and a modal sitting over the only progress bar in
            // the app would hide the thing the click just started.
            s.closeCivitaiDetail()
            void installCivitai(row)
          }}
          onRun={() => {
            const row = s.civitaiDetailRow
            if (!row) return
            s.closeCivitaiDetail()
            // Same one-verb handoff as the card: only a CHECKPOINT is a model the
            // composer can select — an installed LoRA/VAE is offered by the
            // adapter picker inside the composer instead.
            if (row.type === 'Checkpoint') selectLocalMediaModel('image', row.id)
            else selectLocalMediaModel('image', '')
            navigate('/media')
          }}
        />
      )}
    </div>
  )
}

function InstalledRow({ m, runState, onRun, onRemove }: {
  m: InstalledModel
  /** One-verb RUN state for llama.cpp rows (null = legacy Run button). */
  runState?: RunState | null
  onRun: () => void
  onRemove: () => void
}) {
  const { t } = useTranslation('catalog')
  // Binary-unit formatter shared with the cards: the old hardcoded GB.toFixed(1)
  // rendered every piper voice and small whisper weight as "0.1 GB" / "0.0 GB".
  const size = formatModelSize(m.sizeBytes) ?? ''
  const busy = runState === 'downloading' || runState === 'starting'
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px',
      border: 'var(--border-width) solid var(--border)', background: 'var(--bg-elevated)',
      fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: 'var(--text-primary)', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>{m.runtime}{size ? ` · ${size}` : ''}</div>
        {/* WHY THIS ROW READS SMALLER THAN ITS DOWNLOAD SIZE. The size above is
            this row's own disk claim: a component hard-linked into several rows
            is charged once, to the first row holding it (catalog-service's
            shared-bytes rule), because the bytes exist once. Without this line a
            17.6 GB model listing as 6 GB looks like a bug in the number rather
            than the truth about the volume. */}
        {m.sharedWith && m.sharedWith.length > 0 && (
          <div style={{ color: 'var(--text-dim)', fontSize: 10 }}>
            {t('sdRemove.sharedWith', { models: m.sharedWith.join(', ') })}
          </div>
        )}
      </div>
      <button onClick={onRun} disabled={busy}
        style={{ ...rowBtn('var(--accent)'), ...(busy ? { opacity: 0.6, cursor: 'default' } : null) }}>
        {runState ? t(RUN_LABEL_KEY[runState]) : t('run')}
      </button>
      <button onClick={onRemove} style={rowBtn('var(--danger, #c00)')}>{t('remove')}</button>
    </div>
  )
}

function rowBtn(border: string): React.CSSProperties {
  return {
    padding: '5px 10px', border: `var(--border-width) solid ${border}`,
    background: 'transparent', color: 'var(--text-primary)',
    fontFamily: 'JetBrains Mono, monospace', fontSize: 11, cursor: 'pointer', flexShrink: 0,
  }
}

function tab(active: boolean): React.CSSProperties {
  return {
    padding: '6px 10px',
    border: 'var(--border-width) solid var(--border)',
    background: active ? 'var(--accent-muted)' : 'transparent',
    color: active ? 'var(--accent-text)' : 'var(--text-muted)',
    fontFamily: 'JetBrains Mono, monospace', fontSize: 11, cursor: 'pointer',
  }
}

export default CatalogPage
