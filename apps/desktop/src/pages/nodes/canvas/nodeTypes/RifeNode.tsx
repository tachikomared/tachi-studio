// apps/desktop/src/pages/nodes/canvas/nodeTypes/RifeNode.tsx
//
// RIFE node — LOCAL frame interpolation as a canvas step.
//
// The nodes-tab half of the vertical 48381ca shipped for the gallery, landed
// under the standing rule that every feature is also a node. It is the canvas's
// first POST-PROCESS tile: wire a finished local video into `video ▸`, press
// RUN, and the clip comes back with twice (or four times) the frames.
//
// ── WHAT MAKES IT DIFFERENT FROM EVERY OTHER NODE ────────────────────────────
//
//  • IT CONSUMES AN ARTIFACT, NOT A PROMPT. There is no model picker, no prompt
//    field, no provider. The only input is the .mp4 upstream already wrote, and
//    the only knob is x2 / x4.
//  • IT TAKES THE WHOLE CLIP, NOT A FRAME. The FLF hop that turns a wired video
//    into an init frame is deliberately NOT in this path — resolveWiredLastFrame
//    answers a question this node is not asking.
//  • THE ENGINE IS 431 MB. Same rule the gallery button follows: before the
//    sidecar exists the control SAYS the size and the press installs. Only once
//    it is installed does it become the verb. The status is read through the
//    SHARED cache RifeAction owns, so a gallery and a canvas full of these cost
//    one IPC between them, and an install on either surface updates both.
//  • PROGRESS AND STOP LIVE ON THE RAIL. rife:progress already opens an activity
//    row per source path with real frame counts and a working Stop, from any
//    tab. A second progress bar here would be a second, divergent copy of a
//    number the rail already owns — so this card renders none, and its STOP
//    goes through the app's ONE cancel dispatcher (runActivityCancel).
//
// PRIVATE MODE does not gate it, on purpose: this reads a file the user already
// has and spawns three local programs.

import React, { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { TachiRifeNode } from '../../types'
import { useNodesStore } from '../../store/nodes.store'
import { ErrorHandle } from '../EightHandles'
import { useNodeRun } from '../useNodeRun'
import { RunControls, InlineTextPreview } from '../NodeRunUI'
// The SHARED engine-status cache + size formatter — one read per app, owned by
// the gallery control so the two surfaces can never disagree (see its header).
import { useRifeStatus, formatMb } from '../../../media/RifeAction'
// The app's ONE stop dispatcher (descriptor → IPC), so this STOP and the
// activity rail's STOP are provably the same kill.
import { runActivityCancel } from '../../../../components/activity/activityCancel'
import {
  nextRifeMultiplier,
  resolveRifeMultiplier,
  rifeNodeState,
  rifeSourcePath,
} from '../../rifeNode'

const COLOR = 'var(--accent)'

// ── Styles (same brutalist chassis as the media node) ────────────────────────

const nodeStyle: React.CSSProperties = {
  position: 'relative', background: 'var(--bg-surface)', border: `2px solid ${COLOR}`,
  fontFamily: 'JetBrains Mono, monospace', width: 240, boxShadow: `4px 4px 0 ${COLOR}`,
}
const headerStyle: React.CSSProperties = {
  padding: '4px 8px', borderBottom: `2px solid ${COLOR}`, background: COLOR, color: 'var(--bg-base)',
  fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
}
const bodyStyle: React.CSSProperties = { padding: '8px 10px' }
const fieldLabelStyle: React.CSSProperties = {
  fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
  color: 'var(--text-dim)', display: 'block', marginBottom: 3, marginTop: 8,
}
const btnStyle: React.CSSProperties = {
  padding: '3px 8px', border: '2px solid var(--border)', background: 'var(--bg-elevated)',
  color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace',
  fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
}
const readoutStyle: React.CSSProperties = {
  padding: '4px 6px', border: '2px solid var(--border)', background: 'var(--bg-inset)',
  color: 'var(--text-dim)', fontSize: 9, lineHeight: 1.35, wordBreak: 'break-all',
}
const hintStyle: React.CSSProperties = { fontSize: 8, lineHeight: 1.4, color: 'var(--text-dim)', marginTop: 8 }

// Typed plug visuals — VISIBLE + labeled, like the media node's plugs.
const plugHandleStyle: React.CSSProperties = {
  width: 11, height: 11, background: COLOR, border: '2px solid var(--bg-base)', borderRadius: 0,
}
const plugLabelStyle: React.CSSProperties = {
  position: 'absolute', fontSize: 8, fontWeight: 700, letterSpacing: '0.06em',
  textTransform: 'uppercase', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace',
  pointerEvents: 'none', whiteSpace: 'nowrap',
}

/** Just the filename — a full Windows path would wrap the whole card. */
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p
}

// ── Component ────────────────────────────────────────────────────────────────

export function RifeNode({ id, data }: NodeProps<TachiRifeNode>) {
  const { t } = useTranslation('nodes')
  const updateNodeData = useNodesStore(s => s.updateNodeData)
  const deleteNode     = useNodesStore(s => s.deleteNode)
  const nodes          = useNodesStore(s => s.nodes)
  const edges          = useNodesStore(s => s.edges)
  const [hover, setHover] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { status, refresh } = useRifeStatus()
  const { run, runNode, reset } = useNodeRun(id)

  const multiplier = resolveRifeMultiplier(data)
  const isPinned = data.pinned === true

  // THE CLIP, resolved from the live canvas by the SAME function main uses when
  // the stage actually runs — so what the card names is what the sidecar opens.
  const sourcePath = useMemo(() => rifeSourcePath(id, nodes, edges), [id, nodes, edges])

  // A run started elsewhere (the gallery, another card wired to the same clip)
  // still owns this file — read that off the shared status so the button latches.
  const runningElsewhere = !!sourcePath && !!status?.active?.some(p => p === sourcePath)
  const running = run.kind === 'running' || runningElsewhere

  const state = rifeNodeState({
    ...(status ? { supported: status.supported, installed: status.installed } : {}),
    installing,
    hasInput: !!sourcePath,
    running,
  })

  const install = useCallback(async () => {
    setError(null)
    setInstalling(true)
    try {
      const res = await window.tachi.rife.install()
      if (!res?.ok) setError(res?.error || t('rifeNode.installFailed'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setInstalling(false)
      refresh()
    }
  }, [refresh, t])

  /**
   * Stop THIS interpolation. The job id IS the source path (one run per file, see
   * rife-runner), which is exactly what the rail's own Stop sends — so pressing
   * either kills the same process tree.
   */
  const stop = useCallback(() => {
    if (!sourcePath) return
    void runActivityCancel({ kind: 'rife', jobId: sourcePath })
  }, [sourcePath])

  const clearOutput = useCallback(() => {
    updateNodeData(id, { lastArtifacts: undefined })
    reset()
  }, [id, updateNodeData, reset])

  const cachedArtifacts = Array.isArray(data.lastArtifacts) ? data.lastArtifacts : []
  const hasOutput = cachedArtifacts.length > 0
  const sizeLabel = formatMb(status?.downloadBytes ?? 0)

  return (
    <div
      style={isPinned ? { ...nodeStyle, boxShadow: `0 0 0 2px var(--accent-muted), 4px 4px 0 ${COLOR}` } : nodeStyle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={hover ? 'tachi-node-hover' : undefined}
    >
      <div style={headerStyle}>
        <span>{t('rifeNode.header')}{isPinned ? ' · PINNED' : ''}</span>
        {hover && (
          <button
            onClick={(e) => { e.stopPropagation(); deleteNode(id) }}
            className="nodrag" title={t('node.delete')} aria-label={t('node.delete')}
            style={{ width: 16, height: 16, padding: 0, border: 'var(--border-width) solid var(--bg-base)', background: 'transparent', color: 'var(--bg-base)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 800, lineHeight: 1, cursor: 'pointer' }}
          >×</button>
        )}
      </div>

      <div style={bodyStyle}>
        {/* ── The one knob: x2 / x4, one sidecar pass either way ─────────────── */}
        <label style={{ ...fieldLabelStyle, marginTop: 0 }}>{t('rifeNode.multiplierLabel')}</label>
        <button
          className="nodrag"
          onClick={() => updateNodeData(id, { multiplier: nextRifeMultiplier(multiplier) })}
          title={t('rifeNode.multiplierTitle')}
          aria-label={t('rifeNode.multiplierTitle')}
          style={{ ...btnStyle, borderColor: COLOR, color: COLOR }}
        >
          ×{multiplier}
        </button>

        {/* ── The clip it will open ──────────────────────────────────────────── */}
        <label style={fieldLabelStyle}>{t('rifeNode.sourceLabel')}</label>
        <div style={readoutStyle}>
          {sourcePath ? baseName(sourcePath) : t('rifeNode.noSource')}
        </div>

        {/* ── The one control, by state ──────────────────────────────────────── */}
        {state === 'unsupported' ? (
          <div style={hintStyle}>{t('rifeNode.unsupported')}</div>
        ) : state === 'checking' ? (
          <div style={hintStyle}>{t('rifeNode.checking')}</div>
        ) : state === 'not-installed' || state === 'installing' ? (
          <>
            <button
              className="nodrag"
              onClick={() => { void install() }}
              disabled={state === 'installing'}
              title={t('rifeNode.installTitle', { size: sizeLabel })}
              style={{ ...btnStyle, marginTop: 10, borderColor: COLOR, width: '100%' }}
            >
              {state === 'installing'
                ? t('rifeNode.installing')
                : t('rifeNode.install', { size: sizeLabel })}
            </button>
            <div style={hintStyle}>{t('rifeNode.installHint')}</div>
          </>
        ) : (
          <>
            <div style={{ marginTop: 10 }}>
              <RunControls
                accent={COLOR}
                run={run}
                pinned={isPinned}
                hasOutput={hasOutput}
                onRun={() => { void runNode() }}
                onTogglePin={() => updateNodeData(id, { pinned: !isPinned })}
                onClear={clearOutput}
                runTitle={t('rifeNode.runTitle')}
                // A stop that can reach a real process, and only then (a run
                // with no clip has no job id to kill).
                {...(sourcePath ? { onStopRun: stop } : {})}
              />
            </div>
            {state === 'no-input' && <div style={hintStyle}>{t('rifeNode.wireHint')}</div>}
          </>
        )}

        {/* Status only (spinner / error). The RESULT lands on its own Output card
            like every other producing node — never duplicated inline. */}
        {(run.kind === 'running' || run.kind === 'error') && <InlineTextPreview run={run} />}

        {error && (
          <div style={{ ...hintStyle, color: 'var(--danger)' }}>{error}</div>
        )}

        {/* Said once, on the node: this never leaves the machine. */}
        <div style={hintStyle}>{t('rifeNode.localHint')}</div>
      </div>

      {/* video: TARGET (left). A local video result — from a media(video) node,
          an Output card, or another rife node — is what this opens. */}
      <Handle id="video" type="target" position={Position.Left} style={{ ...plugHandleStyle, top: 26 }} />
      <span style={{ ...plugLabelStyle, right: 'calc(100% + 6px)', top: 21, textAlign: 'right' }}>video ▸</span>

      {/* out: SOURCE (right) — the interpolated clip, threaded onward like any
          media artifact (another rife pass, an i2v segment, an Output card). */}
      <Handle id="out" type="source" position={Position.Right} style={{ ...plugHandleStyle, top: 26 }} />
      <span style={{ ...plugLabelStyle, left: 'calc(100% + 6px)', top: 21 }}>▸ out</span>

      {/* #6: the ERROR output — wire it to a node that handles this stage's
          failure (no engine, an undecodable clip, a cancel). */}
      <ErrorHandle />
    </div>
  )
}
