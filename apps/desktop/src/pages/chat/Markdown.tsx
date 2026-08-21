// apps/desktop/src/pages/chat/Markdown.tsx
//
// Brutalist markdown renderer for assistant chat messages.
// - GitHub-flavored markdown via react-markdown + remark-gfm
// - Code fences highlighted with shiki (cached singleton highlighter)
// - Copy button on every code block, links open through window.tachi.shell
//
// Streaming-friendly: re-renders on every `source` change. Code blocks render
// a plain <pre> first and upgrade to highlighted HTML once shiki resolves.

import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Highlighter, BundledLanguage } from 'shiki'
import { getHighlighter } from 'shiki'
import MermaidBlock from '../../components/MermaidBlock'

// ── shiki: cached singleton (do NOT re-instantiate per render) ─────────────
const SUPPORTED_LANGS = [
  'javascript', 'typescript', 'tsx', 'jsx', 'python', 'bash', 'shell',
  'json', 'css', 'html', 'go', 'rust', 'java', 'sql', 'yaml', 'markdown',
] as const
const SUPPORTED_LANG_SET = new Set<string>(SUPPORTED_LANGS)
const THEME = 'github-dark'

let _highlighter: Highlighter | null = null
let _highlighterPromise: Promise<Highlighter> | null = null

function loadHighlighter(): Promise<Highlighter> {
  if (_highlighter) return Promise.resolve(_highlighter)
  if (_highlighterPromise) return _highlighterPromise
  _highlighterPromise = getHighlighter({
    themes: [THEME],
    langs: SUPPORTED_LANGS as unknown as BundledLanguage[],
  }).then(h => {
    _highlighter = h
    return h
  })
  return _highlighterPromise
}

function normalizeLang(raw: string | undefined): string {
  if (!raw) return 'text'
  const l = raw.toLowerCase()
  if (l === 'sh' || l === 'zsh') return 'bash'
  if (l === 'ts') return 'typescript'
  if (l === 'js') return 'javascript'
  if (l === 'yml') return 'yaml'
  if (l === 'md') return 'markdown'
  return SUPPORTED_LANG_SET.has(l) ? l : 'text'
}

// ── components ──────────────────────────────────────────────────────────────

interface CodeBlockProps {
  language: string
  code: string
}

function CodeBlock({ language, code }: CodeBlockProps) {
  const { t } = useTranslation('chat')
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (language === 'text') {
      setHtml(null)
      return
    }
    loadHighlighter()
      .then(h => {
        if (cancelled) return
        const out = h.codeToHtml(code, { lang: language, theme: THEME })
        setHtml(out)
      })
      .catch((err) => {
        // Fall back to the plain <pre> below — but say WHY once, loudly: a
        // silent catch here hid a CSP-blocked shiki wasm for weeks (packaged
        // builds rendered unreadable code with zero console evidence).
        if (!(window as unknown as { __shikiWarned?: boolean }).__shikiWarned) {
          ;(window as unknown as { __shikiWarned?: boolean }).__shikiWarned = true
          console.error('[markdown] shiki highlighter failed — code blocks fall back to plain text:', err)
        }
      })
    return () => { cancelled = true }
  }, [code, language])

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
          {language}
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
        className="tachi-shiki"
        style={{
          // The code card is ALWAYS dark (github-dark shiki theme), so the
          // fallback text color must be a FIXED light value — var(--text-primary)
          // is near-black in the light theme and made un-highlighted code
          // invisible on this background.
          background: '#0a0a0a',
          color: '#e2e4ea',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 12.5,
          lineHeight: 1.6,
          padding: '10px 12px',
          overflowX: 'auto',
        }}
      >
        {html ? (
          <div
            // shiki returns a complete <pre> tree; inject inert HTML
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <pre style={{ margin: 0, whiteSpace: 'pre' }}>
            <code>{code}</code>
          </pre>
        )}
      </div>
    </div>
  )
}

function openExternal(href: string): void {
  try {
    const api = (window as unknown as { tachi?: { shell?: { openExternal?: (u: string) => Promise<void> } } }).tachi
    if (api?.shell?.openExternal) {
      void api.shell.openExternal(href)
    }
  } catch {
    /* noop */
  }
}

// react-markdown passes `node` plus standard intrinsic props; we accept any
// children and narrow as needed.
const components: Components = {
  code(props) {
    const { className, children, ...rest } = props as {
      className?: string
      children?: React.ReactNode
      inline?: boolean
    }
    // react-markdown v9 emits `<code>` inline for inline code and `<code>`
    // wrapped in `<pre>` for fences. The `pre` override below skips wrapping
    // and renders our card. Inline code is whatever doesn't match a fence
    // language pattern — detect via className === undefined OR no `language-`.
    const match = /language-([\w-]+)/.exec(className || '')
    const isInline = !match
    if (isInline) {
      return (
        <code
          {...rest}
          style={{
            background: 'var(--bg-inset)',
            color: 'var(--accent)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: '0.92em',
            padding: '1px 4px',
            border: '2px solid var(--border)',
          }}
        >
          {children}
        </code>
      )
    }
    // Block code is handled by the `pre` override which extracts text + lang
    // from the underlying `<code>` element. Returning children here keeps the
    // shape valid in case anything else inspects the tree.
    return <code className={className}>{children}</code>
  },
  pre(props) {
    // react-markdown gives us <pre><code className="language-xx">text</code></pre>
    // We crack open the child <code> to read its language + raw text.
    const child = React.Children.toArray(props.children).find(
      (c): c is React.ReactElement => React.isValidElement(c),
    )
    if (!child) {
      return <pre {...props} />
    }
    const childProps = (child.props || {}) as { className?: string; children?: React.ReactNode }
    const match = /language-([\w-]+)/.exec(childProps.className || '')
    const rawLang = match ? match[1] : undefined
    const language = normalizeLang(rawLang)
    // Flatten code text — react-markdown delivers a single string child for
    // fenced code, but be defensive against array children.
    const codeText = React.Children.toArray(childProps.children)
      .map(c => (typeof c === 'string' ? c : ''))
      .join('')
      .replace(/\n$/, '')
    // ```mermaid fences render as diagrams (with a code-block fallback while
    // streaming / on parse errors). Checked against rawLang because
    // normalizeLang folds unknown languages into 'text'.
    if ((rawLang || '').toLowerCase() === 'mermaid') {
      return <MermaidBlock code={codeText} />
    }
    return <CodeBlock language={language} code={codeText} />
  },
  a(props) {
    const { href, children, ...rest } = props as {
      href?: string
      children?: React.ReactNode
    }
    return (
      <a
        {...rest}
        href={href}
        onClick={e => {
          e.preventDefault()
          if (href) openExternal(href)
        }}
        style={{
          color: 'var(--accent)',
          textDecoration: 'underline',
          textUnderlineOffset: 2,
          cursor: 'pointer',
        }}
      >
        {children}
      </a>
    )
  },
  p(props) {
    return (
      <p style={{ margin: '6px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {props.children}
      </p>
    )
  },
  h1(props) {
    return (
      <h1
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: 'var(--text-primary)',
          margin: '14px 0 8px',
          paddingBottom: 4,
          borderBottom: '2px solid var(--border)',
          fontFamily: 'JetBrains Mono, monospace',
          letterSpacing: '0.02em',
        }}
      >
        {props.children}
      </h1>
    )
  },
  h2(props) {
    return (
      <h2
        style={{
          fontSize: 16,
          fontWeight: 700,
          color: 'var(--text-primary)',
          margin: '12px 0 6px',
          paddingBottom: 3,
          borderBottom: '2px solid var(--border)',
          fontFamily: 'JetBrains Mono, monospace',
          letterSpacing: '0.02em',
        }}
      >
        {props.children}
      </h2>
    )
  },
  h3(props) {
    return (
      <h3
        style={{
          fontSize: 14,
          fontWeight: 700,
          color: 'var(--text-primary)',
          margin: '10px 0 4px',
          fontFamily: 'JetBrains Mono, monospace',
        }}
      >
        {props.children}
      </h3>
    )
  },
  h4(props) {
    return (
      <h4 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', margin: '8px 0 4px' }}>
        {props.children}
      </h4>
    )
  },
  h5(props) {
    return (
      <h5 style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', margin: '6px 0 4px' }}>
        {props.children}
      </h5>
    )
  },
  h6(props) {
    return (
      <h6 style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)', margin: '6px 0 4px' }}>
        {props.children}
      </h6>
    )
  },
  ul(props) {
    return (
      <ul style={{ margin: '6px 0', paddingLeft: 22, listStyle: 'square' }}>
        {props.children}
      </ul>
    )
  },
  ol(props) {
    return (
      <ol style={{ margin: '6px 0', paddingLeft: 22 }}>
        {props.children}
      </ol>
    )
  },
  li(props) {
    return <li style={{ margin: '2px 0' }}>{props.children}</li>
  },
  blockquote(props) {
    return (
      <blockquote
        style={{
          margin: '8px 0',
          padding: '4px 10px',
          borderLeft: '4px solid var(--accent)',
          background: 'var(--bg-inset)',
          color: 'var(--text-muted)',
        }}
      >
        {props.children}
      </blockquote>
    )
  },
  hr() {
    return <hr style={{ border: 0, borderTop: '2px solid var(--border)', margin: '12px 0' }} />
  },
  strong(props) {
    return <strong style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{props.children}</strong>
  },
  em(props) {
    return <em style={{ color: 'var(--text-primary)', fontStyle: 'italic' }}>{props.children}</em>
  },
  table(props) {
    return (
      <div style={{ overflowX: 'auto', margin: '8px 0' }}>
        <table
          style={{
            borderCollapse: 'collapse',
            border: '2px solid var(--border)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12,
          }}
        >
          {props.children}
        </table>
      </div>
    )
  },
  thead(props) {
    return <thead style={{ background: 'var(--bg-elevated)' }}>{props.children}</thead>
  },
  tbody(props) {
    return <tbody>{props.children}</tbody>
  },
  tr(props) {
    return <tr style={{ borderBottom: '2px solid var(--border)' }}>{props.children}</tr>
  },
  th(props) {
    return (
      <th
        style={{
          textAlign: 'left',
          padding: '4px 8px',
          border: '2px solid var(--border)',
          color: 'var(--text-primary)',
          fontWeight: 700,
        }}
      >
        {props.children}
      </th>
    )
  },
  td(props) {
    return (
      <td
        style={{
          padding: '4px 8px',
          border: '2px solid var(--border)',
          color: 'var(--text-muted)',
        }}
      >
        {props.children}
      </td>
    )
  },
}

interface MarkdownProps {
  source: string
}

export const Markdown = React.memo(function Markdown({ source }: MarkdownProps) {
  // Memoize plugins array so react-markdown does not re-init on every render.
  const remarkPlugins = useMemo(() => [remarkGfm], [])
  return (
    <div className="tachi-markdown">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  )
})

export default Markdown
