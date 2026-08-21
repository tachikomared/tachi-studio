// apps/desktop/src/pages/learn/LearnPage.tsx
//
// In-app learning guide — plain-language walkthrough so anyone (no coding
// background needed) can understand what TachiDesk does and follow along.
// Self-contained content; for the deep technical docs see docs/app/*.md.
//
// Brutalist: 2px borders, no radius, JetBrains Mono, semantic CSS vars, no emojis.

import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Trans, useTranslation } from 'react-i18next'
import { useFirstLaunchStore } from '../../store/firstLaunch.store'

interface Section {
  id: string
  title: string
  body: React.ReactNode
}

export function LearnPage() {
  const navigate = useNavigate()
  const { t } = useTranslation('learn')

  // First-launch welcome hero (shown once on a fresh install; see
  // FirstLaunchGate). Dismissing persists the done-flag here; navigating away is
  // handled by the gate's location observer — both permanent, never re-shown.
  const heroVisible = useFirstLaunchStore(s => s.heroVisible)
  const dismissHero = useFirstLaunchStore(s => s.dismissHero)

  const go = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const sections: Section[] = [
    {
      id: 'basics',
      title: t('sections.basics.title'),
      body: (
        <>
          <p style={p}>
            <Trans i18nKey="sections.basics.intro1" t={t} components={inlineComponents} />
          </p>
          <p style={p}>
            {t('sections.basics.intro2')}
          </p>
          <ul style={ul}>
            <li><Trans i18nKey="sections.basics.ways.chat" t={t} components={inlineComponents} /></li>
            <li><Trans i18nKey="sections.basics.ways.code" t={t} components={inlineComponents} /></li>
            <li><Trans i18nKey="sections.basics.ways.design" t={t} components={inlineComponents} /></li>
            <li><Trans i18nKey="sections.basics.ways.media" t={t} components={inlineComponents} /></li>
            <li><Trans i18nKey="sections.basics.ways.nodes" t={t} components={inlineComponents} /></li>
          </ul>
        </>
      ),
    },
    {
      id: 'chat',
      title: t('sections.chat.title'),
      body: (
        <>
          <ol style={ol}>
            <li><Trans i18nKey="sections.chat.steps.open" t={t} components={inlineComponents} /></li>
            <li>{t('sections.chat.steps.type')}</li>
            <li>{t('sections.chat.steps.done')}</li>
          </ol>
          <p style={note}>
            <Trans i18nKey="sections.chat.note" t={t} components={inlineComponents} />
          </p>
          <button style={linkBtn} onClick={() => navigate('/chat')}>{t('sections.chat.open')}</button>
          <p style={subhead}>{t('sections.chat.moreTitle')}</p>
          <ul style={ul}>
            <li><Trans i18nKey="sections.chat.extras.commands" t={t} components={inlineComponents} /></li>
            <li><Trans i18nKey="sections.chat.extras.sources" t={t} components={inlineComponents} /></li>
          </ul>
        </>
      ),
    },
    {
      id: 'code',
      title: t('sections.code.title'),
      body: (
        <>
          <ol style={ol}>
            <li><Trans i18nKey="sections.code.steps.open" t={t} components={inlineComponents} /></li>
            <li><Trans i18nKey="sections.code.steps.choose" t={t} components={inlineComponents} /></li>
            <li><Trans i18nKey="sections.code.steps.type" t={t} components={inlineComponents} /></li>
            <li><Trans i18nKey="sections.code.steps.watch" t={t} components={inlineComponents} /></li>
          </ol>
          <p style={note}>
            {t('sections.code.note')}
          </p>
          <button style={linkBtn} onClick={() => navigate('/agent')}>{t('sections.code.open')}</button>
          <p style={subhead}>{t('sections.code.moreTitle')}</p>
          <ul style={ul}>
            <li><Trans i18nKey="sections.code.extras.tachiapp" t={t} components={inlineComponents} /></li>
            <li><Trans i18nKey="sections.code.extras.spawnLoop" t={t} components={inlineComponents} /></li>
            <li><Trans i18nKey="sections.code.extras.incomplete" t={t} components={inlineComponents} /></li>
          </ul>
        </>
      ),
    },
    {
      id: 'design',
      title: t('sections.design.title'),
      body: (
        <>
          <ol style={ol}>
            <li><Trans i18nKey="sections.design.steps.open" t={t} components={inlineComponents} /></li>
            <li><Trans i18nKey="sections.design.steps.pick" t={t} components={inlineComponents} /></li>
            <li><Trans i18nKey="sections.design.steps.engine" t={t} components={inlineComponents} /></li>
            <li>{t('sections.design.steps.type')}</li>
          </ol>
          <p style={note}>
            <Trans i18nKey="sections.design.note" t={t} components={inlineComponents} />
          </p>
          <button style={linkBtn} onClick={() => navigate('/design')}>{t('sections.design.open')}</button>
        </>
      ),
    },
    {
      id: 'media',
      title: t('sections.media.title'),
      body: (
        <>
          <ol style={ol}>
            <li><Trans i18nKey="sections.media.steps.open" t={t} components={inlineComponents} /></li>
            <li>{t('sections.media.steps.pick')}</li>
            <li>{t('sections.media.steps.prompt')}</li>
          </ol>
          <p style={note}>
            <Trans i18nKey="sections.media.note" t={t} components={inlineComponents} />
          </p>
          <button style={linkBtn} onClick={() => navigate('/media')}>{t('sections.media.open')}</button>
        </>
      ),
    },
    {
      id: 'buttons',
      title: t('sections.buttons.title'),
      body: (
        <>
          <p style={p}>{t('sections.buttons.intro')}</p>
          <table style={table}>
            <thead>
              <tr><th style={th}>{t('sections.buttons.table.head.button')}</th><th style={th}>{t('sections.buttons.table.head.plain')}</th><th style={th}>{t('sections.buttons.table.head.realName')}</th></tr>
            </thead>
            <tbody>
              <tr><td style={td}><strong>{t('sections.buttons.table.mode.name')}</strong></td><td style={td}>{t('sections.buttons.table.mode.plain')}</td><td style={tdDim}>plan / build</td></tr>
              <tr><td style={td}><strong>{t('sections.buttons.table.thinking.name')}</strong></td><td style={td}>{t('sections.buttons.table.thinking.plain')}</td><td style={tdDim}>normal / think / ultra</td></tr>
              <tr><td style={td}><strong>{t('sections.buttons.table.engine.name')}</strong></td><td style={td}>{t('sections.buttons.table.engine.plain')}</td><td style={tdDim}>TACHI · OpenClaude</td></tr>
              <tr><td style={td}><strong>{t('sections.buttons.table.gateway.name')}</strong></td><td style={td}>{t('sections.buttons.table.gateway.plain')}</td><td style={tdDim}>Free · Bankr · Surplus · Venice</td></tr>
            </tbody>
          </table>
          <p style={note}>
            <Trans i18nKey="sections.buttons.note" t={t} components={inlineComponents} />
          </p>
        </>
      ),
    },
    {
      id: 'private',
      title: t('sections.private.title'),
      body: (
        <>
          <p style={p}>
            <Trans i18nKey="sections.private.intro" t={t} components={inlineComponents} />
          </p>
          <ol style={ol}>
            <li><Trans i18nKey="sections.private.steps.palette" t={t} components={inlineComponents} /></li>
            <li><Trans i18nKey="sections.private.steps.toggle" t={t} components={inlineComponents} /></li>
            <li><Trans i18nKey="sections.private.steps.badge" t={t} components={inlineComponents} /></li>
          </ol>
          <p style={note}>
            {t('sections.private.note')}
          </p>
        </>
      ),
    },
    {
      id: 'providers',
      title: t('sections.providers.title'),
      body: (
        <>
          <p style={p}>
            {t('sections.providers.intro')}
          </p>
          <ol style={ol}>
            <li><Trans i18nKey="sections.providers.steps.settings" t={t} components={inlineComponents} /></li>
            <li><Trans i18nKey="sections.providers.steps.key" t={t} components={inlineComponents} /></li>
            <li>{t('sections.providers.steps.green')}</li>
          </ol>
          <button style={linkBtn} onClick={() => navigate('/settings')}>{t('sections.providers.open')}</button>
        </>
      ),
    },
    {
      id: 'power',
      title: t('sections.power.title'),
      body: (
        <>
          <ul style={ul}>
            <li><Trans i18nKey="sections.power.list.nodes" t={t} components={inlineComponents} /></li>
            <li><Trans i18nKey="sections.power.list.swarm" t={t} components={inlineComponents} /></li>
            <li><Trans i18nKey="sections.power.list.parallel" t={t} components={inlineComponents} /></li>
            <li><Trans i18nKey="sections.power.list.inbox" t={t} components={inlineComponents} /></li>
            <li><Trans i18nKey="sections.power.list.marketplace" t={t} components={inlineComponents} /></li>
            <li><Trans i18nKey="sections.power.list.scheduler" t={t} components={inlineComponents} /></li>
          </ul>
          <p style={note}>{t('sections.power.note')}</p>
        </>
      ),
    },
    {
      id: 'tips',
      title: t('sections.tips.title'),
      body: (
        <ul style={ul}>
          <li><Trans i18nKey="sections.tips.list.palette" t={t} components={inlineComponents} /></li>
          <li><Trans i18nKey="sections.tips.list.send" t={t} components={inlineComponents} /></li>
          <li><Trans i18nKey="sections.tips.list.new" t={t} components={inlineComponents} /></li>
          <li>{t('sections.tips.list.tooltip')}</li>
          <li><Trans i18nKey="sections.tips.list.reconnect" t={t} components={inlineComponents} /></li>
        </ul>
      ),
    },
  ]

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg-base)', color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace' }}>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '28px 24px 80px' }}>
        {heroVisible && (
          <section style={heroCard} data-testid="first-launch-hero">
            <div style={heroTopRow}>
              <span style={heroEyebrow}>{t('hero.eyebrow')}</span>
              <button
                onClick={dismissHero}
                style={heroDismiss}
                title={t('hero.dismiss')}
                aria-label={t('hero.dismiss')}
              >
                {t('hero.dismiss')} ×
              </button>
            </div>
            <h2 style={heroTitle}>{t('hero.title')}</h2>
            <p style={heroIntro}>{t('hero.intro')}</p>
            <ul style={heroList}>
              <li style={heroLi}><span style={heroMark}>▸ </span><Trans i18nKey="hero.lines.chat"   t={t} components={inlineComponents} /></li>
              <li style={heroLi}><span style={heroMark}>▸ </span><Trans i18nKey="hero.lines.code"   t={t} components={inlineComponents} /></li>
              <li style={heroLi}><span style={heroMark}>▸ </span><Trans i18nKey="hero.lines.nodes"  t={t} components={inlineComponents} /></li>
              <li style={heroLi}><span style={heroMark}>▸ </span><Trans i18nKey="hero.lines.design" t={t} components={inlineComponents} /></li>
              <li style={heroLi}><span style={heroMark}>▸ </span><Trans i18nKey="hero.lines.media"  t={t} components={inlineComponents} /></li>
            </ul>
            <div style={heroCtaRow}>
              <button style={heroCtaPrimary}   onClick={() => navigate('/chat')}>{t('hero.cta.chat')}</button>
              <button style={heroCtaSecondary} onClick={() => navigate('/nodes')}>{t('hero.cta.flow')}</button>
              <button style={heroCtaSecondary} onClick={() => go('basics')}>{t('hero.cta.quickstart')}</button>
            </div>
          </section>
        )}
        <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.5px', margin: '0 0 6px' }}>{t('header.title')}</h1>
        <p style={{ ...p, color: 'var(--text-muted)', marginTop: 0 }}>
          {t('header.intro')}
        </p>

        {/* Jump links */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '14px 0 24px' }}>
          {sections.map(s => (
            <button key={s.id} onClick={() => go(s.id)} style={chip}>{s.title}</button>
          ))}
        </div>

        {sections.map(s => (
          <section key={s.id} id={s.id} style={card}>
            <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 10px', letterSpacing: '0.02em' }}>{s.title}</h2>
            {s.body}
          </section>
        ))}

        <div style={{ ...note, marginTop: 24 }}>
          <Trans i18nKey="footer.deepDocs" t={t} components={inlineComponents} />
        </div>
      </div>
    </div>
  )
}

// ── Styles ──────────────────────────────────────────────────────────────────
const card: React.CSSProperties = {
  border: '2px solid var(--border)', background: 'var(--bg-surface)',
  padding: '16px 18px', marginBottom: 14,
}

// First-launch welcome hero — brutalist, accent-bordered, sits above the header.
const heroCard: React.CSSProperties = {
  border: '2px solid var(--accent)', background: 'var(--bg-inset)',
  padding: '18px 20px', marginBottom: 22,
}
const heroTopRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8,
}
const heroEyebrow: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--accent)',
}
const heroDismiss: React.CSSProperties = {
  border: '2px solid var(--border)', background: 'transparent', color: 'var(--text-muted)',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
  textTransform: 'uppercase', cursor: 'pointer', padding: '4px 9px', flexShrink: 0,
}
const heroTitle: React.CSSProperties = {
  fontSize: 22, fontWeight: 800, letterSpacing: '-0.5px', margin: '0 0 6px',
}
const heroIntro: React.CSSProperties = {
  fontSize: 13, lineHeight: 1.6, color: 'var(--text-muted)', margin: '0 0 12px',
}
const heroList: React.CSSProperties = {
  listStyle: 'none', margin: '0 0 16px', padding: 0, fontSize: 12.5, lineHeight: 1.85,
}
const heroLi: React.CSSProperties = { margin: 0 }
const heroMark: React.CSSProperties = { color: 'var(--text-dim)' }
const heroCtaRow: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 10 }
const heroCtaPrimary: React.CSSProperties = {
  padding: '8px 16px', border: '2px solid var(--accent)', background: 'var(--accent)', color: '#ffffff',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em',
  textTransform: 'uppercase', cursor: 'pointer',
}
const heroCtaSecondary: React.CSSProperties = {
  padding: '8px 16px', border: '2px solid var(--accent)', background: 'transparent', color: 'var(--accent)',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em',
  textTransform: 'uppercase', cursor: 'pointer',
}
const p: React.CSSProperties = { fontSize: 13, lineHeight: 1.65, margin: '0 0 10px' }
const subhead: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
  color: 'var(--text-dim)', margin: '16px 0 6px',
}
const note: React.CSSProperties = {
  fontSize: 12, lineHeight: 1.6, color: 'var(--text-muted)',
  borderLeft: '2px solid var(--accent)', paddingLeft: 10, margin: '10px 0 0',
}
const ul: React.CSSProperties = { fontSize: 13, lineHeight: 1.8, margin: '0 0 6px', paddingLeft: 18 }
const ol: React.CSSProperties = { fontSize: 13, lineHeight: 1.8, margin: '0 0 6px', paddingLeft: 18 }
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 12, margin: '6px 0' }
const th: React.CSSProperties = { textAlign: 'left', padding: '4px 8px', borderBottom: '2px solid var(--border)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-dim)' }
const td: React.CSSProperties = { padding: '6px 8px', borderBottom: 'var(--border-width) solid var(--border)', verticalAlign: 'top' }
const tdDim: React.CSSProperties = { ...td, color: 'var(--text-dim)' }
const chip: React.CSSProperties = {
  padding: '3px 9px', border: '2px solid var(--border)', background: 'var(--bg-elevated)',
  color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
  fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer',
}
const linkBtn: React.CSSProperties = {
  marginTop: 4, padding: '6px 14px', border: '2px solid var(--accent)', background: 'transparent',
  color: 'var(--accent)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700,
  letterSpacing: '0.04em', cursor: 'pointer',
}
const code: React.CSSProperties = { background: 'var(--bg-elevated)', border: 'var(--border-width) solid var(--border)', padding: '0 4px' }

// Inline-markup elements reused across <Trans> blocks. Tags are matched by name
// in the translation strings (e.g. "<strong>…</strong>"), so brand terms can stay
// verbatim inside an otherwise-translated sentence. Defined after `code` so its
// style ref is initialized before use.
const inlineComponents = {
  strong: <strong />,
  em: <em />,
  code: <code style={code} />,
}
