// apps/desktop/src/pages/nodes/canvas/NodeRunUI.tsx
//
// Shared per-node-run UI (#3) for MediaNode + AgentNode: the Run/Pin/Clear
// control row, an inline TEXT preview (agent answer / STT transcript), and the
// inline ARTIFACT preview (image / audio / video). Keeps both node cards DRY and
// the brutalist styling (2px borders, no radius, JetBrains Mono, semantic vars)
// in one place.
//
// Also exports ResultCard: an InlineTextPreview / ArtifactList wrapped inside
// ResultCardChrome (hover-reveal header + collapse). Use this instead of the
// bare InlineTextPreview/ArtifactList in node cards that have result content.

import React from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { Artifact } from '../../../types/electron'
import type { NodeRunState } from './useNodeRun'
import { SR_ONLY } from '../a11y'
import { ResultCardChrome, ChromeActionButton } from './ResultCardChrome'

/** "RETRY N/M" label while a node is re-running (attempt > 1), else null. */
function retryProgressLabel(run: NodeRunState, t: TFunction): string | null {
  if (run.kind !== 'running' || !run.attempt || run.attempt <= 1) return null
  return t('runUI.retry', {
    attempt: run.attempt,
    attempts: run.attempts ?? run.attempt,
    defaultValue: 'RETRY {{attempt}}/{{attempts}}',
  })
}

// ── Run / Pin / Clear control row ───────────────────────────────────────────────

interface RunControlsProps {
  accent:      string
  run:         NodeRunState
  pinned:      boolean
  hasOutput:   boolean
  onRun:       () => void
  onTogglePin: () => void
  onClear:     () => void
  runTitle?:   string
  /** Optional override for the Run button label while running (e.g. progress %). */
  runningLabel?: string
  // ── FAN-OUT xN (PROMPT / MEDIA nodes only; absent → no chip) ────────────────
  /** Current fan-out count (1 = single). Presence renders the ×N cycle-chip. */
  fanoutCount?:    number
  /** Advance the cycle-chip (1 → 2 → 4 → 1). */
  onCycleFanout?:  () => void
  /** True while a multi-run fan-out is in flight (stable across variants). */
  fanoutActive?:   boolean
  /** Live "done/total" progress for the RUN-button label. */
  fanoutProgress?: { done: number; total: number }
  /** Stop the fan-out after the current variant finishes. */
  onStopFanout?:   () => void
  /**
   * Kill the CURRENT run outright (not "after this variant") — the local
   * sd.cpp child. Absent → no button at all, because a stop that cannot reach a
   * process is worse than no stop: a cloud job has no handle to kill, and the
   * rail learned that lesson first (activityRows' `cancel` is null there too).
   *
   * This is the affordance the FLF driver had no access to: a 44-minute canvas
   * render with the tab switched away had no in-app stop anywhere.
   */
  onStopRun?:      () => void
}

export function RunControls({
  accent, run, pinned, hasOutput, onRun, onTogglePin, onClear, runTitle, runningLabel,
  fanoutCount, onCycleFanout, fanoutActive, fanoutProgress, onStopFanout, onStopRun,
}: RunControlsProps) {
  const { t } = useTranslation('nodes')
  const running = run.kind === 'running' || fanoutActive === true
  // Retry-on-fail: from the 2nd attempt onward, the button reads "RETRY N/M".
  const retryLabel = retryProgressLabel(run, t)
  // Fan-out: a steady "RUN i/N" while the whole batch runs (current = done + 1).
  const fanoutLabel = fanoutActive && fanoutProgress
    ? t('runUI.fanoutRunning', {
        current: Math.min(fanoutProgress.done + 1, fanoutProgress.total),
        total: fanoutProgress.total,
        defaultValue: 'RUN {{current}}/{{total}}',
      })
    : null
  const hasFanout = fanoutCount != null
  return (
    <div style={{ display: 'flex', gap: 4, marginTop: 8, alignItems: 'stretch' }}>
      <button
        onClick={(e) => { e.stopPropagation(); onRun() }}
        className="nodrag"
        disabled={running}
        title={runTitle ?? t('runUI.runDefault')}
        style={{
          flex: 1, padding: '5px 6px', border: `2px solid ${accent}`,
          background: accent, color: 'var(--bg-base)', fontFamily: 'JetBrains Mono, monospace',
          fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em',
          cursor: running ? 'wait' : 'pointer', opacity: running ? 0.7 : 1,
        }}
      >
        {running ? (fanoutLabel ?? retryLabel ?? runningLabel ?? t('runUI.running')) : t('runUI.run')}
      </button>

      {/* STOP — a single in-flight run, killed for real. Rendered only while
          this node is running AND the caller handed us a reachable cancel; a
          fan-out has its own stop below (stop-after-variant), so the two never
          share the row. Survives a remount because `run` now comes from the
          store, which is the whole point of finding 3. */}
      {run.kind === 'running' && onStopRun && !fanoutActive && (
        <button
          onClick={(e) => { e.stopPropagation(); onStopRun() }}
          className="nodrag"
          title={t('runUI.stopRunTitle', { defaultValue: 'Stop this render — kills the local engine process now' })}
          style={{
            padding: '5px 8px', border: '2px solid var(--destructive)',
            background: 'var(--destructive)', color: 'var(--bg-base)',
            fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 800,
            textTransform: 'uppercase', letterSpacing: '0.06em', cursor: 'pointer',
          }}
        >
          {t('runUI.stopRun', { defaultValue: 'STOP' })}
        </button>
      )}

      {/* FAN-OUT xN — a tiny cycle-chip (×1/×2/×4). While a fan-out runs it
          becomes STOP (cancels after the current variant). */}
      {hasFanout && (
        fanoutActive ? (
          <button
            onClick={(e) => { e.stopPropagation(); onStopFanout?.() }}
            className="nodrag"
            title={t('runUI.fanoutStopTitle', { defaultValue: 'Stop the fan-out after the current variant finishes' })}
            style={{
              padding: '5px 8px', border: '2px solid var(--destructive)',
              background: 'var(--destructive)', color: 'var(--bg-base)',
              fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 800,
              textTransform: 'uppercase', letterSpacing: '0.06em', cursor: 'pointer',
            }}
          >
            {t('runUI.fanoutStop', { defaultValue: 'STOP' })}
          </button>
        ) : (
          <button
            onClick={(e) => { e.stopPropagation(); onCycleFanout?.() }}
            className="nodrag"
            disabled={run.kind === 'running'}
            aria-label={t('runUI.fanoutAria', { count: fanoutCount, defaultValue: 'Fan-out ×{{count}}' })}
            title={t('runUI.fanoutTitle', {
              count: fanoutCount,
              defaultValue: 'Fan out ×{{count}} — RUN executes this node {{count}} times into separate result cards. Click to change (×1 · ×2 · ×4).',
            })}
            style={{
              padding: '5px 8px',
              border: `2px solid ${(fanoutCount ?? 1) > 1 ? accent : 'var(--border)'}`,
              background: (fanoutCount ?? 1) > 1 ? 'var(--accent-muted)' : 'var(--bg-elevated)',
              color: (fanoutCount ?? 1) > 1 ? 'var(--accent-text)' : 'var(--text-muted)',
              fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 800,
              letterSpacing: '0.04em', cursor: running ? 'wait' : 'pointer',
              opacity: run.kind === 'running' ? 0.7 : 1,
            }}
          >
            {`×${fanoutCount}`}
          </button>
        )
      )}

      {/* PIN — freeze lastOutput as a reference source for downstream runs. */}
      <button
        onClick={(e) => { e.stopPropagation(); onTogglePin() }}
        className="nodrag"
        title={pinned ? t('runUI.pinnedTitle') : t('runUI.pinTitle')}
        aria-pressed={pinned}
        style={{
          padding: '5px 8px',
          border: `2px solid ${pinned ? accent : 'var(--border)'}`,
          background: pinned ? 'var(--accent-muted)' : 'var(--bg-elevated)',
          color: pinned ? 'var(--accent-text)' : 'var(--text-muted)',
          fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 800,
          textTransform: 'uppercase', letterSpacing: '0.06em', cursor: 'pointer',
        }}
      >
        {pinned ? t('runUI.pinned') : t('runUI.pin')}
      </button>

      {/* Clear cached output (only when there's something to clear) — and NEVER
          while this node is running. It was gated on `hasOutput` alone, so a ×
          pressed during a 44-minute render read as "forget this run": the store
          dropped the whole slice, `inflight` included, which re-enabled RUN for a
          DUPLICATE render and darkened every lamp with sd-cli still on the GPU.
          resetNodeRun now refuses to forget a live run, and the button stops
          offering; RUN and the ×N chip were already disabled here, × was the odd
          one out. */}
      {hasOutput && (
        <button
          onClick={(e) => { e.stopPropagation(); onClear() }}
          className="nodrag"
          disabled={running}
          title={running
            ? t('runUI.clearBusyTitle', { defaultValue: 'Can’t clear while this node is running — stop the run first' })
            : t('runUI.clearTitle')}
          aria-label={t('runUI.clearAria')}
          style={{
            padding: '5px 8px', border: '2px solid var(--border)',
            background: 'var(--bg-elevated)', color: 'var(--text-dim)',
            fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 800,
            lineHeight: 1, cursor: running ? 'not-allowed' : 'pointer',
            opacity: running ? 0.5 : 1,
          }}
        >×</button>
      )}
    </div>
  )
}

// ── Inline TEXT preview (agent answer / STT transcript) ─────────────────────────

export function InlineTextPreview({
  run, cached, emptyLabel,
}: { run: NodeRunState; cached?: string; emptyLabel?: string }) {
  const { t } = useTranslation('nodes')
  if (run.kind === 'running') {
    return <RunningBox note={retryProgressLabel(run, t) ?? t('runUI.running')} />
  }
  if (run.kind === 'error') {
    return <ErrorBox error={run.error} />
  }
  // After a finished run prefer its text; otherwise fall back to cached lastOutput.
  const text = run.kind === 'done' ? (run.text ?? '') : (cached ?? '')
  if (run.kind === 'idle' && !cached) return null
  return (
    <pre
      style={{
        margin: '8px 0 0', padding: 6, border: '2px solid var(--border)',
        background: 'var(--bg-elevated)', fontFamily: 'JetBrains Mono, monospace',
        fontSize: 10, color: 'var(--text-primary)', whiteSpace: 'pre-wrap',
        wordBreak: 'break-word', maxHeight: 140, overflow: 'auto',
      }}
    >
      {text || (emptyLabel ?? t('runUI.noOutput'))}
    </pre>
  )
}

// ── Inline ARTIFACT preview (image / audio / video) ─────────────────────────────

export function ArtifactList({ artifacts }: { artifacts: Artifact[] }) {
  if (artifacts.length === 0) return null
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {artifacts.map((a, i) => <ArtifactView key={i} artifact={a} />)}
    </div>
  )
}

export function ArtifactView({ artifact }: { artifact: Artifact }) {
  const { t } = useTranslation('nodes')
  const { kind, mimeType, b64, path } = artifact
  if (kind === 'image') {
    // Small images carry inline b64 for instant preview; else fall back to a
    // file:// reference (never base64 large binaries into the renderer).
    const src = b64 ? `data:${mimeType};base64,${b64}` : (path ? fileUrl(path) : '')
    if (!src) return <PathChip artifact={artifact} />
    return (
      <img
        src={src} alt={t('runUI.generatedAlt')}
        style={{ width: '100%', display: 'block', border: '2px solid var(--border)' }}
      />
    )
  }
  if (kind === 'audio' && path) {
    // Bridge to the Design tab (user rule: features reach the Nodes canvas):
    // one click copies the clip into design-audio, where animate compositions
    // can score with it via staticFile(...).
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <audio className="nodrag" controls src={fileUrl(path)} style={{ width: '100%' }} />
        <button
          className="nodrag"
          style={{ alignSelf: 'flex-start', padding: '3px 8px', border: '2px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace', fontSize: 9, cursor: 'pointer' }}
          title={t('runUI.toDesignAudioTitle')}
          onClick={() => {
            window.tachi.design.importAudio(path).then(r => {
              window.dispatchEvent(new CustomEvent('tachi:toast', {
                detail: r.ok
                  ? { kind: 'success', text: t('runUI.toDesignAudioDone', { file: r.file }) }
                  : { kind: 'error', text: r.error ?? 'import failed' },
              }))
            }).catch(() => {})
          }}>
          {t('runUI.toDesignAudio')}
        </button>
      </div>
    )
  }
  if (kind === 'video' && path) {
    return <video className="nodrag" controls src={fileUrl(path)} style={{ width: '100%', display: 'block', border: '2px solid var(--border)' }} />
  }
  if (kind === 'text' && artifact.text) {
    return (
      <pre style={{ margin: 0, padding: 6, border: '2px solid var(--border)', background: 'var(--bg-elevated)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 120, overflow: 'auto' }}>
        {artifact.text}
      </pre>
    )
  }
  return <PathChip artifact={artifact} />
}

function PathChip({ artifact }: { artifact: Artifact }) {
  return (
    <div style={{ padding: 6, border: '2px solid var(--border)', background: 'var(--bg-elevated)', fontSize: 9, color: 'var(--text-muted)', wordBreak: 'break-all' }}>
      {artifact.path ?? `(${artifact.kind} artifact)`}
    </div>
  )
}

function RunningBox({ note }: { note: string }) {
  return (
    <div style={{ marginTop: 8, padding: 6, border: '2px dashed var(--border)', fontSize: 10, color: 'var(--text-dim)' }}>
      {note}
    </div>
  )
}

// Defensive: `error` is typed string but a gateway can hand us an object
// ({type,message}) — rendering that object as a React child crashes the tree.
// Always coerce to a readable string.
function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const m = (error as { message?: unknown }).message
    if (typeof m === 'string') return m
    try { return JSON.stringify(error) } catch { /* fallthrough */ }
  }
  return String(error)
}

function ErrorBox({ error }: { error: unknown }) {
  return (
    <div style={{ marginTop: 8, padding: 6, border: '2px solid var(--destructive)', fontSize: 10, color: 'var(--destructive)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {errorText(error)}
    </div>
  )
}

// Build a renderer-loadable URL for an on-disk artifact. A renderer served over
// http://localhost CANNOT load file:// (broken image/audio/video), so we route
// through the tachi-media:// protocol registered in main (streams the file).
export function fileUrl(p: string): string {
  return `tachi-media://artifact/${encodeURIComponent(p)}`
}

// ── ResultCard — PanelChrome-wrapped result content ───────────────────────────
//
// Wraps InlineTextPreview + ArtifactList inside ResultCardChrome so the
// hover-header (title + optional actions) appears only when you need it,
// keeping the canvas tidy at rest.

export interface ResultCardProps {
  /** Title shown in the hover header (e.g. the node label or modality). */
  title: string
  /** Accent colour passed through to ResultCardChrome. */
  accent?: string
  /** run state, passed to InlineTextPreview. */
  run: NodeRunState
  /** Cached last-output text (shown when run is idle). */
  cached?: string
  /** Displayed when there is no output at all. */
  emptyLabel?: string
  /** Media artifacts rendered below the text preview. */
  artifacts?: Artifact[]
  /** Optional actions slot rendered in the hover header. */
  actions?: React.ReactNode
  /** Whether the card starts collapsed. Default false. */
  defaultCollapsed?: boolean
}

export function ResultCard({
  title,
  accent,
  run,
  cached,
  emptyLabel,
  artifacts = [],
  actions,
  defaultCollapsed = false,
}: ResultCardProps) {
  const { t } = useTranslation('nodes')
  const hasText  = run.kind !== 'idle' || !!cached
  const hasMedia = artifacts.length > 0

  // Don't render the chrome at all when there's nothing to show and we are
  // idle — keeps the card visually clean before the first run.
  if (run.kind === 'idle' && !hasText && !hasMedia) return null

  return (
    <ResultCardChrome
      title={title}
      accent={accent}
      actions={actions}
      defaultCollapsed={defaultCollapsed}
      style={{ marginTop: 8 }}
    >
      {/* A11Y (batch34): the card updates IN PLACE when a node finishes, which a
          screen reader never notices. One polite live region announces the
          TERMINAL states only — it stays empty while idle/running, so a
          streaming run cannot turn this into a chatty region. */}
      <span role="status" aria-live="polite" aria-atomic="true" style={SR_ONLY}>
        {run.kind === 'done'
          ? t('runUI.statusDone', { title, defaultValue: '{{title}}: run finished' })
          : run.kind === 'error'
            ? t('runUI.statusError', { title, defaultValue: '{{title}}: run failed' })
            : ''}
      </span>
      <div style={{ padding: '6px 8px' }}>
        {hasMedia && <ArtifactList artifacts={artifacts} />}
        <InlineTextPreview run={run} cached={cached} emptyLabel={emptyLabel} />
      </div>
    </ResultCardChrome>
  )
}

// Re-export ChromeActionButton so callers can style header actions to match.
export { ChromeActionButton }
