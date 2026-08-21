// apps/desktop/src/pages/agent/CodexWorkerCard.tsx
//
// The dedicated transcript card for a `codex_worker` delegation.
//
// A generic ToolCallBlock renders this tool as raw JSON args ({"task":"…"})
// plus a wall of worker output — which is exactly the moment the user most
// wants to see WHAT was delegated and WHAT the worker did. This card pulls the
// three facts out of those blobs:
//
//   header  — CODEX badge + sandbox chip (WRITE / READ-ONLY) + the task text
//   body    — the worker's answer segmented into console rows ("$ cmd") and
//             prose, plus the step summary the tool result carries
//   footer  — files the answer mentions, the resumable session id, step count
//
// Everything above the component is PURE and unit-tested (codexWorkerCard.test.ts).
// The parsers are deliberately tolerant: if the args don't look like a codex
// task at all, `parseCodexArgs` returns null and ToolCallBlock falls back to the
// generic rendering — the transcript must never lose a tool call to a shape
// change in the sidecar.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatToolDuration } from '../../components/toolCallRow.format'
import {
  classifyProgress, codexToolKind, progressBody, progressTail, shouldShowProgress,
  type ProgressKind,
} from './codexProgress'

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * True for the Codex delegation tool (NOT codex_review, which has its own
 * card). Name matching lives in codexProgress.ts so the card, the review card
 * and the transcript's progress router all agree on what "a codex tool" is.
 */
export function isCodexWorkerTool(name: unknown): boolean {
  return codexToolKind(name) === 'worker'
}

export interface CodexTaskArgs {
  /** The self-contained brief handed to the worker. */
  task: string
  /** true = workspace-write sandbox (what the permission gate prompts about). */
  write: boolean
  model?: string
  resumeSession?: string
}

/**
 * Extract the task brief from the JSON-string tool input. Returns null for
 * anything that isn't an object carrying a non-empty `task` — the caller then
 * keeps the generic rendering instead of showing a half-empty card.
 */
export function parseCodexArgs(rawInput: unknown): CodexTaskArgs | null {
  if (typeof rawInput !== 'string') return null
  let v: unknown
  try { v = JSON.parse(rawInput) } catch { return null }
  // Some harnesses double-encode the args object; unwrap one level.
  if (typeof v === 'string') {
    try { v = JSON.parse(v) } catch { return null }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const task = typeof o.task === 'string' ? o.task.trim() : ''
  if (!task) return null
  const str = (k: string): string | undefined => {
    const raw = o[k]
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
  }
  return {
    task,
    write: o.write === true,
    model: str('model'),
    resumeSession: str('resume_session'),
  }
}

export interface CodexResult {
  /** false when the worker reported a failure (or threw at the tool seam). */
  ok: boolean
  /** Failure headline, without the "Codex worker FAILED:" prefix. */
  error?: string
  /** The answer (or partial output) with the trailing meta lines stripped. */
  body: string
  /** Last steps mined from the "[codex ran N step(s); last: …]" footer. */
  steps: string[]
  /** Total step count reported by that footer, when present. */
  stepCount?: number
  /** Session id from the resume hint — the thread `resume_session` continues. */
  sessionId?: string
}

// loop.ts appends both of these to every codex_worker result.
const STEPS_RE   = /\[codex ran (\d+) step\(s\)(?:;\s*last:\s*([^\]]*))?\]/
const SESSION_RE = /\[codex session:\s*([^\s\]]+)[^\]]*\]/
const FAIL_RE    = /^\s*(?:Codex worker FAILED|codex_worker failed):\s*([\s\S]*?)(?:\n\s*Partial output:\s*\n([\s\S]*))?$/

/**
 * Split a codex_worker tool result into its answer body + the machine-ish meta
 * the harness appends (step summary, resume hint) and detect the failure shape.
 */
export function parseCodexResult(output: unknown): CodexResult {
  let rest = typeof output === 'string' ? output.replace(/\r\n?/g, '\n') : ''

  let steps: string[] = []
  let stepCount: number | undefined
  const sm = rest.match(STEPS_RE)
  if (sm) {
    const n = Number(sm[1])
    if (Number.isFinite(n)) stepCount = n
    steps = (sm[2] ?? '').split('·').map(s => s.trim()).filter(Boolean)
    rest = rest.replace(STEPS_RE, '')
  }

  let sessionId: string | undefined
  const sess = rest.match(SESSION_RE)
  if (sess) {
    sessionId = sess[1]
    rest = rest.replace(SESSION_RE, '')
  }

  let ok = true
  let error: string | undefined
  const fail = rest.match(FAIL_RE)
  if (fail) {
    ok = false
    error = fail[1].trim()
    rest = fail[2] ?? ''
  }

  return { ok, error, body: rest.trim(), steps, stepCount, sessionId }
}

export type CodexSegment =
  | { kind: 'command'; text: string }
  | { kind: 'prose';   text: string }

/**
 * Turn worker output into readable segments: shell invocations (the "$ cmd"
 * progress lines, optionally still wearing their "[codex] " stream prefix)
 * become console rows; everything else coalesces into prose blocks.
 */
export function segmentCodexOutput(output: unknown): CodexSegment[] {
  if (typeof output !== 'string' || !output.trim()) return []
  const segments: CodexSegment[] = []
  let prose: string[] = []

  const flushProse = () => {
    while (prose.length && !prose[0].trim()) prose.shift()
    while (prose.length && !prose[prose.length - 1].trim()) prose.pop()
    if (prose.length) segments.push({ kind: 'prose', text: prose.join('\n') })
    prose = []
  }

  for (const raw of output.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/^\[codex\]\s?/, '')
    const cmd = line.match(/^\s*\$\s+(\S.*)$/)
    if (cmd) {
      flushProse()
      segments.push({ kind: 'command', text: cmd[1].trimEnd() })
      continue
    }
    prose.push(line)
  }
  flushProse()
  return segments
}

// Extensions worth surfacing as "a file the worker touched". Deliberately a
// whitelist: a loose \w+\.\w+ matcher turns version numbers and sentence ends
// into fake file chips.
const FILE_RE = /(?:[A-Za-z]:)?[\w.@+~-]+(?:[\\/][\w.@+~-]+)*\.(?:tsx?|jsx?|mjs|cjs|json|jsonc|md|mdx|css|scss|less|html?|ya?ml|toml|ini|py|rs|go|java|rb|php|sh|ps1|bat|sql|txt|svg|vue|svelte|cpp|hpp|[ch])\b/g

// Prose that the whitelist would otherwise mistake for a filename.
const NOT_A_FILE = new Set(['node.js', 'next.js', 'vue.js', 'three.js', 'react.js', 'nuxt.js', 'express.js'])

/**
 * Collect the distinct file paths a worker answer mentions, in first-seen
 * order. Used for the card's compact "files" footer.
 */
export function extractCodexFiles(text: unknown): string[] {
  if (typeof text !== 'string' || !text) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const path of text.match(FILE_RE) ?? []) {
    // A bare "something.json" with no separator still counts — dotted prose
    // ("v1.2", "0.144.5") is already filtered out by the extension whitelist.
    if (NOT_A_FILE.has(path.toLowerCase())) continue
    if (seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}

/** Body is worth collapsing by default once it stops fitting in a glance. */
export function isLongCodexBody(segments: CodexSegment[], body: string): boolean {
  return segments.length > 4 || body.length > 400
}

// ── Component ────────────────────────────────────────────────────────────────

export interface CodexWorkerCardProps {
  /** Pre-parsed args (ToolCallBlock only mounts the card when these parse). */
  args:        CodexTaskArgs
  /** Final tool result text; undefined while the worker is still running. */
  output?:     string
  running:     boolean
  /** Session ended before the worker returned. */
  aborted?:    boolean
  durationMs?: number
  /**
   * Live worker progress, routed here by pairToolEvents instead of being left
   * as loose `[codex] …` text under the card.
   */
  progress?:   string[]
}

export const CODEX = 'var(--info, #60a5fa)'

export function CodexWorkerCard({ args, output, running, aborted, durationMs, progress }: CodexWorkerCardProps) {
  const { t } = useTranslation('agent')
  // null = follow the automatic rule (open while running, collapsed once a long
  // answer landed); a click pins the user's choice for the rest of the session.
  const [manual, setManual] = useState<boolean | null>(null)

  const result = useMemo(() => parseCodexResult(output), [output])
  const segments = useMemo(() => segmentCodexOutput(result.body), [result.body])
  const files = useMemo(() => extractCodexFiles(result.body), [result.body])

  const failed = !!output && !result.ok
  const expanded = manual ?? (running || !isLongCodexBody(segments, result.body))
  const accent = failed || aborted ? 'var(--danger, #ff5252)' : CODEX
  // The strip retires the moment the result carries its own detail — the card
  // must END in its terminal state, not keep streaming.
  const showProgress = shouldShowProgress({
    running,
    hasResultDetail: segments.length > 0 || result.steps.length > 0 || !!result.error,
    progressCount: progress?.length ?? 0,
  })

  return (
    <div style={{
      border: `2px solid ${failed || aborted ? 'var(--danger, #ff5252)' : 'var(--border)'}`,
      borderLeft: `4px solid ${accent}`,
      background: 'var(--bg-elevated)',
      fontFamily: 'JetBrains Mono, monospace',
      transition: 'box-shadow 80ms linear',
      boxShadow: expanded ? 'var(--shadow-soft)' : 'none',
      marginBottom: 4,
    }}>
      {/* ── Header (always visible, click to toggle) ── */}
      <button
        type="button"
        onClick={() => setManual(expanded ? false : true)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          width: '100%', padding: '6px 10px',
          background: 'transparent', border: 'none',
          color: 'var(--text-primary)',
          fontFamily: 'JetBrains Mono, monospace', fontSize: 12,
          textAlign: 'left', cursor: 'pointer', boxSizing: 'border-box',
        }}
      >
        {/* CODEX badge — filled brutalist tag, distinct from the tool families. */}
        <span style={{
          padding: '2px 8px', background: accent, color: '#000',
          fontSize: 9, fontWeight: 800, letterSpacing: '0.08em',
          textTransform: 'uppercase', flexShrink: 0,
        }}>CODEX</span>

        {/* Sandbox chip — write access is the thing the user approved. */}
        <span
          title={args.write ? t('codexCard.writeTitle') : t('codexCard.readOnlyTitle')}
          style={{
            padding: '2px 6px',
            border: `1px solid ${args.write ? 'var(--warning)' : 'var(--border-strong)'}`,
            color: args.write ? 'var(--warning)' : 'var(--text-muted)',
            fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
            textTransform: 'uppercase', flexShrink: 0,
          }}
        >{args.write ? t('codexCard.write') : t('codexCard.readOnly')}</span>

        {/* The TASK — the whole point of the card. */}
        <span
          title={args.task}
          style={{
            flex: 1, minWidth: 0, fontSize: 11, color: 'var(--text-muted)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >{args.task}</span>

        {typeof durationMs === 'number' && !running && (
          <span style={{ fontSize: 10, color: 'var(--text-dim)', flexShrink: 0 }}>
            {formatToolDuration(durationMs)}
          </span>
        )}

        {/* Live step counter — the run's heartbeat, visible while collapsed. */}
        {running && (progress?.length ?? 0) > 0 && (
          <span style={{ fontSize: 10, color: 'var(--text-dim)', flexShrink: 0 }}>
            {t('codexCard.stepsCount', { count: progress!.length })}
          </span>
        )}

        {/* Status */}
        {aborted ? (
          <span style={{
            padding: '2px 6px', background: 'var(--danger, #ff5252)', color: '#fff',
            fontSize: 9, fontWeight: 800, letterSpacing: '0.08em', flexShrink: 0,
          }} title={t('toolCall.abortedTooltip')}>{t('toolCall.aborted')}</span>
        ) : failed ? (
          <span style={{
            padding: '2px 6px', background: 'var(--danger, #ff5252)', color: '#fff',
            fontSize: 9, fontWeight: 800, letterSpacing: '0.08em', flexShrink: 0,
          }} title={result.error}>{t('codexCard.failed')}</span>
        ) : running ? (
          <span
            className="tachi-pulse-dot"
            style={{ width: 6, height: 6, background: 'var(--warning, #f59e0b)', flexShrink: 0 }}
            title={t('codexCard.runningTitle')}
          />
        ) : null}

        <span style={{
          width: 16, textAlign: 'center', color: 'var(--text-muted)',
          fontSize: 14, fontWeight: 700, flexShrink: 0,
        }}>{expanded ? '−' : '+'}</span>
      </button>

      {/* ── Body ── */}
      {expanded && (
        <div className="tachi-wedge-down" style={{ borderTop: '2px solid var(--border)', background: '#0a0a0a' }}>
          {/* Full task brief — the header only shows one ellipsized line. */}
          <div style={sectionLabel}>{t('codexCard.task')}</div>
          <div style={{ ...bodyText, color: '#d8d8d8', whiteSpace: 'pre-wrap' }}>{args.task}</div>

          {/* Live worker progress — the lines that used to pile up OUTSIDE the
              card as grey `[codex] …` prose. */}
          {showProgress && <CodexProgressStrip lines={progress ?? []} running={running} />}

          {/* Failure headline first — it explains everything below it. */}
          {failed && result.error && (
            <>
              <div style={sectionLabel}>{t('codexCard.error')}</div>
              <div style={{ ...bodyText, color: 'var(--danger, #ff5252)', whiteSpace: 'pre-wrap' }}>
                {result.error.slice(0, 2000)}
              </div>
            </>
          )}

          {/* The answer, segmented into console rows + prose. */}
          {segments.length > 0 && (
            <>
              <div style={sectionLabel}>{failed ? t('codexCard.partial') : t('codexCard.output')}</div>
              <div style={{ maxHeight: 360, overflowY: 'auto', padding: '6px 0' }}>
                {segments.map((seg, i) => seg.kind === 'command' ? (
                  <div key={i} style={consoleRow} title={seg.text}>
                    <span style={{ color: CODEX, flexShrink: 0 }}>$</span>
                    <span style={{ color: '#c8e6c9', wordBreak: 'break-all' }}>{seg.text}</span>
                  </div>
                ) : (
                  <div key={i} style={{ ...bodyText, color: '#d8d8d8', whiteSpace: 'pre-wrap' }}>{seg.text}</div>
                ))}
              </div>
            </>
          )}

          {/* Steps the harness summarized (the worker's last actions). */}
          {result.steps.length > 0 && (
            <>
              <div style={sectionLabel}>
                {typeof result.stepCount === 'number'
                  ? t('codexCard.stepsCount', { count: result.stepCount })
                  : t('codexCard.steps')}
              </div>
              <div style={{ padding: '4px 0' }}>
                {result.steps.map((s, i) => (
                  <div key={i} style={consoleRow} title={s}>
                    <span style={{ color: 'var(--text-dim)', flexShrink: 0 }}>›</span>
                    <span style={{ color: '#b0b0b0', wordBreak: 'break-all' }}>{s}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Files the answer mentions — plain rows, no chip dependency. */}
          {files.length > 0 && (
            <>
              <div style={sectionLabel}>{t('codexCard.files')}</div>
              <div style={{ ...bodyText, color: '#9fd6ff', wordBreak: 'break-all' }}>
                {files.slice(0, 12).join('  ·  ')}
                {files.length > 12 ? `  · +${files.length - 12}` : ''}
              </div>
            </>
          )}

          {/* Resume hint — the id the model passes back as resume_session. */}
          {(result.sessionId || args.resumeSession || args.model) && (
            <div style={{
              padding: '5px 10px', borderTop: 'var(--border-width) solid var(--border)',
              display: 'flex', gap: 12, flexWrap: 'wrap',
              fontSize: 10, color: 'var(--text-dim)',
            }}>
              {result.sessionId && <span>{t('codexCard.session', { id: result.sessionId })}</span>}
              {args.resumeSession && <span>{t('codexCard.resumed', { id: args.resumeSession })}</span>}
              {args.model && <span>{t('codexCard.model', { model: args.model })}</span>}
            </div>
          )}

          {/* Nothing back yet — and no live progress standing in for it. */}
          {output === undefined && (aborted || !showProgress) && (
            <div style={{
              padding: '6px 10px', fontSize: 11,
              color: aborted ? 'var(--danger, #ff5252)' : 'var(--text-dim)',
              fontStyle: aborted ? 'normal' : 'italic',
              fontWeight: aborted ? 700 : undefined,
            }}>
              {aborted ? t('toolCall.abortedPlaceholder') : t('codexCard.runningPlaceholder')}
            </div>
          )}
          {output !== undefined && segments.length === 0 && !failed && (
            <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-dim)', fontStyle: 'italic' }}>
              {t('toolCall.noOutput')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Shared: the live progress strip ──────────────────────────────────────────
//
// Both codex cards mount this. It renders the worker's forwarded progress lines
// as console rows INSIDE the card, tailing the newest ones and auto-scrolling
// while the run is live — the "watch it work" surface the loose `[codex] …`
// text events never gave (they rendered as markdown prose below the card and
// pushed it off-screen).
const PROGRESS_GLYPH: Record<ProgressKind, string> = {
  command: '$',
  edit:    '±',
  error:   '!',
  note:    '·',
}

const PROGRESS_COLOR: Record<ProgressKind, string> = {
  command: '#c8e6c9',
  edit:    '#9fd6ff',
  error:   'var(--danger, #ff5252)',
  note:    '#b0b0b0',
}

export interface CodexProgressStripProps {
  lines:   readonly string[]
  running: boolean
  /** How many rows to keep on screen; older ones collapse into a "+N" hint. */
  max?:    number
}

export function CodexProgressStrip({ lines, running, max = 8 }: CodexProgressStripProps) {
  const { t } = useTranslation('agent')
  const { shown, hidden } = useMemo(() => progressTail(lines, max), [lines, max])
  const scroller = useRef<HTMLDivElement | null>(null)

  // Follow the tail while the worker is live. Only ever scrolls this box.
  useEffect(() => {
    if (!running) return
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [running, lines.length])

  if (shown.length === 0) return null

  return (
    <>
      <div style={{ ...sectionLabel, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>{t('codexCard.progress')}</span>
        {running && (
          <span
            className="tachi-pulse-dot"
            style={{ width: 5, height: 5, background: 'var(--warning, #f59e0b)', flexShrink: 0 }}
            title={t('codexCard.runningTitle')}
          />
        )}
        {hidden > 0 && (
          <span style={{ marginLeft: 'auto', fontWeight: 700, letterSpacing: '0.06em' }}>
            {t('codexCard.progressEarlier', { count: hidden })}
          </span>
        )}
      </div>
      <div ref={scroller} data-codex-progress style={{ maxHeight: 168, overflowY: 'auto', padding: '4px 0' }}>
        {shown.map((line, i) => {
          const kind = classifyProgress(line)
          return (
            <div key={`${i}-${line}`} style={consoleRow} title={line}>
              <span style={{ color: kind === 'error' ? PROGRESS_COLOR.error : CODEX, flexShrink: 0 }}>
                {PROGRESS_GLYPH[kind]}
              </span>
              <span style={{ color: PROGRESS_COLOR[kind], wordBreak: 'break-all' }}>{progressBody(line)}</span>
            </div>
          )
        })}
      </div>
    </>
  )
}

/**
 * Fail-soft wrapper: a shape the card mis-renders must degrade to the generic
 * tool block, never blank the transcript (RootErrorBoundary would otherwise
 * take the whole page).
 */
interface BoundaryState { failed: boolean }

export class CodexCardBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  BoundaryState
> {
  state: BoundaryState = { failed: false }

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error): void {
    console.error('[codex-worker-card]', error)
  }

  render(): React.ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

// Style tokens — exported so CodexReviewCard is a genuine sibling of this card
// (same section labels, same body type, same console row) instead of a fork.
export const sectionLabel: React.CSSProperties = {
  padding: '4px 10px',
  borderBottom: 'var(--border-width) solid var(--border)',
  background: 'var(--bg-base)',
  fontSize: 9,
  fontWeight: 800,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--text-dim)',
  fontFamily: 'JetBrains Mono, monospace',
}

export const bodyText: React.CSSProperties = {
  padding: '6px 10px',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  lineHeight: 1.55,
  wordBreak: 'break-word',
}

export const consoleRow: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  padding: '2px 10px',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  lineHeight: 1.5,
  background: 'rgba(255,255,255,0.03)',
  borderLeft: '2px solid rgba(255,255,255,0.08)',
}
