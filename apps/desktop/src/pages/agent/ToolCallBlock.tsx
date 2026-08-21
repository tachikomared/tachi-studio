// apps/desktop/src/pages/agent/ToolCallBlock.tsx
//
// Compact, collapsible representation of a single agent tool invocation.
//
// Pairs a `tool-call` event (input/args) with its eventual `tool-done` event
// (output). Renders as a one-line brutalist tile with a colored tag chip,
// short context (filename / command / arg summary), and a +/- toggle. When
// expanded, shows the full JSON-pretty input and the raw output (or "running…"
// placeholder when no output has arrived yet).
//
// Mirrors the look users see in Claude Code's transcript: stacked, scannable,
// no wall of text until they ask for it.
import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { InlineDiff } from './InlineDiff'
import { ToolCallRow } from '../../components/ToolCallRow'
import { formatToolDuration } from '../../components/toolCallRow.format'
import { CodexWorkerCard, CodexCardBoundary, isCodexWorkerTool, parseCodexArgs } from './CodexWorkerCard'
import { CodexReviewCard, isCodexReviewTool, parseCodexReviewArgs } from './CodexReviewCard'

export interface ToolCallBlockProps {
  /** Tool name as reported by the harness (e.g. "Read", "Bash", "Edit"). */
  name:    string
  /** JSON-string input as emitted by the harness. */
  input:   string
  /** Final output text; undefined while still running. */
  output?: string
  /** True between tool-call and tool-done (no output yet). */
  running: boolean
  /**
   * True when the session ended (done/error) without a matching tool-done.
   * The tool was abandoned mid-execution; shown as a red [ABORTED] badge.
   */
  aborted?: boolean
  /** Wall-clock ms between tool-call and tool-done (UX #7); shown as "1.2s". */
  durationMs?: number
  /**
   * Live `[codex] …` progress lines pairToolEvents re-routed onto this call.
   * Only the codex cards render them; the generic block ignores the prop.
   */
  progress?: string[]
}

// ── Tool family classification ───────────────────────────────────────────────
//
// Maps a raw tool name (varies across TACHI / OpenClaude / Codex / …) onto a
// stable family used for color + context-extraction. Keeps the matcher loose
// because different harnesses use slightly different names ("Read" vs
// "read_file" vs "view_file") for the same operation.
type Family = 'read' | 'write' | 'edit' | 'bash' | 'search' | 'fetch' | 'list' | 'other'

function familyOf(name: string): Family {
  // A fan-out child's tools arrive prefixed with its index ("[2] read") so the
  // parent transcript reads as N lanes. Strip it before classifying, or every
  // child tool would collapse into the colourless "other" family.
  const n = name.toLowerCase().replace(/^\[\d+\]\s*/, '')
  if (/^(read|cat|view|open)/.test(n) || /read_file|view_file/.test(n)) return 'read'
  if (/^(write|create)/.test(n)    || /write_file|create_file/.test(n)) return 'write'
  if (/^(edit|patch|update|replace|str_replace|multiedit)/.test(n))     return 'edit'
  if (/^(bash|shell|run_command|execute)/.test(n) || /^cmd/.test(n))    return 'bash'
  if (/^(grep|search|find|ripgrep)/.test(n))                            return 'search'
  if (/^(fetch|webfetch|http)/.test(n))                                 return 'fetch'
  if (/^(ls|list|glob|tree)/.test(n))                                   return 'list'
  return 'other'
}

const FAMILY_COLOR: Record<Family, string> = {
  read:   'var(--accent)',
  write:  'var(--success)',
  edit:   'var(--warning)',
  bash:   '#a0e0a0',
  search: 'var(--accent)',
  fetch:  'var(--accent)',
  list:   'var(--text-muted)',
  other:  'var(--text-muted)',
}

// Short label shown in the chip — keeps tool names consistent regardless of
// which harness emitted them.
const FAMILY_LABEL: Record<Family, string> = {
  read:   'READ',
  write:  'WRITE',
  edit:   'EDIT',
  bash:   'BASH',
  search: 'SEARCH',
  fetch:  'FETCH',
  list:   'LIST',
  other:  'TOOL',
}

// ── Context extraction ───────────────────────────────────────────────────────
//
// Pulls the one most-relevant string out of the JSON-stringified `input`
// to show in the collapsed header — file path for reads, command for bash,
// pattern for search, etc. Falls back to a 60-char preview of the raw JSON.
function extractContext(family: Family, rawInput: string, parsed: unknown): string {
  const p = parsed as Record<string, unknown> | null
  if (!p || typeof p !== 'object') {
    return rawInput.length > 60 ? rawInput.slice(0, 60) + '…' : rawInput
  }
  // Common path-ish field names across TACHI / OpenClaude / Codex.
  const path = (p.file_path ?? p.path ?? p.target_file ?? p.filename) as string | undefined
  const cmd  = p.command as string | undefined
  const pat  = (p.pattern ?? p.query) as string | undefined
  const url  = p.url as string | undefined

  if (family === 'bash')    return cmd ? `$ ${cmd}` : '(no command)'
  if (family === 'read')    return path ?? rawInput.slice(0, 60)
  if (family === 'write')   return path ?? rawInput.slice(0, 60)
  if (family === 'edit')    return path ?? rawInput.slice(0, 60)
  if (family === 'search')  return pat ? `“${pat}”` : (path ?? rawInput.slice(0, 60))
  if (family === 'fetch')   return url ?? rawInput.slice(0, 60)
  if (family === 'list')    return path ?? rawInput.slice(0, 60)
  return rawInput.length > 60 ? rawInput.slice(0, 60) + '…' : rawInput
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * One tool invocation.
 *
 * The codex vertical gets rich cards — `codex_worker` its delegation card (task
 * brief, console rows, produced files) and `codex_review` its review card
 * (claim, structured findings by severity, verdict) — and both stream the
 * worker's live progress inside themselves. Every other tool renders as the
 * generic collapsible tile.
 *
 * Each card is behind an error boundary AND behind a parse guard: an unexpected
 * args shape falls straight back to the generic block, so a sidecar schema
 * change can never cost the transcript a tool call.
 */
export function ToolCallBlock(props: ToolCallBlockProps) {
  const codexArgs = useMemo(
    () => (isCodexWorkerTool(props.name) ? parseCodexArgs(props.input) : null),
    [props.name, props.input],
  )
  const reviewArgs = useMemo(
    () => (isCodexReviewTool(props.name) ? parseCodexReviewArgs(props.input) : null),
    [props.name, props.input],
  )
  const generic = <GenericToolCallBlock {...props} />
  if (codexArgs) {
    return (
      <CodexCardBoundary fallback={generic}>
        <CodexWorkerCard
          args={codexArgs}
          output={props.output}
          running={props.running}
          aborted={props.aborted}
          durationMs={props.durationMs}
          progress={props.progress}
        />
      </CodexCardBoundary>
    )
  }
  if (reviewArgs) {
    return (
      <CodexCardBoundary fallback={generic}>
        <CodexReviewCard
          args={reviewArgs}
          output={props.output}
          running={props.running}
          aborted={props.aborted}
          durationMs={props.durationMs}
          progress={props.progress}
        />
      </CodexCardBoundary>
    )
  }
  return generic
}

function GenericToolCallBlock({ name, input, output, running, aborted, durationMs }: ToolCallBlockProps) {
  const { t } = useTranslation('agent')
  const [expanded, setExpanded] = useState(false)
  const fam = familyOf(name)
  const color = FAMILY_COLOR[fam]
  const label = FAMILY_LABEL[fam]

  // Parse once — guards against double-encoded JSON the harness sometimes emits.
  const parsed = useMemo<unknown>(() => {
    try { return JSON.parse(input) } catch { return null }
  }, [input])

  const context = useMemo(() => extractContext(fam, input, parsed), [fam, input, parsed])

  // Errors get a red left-edge so failures stand out at a glance even
  // when the block is collapsed.
  const looksLikeError = !!output && /^(error|exception|traceback|failed)/i.test(output.trim())
  const borderColor = aborted
    ? 'var(--danger, #ff5252)'
    : looksLikeError
      ? 'var(--danger, #ff5252)'
      : 'var(--border)'

  return (
    <div
      style={{
        border: `2px solid ${borderColor}`,
        background: 'var(--bg-elevated)',
        fontFamily: 'JetBrains Mono, monospace',
        // Subtle hover-lift; the brutalist look stays — no border-radius, no easing curve.
        transition: 'box-shadow 80ms linear, transform 80ms linear',
        boxShadow: expanded ? 'var(--shadow-soft)' : 'none',
        marginBottom: 4,
      }}
    >
      {/* ── Header row (always visible, click to toggle) ── */}
      <ToolCallRow
        onClick={() => setExpanded(e => !e)}
        padding="6px 10px"
        fontSize={12}
        bordered={false}
        name=""
        status={aborted || looksLikeError ? 'error' : running ? 'running' : 'ok'}
        /* Family chip — filled brutalist tag (no border-radius). */
        leading={
          <span data-tool-family={fam} style={{
            padding: '2px 8px',
            background: looksLikeError ? 'var(--danger, #ff5252)' : color,
            color: '#000',
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            flexShrink: 0,
          }}>{label}</span>
        }
        /* Context (file path / command / arg summary) fills the middle. */
        argsPreview={context}
      >
        {/* Duration (UX #7): how long the tool actually ran. */}
        {typeof durationMs === 'number' && !running && (
          <span style={{ fontSize: 10, color: 'var(--text-dim)', flexShrink: 0 }}>
            {formatToolDuration(durationMs)}
          </span>
        )}

        {/* Running indicator OR aborted badge OR tool's actual name */}
        {aborted ? (
          <span style={{
            padding: '2px 6px',
            background: 'var(--danger, #ff5252)',
            color: '#fff',
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: '0.08em',
            flexShrink: 0,
          }} title={t('toolCall.abortedTooltip')}>
            {t('toolCall.aborted')}
          </span>
        ) : running ? (
          <span
            className="tachi-pulse-dot"
            style={{
              width: 6, height: 6, background: 'var(--warning, #f59e0b)',
              flexShrink: 0,
            }}
            title={t('toolCall.running')}
          />
        ) : name.toUpperCase() !== label ? (
          <span style={{
            fontSize: 9, color: 'var(--text-dim)', letterSpacing: '0.04em',
            flexShrink: 0,
          }} title={t('toolCall.harnessReports', { name })}>{name}</span>
        ) : null}

        {/* +/- toggle */}
        <span style={{
          width: 16,
          textAlign: 'center',
          color: 'var(--text-muted)',
          fontSize: 14,
          fontWeight: 700,
          flexShrink: 0,
        }}>{expanded ? '−' : '+'}</span>
      </ToolCallRow>

      {/* ── Body (only when expanded) ── */}
      {expanded && (
        <div
          className="tachi-wedge-down"
          style={{
            borderTop: '2px solid var(--border)',
            background: '#0a0a0a',
            color: '#e0e0e0',
          }}
        >
          {/* INPUT section */}
          <div style={sectionLabel}>{t('toolCall.input')}</div>
          <pre style={sectionPre}>
            {parsed != null ? JSON.stringify(parsed, null, 2) : input}
          </pre>

          {/* InlineDiff for Edit / Write tools when we have the necessary data */}
          {(fam === 'edit' || fam === 'write') && parsed != null && typeof parsed === 'object' && (() => {
            const p = parsed as Record<string, unknown>
            const hasEditData = fam === 'edit' && (typeof p.old_string === 'string' || typeof p.new_string === 'string')
            const hasWriteData = fam === 'write' && typeof p.content === 'string'
            return (hasEditData || hasWriteData)
              ? <InlineDiff family={fam} parsedInput={p} />
              : null
          })()}

          {/* RESULT section — only after tool-done arrives. */}
          {output !== undefined && (
            <>
              <div style={sectionLabel}>{t('toolCall.result')}</div>
              <pre style={{
                ...sectionPre,
                maxHeight: 320,
                overflowY: 'auto',
                color: looksLikeError ? 'var(--danger, #ff5252)' : '#a0e0a0',
              }}>
                {output || t('toolCall.noOutput')}
              </pre>
            </>
          )}

          {/* "Running…" / "[ABORTED]" placeholder when no output received */}
          {output === undefined && (
            <div style={{
              padding: '6px 10px',
              fontSize: 11,
              color: aborted ? 'var(--danger, #ff5252)' : 'var(--text-dim)',
              fontStyle: aborted ? 'normal' : 'italic',
              fontWeight: aborted ? 700 : undefined,
              letterSpacing: aborted ? '0.06em' : undefined,
            }}>
              {aborted
                ? t('toolCall.abortedPlaceholder')
                : t('toolCall.runningPlaceholder')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const sectionLabel: React.CSSProperties = {
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

const sectionPre: React.CSSProperties = {
  margin: 0,
  padding: '8px 10px',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  lineHeight: 1.55,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  background: 'transparent',
}
