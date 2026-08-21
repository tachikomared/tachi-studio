// apps/desktop/src/components/MermaidBlock.tsx
//
// Renders ```mermaid fences from chat markdown as real diagrams.
//
// - mermaid@11 is bundled locally (no CDN, CSP-safe) and loaded via a lazy
//   dynamic import the first time a diagram actually mounts.
// - Initialized ONCE with securityLevel 'strict' (labels sanitized, no
//   scripts/click bindings), so injecting the produced SVG via
//   dangerouslySetInnerHTML is safe.
// - Streaming-friendly: rendering is debounced. While the fence is still
//   growing (partial/unparseable code), the component shows the plain fenced
//   code block — no error flicker, no wasted parses. Only after the code has
//   been stable for a beat does mermaid run.
// - Results are memoized by code content in a module-level cache so remounts
//   (message list re-renders, tab switches) never re-parse.

import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

// ── lazy mermaid singleton ──────────────────────────────────────────────────

type MermaidApi = typeof import('mermaid')['default']

let _mermaidPromise: Promise<MermaidApi> | null = null

function loadMermaid(): Promise<MermaidApi> {
  if (_mermaidPromise) return _mermaidPromise
  _mermaidPromise = import('mermaid')
    .then(mod => {
      const mermaid = mod.default
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'dark',
        fontFamily: 'JetBrains Mono, monospace',
      })
      return mermaid
    })
    .catch(err => {
      // Allow a later mount to retry instead of caching the failure forever.
      _mermaidPromise = null
      throw err
    })
  return _mermaidPromise
}

// ── render cache (code → outcome), keeps remounts from re-parsing ───────────

const CACHE_MAX = 50
const _svgCache = new Map<string, string>()
const _errCache = new Map<string, string>()

function cachePut(cache: Map<string, string>, key: string, value: string): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, value)
}

let _idCounter = 0

/** Wait this long after the last code change before parsing — while a chat
 *  response streams, the fence mutates every few ms and must NOT be parsed. */
const RENDER_DEBOUNCE_MS = 300

function firstLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const line = msg.split('\n')[0]?.trim() || 'diagram failed to render'
  return line.length > 160 ? `${line.slice(0, 157)}...` : line
}

// ── fallback: plain fenced code block (mirrors the chat code-block chrome) ──

function FallbackCode({ code }: { code: string }) {
  const { t } = useTranslation('chat')

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      window.dispatchEvent(new CustomEvent('tachi:toast', {
        detail: { kind: 'success', text: t('toast.codeCopied') },
      }))
    } catch {
      window.dispatchEvent(new CustomEvent('tachi:toast', {
        detail: { kind: 'error', text: t('toast.copyFailed') },
      }))
    }
  }

  return (
    <div
      style={{
        margin: '8px 0',
        border: '2px solid var(--border)',
        background: 'var(--bg-inset)',
        boxShadow: 'var(--shadow-soft)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '4px 8px',
          background: 'var(--bg-elevated)',
          borderBottom: '2px solid var(--border)',
        }}
      >
        <span
          style={{
            fontSize: 9,
            color: 'var(--text-dim)',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            fontFamily: 'JetBrains Mono, monospace',
            fontWeight: 700,
          }}
        >
          mermaid
        </span>
        <button
          type="button"
          onClick={onCopy}
          style={{
            padding: '2px 8px',
            border: '2px solid var(--accent)',
            background: 'transparent',
            color: 'var(--accent)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '0.1em',
            cursor: 'pointer',
            textTransform: 'uppercase',
          }}
        >
          {t('actions.copy')}
        </button>
      </div>
      <div
        style={{
          // Fixed dark background to match the always-dark code card in chat.
          background: '#0a0a0a',
          color: '#e2e4ea',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 12.5,
          lineHeight: 1.6,
          padding: '10px 12px',
          overflowX: 'auto',
        }}
      >
        <pre style={{ margin: 0, whiteSpace: 'pre' }}>
          <code>{code}</code>
        </pre>
      </div>
    </div>
  )
}

// ── the block ───────────────────────────────────────────────────────────────

type RenderState =
  | { kind: 'pending' }
  | { kind: 'svg'; svg: string }
  | { kind: 'error'; message: string }

interface MermaidBlockProps {
  code: string
}

export const MermaidBlock = React.memo(function MermaidBlock({ code }: MermaidBlockProps) {
  const trimmed = code.trim()

  const [state, setState] = useState<RenderState>(() => {
    const svg = _svgCache.get(trimmed)
    if (svg) return { kind: 'svg', svg }
    const error = _errCache.get(trimmed)
    if (error) return { kind: 'error', message: error }
    return { kind: 'pending' }
  })

  useEffect(() => {
    const cachedSvg = _svgCache.get(trimmed)
    if (cachedSvg) {
      setState({ kind: 'svg', svg: cachedSvg })
      return
    }
    const cachedErr = _errCache.get(trimmed)
    if (cachedErr) {
      setState({ kind: 'error', message: cachedErr })
      return
    }
    // Unknown code → show the plain fence while we wait for it to stabilize.
    setState({ kind: 'pending' })
    if (!trimmed) return

    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        const id = `tachi-mermaid-${++_idCounter}`
        try {
          const mermaid = await loadMermaid()
          if (cancelled) return
          const { svg } = await mermaid.render(id, trimmed)
          cachePut(_svgCache, trimmed, svg)
          if (!cancelled) setState({ kind: 'svg', svg })
        } catch (err) {
          // mermaid can leave an orphaned temp element in <body> on failure —
          // both the target id and its 'd'-prefixed scratch container.
          for (const orphanId of [id, `d${id}`]) {
            const el = document.getElementById(orphanId)
            if (el) el.remove()
          }
          const message = firstLine(err)
          cachePut(_errCache, trimmed, message)
          if (!cancelled) setState({ kind: 'error', message })
        }
      })()
    }, RENDER_DEBOUNCE_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [trimmed])

  if (state.kind === 'svg') {
    return (
      <div
        style={{
          margin: '8px 0',
          maxWidth: '100%',
          overflow: 'auto',
          border: '1px solid var(--border)',
          // mermaid 'dark' theme expects a dark canvas — fixed like the code card.
          background: '#0a0a0a',
          padding: '10px 12px',
        }}
        // securityLevel 'strict' sanitizes the SVG (no scripts, no bindings).
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    )
  }

  return (
    <div>
      <FallbackCode code={code} />
      {state.kind === 'error' && (
        <div
          style={{
            margin: '-6px 0 8px',
            fontSize: 10,
            color: 'var(--text-dim)',
            fontFamily: 'JetBrains Mono, monospace',
            letterSpacing: '0.02em',
          }}
        >
          {/* Hardcoded English by design — diagnostic note, not product copy. */}
          mermaid render failed: {state.message}
        </div>
      )}
    </div>
  )
})

export default MermaidBlock
