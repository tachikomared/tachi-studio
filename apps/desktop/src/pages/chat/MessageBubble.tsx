import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { ChatMessage, ContentPart, contentToText, useChatStore } from '../../store/chat.store'
import { Markdown } from './Markdown'
import { ReasoningBlock } from './ReasoningBlock'
import { parseReasoning } from './reasoning'
import { extractArtifacts } from './extractArtifacts'
import { useArtifactsStore } from '../../store/artifacts.store'
import { showToast } from '../../components/Toaster'
import { friendlyError } from '../../lib/friendly-error'
import { computeCompareStats, formatRate, formatTtft } from './compareStats'
import { SourceChips } from './SourceChips'
import { ChatFilePathChips } from './ChatFilePathChips'
import { shouldRenderFileChips } from './messageWorkingDir'
import { modelDisplayName } from '../../utils/model-display'

interface MessageBubbleProps {
  message: ChatMessage
  conversationId?: string
  /**
   * FILE-PATH CHIPS: the dir this message's paths resolve against, already
   * resolved by the list (message stamp → conversation dirs → null). Passed as
   * a prop rather than looked up here so the memoized bubble keeps re-rendering
   * on a plain string compare.
   */
  workingDir?: string | null
}

function isToolUse(content: string): boolean {
  return content.startsWith('[tool:')
}

function parseToolName(content: string): string {
  const match = content.match(/^\[tool:([^\]]+)\]/)
  return match ? match[1] : 'unknown'
}

// ── Media artifact block (image / audio / video) ───────────────────────────
// Renders a Surplus media result inline with a small Save / Reveal action row.
// `path` (when present) is the absolute on-disk artifact path used for Save.

const mediaActionBtnStyle: React.CSSProperties = {
  padding: '2px 8px',
  border: '2px solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-muted)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.08em',
  cursor: 'pointer',
  textTransform: 'uppercase',
}

async function saveMediaPart(part: ContentPart, t: TFunction): Promise<void> {
  // Disk-backed parts (audio/video, and images with a path) copy via the engine.
  const path = (part.type === 'audio' || part.type === 'video') ? part.path : undefined
  if (path) {
    const destDir = await window.tachi.agent.pickFolder()
    if (!destDir) return
    try {
      const res = await window.tachi.surplusMedia.saveArtifact({ jobId: '', index: 0, destDir, srcPath: path })
      showToast({ kind: 'info', text: t('media.savedTo', { path: res.path }) })
    } catch (err) {
      showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
    return
  }
  // Inline data-URL image with no disk path → browser download.
  if (part.type === 'image' && part.data.startsWith('data:')) {
    const a = document.createElement('a')
    a.href = part.data
    a.download = `surplus-image-${Date.now()}.png`
    a.click()
    return
  }
  showToast({ kind: 'error', text: t('media.nothingToSave') })
}

function MediaPartBlock({ part }: { part: ContentPart }): React.ReactElement | null {
  const { t } = useTranslation('chat')
  const diskPath = (part.type === 'audio' || part.type === 'video') ? part.path : undefined
  const media =
    part.type === 'image' ? (
      <img
        src={part.data}
        alt={t('media.generatedImageAlt')}
        style={{ maxWidth: '70%', display: 'block', border: 'var(--border-width) solid var(--border)' }}
      />
    ) : part.type === 'audio' ? (
      <audio controls src={part.src} style={{ display: 'block', maxWidth: '100%' }} />
    ) : part.type === 'video' ? (
      <video controls src={part.src} style={{ maxWidth: '70%', display: 'block', border: 'var(--border-width) solid var(--border)' }} />
    ) : null
  if (!media) return null
  return (
    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {media}
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" style={mediaActionBtnStyle} onClick={() => { saveMediaPart(part, t) }}>{t('media.save')}</button>
        {diskPath && (
          <button
            type="button"
            style={mediaActionBtnStyle}
            onClick={() => { window.tachi.shell.revealInFolder(diskPath).catch(() => {}) }}
          >{t('media.reveal')}</button>
        )}
      </div>
    </div>
  )
}

function renderUserParts(content: ChatMessage['content'], t: TFunction): React.ReactNode {
  if (typeof content === 'string') {
    return <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{content}</span>
  }
  return (
    <>
      {(content as ContentPart[]).map((part, i) => {
        if (part.type === 'text') {
          return <span key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{part.text}</span>
        }
        if (part.type === 'image') {
          return (
            <img
              key={i}
              src={part.data}
              alt={t('media.attachedImageAlt')}
              style={{ maxWidth: '70%', display: 'block', marginTop: 4, border: 'var(--border-width) solid var(--border)' }}
            />
          )
        }
        if (part.type === 'file') {
          return (
            <div
              key={i}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '3px 8px', border: 'var(--border-width) solid var(--border)',
                fontSize: 10, fontFamily: 'JetBrains Mono', background: 'var(--bg-elevated)',
                marginTop: 4,
              }}
            >
              [file] {part.filename} <span style={{ color: 'var(--text-dim)' }}>({Math.round(part.data.length / 1024)} KB)</span>
            </div>
          )
        }
        if (part.type === 'audio' || part.type === 'video') {
          return <MediaPartBlock key={i} part={part} />
        }
        return null
      })}
    </>
  )
}

/**
 * Render a block of assistant text, splitting out reasoning (<think> /
 * <thought> / <reasoning>) into collapsed disclosures. Text outside the tags
 * renders as normal markdown. Streaming-safe: an unclosed reasoning tag renders
 * as an in-progress (open) disclosure.
 */
function ReasoningAwareText({ source }: { source: string }): React.ReactElement {
  const segments = parseReasoning(source)
  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === 'reasoning' ? (
          <ReasoningBlock key={i} text={seg.text} inProgress={seg.open} />
        ) : (
          <Markdown key={i} source={seg.text} />
        ),
      )}
    </>
  )
}

/**
 * One compare column's hardware-truth stat line (UX #6): tokens/second over
 * the generation window + time-to-first-token, both measured around the leg's
 * real stream in the main process. Unmeasurable dimensions render "—" — never
 * a fabricated number. Chars/4-estimated rates are prefixed "~".
 */
function CompareStatLine({ member }: { member: NonNullable<ChatMessage['panelMembers']>[number] }) {
  const { t } = useTranslation('chat')
  const stats = computeCompareStats(member)
  const rateLabel = stats.tokPerSec !== null
    ? t(stats.tokensEstimated ? 'compare.tokPerSecEst' : 'compare.tokPerSec', { rate: formatRate(stats.tokPerSec) })
    : t('compare.tokPerSecNone')
  const ttftLabel = stats.ttftSeconds !== null
    ? t('compare.ttft', { seconds: formatTtft(stats.ttftSeconds) })
    : t('compare.ttftNone')
  return (
    <div
      data-testid="compare-stat-line"
      style={{
        padding: '3px 8px', borderBottom: '2px solid var(--border)',
        fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
        color: 'var(--text-dim)', letterSpacing: '0.04em', whiteSpace: 'nowrap',
      }}
    >
      {rateLabel} · {ttftLabel}
    </div>
  )
}

/**
 * Fusion COMPARE mode: render every panel answer as a pickable column
 * (model · wall-time · tokens · chars). Picking a column adopts its text as
 * the message content; afterwards a one-line note replaces the columns.
 */
function ComparePanelColumns({ message, conversationId }: { message: ChatMessage; conversationId?: string }) {
  const { t } = useTranslation('chat')
  const choose = useChatStore(s => s.choosePanelAnswer)
  const members = message.panelMembers ?? []
  const picked = message.chosenPanelIndex
  if (members.length === 0) return null

  if (picked !== undefined) {
    return (
      <div style={{ fontSize: 9, color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace', marginBottom: 4 }}>
        {t('compare.pickedNote', { count: members.length, model: members[picked]?.model ?? '' })}
      </div>
    )
  }

  return (
    <div data-testid="compare-columns" style={{ display: 'flex', gap: 8, overflowX: 'auto', padding: '4px 0 8px', alignItems: 'stretch' }}>
      {members.map((m, i) => (
        <div
          key={i}
          data-testid={`compare-col-${i}`}
          style={{
            minWidth: 280, maxWidth: 340, flex: '0 0 auto',
            border: '2px solid var(--border)', background: 'var(--bg-surface)',
            boxShadow: 'var(--shadow-hard)', display: 'flex', flexDirection: 'column',
          }}
        >
          <div style={{
            display: 'flex', alignItems: 'baseline', gap: 6, padding: '5px 8px',
            borderBottom: '2px solid var(--border)', background: 'var(--bg-elevated)',
            fontFamily: 'JetBrains Mono, monospace',
          }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={m.model}>{modelDisplayName(m.model)}</span>
            <span style={{ fontSize: 9, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
              {(m.ms / 1000).toFixed(1)}s{m.tokens ? ` · ${m.tokens} tok` : ''} · {m.text.length}c
            </span>
          </div>
          {/* UX #6: measured tok/s + TTFT — local and cloud columns alike */}
          <CompareStatLine member={m} />
          <div style={{ padding: '6px 8px', fontSize: 12, lineHeight: 1.55, maxHeight: 300, overflowY: 'auto', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
            <Markdown source={m.text} />
          </div>
          {conversationId && (
            <button
              data-testid={`compare-use-${i}`}
              onClick={() => choose(conversationId, message.id, i)}
              style={{
                marginTop: 'auto', padding: '5px 8px', border: 'none',
                borderTop: '2px solid var(--border)', background: 'var(--accent)', color: '#fff',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 700,
                textTransform: 'uppercase', letterSpacing: '0.08em', cursor: 'pointer',
              }}
            >{t('compare.useThis')}</button>
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * Render the body of an assistant message. Text parts are merged and run
 * through the markdown renderer; image/file parts keep their previous
 * brutalist chip rendering so attachments still surface.
 */
function renderAssistantBody(content: ChatMessage['content']): React.ReactNode {
  if (typeof content === 'string') {
    return <ReasoningAwareText source={content} />
  }
  const parts = content as ContentPart[]
  // Collapse consecutive text parts into a single markdown render so fenced
  // code blocks that span "parts" (rare but possible) still parse correctly.
  const groups: Array<{ kind: 'text'; text: string } | { kind: 'media'; part: ContentPart } | { kind: 'file'; part: ContentPart }> = []
  for (const p of parts) {
    if (p.type === 'text') {
      const last = groups[groups.length - 1]
      if (last && last.kind === 'text') last.text += p.text
      else groups.push({ kind: 'text', text: p.text })
    } else if (p.type === 'image' || p.type === 'audio' || p.type === 'video') {
      groups.push({ kind: 'media', part: p })
    } else if (p.type === 'file') {
      groups.push({ kind: 'file', part: p })
    }
  }
  return (
    <>
      {groups.map((g, i) => {
        if (g.kind === 'text') {
          return <ReasoningAwareText key={i} source={g.text} />
        }
        if (g.kind === 'media') {
          return <MediaPartBlock key={i} part={g.part} />
        }
        if (g.kind === 'file' && g.part.type === 'file') {
          return (
            <div
              key={i}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '3px 8px', border: 'var(--border-width) solid var(--border)',
                fontSize: 10, fontFamily: 'JetBrains Mono', background: 'var(--bg-elevated)',
                marginTop: 4,
              }}
            >
              [file] {g.part.filename} <span style={{ color: 'var(--text-dim)' }}>({Math.round(g.part.data.length / 1024)} KB)</span>
            </div>
          )
        }
        return null
      })}
    </>
  )
}

// ── Assistant hover-action bar ─────────────────────────────────────────────
interface AssistantActionBarProps {
  visible: boolean
  text: string
  messageId: string
  conversationId?: string
}

function AssistantActionBar({ visible, text, messageId, conversationId }: AssistantActionBarProps) {
  const { t } = useTranslation('chat')
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      window.dispatchEvent(new CustomEvent('tachi:toast', {
        detail: { kind: 'info', text: t('toast.copied') },
      }))
    } catch {
      window.dispatchEvent(new CustomEvent('tachi:toast', {
        detail: { kind: 'error', text: t('toast.copyFailed') },
      }))
    }
  }
  const onRegen = () => {
    window.dispatchEvent(new CustomEvent('tachi:regenerate-message', {
      detail: { messageId, conversationId },
    }))
  }
  const onFork = () => {
    if (!conversationId) return
    const forked = useChatStore.getState().forkConversation(conversationId, messageId)
    if (forked) {
      window.dispatchEvent(new CustomEvent('tachi:toast', {
        detail: { kind: 'success', text: t('actions.forked', 'Forked — you are now in the new branch') },
      }))
    }
  }
  return (
    <div
      style={{
        display: 'flex',
        gap: 6,
        marginTop: 6,
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? 'auto' : 'none',
        transition: 'opacity 120ms ease-out',
      }}
    >
      <button
        type="button"
        onClick={onCopy}
        style={{
          padding: '2px 8px',
          border: '2px solid var(--border)',
          background: 'var(--bg-elevated)',
          color: 'var(--text-muted)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.08em',
          cursor: 'pointer',
          textTransform: 'uppercase',
        }}
      >
        {t('actions.copy')}
      </button>
      <button
        type="button"
        onClick={onRegen}
        style={{
          padding: '2px 8px',
          border: '2px solid var(--border)',
          background: 'var(--bg-elevated)',
          color: 'var(--text-muted)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.08em',
          cursor: 'pointer',
          textTransform: 'uppercase',
        }}
      >
        {t('actions.regenerate')}
      </button>
      <button
        type="button"
        onClick={onFork}
        title={t('actions.fork', 'Fork — new chat seeded with the conversation up to here')}
        style={{
          padding: '2px 8px',
          border: '2px solid var(--border)',
          background: 'var(--bg-elevated)',
          color: 'var(--text-muted)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.08em',
          cursor: 'pointer',
          textTransform: 'uppercase',
        }}
      >
        ⑂ {t('actions.forkLabel', 'Fork')}
      </button>
    </div>
  )
}

// ── ModelBadge ────────────────────────────────────────────────────────────────
// Brutalist 1px border badge shown below every assistant response.
// Format: [PROVIDER · model]  (e.g. [BANKR · gemini-3-flash] or [OPENCLAUDE · claude-opus-4.5]).
// AUTO-routed replies prepend an "AUTO →" tag so the router's pick is visible.
function ModelBadge({ provider, model, autoLabel }: { provider?: string; model?: string; autoLabel?: string }) {
  const parts: string[] = []
  if (provider) parts.push(provider.toUpperCase())
  if (model)    parts.push(modelDisplayName(model))
  if (parts.length === 0 && !autoLabel) return null
  return (
    <div title={model} style={{
      marginTop: 6,
      display: 'inline-block',
      padding: '1px 5px',
      border: 'var(--border-width) solid var(--border)',
      background: 'var(--bg-elevated)',
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 10,
      color: 'var(--text-muted)',
      letterSpacing: '0.04em',
      userSelect: 'none',
    }}>
      {autoLabel && <span style={{ color: 'var(--accent-text)', fontWeight: 700 }}>{autoLabel} → </span>}
      [{parts.join(' · ')}]
    </div>
  )
}

/**
 * CONNECTION RESILIENCE — the transient strip that replaces a streaming reply
 * while its dropped stream is being re-requested. Counts down to the next
 * attempt so the wait is legible instead of looking like a hang.
 */
function ChatReconnectStrip({ info }: { info: NonNullable<ChatMessage['reconnect']> }) {
  const { t } = useTranslation('chat')
  const [remainingMs, setRemainingMs] = useState(Math.max(0, info.delayMs - (Date.now() - info.at)))
  useEffect(() => {
    const tick = () => setRemainingMs(Math.max(0, info.delayMs - (Date.now() - info.at)))
    tick()
    const id = setInterval(tick, 500)
    return () => clearInterval(id)
  }, [info.at, info.delayMs])
  const seconds = Math.ceil(remainingMs / 1000)
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 12px', margin: '4px 16px',
        borderLeft: '4px solid var(--warning, var(--accent-alt))',
        background: 'var(--bg-inset)',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 11,
        color: 'var(--warning, var(--accent-alt))',
      }}
      title={t('reconnect.reason', { reason: info.reason, defaultValue: 'Cause: {{reason}}' })}
    >
      <span aria-hidden style={{ fontSize: 13 }}>⟳</span>
      <span style={{ letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 700 }}>
        {t('reconnect.retrying', {
          attempt: info.attempt,
          max: info.maxAttempts,
          defaultValue: 'Connection lost — retrying {{attempt}}/{{max}}',
        })}
      </span>
      {seconds > 0 && (
        <span style={{ color: 'var(--text-muted)' }}>
          {t('reconnect.nextIn', { seconds, defaultValue: 'next in {{seconds}}s' })}
        </span>
      )}
    </div>
  )
}

export const MessageBubble = React.memo(function MessageBubble({ message, conversationId, workingDir }: MessageBubbleProps) {
  const { t } = useTranslation('chat')
  const { role, model, streaming, error, autoRoute } = message
  const content = message.content
  // For tool-use detection, work with the text representation
  const contentText = contentToText(content)
  const [hovered, setHovered] = useState(false)

  // ── Artifact extraction ────────────────────────────────────────────────────
  // Run once when an assistant message finishes streaming (streaming goes false
  // or was never true). Use a ref to prevent repeated extraction on re-renders.
  const extractedRef = useRef(false)
  const addArtifact = useArtifactsStore(s => s.addArtifact)

  useEffect(() => {
    // Only extract from completed assistant messages in a known conversation
    if (role !== 'assistant') return
    if (streaming) return
    if (error) return
    if (!conversationId) return
    if (extractedRef.current) return
    extractedRef.current = true

    const candidates = extractArtifacts(contentText, message.id)
    for (const candidate of candidates) {
      // Avoid re-adding artifacts that are already stored for this message
      // (e.g. after a page reload where the message is already in localStorage)
      const existing = useArtifactsStore.getState().getForConversation(conversationId)
      const alreadyStored = existing.some(
        a => a.messageId === message.id && a.content === candidate.content,
      )
      if (!alreadyStored) {
        addArtifact(conversationId, candidate)
      }
    }
  }, [streaming, role, error, conversationId, message.id, contentText, addArtifact])

  // Thinking state — and, while a dropped stream is being re-requested, the
  // CONNECTION RESILIENCE strip in its place. The `reconnect` guard is belt and
  // braces: a `reset` chunk always empties the content just before `reconnect`
  // arrives, so contentText is empty anyway, but if it ever weren't we still
  // want the retry state on screen rather than a stalled-looking half answer.
  if (role === 'assistant' && streaming && (!contentText || message.reconnect)) {
    return message.reconnect
      ? <ChatReconnectStrip info={message.reconnect} />
      : (
        <div
          role="status"
          aria-label={t('a11y.thinking', { defaultValue: 'Assistant is thinking' })}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 16px',
            color: 'var(--text-muted)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 11,
          }}
        >
          <span aria-hidden="true" style={{ color: 'var(--accent)', letterSpacing: 2, fontSize: 14 }}>···</span>
          <span style={{ letterSpacing: '0.1em', textTransform: 'uppercase' }}>{t('message.thinking')}</span>
        </div>
      )
  }

  // Error state
  if (role === 'assistant' && error) {
    const fe = friendlyError(t, error)
    return (
      <div role="article" aria-label={t('a11y.errorMessage', { defaultValue: 'Assistant error' })} style={{
        padding: '8px 12px',
        borderLeft: '4px solid var(--destructive)',
        background: 'var(--bg-inset)',
        margin: '4px 16px',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 12,
        color: 'var(--destructive)',
      }}>
        <div style={{ fontSize: 10, fontWeight: 700, marginBottom: 4, letterSpacing: '0.08em' }}>{t('message.error')}</div>
        <div>{fe.title}</div>
        {fe.detail && (
          <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>{fe.detail}</div>
        )}
      </div>
    )
  }

  // Tool use
  if (role === 'assistant' && isToolUse(contentText)) {
    const toolName = parseToolName(contentText)
    const details = contentText.replace(/^\[tool:[^\]]+\]\s*/, '')
    return (
      <div role="article" aria-label={t('a11y.toolMessage', { defaultValue: 'Tool call: {{tool}}', tool: toolName })} style={{
        padding: '6px 12px',
        borderLeft: '4px solid var(--accent-alt)',
        background: 'var(--bg-inset)',
        margin: '4px 16px',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 11,
      }}>
        <div style={{ color: 'var(--accent-alt)', fontWeight: 700, marginBottom: 2 }}>
          <span aria-hidden="true">▶ </span>{toolName}
        </div>
        {details && (
          <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>{details}</div>
        )}
      </div>
    )
  }

  // User message
  if (role === 'user') {
    const onEdit = () => window.dispatchEvent(new CustomEvent('tachi:edit-message', { detail: { messageId: message.id, conversationId } }))
    const onFork = () => {
      if (!conversationId) return
      const forked = useChatStore.getState().forkConversation(conversationId, message.id)
      if (forked) showToast({ kind: 'success', text: t('actions.forked', 'Forked — you are now in the new branch') })
    }
    return (
      <div
        role="article"
        aria-label={t('a11y.userMessage', { defaultValue: 'Your message' })}
        style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 6, padding: '4px 16px' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        /* KEYBOARD PARITY: the fork/edit controls are hover-revealed
           (opacity 0 + pointerEvents none) but still in the tab order — a
           keyboard user would otherwise focus two invisible, unclickable
           buttons. Focus reveals the row exactly like the mouse does. */
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
      >
        <button
          type="button"
          onClick={onFork}
          title={t('actions.fork', 'Fork — new chat seeded with the conversation up to here')}
          aria-label={t('actions.fork', 'Fork — new chat seeded with the conversation up to here')}
          style={{
            opacity: hovered ? 1 : 0, pointerEvents: hovered ? 'auto' : 'none', transition: 'opacity 120ms ease-out',
            padding: '2px 7px', border: '2px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-muted)',
            fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700, cursor: 'pointer',
          }}
        >⑂</button>
        <button
          type="button"
          onClick={onEdit}
          title={t('actions.editRewind', 'Edit & regenerate from here')}
          aria-label={t('actions.editRewind', 'Edit & regenerate from here')}
          style={{
            opacity: hovered ? 1 : 0, pointerEvents: hovered ? 'auto' : 'none', transition: 'opacity 120ms ease-out',
            padding: '2px 7px', border: '2px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-muted)',
            fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700, cursor: 'pointer',
          }}
        >↺</button>
        <div style={{
          maxWidth: '75%',
          padding: '8px 12px',
          border: 'var(--border-width) solid var(--accent)',
          background: 'var(--accent-muted)',
          color: 'var(--text-primary)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 13,
          lineHeight: 1.5,
          boxShadow: 'var(--shadow-hard)',
        }}>
          {renderUserParts(content, t)}
        </div>
      </div>
    )
  }

  // AI message (default assistant)
  return (
    <div
      role="article"
      aria-label={t('a11y.assistantMessage', { defaultValue: 'Assistant reply' })}
      style={{ padding: '8px 16px' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      /* Same keyboard parity as the user row: COPY / REGENERATE / FORK are
         hover-revealed but tabbable, so focus must reveal them too. */
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
    >
      {/* Header row: dot + TACHI label + model */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        marginBottom: 4,
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 10,
      }}>
        <div aria-hidden="true" style={{
          width: 7,
          height: 7,
          background: 'var(--accent)',
          flexShrink: 0,
        }} />
        <span style={{ color: 'var(--accent-text)', fontWeight: 700, letterSpacing: '0.06em' }}>TACHI</span>
        {(model || autoRoute) && (
          <span style={{ color: 'var(--text-dim)' }} title={autoRoute ? t('auto.routedTitle', { defaultValue: 'Picked automatically by the AUTO router' }) : model}>
            {autoRoute && (
              <span style={{ color: 'var(--accent-text)', fontWeight: 700 }}>{t('auto.badge', { defaultValue: 'AUTO' })} → </span>
            )}
            {modelDisplayName(model)}
          </span>
        )}
      </div>
      {/* Fusion compare: pickable side-by-side columns (before any pick) */}
      {message.panelMembers && (
        <ComparePanelColumns message={message} conversationId={conversationId} />
      )}
      {/* Message body */}
      <div
        aria-live="polite"
        aria-atomic="false"
        style={{
          color: 'var(--text-muted)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 13,
          lineHeight: 1.6,
        }}
      >
        {renderAssistantBody(content)}
      </div>
      {/* T20: attached-folder provenance — file:line chips that expand to the
          exact retrieved chunk. Renders nothing when retrieval wasn't used. */}
      <SourceChips citations={message.citations} />
      {/* FILE-PATH CHIPS: files the reply NAMED (as opposed to files it was
          grounded in). Finished assistant turns only — see shouldRenderFileChips
          for why streaming is excluded. Renders nothing when the text names no
          previewable path. */}
      {shouldRenderFileChips(message) && (
        <ChatFilePathChips text={contentText} workingDir={workingDir ?? null} />
      )}
      {!streaming && !error && (
        <AssistantActionBar
          visible={hovered}
          text={contentText}
          messageId={message.id}
          conversationId={conversationId}
        />
      )}
      {/* Model identity badge — always visible, below bubble. For AUTO-routed
          replies the badge shows the CONCRETE provider the router picked, not
          the 'auto' pseudo-provider, prefixed with an "AUTO →" tag.

          PROVENANCE (driver-proven 2026-08-01): the provider comes from THIS
          MESSAGE's own record — never the conversation's live providerId, which
          made a delivered Kilo reply relabel itself "[OPENROUTER-OAUTH]" when
          the picker changed. Messages written before the stamp shipped carry no
          providerId and show only their recorded model: no segment beats a
          guess. */}
      {(model || message.providerId || autoRoute) && (
        <ModelBadge
          provider={autoRoute?.provider ?? message.providerId}
          model={model}
          autoLabel={autoRoute ? t('auto.badge', { defaultValue: 'AUTO' }) : undefined}
        />
      )}
    </div>
  )
})
