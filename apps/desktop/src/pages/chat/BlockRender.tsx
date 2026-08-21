// apps/desktop/src/pages/chat/BlockRender.tsx
//
// Sprint D3 — Brutalist block-tree renderer.
// Renders a Block[] (heading / bullet / text / code) as React elements.
// Style matches the ToolCallBlock brutalist aesthetic: 2px borders, JetBrains Mono,
// no border-radius, semantic CSS vars.

import React from 'react'
import { useTranslation } from 'react-i18next'

// ── Block type mirror (must stay in sync with playbook-service.ts) ────────────

export type Block =
  | { type: 'heading'; level: 1 | 2; text: string }
  | { type: 'bullet';  text: string; children?: Block[] }
  | { type: 'text';    text: string }
  | { type: 'code';    lang?: string; text: string }

// ── Shared style constants ─────────────────────────────────────────────────────

const MONO: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
}

// ── Individual block renderers ────────────────────────────────────────────────

function HeadingBlock({ level, text }: { level: 1 | 2; text: string }) {
  const isH1 = level === 1
  return (
    <span
      style={{
        display: 'block',
        fontWeight: 700,
        fontSize: isH1 ? 12 : 11,
        borderBottom: '2px solid var(--border-default, var(--border))',
        paddingBottom: 2,
        marginBottom: isH1 ? 6 : 4,
        marginTop: isH1 ? 8 : 6,
        color: 'var(--text-primary)',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        ...MONO,
      }}
    >
      {text}
    </span>
  )
}

function BulletBlock({ text, children }: { text: string; children?: Block[] }) {
  return (
    <div style={{ marginBottom: 2 }}>
      <div style={{
        display: 'flex',
        gap: 4,
        fontSize: 10,
        color: 'var(--text-primary)',
        ...MONO,
      }}>
        <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>&gt;</span>
        <span>{text}</span>
      </div>
      {children && children.length > 0 && (
        <div style={{ paddingLeft: 16 }}>
          {children.map((child, i) => (
            <BlockNode key={i} block={child} />
          ))}
        </div>
      )}
    </div>
  )
}

function TextBlock({ text }: { text: string }) {
  return (
    <p style={{
      margin: '2px 0',
      fontSize: 10,
      color: 'var(--text-primary)',
      lineHeight: 1.5,
      ...MONO,
    }}>
      {text}
    </p>
  )
}

function CodeBlock({ lang, text }: { lang?: string; text: string }) {
  return (
    <pre style={{
      margin: '4px 0',
      padding: '4px 8px',
      border: '2px solid var(--border-default, var(--border))',
      background: 'var(--bg-elevated)',
      fontSize: 10,
      overflowX: 'auto',
      color: 'var(--text-primary)',
      ...MONO,
    }}>
      {lang && (
        <span style={{ color: 'var(--text-muted)', display: 'block', marginBottom: 2 }}>
          [{lang}]
        </span>
      )}
      {text}
    </pre>
  )
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

function BlockNode({ block }: { block: Block }) {
  switch (block.type) {
    case 'heading':
      return <HeadingBlock level={block.level} text={block.text} />
    case 'bullet':
      return <BulletBlock text={block.text} children={block.children} />
    case 'text':
      return <TextBlock text={block.text} />
    case 'code':
      return <CodeBlock lang={block.lang} text={block.text} />
    default:
      return null
  }
}

// ── Public component ──────────────────────────────────────────────────────────

interface BlockRenderProps {
  blocks: Block[]
}

export function BlockRender({ blocks }: BlockRenderProps) {
  const { t } = useTranslation('chat')
  if (!blocks || blocks.length === 0) {
    return (
      <div style={{ color: 'var(--text-dim)', fontSize: 10, ...MONO }}>
        {t('blocks.empty')}
      </div>
    )
  }
  return (
    <div>
      {blocks.map((block, i) => (
        <BlockNode key={i} block={block} />
      ))}
    </div>
  )
}
