// apps/desktop/src/pages/nodes/sidebar/FlowsRail.tsx
//
// Saved-canvas rail (left of the palette) — works like the chat history list:
// every canvas is a saved flow you can click to switch between, plus "+ New".
// Backed by the existing nodes IPC (listFlows / loadFlow / saveFlow → files
// under <userData>/nodes). Switching auto-saves the current canvas first so no
// work is lost; the active flow is highlighted.
//
// Portability (UX-benchmark #4): every flow exports as a shareable
// `<name>.tachiflow.json` (⇩ per row) and the IMPORT button loads one back —
// ids are regenerated on import so collisions can't happen. A TEMPLATES
// section below the list clones a curated starter flow into a new canvas.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useNodesStore } from '../store/nodes.store'
import { runFlowDoctor } from '../store/flow-doctor.store'
import { useNodesRunStore } from '../../../store/nodesRun.store'
import { serializeFlow, parseFlow, stableFlowJson } from '../serialization'
import { runFlowSave, describeSaveFailure, uniqueFlowName, nextUntitledFlowName, type SaveOutcome } from '../flow-save'
import { RevisionsDrawer } from './RevisionsDrawer'
import { downloadTachiflow, readTachiflowFile, parseTachiflowFile, remapFlowIds, TachiflowParseError } from '../templates/tachiflow'
import { extractFlowFromPng } from '../png-flow'
import { exportFlowPng } from '../png-export'
import { FLOW_TEMPLATES, type FlowTemplate } from '../templates'
import type { TachiFlow } from '../types'

interface FlowMeta { filename: string; name: string; savedAt: string }

function railToast(text: string, kind: 'success' | 'error' | 'info') {
  window.dispatchEvent(new CustomEvent('tachi:toast', { detail: { kind, text } }))
}

export function FlowsRail() {
  const { t } = useTranslation('nodes')
  const navigate    = useNavigate()
  const flowName    = useNodesStore(s => s.flowName)
  const setFlowName = useNodesStore(s => s.setFlowName)
  const setNodes    = useNodesStore(s => s.setNodes)
  const setEdges    = useNodesStore(s => s.setEdges)
  const loadFlow    = useNodesStore(s => s.loadFlow)
  const clearCanvas = useNodesStore(s => s.clearCanvas)
  const nodeCount   = useNodesStore(s => s.nodes.length)

  const [flows, setFlows] = useState<FlowMeta[]>([])
  const [busy, setBusy]   = useState(false)
  const [renaming, setRenaming]           = useState<string | null>(null)  // filename being renamed inline
  const [renameValue, setRenameValue]     = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)  // filename pending a 2nd-click confirm
  const [revisionsFor, setRevisionsFor]   = useState<string | null>(null)  // filename whose REVISIONS drawer is open
  const [revisionsKey, setRevisionsKey]   = useState(0)                    // bump to remount → re-read the drawer
  const importInputRef = useRef<HTMLInputElement>(null)
  // A11Y (batch34): inline rename REPLACES the row, so the button that opened it
  // is unmounted and focus would fall to <body>. Remember it and hand focus back
  // to the row's own control once the rename commits or is cancelled.
  const renameReturnRef = useRef<HTMLElement | null>(null)

  const refresh = useCallback(() => {
    window.tachi.nodes.listFlows()
      .then(r => { if (r.ok && Array.isArray(r.flows)) setFlows(r.flows) })
      .catch(() => {})
  }, [])
  useEffect(() => {
    refresh()
    const onChanged = () => refresh()
    window.addEventListener('tachi:flows-changed', onChanged)
    return () => window.removeEventListener('tachi:flows-changed', onChanged)
  }, [refresh])

  // Persist the current canvas under its name so switching never loses work.
  // LANE J: this is a PRECONDITION, not a courtesy — it used to swallow every
  // error, and a silently-failed save followed by clearCanvas() wiped a
  // never-saved canvas on a live run. Every caller below must abort its
  // destructive step when this comes back `ok:false`.
  //
  // …and it writes stableFlowJson, like every other save in the app. It used to
  // be a bare JSON.stringify, which meant THE AUTOSAVES — the writes that
  // happen on every flow switch, import and template open — were the one seam
  // that kept the multi-megabyte artifact bytes stableFlowJson strips (FLF
  // driver, finding 4), and churned the on-disk key order while doing it.
  const saveCurrent = useCallback(async (): Promise<SaveOutcome> => {
    const { flowName: fn, nodes, edges } = useNodesStore.getState()
    const name = (fn || 'Untitled flow').trim() || 'Untitled flow'
    return runFlowSave(nodes.length > 0, () =>
      window.tachi.nodes.saveFlow(name, stableFlowJson(serializeFlow(name, nodes, edges))))
  }, [])

  // One toast for a failed pre-save. Controlled Folder Access gets copy that
  // names it and says where the data goes instead — a raw ENOENT on a folder
  // the user can SEE is worse than useless.
  const reportSaveFailure = useCallback((error: string) => {
    const d = describeSaveFailure(error)
    railToast(
      d.key === 'cfaBlocked'
        ? t('flowsRail.cfaBlocked', { fallback: d.fallback })
        : t('flowsRail.saveFailed', { error: d.error }),
      'error',
    )
  }, [t])

  const switchTo = useCallback(async (f: FlowMeta) => {
    if (busy || f.name === flowName) return
    setBusy(true)
    try {
      const saved = await saveCurrent()
      if (!saved.ok) { reportSaveFailure(saved.error); return }
      const r = await window.tachi.nodes.loadFlow(f.filename)
      if (r.ok && r.json) {
        const parsed = parseFlow(JSON.parse(r.json))
        setFlowName(parsed.name)
        setNodes(parsed.nodes)
        setEdges(parsed.edges)
        useNodesRunStore.getState().setStatus({ kind: 'idle' })
        // …and the PER-NODE runs go with it. They were never pruned by anything,
        // so every slice this session created stayed alive — artifacts, inline
        // b64 bytes and all — and since the templates use FIXED node ids, the
        // flow you switch INTO could inherit the results of the one you left. A
        // run still in flight is spared (see resetAllNodeRuns).
        useNodesRunStore.getState().resetAllNodeRuns()
        runFlowDoctor() // NODES-RESEARCH #4: self-heal check on flow switch
      }
      refresh()
    } catch { /* ignore bad file */ } finally { setBusy(false) }
  }, [busy, flowName, saveCurrent, reportSaveFailure, setFlowName, setNodes, setEdges, refresh])

  const newFlow = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      // The save MUST land before the canvas is thrown away.
      const saved = await saveCurrent()
      if (!saved.ok) { reportSaveFailure(saved.error); return }
      clearCanvas()
      // …and the fresh canvas must not adopt a name that already exists on
      // disk: `flows.length + 1` collided with a saved flow on a live run, so
      // the next Save would have silently overwritten it. Same guard as import
      // and templates.
      setFlowName(nextUntitledFlowName(flows.map(x => x.name)))
      useNodesRunStore.getState().setStatus({ kind: 'idle' })
      useNodesRunStore.getState().resetAllNodeRuns()  // an empty canvas has no runs
      runFlowDoctor() // NODES-RESEARCH #4: recheck (an empty new flow → no issues)
      refresh()
    } finally { setBusy(false) }
  }, [busy, saveCurrent, reportSaveFailure, clearCanvas, setFlowName, flows, refresh])

  // ── Export (⇩ .tachiflow.json) ─────────────────────────────────────────────
  // The ACTIVE flow exports straight from the canvas (includes unsaved edits);
  // any other flow is read from its file on disk.
  const exportFlow = useCallback(async (f: FlowMeta) => {
    try {
      let flow: TachiFlow
      if (f.name === flowName) {
        const s = useNodesStore.getState()
        flow = serializeFlow((s.flowName || f.name).trim() || f.name, s.nodes, s.edges)
      } else {
        const r = await window.tachi.nodes.loadFlow(f.filename)
        if (!r.ok || !r.json) throw new Error(r.error || 'load failed')
        flow = parseFlow(JSON.parse(r.json))
      }
      const file = downloadTachiflow(flow)
      railToast(t('flowsRail.exported', { file }), 'success')
    } catch (err) {
      railToast(t('flowsRail.exportFailed', { error: err instanceof Error ? err.message : String(err) }), 'error')
    }
  }, [flowName, t])

  // ── Export current canvas as PNG (flow JSON embedded, NODES-RESEARCH #5) ────
  // A screenshot is a portable artifact: dropping it back on the canvas (IMPORT)
  // reconstructs the graph. Captures the LIVE canvas, so it targets the current
  // flow regardless of which row is highlighted.
  const exportPng = useCallback(async () => {
    const s = useNodesStore.getState()
    if (s.nodes.length === 0) return
    try {
      const name = (s.flowName || 'Untitled flow').trim() || 'Untitled flow'
      const file = await exportFlowPng(name, s.nodes, s.edges)
      railToast(t('flowsRail.pngExported', { file }), 'success')
    } catch (err) {
      railToast(t('flowsRail.pngExportFailed', { error: err instanceof Error ? err.message : String(err) }), 'error')
    }
  }, [t])

  // ── Import (.tachiflow.json / .tachi-flow.json / .png) ─────────────────────
  const handleImportFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''  // re-selecting the same file must fire change again
    if (!file || busy) return
    setBusy(true)
    try {
      // A .png export carries the flow JSON in a tEXt chunk — pull it out and run
      // it through the SAME parse/load path as a JSON import (fail-closed: a PNG
      // without an embedded flow reports 'not a flow' rather than opening blank).
      const isPng = file.type === 'image/png' || /\.png$/i.test(file.name)
      const flow = isPng
        ? await (async () => {
            const bytes = new Uint8Array(await file.arrayBuffer())
            const json = extractFlowFromPng(bytes)
            if (json == null) throw new TachiflowParseError('not-tachiflow')
            return parseTachiflowFile(JSON.parse(json))
          })()
        : await readTachiflowFile(file)
      // Fresh ids so an import can never collide with existing nodes/flows.
      const remapped = remapFlowIds(flow.nodes, flow.edges)
      // Importing REPLACES the canvas — same precondition as + New flow.
      const saved = await saveCurrent()
      if (!saved.ok) { reportSaveFailure(saved.error); return }
      const name = uniqueFlowName((flow.name || 'Imported flow').trim() || 'Imported flow', new Set(flows.map(x => x.name)))
      loadFlow(name, remapped.nodes, remapped.edges)
      useNodesRunStore.getState().setStatus({ kind: 'idle' })
      // Imported ids are freshly remapped, so no slice here could belong to them.
      useNodesRunStore.getState().resetAllNodeRuns()
      runFlowDoctor() // NODES-RESEARCH #4: self-heal check on import

      try { await window.tachi.nodes.saveFlow(name, stableFlowJson(serializeFlow(name, remapped.nodes, remapped.edges))) } catch { /* rail entry appears on next Save */ }
      refresh()
      railToast(t('flowsRail.imported', { name }), 'success')
    } catch (err) {
      const wasPng = file.type === 'image/png' || /\.png$/i.test(file.name)
      if (err instanceof TachiflowParseError && err.code === 'not-tachiflow') {
        railToast(wasPng ? t('flowsRail.pngNoFlow') : t('flowsRail.notTachiflow'), 'error')
      } else if (err instanceof TachiflowParseError && err.code === 'unsupported-version') {
        railToast(t('flowsRail.unsupportedVersion'), 'error')
      } else {
        railToast(t('flowsRail.importFailed', { error: err instanceof Error ? err.message : String(err) }), 'error')
      }
    } finally { setBusy(false) }
  }, [busy, saveCurrent, reportSaveFailure, flows, loadFlow, refresh, t])

  // ── Templates: clone a curated starter flow into a NEW flow and open it ────
  const applyTemplate = useCallback(async (tpl: FlowTemplate) => {
    if (busy) return
    setBusy(true)
    try {
      // Opening a template REPLACES the canvas — abort if the pre-save failed.
      const saved = await saveCurrent()
      if (!saved.ok) { reportSaveFailure(saved.error); return }
      const { nodes, edges } = remapFlowIds(tpl.file.flow.nodes, tpl.file.flow.edges)
      const name = uniqueFlowName(tpl.file.flow.name, new Set(flows.map(x => x.name)))
      loadFlow(name, nodes, edges)
      useNodesRunStore.getState().setStatus({ kind: 'idle' })
      // The sharpest case of the stale-slice bug: templates ship FIXED node ids
      // ('p2i-image'), so without this the starter opens showing the LAST run of
      // whichever template was opened before it.
      useNodesRunStore.getState().resetAllNodeRuns()
      runFlowDoctor() // NODES-RESEARCH #4: self-heal check on template open

      try { await window.tachi.nodes.saveFlow(name, stableFlowJson(serializeFlow(name, nodes, edges))) } catch { /* rail entry appears on next Save */ }
      refresh()
      railToast(t('toast.templateLoaded', { label: t(`templatesRail.items.${tpl.id}.label`, { defaultValue: tpl.label }) }), 'success')
    } finally { setBusy(false) }
  }, [busy, saveCurrent, reportSaveFailure, flows, loadFlow, refresh, t])

  // ── Rename (inline) ────────────────────────────────────────────────────────
  const startRename = useCallback((f: FlowMeta) => {
    setConfirmDelete(null)
    renameReturnRef.current = (document.activeElement as HTMLElement | null) ?? null
    setRenaming(f.filename)
    setRenameValue(f.name)
  }, [])

  // Focus restore for the inline rename: the row re-renders as buttons again, so
  // the id-stable row button gets focus back (falls back to the rail itself).
  const restoreRenameFocus = useCallback((filename: string) => {
    const prev = renameReturnRef.current
    renameReturnRef.current = null
    requestAnimationFrame(() => {
      const back = document.querySelector<HTMLElement>(`[data-flow-row="${CSS.escape(filename)}"]`)
      ;(back ?? prev)?.focus?.()
    })
  }, [])

  const cancelRename = useCallback((f: FlowMeta) => {
    setRenaming(null)
    restoreRenameFocus(f.filename)
  }, [restoreRenameFocus])

  const commitRename = useCallback(async (f: FlowMeta) => {
    const next = renameValue.trim()
    setRenaming(null)
    restoreRenameFocus(f.filename)
    if (!next || next === f.name) return
    try {
      const r = await window.tachi.nodes.renameFlow(f.filename, next)
      // If the open flow was renamed, keep the canvas label in sync so the
      // highlight + next save stay on the same flow.
      if (r.ok && f.name === flowName) setFlowName(next)
      refresh()
    } catch { /* ignore */ }
  }, [renameValue, flowName, setFlowName, refresh, restoreRenameFocus])

  // ── Schedule (⏱) ───────────────────────────────────────────────────────────
  // The scheduler itself lives in Settings → Advanced → Scheduled; this is the
  // cheap entry point from where flows actually live. Save first so the file on
  // disk (what the scheduler will run) matches what is on screen.
  const scheduleFlow = useCallback(async (f: FlowMeta) => {
    if (f.name === flowName) {
      // Nothing destructive follows, but scheduling a STALE file silently is
      // its own trap — say so and stop rather than arming the wrong graph.
      const saved = await saveCurrent()
      if (!saved.ok) { reportSaveFailure(saved.error); return }
    }
    try {
      sessionStorage.setItem('tachi:schedule-flow', f.filename)
      sessionStorage.setItem('tachi:settings-scroll', 'scheduler')
    } catch { /* storage disabled — Settings still opens, just unfilled */ }
    navigate('/settings?tab=advanced')
  }, [flowName, saveCurrent, reportSaveFailure, navigate])

  // ── Delete (two-click confirm — Electron has no window.confirm-free prompt) ──
  const doDelete = useCallback(async (f: FlowMeta) => {
    setConfirmDelete(null)
    try {
      const r = await window.tachi.nodes.deleteFlow(f.filename)
      // Deleting the open flow → clear the canvas (it no longer exists on disk).
      if (r.ok && f.name === flowName) { clearCanvas(); setFlowName('Untitled flow') }
      refresh()
    } catch { /* ignore */ }
  }, [flowName, clearCanvas, setFlowName, refresh])

  // ── Revisions (⟲) — A1, NODES-RESEARCH-2026-07-26 ──────────────────────────
  // Every save snapshots the flow under Flows/.history; this drawer lists those
  // snapshots with a change summary against the CURRENT state. Undo/redo lives
  // in the store and dies with the tab — this is the durable half.
  const toggleRevisions = useCallback((f: FlowMeta) => {
    setConfirmDelete(null)
    setRevisionsFor(prev => (prev === f.filename ? null : f.filename))
    setRevisionsKey(k => k + 1)
  }, [])

  // What the drawer diffs each revision AGAINST: the live canvas for the open
  // flow (so unsaved edits count), the file on disk for every other row.
  const revisionsCurrentJson = useCallback(async (): Promise<string> => {
    const f = flows.find(x => x.filename === revisionsFor)
    if (!f) return ''
    if (f.name === flowName) {
      const s = useNodesStore.getState()
      return stableFlowJson(serializeFlow((s.flowName || f.name).trim() || f.name, s.nodes, s.edges))
    }
    try {
      const r = await window.tachi.nodes.loadFlow(f.filename)
      return r.ok && r.json ? r.json : ''
    } catch { return '' }
  }, [flows, revisionsFor, flowName])

  const restoreRevision = useCallback(async (ts: number) => {
    const f = flows.find(x => x.filename === revisionsFor)
    if (!f) return
    try {
      // Restoring the OPEN flow: persist the canvas first so the state being
      // replaced — and snapshotted by the restore — is the one on screen. A
      // failed pre-save means that state would be lost, so the restore is off.
      if (f.name === flowName) {
        const saved = await saveCurrent()
        if (!saved.ok) { reportSaveFailure(saved.error); return }
      }
      const r = await window.tachi.nodes.restoreRevision(f.filename, ts)
      if (!r.ok || !r.json) throw new Error(r.error || 'restore failed')
      if (f.name === flowName) {
        const parsed = parseFlow(JSON.parse(r.json))
        setFlowName(parsed.name)
        setNodes(parsed.nodes)
        setEdges(parsed.edges)
        useNodesRunStore.getState().setStatus({ kind: 'idle' })
        runFlowDoctor() // NODES-RESEARCH #4: self-heal check on restore
      }
      refresh()
      setRevisionsKey(k => k + 1) // re-read the drawer: the restore added a snapshot
      railToast(t('flowsRail.revisions.restored', { name: f.name }), 'success')
    } catch (err) {
      railToast(t('flowsRail.revisions.restoreFailed', { error: err instanceof Error ? err.message : String(err) }), 'error')
    }
  }, [flows, revisionsFor, flowName, saveCurrent, reportSaveFailure, setFlowName, setNodes, setEdges, refresh, t])

  // A11Y (batch34): every row repeats the same five icon actions, so a bare
  // "Export flow" would read identically twelve times over. Each action name is
  // qualified with the flow it acts on.
  const rowAria = (action: string, name: string) =>
    t('flowsRail.rowActionAria', { action, name, defaultValue: '{{action}} — {{name}}' })

  return (
    <div
      role="complementary"
      aria-label={t('flowsRail.aria', { defaultValue: 'Saved flows' })}
      style={{
        width: 168, flexShrink: 0, display: 'flex', flexDirection: 'column',
        borderRight: '2px solid var(--border)', background: 'var(--bg-sidebar)', overflow: 'hidden',
        fontFamily: 'JetBrains Mono, monospace',
      }}
    >
      <div style={{
        padding: '8px 10px', borderBottom: '2px solid var(--border)', display: 'flex',
        alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
      }}>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>{t('flowsRail.title')}</span>
        <span style={{ display: 'inline-flex', gap: 8 }}>
          <button
            onClick={() => importInputRef.current?.click()}
            disabled={busy}
            title={t('flowsRail.importTitle')} aria-label={t('flowsRail.importAria')}
            style={{ border: 'none', background: 'transparent', color: 'var(--text-dim)', fontSize: 11, cursor: busy ? 'wait' : 'pointer', padding: 0 }}
          >⇧</button>
          <button
            onClick={refresh} title={t('flowsRail.refreshTitle')} aria-label={t('flowsRail.refreshAria')}
            style={{ border: 'none', background: 'transparent', color: 'var(--text-dim)', fontSize: 11, cursor: 'pointer', padding: 0 }}
          >↻</button>
        </span>
      </div>

      <button
        onClick={newFlow}
        disabled={busy}
        title={t('flowsRail.newTitle')}
        style={{
          margin: 8, padding: '7px 10px', border: '2px solid var(--accent)', background: 'var(--accent)',
          color: '#ffffff', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
          letterSpacing: '0.06em', textTransform: 'uppercase', cursor: busy ? 'wait' : 'pointer',
          boxShadow: 'var(--shadow-hard)', flexShrink: 0,
        }}
      >{t('flowsRail.newFlow')}</button>

      <button
        onClick={() => importInputRef.current?.click()}
        disabled={busy}
        title={t('flowsRail.importTitle')}
        style={{
          margin: '0 8px 8px', padding: '5px 10px', border: '2px solid var(--border)', background: 'var(--bg-elevated)',
          color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 700,
          letterSpacing: '0.06em', textTransform: 'uppercase', cursor: busy ? 'wait' : 'pointer', flexShrink: 0,
        }}
      >{t('flowsRail.import')}</button>

      {/* Export the current canvas as a PNG with the flow embedded (NODES-RESEARCH
          #5) — a portable, re-importable artifact. Operates on the live canvas. */}
      <button
        onClick={exportPng}
        disabled={busy || nodeCount === 0}
        title={t('flowsRail.pngExportTitle')}
        style={{
          margin: '0 8px 8px', padding: '5px 10px', border: '2px solid var(--border)', background: 'var(--bg-elevated)',
          color: nodeCount === 0 ? 'var(--text-dim)' : 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace',
          fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
          cursor: busy || nodeCount === 0 ? 'default' : 'pointer', opacity: nodeCount === 0 ? 0.5 : 1, flexShrink: 0,
        }}
      >{t('flowsRail.pngExport')}</button>

      {/* Hidden picker for IMPORT — accepts our export format, the app-native save
          format, and a .png with an embedded flow (NODES-RESEARCH #5). */}
      <input
        ref={importInputRef}
        type="file"
        accept=".json,.tachiflow.json,.png,image/png"
        style={{ display: 'none' }}
        onChange={handleImportFile}
        aria-hidden="true"
      />

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {flows.length === 0 && (
          <div style={{ padding: '8px 10px', fontSize: 9, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            {t('flowsRail.empty')}
          </div>
        )}
        {flows.map(f => {
          const active = f.name === flowName

          // Inline rename: replace the row with a text input.
          if (renaming === f.filename) {
            return (
              <input
                key={f.filename}
                value={renameValue}
                autoFocus
                aria-label={rowAria(t('flowsRail.renameAria', { defaultValue: 'Rename flow' }), f.name)}
                onChange={e => setRenameValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); commitRename(f) }
                  else if (e.key === 'Escape') { e.preventDefault(); cancelRename(f) }
                }}
                onBlur={() => commitRename(f)}
                style={{
                  display: 'block', width: '100%', boxSizing: 'border-box', padding: '6px 10px',
                  border: 'none', borderBottom: 'var(--border-width) solid var(--border)',
                  borderLeft: '3px solid var(--accent)', background: 'var(--bg-elevated)',
                  color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 11, outline: 'none',
                }}
              />
            )
          }

          const revisionsOpen = revisionsFor === f.filename

          return (
            <React.Fragment key={f.filename}>
            <div
              style={{
                display: 'flex', alignItems: 'stretch',
                borderBottom: 'var(--border-width) solid var(--border)',
                borderLeft: active ? '3px solid var(--accent)' : '3px solid transparent',
                background: active ? 'var(--accent-muted)' : 'transparent',
              }}
            >
              <button
                data-flow-row={f.filename}
                onClick={() => switchTo(f)}
                title={`${f.name} · ${f.savedAt}`}
                aria-label={rowAria(t('flowsRail.openAria', { defaultValue: 'Open flow' }), f.name)}
                aria-current={active ? 'true' : undefined}
                style={{
                  flex: 1, minWidth: 0, textAlign: 'left', padding: '6px 8px',
                  border: 'none', background: 'transparent',
                  color: active ? 'var(--accent-text)' : 'var(--text-muted)',
                  fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: active ? 700 : 400,
                  cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
              >
                {f.name}
              </button>
              <button onClick={() => exportFlow(f)} title={t('flowsRail.exportTitle')} aria-label={rowAria(t('flowsRail.exportAria'), f.name)} style={railIconBtn}>⇩</button>
              <button
                onClick={() => scheduleFlow(f)}
                title={t('flowsRail.scheduleTitle', { defaultValue: 'Schedule this flow to run on a timer' })}
                aria-label={rowAria(t('flowsRail.scheduleAria', { defaultValue: 'Schedule this flow' }), f.name)}
                style={railIconBtn}
              >⏱</button>
              <button
                onClick={() => toggleRevisions(f)}
                title={t('flowsRail.revisions.openTitle')}
                aria-label={rowAria(t('flowsRail.revisions.openAria'), f.name)}
                aria-expanded={revisionsOpen}
                style={{ ...railIconBtn, color: revisionsOpen ? 'var(--accent-text)' : 'var(--text-dim)' }}
              >⟲</button>
              <button
                onClick={() => startRename(f)}
                title={t('flowsRail.renameTitle')}
                aria-label={rowAria(t('flowsRail.renameAria', { defaultValue: 'Rename flow' }), f.name)}
                style={railIconBtn}
              >{t('flowsRail.rename')}</button>
              {confirmDelete === f.filename ? (
                <button
                  onClick={() => doDelete(f)}
                  title={t('flowsRail.confirmDeleteTitle')}
                  aria-label={rowAria(t('flowsRail.confirmDeleteAria', { defaultValue: 'Confirm delete' }), f.name)}
                  style={{ ...railIconBtn, color: 'var(--warning)', fontWeight: 700 }}
                >{t('flowsRail.confirmDelete')}</button>
              ) : (
                <button
                  onClick={() => setConfirmDelete(f.filename)}
                  title={t('flowsRail.deleteTitle')}
                  aria-label={rowAria(t('flowsRail.deleteAria', { defaultValue: 'Delete flow' }), f.name)}
                  style={railIconBtn}
                >×</button>
              )}
            </div>
            {revisionsOpen && (
              <RevisionsDrawer
                key={`${f.filename}:${revisionsKey}`}
                filename={f.filename}
                getCurrentJson={revisionsCurrentJson}
                onRestore={restoreRevision}
              />
            )}
            </React.Fragment>
          )
        })}

        {/* ── TEMPLATES — curated starters; click clones into a new flow ── */}
        <div style={{
          padding: '8px 10px 4px', borderBottom: 'var(--border-width) solid var(--border)',
          fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
          color: 'var(--text-dim)',
        }}>
          {t('flowsRail.templates')}
        </div>
        {FLOW_TEMPLATES.map(tpl => {
          const label = t(`templatesRail.items.${tpl.id}.label`, { defaultValue: tpl.label })
          const description = t(`templatesRail.items.${tpl.id}.description`, { defaultValue: tpl.description })
          return (
            <button
              key={tpl.id}
              onClick={() => applyTemplate(tpl)}
              disabled={busy}
              title={description}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px 6px 11px',
                border: 'none', borderBottom: 'var(--border-width) solid var(--border)',
                background: 'transparent', color: 'var(--text-muted)',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 600,
                cursor: busy ? 'wait' : 'pointer',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-elevated)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
            >
              <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span style={{ color: 'var(--text-dim)' }}>▸ </span>{label}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

const railIconBtn: React.CSSProperties = {
  flexShrink: 0, border: 'none', background: 'transparent', color: 'var(--text-dim)',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 700, letterSpacing: '0.04em',
  // 4px (was 7px, then 5px): the row gained a ⏱ SCHEDULE and then a ⟲ REVISIONS
  // action, and the flow name keeps priority for the remaining width.
  textTransform: 'uppercase', cursor: 'pointer', padding: '0 4px',
}
