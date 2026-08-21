// apps/desktop/src/pages/agent/CodexReviewCard.tsx
//
// The transcript card for a `codex_review` tool-call — the adversarial
// second-opinion pass loop.ts runs through the same Codex sidecar, always
// read-only:
//
//   inputSchema: z.object({ summary: z.string(), files: z.array(z.string()).optional(), focus: z.string().optional() })
//   → codexWorker({ task: brief, write: false })
//
// so the RESULT envelope is byte-identical to codex_worker's (answer + the
// "[codex ran N step(s)…]" / "[codex session: …]" footers, or the
// "Codex worker FAILED: …" shape) and is parsed by the worker card's helpers.
// What differs is the CONTENT: the brief asks the reviewer for
// "file:line, severity (CRITICAL/MAJOR/MINOR), and a one-line failure scenario",
// which is a STRUCTURE — and a wall of markdown is the worst way to read it.
//
// This card is a sibling of CodexWorkerCard, not a fork: it reuses that file's
// result parser, segmenter, file extractor, progress strip, style tokens and
// error boundary, and adds only the review-specific parts — the findings
// parser and the verdict chip.
//
// Everything above the component is PURE and unit-tested (codexReviewCard.test.ts).
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatToolDuration } from '../../components/toolCallRow.format'
import {
  CODEX, CodexProgressStrip, bodyText, consoleRow, extractCodexFiles,
  parseCodexResult, sectionLabel, segmentCodexOutput,
} from './CodexWorkerCard'
import { codexToolKind, shouldShowProgress } from './codexProgress'

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** True for the adversarial review tool (NOT codex_worker — different card). */
export function isCodexReviewTool(name: unknown): boolean {
  return codexToolKind(name) === 'review'
}

export interface CodexReviewArgs {
  /** What the agent CLAIMS it did — the thing under review. */
  summary: string
  /** Workspace-relative paths the agent asked the reviewer to focus on. */
  files: string[]
  /** Optional review angle ("concurrency", "error handling"). */
  focus?: string
}

/**
 * Extract the review request from the JSON-string tool input. Returns null for
 * anything without a non-empty `summary` — the caller then keeps the generic
 * tool block rather than showing an empty card.
 */
export function parseCodexReviewArgs(rawInput: unknown): CodexReviewArgs | null {
  if (typeof rawInput !== 'string') return null
  let v: unknown
  try { v = JSON.parse(rawInput) } catch { return null }
  // Some harnesses double-encode the args object; unwrap one level.
  if (typeof v === 'string') {
    try { v = JSON.parse(v) } catch { return null }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const summary = typeof o.summary === 'string' ? o.summary.trim() : ''
  if (!summary) return null
  const files = Array.isArray(o.files)
    ? o.files.filter((f): f is string => typeof f === 'string' && !!f.trim()).map(f => f.trim())
    : []
  const focus = typeof o.focus === 'string' && o.focus.trim() ? o.focus.trim() : undefined
  return { summary, files, focus }
}

export type ReviewSeverity = 'critical' | 'major' | 'minor'

export interface ReviewFinding {
  severity: ReviewSeverity
  /** "src/foo.ts:42" when the reviewer cited a location. */
  location?: string
  /** The failure scenario, markdown noise stripped. */
  text: string
}

// The reviewer is ASKED for CRITICAL/MAJOR/MINOR; BLOCKER shows up often enough
// from models that ignoring it would drop the most important finding on the page.
const SEVERITY_WORD = /(CRITICAL|BLOCKER|MAJOR|MINOR)/
const SEVERITY_LEAD = /^(CRITICAL|BLOCKER|MAJOR|MINOR)\b/i

const SEVERITY_OF: Record<string, ReviewSeverity> = {
  critical: 'critical',
  blocker:  'critical',
  major:    'major',
  minor:    'minor',
}

// "src/foo.ts:42" / "apps\\x\\y.tsx:12:3" — a path with a line number. Bare
// paths (no line) are left to extractCodexFiles; a location chip that isn't a
// location is worse than no chip.
const LOCATION_RE = /(?:[A-Za-z]:)?[\w.@+~-]+(?:[\\/][\w.@+~-]+)*\.[A-Za-z][\w]{0,5}:\d+(?::\d+)?/

const LIST_MARKER = /^\s*(?:[-*•>]+|\d+[.)])\s+/
const HEADING     = /^\s*#{1,6}\s+/
/** Markdown emphasis the reviewer wraps severities and paths in. */
const EMPHASIS    = /[`*_]{1,2}/g

/** How many findings the card will hold — a runaway list is a parse failure. */
export const MAX_FINDINGS = 50

/**
 * Mine the reviewer's answer for structured findings.
 *
 * Deliberately tolerant AND conservative: a line counts as a finding when a
 * severity word leads it (after a bullet / number / emphasis), or when an
 * UPPERCASE severity word appears early in the line — lowercase prose ("a minor
 * detail") must not manufacture findings. Indented follow-on lines extend the
 * finding above them, which is how models format the "failure scenario" half.
 */
export function parseReviewFindings(body: unknown): ReviewFinding[] {
  if (typeof body !== 'string' || !body.trim()) return []
  const out: ReviewFinding[] = []
  let openIdx = -1 // index in `out` a continuation line may extend

  for (const raw of body.replace(/\r\n?/g, '\n').split('\n')) {
    if (!raw.trim()) { openIdx = -1; continue }

    const startsList = LIST_MARKER.test(raw) || HEADING.test(raw)
    const stripped = raw.replace(HEADING, '').replace(LIST_MARKER, '')
    const clean = stripped.replace(EMPHASIS, '').trim()

    let word: string | undefined
    if (SEVERITY_LEAD.test(clean)) {
      word = clean.match(SEVERITY_LEAD)![1]
    } else {
      // Inline: require the reviewer's own uppercase, early in the line.
      const m = clean.slice(0, 160).match(SEVERITY_WORD)
      if (m) word = m[1]
    }

    if (word) {
      const severity = SEVERITY_OF[word.toLowerCase()]
      const location = clean.match(LOCATION_RE)?.[0]
      let text = clean.replace(word, ' ')
      if (location) text = text.replace(location, ' ')
      text = text
        // "(src/a.ts:9)" leaves an orphan bracket pair once the location moves
        // into its own chip.
        .replace(/[([{<]\s*[)\]}>]/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[\s:\-–—,|]+/, '')
        .replace(/[\s:\-–—,|]+$/, '')
        .trim()
      if (out.length < MAX_FINDINGS) {
        out.push({ severity, ...(location ? { location } : {}), text: text || location || clean })
        openIdx = out.length - 1
      }
      continue
    }

    // Continuation: an indented, non-list line right under a finding.
    if (openIdx !== -1 && !startsList && /^\s+\S/.test(raw)) {
      const extra = clean.replace(/\s{2,}/g, ' ').trim()
      if (extra) out[openIdx].text = `${out[openIdx].text} ${extra}`.trim()
      continue
    }
    openIdx = -1
  }
  return out
}

/** Per-severity tally for the header chip. */
export function severityCounts(findings: readonly ReviewFinding[]): Record<ReviewSeverity, number> {
  const counts: Record<ReviewSeverity, number> = { critical: 0, major: 0, minor: 0 }
  for (const f of findings) counts[f.severity]++
  return counts
}

/** Worst severity present — decides the chip colour. */
export function topSeverity(findings: readonly ReviewFinding[]): ReviewSeverity | null {
  if (findings.some(f => f.severity === 'critical')) return 'critical'
  if (findings.some(f => f.severity === 'major')) return 'major'
  if (findings.some(f => f.severity === 'minor')) return 'minor'
  return null
}

// "the work holds" / "no defects found" — the brief explicitly asks the
// reviewer to say this when it fails to refute the claim.
const HOLDS_RE = /\b(?:it holds|holds up|the (?:claim|work|change|implementation|code)[^.\n]{0,40}\bholds\b|no (?:real )?(?:defects|issues|problems|bugs|concerns)\b|found no (?:defects|issues|problems|bugs)|nothing (?:to flag|blocking))/i

export type ReviewVerdict = 'running' | 'failed' | 'findings' | 'holds' | 'reviewed'

/**
 * The card's terminal state. `reviewed` is the honest fallback: the reviewer
 * answered, but neither raised a parseable finding nor said the work holds.
 */
export function reviewVerdict(o: {
  hasOutput: boolean
  ok: boolean
  findings: readonly ReviewFinding[]
  body: string
}): ReviewVerdict {
  if (!o.hasOutput) return 'running'
  if (!o.ok) return 'failed'
  if (o.findings.length > 0) return 'findings'
  if (HOLDS_RE.test(o.body)) return 'holds'
  return 'reviewed'
}

// ── Component ────────────────────────────────────────────────────────────────

const SEVERITY_COLOR: Record<ReviewSeverity, string> = {
  critical: 'var(--danger, #ff5252)',
  major:    'var(--warning, #f59e0b)',
  minor:    'var(--text-muted)',
}

export interface CodexReviewCardProps {
  args:        CodexReviewArgs
  /** Final tool result text; undefined while the reviewer is still working. */
  output?:     string
  running:     boolean
  aborted?:    boolean
  durationMs?: number
  /** Live reviewer progress routed in by pairToolEvents. */
  progress?:   string[]
}

export function CodexReviewCard({ args, output, running, aborted, durationMs, progress }: CodexReviewCardProps) {
  const { t } = useTranslation('agent')
  // null = automatic (open while running or when there is something to act on);
  // a click pins the user's choice.
  const [manual, setManual] = useState<boolean | null>(null)
  const [notesOpen, setNotesOpen] = useState(false)

  const result = useMemo(() => parseCodexResult(output), [output])
  const findings = useMemo(() => parseReviewFindings(result.body), [result.body])
  const segments = useMemo(() => segmentCodexOutput(result.body), [result.body])
  const files = useMemo(() => extractCodexFiles(result.body), [result.body])

  const failed = !!output && !result.ok
  const verdict = reviewVerdict({ hasOutput: output !== undefined, ok: result.ok, findings, body: result.body })
  const worst = topSeverity(findings)
  const counts = useMemo(() => severityCounts(findings), [findings])

  // Findings are the whole point — a review that raised some stays open.
  const expanded = manual ?? (running || findings.length > 0 || failed || result.body.length <= 400)
  const accent = failed || aborted
    ? 'var(--danger, #ff5252)'
    : worst
      ? SEVERITY_COLOR[worst]
      : CODEX

  const showProgress = shouldShowProgress({
    running,
    hasResultDetail: findings.length > 0 || segments.length > 0 || result.steps.length > 0 || !!result.error,
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
        {/* Same filled CODEX tag the worker card wears — one family. */}
        <span style={{
          padding: '2px 8px', background: accent, color: '#000',
          fontSize: 9, fontWeight: 800, letterSpacing: '0.08em',
          textTransform: 'uppercase', flexShrink: 0,
        }}>CODEX</span>

        {/* …distinguished by the REVIEW rider. */}
        <span style={{
          padding: '2px 6px', border: `1px solid ${accent}`, color: accent,
          fontSize: 9, fontWeight: 800, letterSpacing: '0.08em',
          textTransform: 'uppercase', flexShrink: 0,
        }}>{t('codexReview.review')}</span>

        {/* codex_review is ALWAYS read-only — the sandbox chip states it. */}
        <span
          title={t('codexCard.readOnlyTitle')}
          style={{
            padding: '2px 6px', border: '1px solid var(--border-strong)',
            color: 'var(--text-muted)',
            fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
            textTransform: 'uppercase', flexShrink: 0,
          }}
        >{t('codexCard.readOnly')}</span>

        {/* The CLAIM under review. */}
        <span
          title={args.summary}
          style={{
            flex: 1, minWidth: 0, fontSize: 11, color: 'var(--text-muted)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >{args.summary}</span>

        {running && (progress?.length ?? 0) > 0 && (
          <span style={{ fontSize: 10, color: 'var(--text-dim)', flexShrink: 0 }}>
            {t('codexCard.stepsCount', { count: progress!.length })}
          </span>
        )}

        {typeof durationMs === 'number' && !running && (
          <span style={{ fontSize: 10, color: 'var(--text-dim)', flexShrink: 0 }}>
            {formatToolDuration(durationMs)}
          </span>
        )}

        {/* ── Verdict ── */}
        {aborted ? (
          <span style={{
            padding: '2px 6px', background: 'var(--danger, #ff5252)', color: '#fff',
            fontSize: 9, fontWeight: 800, letterSpacing: '0.08em', flexShrink: 0,
          }} title={t('toolCall.abortedTooltip')}>{t('toolCall.aborted')}</span>
        ) : verdict === 'failed' ? (
          <span style={{
            padding: '2px 6px', background: 'var(--danger, #ff5252)', color: '#fff',
            fontSize: 9, fontWeight: 800, letterSpacing: '0.08em', flexShrink: 0,
          }} title={result.error}>{t('codexCard.failed')}</span>
        ) : verdict === 'findings' ? (
          <span
            data-review-verdict="findings"
            style={{
              padding: '2px 6px', background: accent, color: '#000',
              fontSize: 9, fontWeight: 800, letterSpacing: '0.08em', flexShrink: 0,
            }}
            title={`${counts.critical} CRITICAL · ${counts.major} MAJOR · ${counts.minor} MINOR`}
          >{t('codexReview.findingsCount', { count: findings.length })}</span>
        ) : verdict === 'holds' ? (
          <span
            data-review-verdict="holds"
            style={{
              padding: '2px 6px', background: 'var(--success, #4ade80)', color: '#000',
              fontSize: 9, fontWeight: 800, letterSpacing: '0.08em', flexShrink: 0,
            }}
            title={t('codexReview.holdsTitle')}
          >{t('codexReview.holds')}</span>
        ) : verdict === 'reviewed' ? (
          <span
            data-review-verdict="reviewed"
            style={{
              padding: '2px 6px', border: '1px solid var(--border-strong)', color: 'var(--text-muted)',
              fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', flexShrink: 0,
            }}
          >{t('codexReview.reviewed')}</span>
        ) : (
          <span
            className="tachi-pulse-dot"
            style={{ width: 6, height: 6, background: 'var(--warning, #f59e0b)', flexShrink: 0 }}
            title={t('codexReview.runningTitle')}
          />
        )}

        <span style={{
          width: 16, textAlign: 'center', color: 'var(--text-muted)',
          fontSize: 14, fontWeight: 700, flexShrink: 0,
        }}>{expanded ? '−' : '+'}</span>
      </button>

      {/* ── Body ── */}
      {expanded && (
        <div className="tachi-wedge-down" style={{ borderTop: '2px solid var(--border)', background: '#0a0a0a' }}>
          {/* What the agent claimed — the reviewer's target. */}
          <div style={sectionLabel}>{t('codexReview.claim')}</div>
          <div style={{ ...bodyText, color: '#d8d8d8', whiteSpace: 'pre-wrap' }}>{args.summary}</div>

          {/* The request's own scope: focus angle + the files it pointed at. */}
          {(args.focus || args.files.length > 0) && (
            <div style={{
              padding: '5px 10px', borderTop: 'var(--border-width) solid var(--border)',
              display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 10, color: 'var(--text-dim)',
            }}>
              {args.focus && <span>{t('codexReview.focus')}: {args.focus}</span>}
              {args.files.length > 0 && (
                <span style={{ wordBreak: 'break-all' }}>
                  {t('codexReview.filesRequested')}: {args.files.slice(0, 12).join('  ·  ')}
                  {args.files.length > 12 ? `  · +${args.files.length - 12}` : ''}
                </span>
              )}
            </div>
          )}

          {/* Live reviewer progress, inside the card that owns it. */}
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

          {/* ── FINDINGS: the structural payoff of this card ── */}
          {findings.length > 0 ? (
            <>
              <div style={sectionLabel}>{t('codexReview.findingsCount', { count: findings.length })}</div>
              <div style={{ maxHeight: 360, overflowY: 'auto', padding: '4px 0' }}>
                {findings.map((f, i) => (
                  <div key={i} data-severity={f.severity} style={{
                    ...consoleRow,
                    alignItems: 'baseline', flexWrap: 'wrap',
                    borderLeft: `2px solid ${SEVERITY_COLOR[f.severity]}`,
                    padding: '4px 10px',
                  }}>
                    <span style={{
                      color: '#000', background: SEVERITY_COLOR[f.severity],
                      padding: '0 5px', fontSize: 9, fontWeight: 800,
                      letterSpacing: '0.08em', flexShrink: 0,
                    }}>{f.severity.toUpperCase()}</span>
                    {f.location && (
                      <span style={{ color: '#9fd6ff', wordBreak: 'break-all', flexShrink: 0 }}>{f.location}</span>
                    )}
                    <span style={{ color: '#d8d8d8', wordBreak: 'break-word', flex: 1, minWidth: 0 }}>{f.text}</span>
                  </div>
                ))}
              </div>

              {/* Everything the reviewer wrote, one click away — the structured
                  list above is a READING of it, never a replacement. */}
              <button
                type="button"
                onClick={() => setNotesOpen(o => !o)}
                style={{
                  ...sectionLabel,
                  display: 'block', width: '100%', textAlign: 'left',
                  cursor: 'pointer', border: 'none',
                  borderBottom: 'var(--border-width) solid var(--border)',
                }}
              >{notesOpen ? '−' : '+'} {t('codexReview.notes')}</button>
              {notesOpen && (
                <div style={{ maxHeight: 320, overflowY: 'auto', padding: '6px 0' }}>
                  {segments.map((seg, i) => seg.kind === 'command' ? (
                    <div key={i} style={consoleRow} title={seg.text}>
                      <span style={{ color: CODEX, flexShrink: 0 }}>$</span>
                      <span style={{ color: '#c8e6c9', wordBreak: 'break-all' }}>{seg.text}</span>
                    </div>
                  ) : (
                    <div key={i} style={{ ...bodyText, color: '#d8d8d8', whiteSpace: 'pre-wrap' }}>{seg.text}</div>
                  ))}
                </div>
              )}
            </>
          ) : segments.length > 0 ? (
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
          ) : null}

          {/* Steps the harness summarized (what the reviewer actually did). */}
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

          {/* Files the review touched on. */}
          {files.length > 0 && (
            <>
              <div style={sectionLabel}>{t('codexCard.files')}</div>
              <div style={{ ...bodyText, color: '#9fd6ff', wordBreak: 'break-all' }}>
                {files.slice(0, 12).join('  ·  ')}
                {files.length > 12 ? `  · +${files.length - 12}` : ''}
              </div>
            </>
          )}

          {/* Resume hint — the reviewer's thread can be continued by the worker. */}
          {result.sessionId && (
            <div style={{
              padding: '5px 10px', borderTop: 'var(--border-width) solid var(--border)',
              fontSize: 10, color: 'var(--text-dim)',
            }}>
              {t('codexCard.session', { id: result.sessionId })}
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
              {aborted ? t('toolCall.abortedPlaceholder') : t('codexReview.runningPlaceholder')}
            </div>
          )}
          {output !== undefined && segments.length === 0 && findings.length === 0 && !failed && (
            <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-dim)', fontStyle: 'italic' }}>
              {t('toolCall.noOutput')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
