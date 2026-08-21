// apps/desktop/src/pages/freellmapi/FreellmapiDashboardView.tsx
//
// Embeds the freellmapi local dashboard (http://127.0.0.1:<port>/) inside the
// app via iframe — same pattern as OpenClawDashboardView. The freellmapi sidecar
// manages fallback chains, per-provider enable/disable, sort presets, and a
// round-robin key pool that is otherwise only accessible from a browser tab.
//
// Port resolution: ask the sidecar manager via window.tachi.sidecar.list() for
// the slot with id === 'freellmapi'. Default to 31415 when the sidecar isn't
// running so the iframe URL is still sensible for an already-running process.
//
// Probe strategy: renderer-side fetch(url, { mode: 'no-cors' }) is unreliable
// in Electron — opaque requests to localhost throw TypeError on Windows even
// when the server IS running (Electron treats opaque responses as network
// failures). Instead we use window.tachi.sidecar.health('freellmapi') which
// runs a real HTTP GET in the main process (no CORS restrictions) and returns
// a boolean. This is the same probe the sidecar-manager already uses internally
// (hits /api/ping). If the IPC call returns true → ready; false → unreachable.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

const DEFAULT_PORT = 31415

type Probe =
  | { state: 'probing' }
  | { state: 'ready' }
  | { state: 'unreachable'; error: string }

export function FreellmapiDashboardView() {
  const { t }                     = useTranslation('freellmapi')
  const [port, setPort]           = useState<number>(DEFAULT_PORT)
  const [probe, setProbe]         = useState<Probe>({ state: 'probing' })
  const [iframeKey, setIframeKey] = useState(0)
  const iframeRef                 = useRef<HTMLIFrameElement>(null)

  // ── Port resolution ──────────────────────────────────────────────────────
  // Read the actual port freellmapi bound to from the main-process slot.
  // Must complete before probing so the iframe points at the right address.
  useEffect(() => {
    window.tachi.sidecar.list()
      .then((sidecars: Array<{ id: string; port?: number; state?: string }>) => {
        const slot = sidecars.find(s => s.id === 'freellmapi')
        if (slot?.port) setPort(slot.port)
      })
      .catch(() => { /* keep default */ })
  }, [])

  // ── Probe ─────────────────────────────────────────────────────────────────
  // Use the main-process IPC health check instead of a renderer-side fetch.
  // Main-process fetch has no CORS restrictions so it reliably distinguishes
  // "port bound and responding" from "ECONNREFUSED / process not started".
  // sidecar:health hits /api/ping and returns true only when res.ok.
  const probeNow = useCallback(() => {
    setProbe({ state: 'probing' })
    ;(window.tachi.sidecar.health('freellmapi') as Promise<boolean>)
      .then(alive => {
        if (alive) {
          setProbe({ state: 'ready' })
        } else {
          setProbe({
            state: 'unreachable',
            error: t('errors.healthFalse'),
          })
        }
      })
      .catch(err => setProbe({
        state: 'unreachable',
        error: err instanceof Error ? err.message : String(err),
      }))
  }, [t])

  useEffect(() => {
    probeNow()
  }, [port, probeNow])

  const dashboardUrl = `http://127.0.0.1:${port}/`

  // ── Layout ───────────────────────────────────────────────────────────────
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', width: '100%',
      background: 'var(--bg-base)',
      fontFamily: 'JetBrains Mono, monospace',
    }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 14px',
        borderBottom: '2px solid var(--border)',
        background: 'var(--bg-surface)',
        flexShrink: 0,
      }}>
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
          textTransform: 'uppercase', color: 'var(--text-dim)',
        }}>
          {t('toolbar.title')}
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
          {dashboardUrl}
        </span>
        <span style={{ flex: 1 }} />
        <StatusBadge state={probe.state} />
        <ToolButton
          onClick={() => { setIframeKey(k => k + 1); probeNow() }}
          label={t('actions.reload')}
        />
        <ToolButton
          onClick={() => window.tachi.shell.openExternal(dashboardUrl).catch(() => {})}
          label={t('actions.openInBrowser')}
        />
      </div>

      {/* API snippets — copy-paste examples for the local OpenAI-compatible
          server (independent of the freellmapi iframe below, so it renders in
          every probe state; llama.cpp-only users get working snippets too). */}
      <ApiSnippetsCard />

      {/* Body */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {probe.state === 'ready' && (
          <iframe
            key={iframeKey}
            ref={iframeRef}
            src={dashboardUrl}
            style={{
              width: '100%', height: '100%',
              border: 'none',
              background: '#ffffff',
            }}
            title={t('iframe.title')}
          />
        )}
        {probe.state === 'probing' && (
          <CenterCard>
            <span style={{ fontWeight: 700 }}>{t('probing.label', { url: dashboardUrl })}</span>
          </CenterCard>
        )}
        {probe.state === 'unreachable' && (
          <CenterCard>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>
              {t('unreachable.title')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, maxWidth: 520 }}>
              {t('unreachable.body')}
              <pre style={{
                marginTop: 8, marginBottom: 8,
                padding: '6px 10px',
                border: '2px solid var(--border)',
                background: 'var(--bg-elevated)',
                color: 'var(--text-primary)',
                fontSize: 11,
              }}>
                {t('unreachable.portLine', { port })}
              </pre>
              <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                {probe.error}
              </span>
            </div>
            <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
              <ToolButton onClick={probeNow} label={t('actions.reload')} />
            </div>
          </CenterCard>
        )}
      </div>
    </div>
  )
}

// ── API snippets card ────────────────────────────────────────────────────────
//
// "USE IT FROM YOUR CODE" — collapsible card with copy-paste examples for the
// app's local OpenAI-compatible server (electron/services/openai-api-server.ts,
// default http://127.0.0.1:11435/v1). Three tabs: curl / Python (openai sdk) /
// JavaScript (openai sdk). The real baseUrl comes from
// window.tachi.apiServer.status(); until that resolves we show the default.
//
// Key handling: the endpoint is Bearer-gated, but we never render the real key
// in the DOM (screenshot safety — same reveal-on-demand posture as the
// Dashboard's ApiServerRow). Snippets display YOUR_API_KEY; the COPY button
// fetches the token via apiServer.revealToken() and substitutes it into the
// copied text, so what lands on the clipboard actually works. Model id "auto"
// is the canonical routing id the server itself advertises (freellm chain, or
// llama.cpp when it's the only engine up).

const API_FALLBACK_BASE_URL = 'http://127.0.0.1:11435/v1'
const KEY_PLACEHOLDER = 'YOUR_API_KEY'

type SnippetLang = 'curl' | 'python' | 'javascript'
type ApiStatus = { running: boolean; enabled: boolean; baseUrl: string | null; port: number | null }

function buildSnippet(lang: SnippetLang, baseUrl: string): string {
  switch (lang) {
    case 'curl':
      return [
        `curl ${baseUrl}/chat/completions \\`,
        `  -H "Authorization: Bearer ${KEY_PLACEHOLDER}" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{"model": "auto", "messages": [{"role": "user", "content": "Hello!"}]}'`,
      ].join('\n')
    case 'python':
      return [
        'from openai import OpenAI',
        '',
        `client = OpenAI(base_url="${baseUrl}", api_key="${KEY_PLACEHOLDER}")`,
        'r = client.chat.completions.create(',
        '    model="auto",',
        '    messages=[{"role": "user", "content": "Hello!"}],',
        ')',
        'print(r.choices[0].message.content)',
      ].join('\n')
    case 'javascript':
      return [
        'import OpenAI from "openai";',
        '',
        `const client = new OpenAI({ baseURL: "${baseUrl}", apiKey: "${KEY_PLACEHOLDER}" });`,
        'const r = await client.chat.completions.create({',
        '  model: "auto",',
        '  messages: [{ role: "user", content: "Hello!" }],',
        '});',
        'console.log(r.choices[0].message.content);',
      ].join('\n')
  }
}

function ApiSnippetsCard() {
  const { t }               = useTranslation('freellmapi')
  const [open, setOpen]     = useState(false)
  const [status, setStatus] = useState<ApiStatus>({ running: false, enabled: true, baseUrl: null, port: null })
  const [tab, setTab]       = useState<SnippetLang>('curl')
  const [copied, setCopied] = useState<null | 'key' | 'placeholder'>(null)
  const copyTimer           = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Same poll-a-couple-of-times pattern as the Dashboard's ApiServerRow —
  // main may still be binding the port right after app start.
  useEffect(() => {
    let alive = true
    const refresh = () => {
      window.tachi.apiServer.status()
        .then(s => { if (alive) setStatus(s) })
        .catch(() => { /* main not ready — keep fallback */ })
    }
    refresh()
    const tA = setTimeout(refresh, 800)
    const tB = setTimeout(refresh, 2500)
    return () => { alive = false; clearTimeout(tA); clearTimeout(tB) }
  }, [])

  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current) }, [])

  const baseUrl = status.baseUrl ?? API_FALLBACK_BASE_URL
  const snippet = buildSnippet(tab, baseUrl)

  const onCopy = async () => {
    let text = snippet
    let mode: 'key' | 'placeholder' = 'placeholder'
    try {
      const token = await window.tachi.apiServer.revealToken()
      if (token) { text = snippet.split(KEY_PLACEHOLDER).join(token); mode = 'key' }
    } catch { /* server not reachable — copy with placeholder */ }
    try {
      await navigator.clipboard.writeText(text)
      setCopied(mode)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(null), 1800)
    } catch { /* clipboard unavailable — leave the button label unchanged */ }
  }

  const badge = !status.enabled
    ? { label: t('api.status.disabled'), color: 'var(--text-muted)' }
    : status.running
      ? { label: t('api.status.running'), color: 'var(--success, #22c55e)' }
      : { label: t('api.status.stopped'), color: 'var(--danger, #ff5252)' }

  // Static map (not a template key) so typed-i18n resource checking stays happy.
  const tabLabel: Record<SnippetLang, string> = {
    curl:       t('api.tabs.curl'),
    python:     t('api.tabs.python'),
    javascript: t('api.tabs.javascript'),
  }
  const langs: SnippetLang[] = ['curl', 'python', 'javascript']

  return (
    <div style={{
      borderBottom: '2px solid var(--border)',
      background: 'var(--bg-surface)',
      flexShrink: 0,
      fontFamily: 'JetBrains Mono, monospace',
    }}>
      {/* Header row — whole row toggles expand/collapse */}
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 10,
          padding: '6px 14px',
          border: 'none', background: 'transparent',
          color: 'var(--text-primary)', fontFamily: 'inherit',
          cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{open ? '▾' : '▸'}</span>
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
          textTransform: 'uppercase', color: 'var(--text-primary)',
        }}>
          {t('api.title')}
        </span>
        <span style={{
          fontSize: 10, color: 'var(--text-muted)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {baseUrl}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{
          padding: '1px 7px',
          border: `2px solid ${badge.color}`, color: badge.color,
          fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
          textTransform: 'uppercase', whiteSpace: 'nowrap',
        }}>
          {badge.label}
        </span>
      </button>

      {open && (
        <div style={{ padding: '0 14px 10px' }}>
          {/* Tabs + copy */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            {langs.map(l => (
              <button
                key={l}
                onClick={() => { setTab(l); setCopied(null) }}
                style={{
                  padding: '3px 10px',
                  border: `2px solid ${tab === l ? 'var(--accent, #22c55e)' : 'var(--border)'}`,
                  background: 'transparent',
                  color: tab === l ? 'var(--accent, #22c55e)' : 'var(--text-muted)',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  cursor: 'pointer',
                }}
              >
                {tabLabel[l]}
              </button>
            ))}
            <span style={{ flex: 1 }} />
            <button
              onClick={onCopy}
              style={{
                padding: '3px 10px',
                border: `2px solid ${copied ? 'var(--success, #22c55e)' : 'var(--border)'}`,
                background: 'transparent',
                color: copied ? 'var(--success, #22c55e)' : 'var(--text-primary)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
                textTransform: 'uppercase',
                cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              {copied === null
                ? t('api.copy')
                : copied === 'key' ? t('api.copied') : t('api.copiedNoKey')}
            </button>
          </div>

          {/* Snippet */}
          <pre style={{
            margin: 0,
            padding: '10px 12px',
            border: '2px solid var(--border)',
            background: 'var(--bg-elevated)',
            color: 'var(--text-primary)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 11, lineHeight: 1.55,
            overflowX: 'auto', overflowY: 'auto',
            maxHeight: 190,
            whiteSpace: 'pre',
          }}>
            {snippet}
          </pre>

          <div style={{ marginTop: 6, fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            {t('api.keyNote', { placeholder: KEY_PLACEHOLDER })}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Small bits ───────────────────────────────────────────────────────────────

function StatusBadge({ state }: { state: Probe['state'] }) {
  const { t } = useTranslation('freellmapi')
  const map: Record<Probe['state'], { label: string; color: string }> = {
    probing:     { label: t('status.probing'),     color: 'var(--warning)' },
    ready:       { label: t('status.ready'),       color: 'var(--success)' },
    unreachable: { label: t('status.unreachable'), color: 'var(--danger, #ff5252)' },
  }
  const m = map[state]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '2px 8px',
      border: `2px solid ${m.color}`,
      color: m.color,
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
    }}>
      <span style={{ width: 5, height: 5, background: m.color, display: 'inline-block' }} />
      {m.label}
    </span>
  )
}

function ToolButton({ onClick, label }: { onClick: () => void; label: string }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: '4px 10px',
        border: '2px solid var(--border)',
        background: hover ? 'var(--bg-elevated)' : 'transparent',
        color: 'var(--text-primary)',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
        textTransform: 'uppercase',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  )
}

function CenterCard({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <div style={{
        padding: 24,
        border: '2px solid var(--border)',
        background: 'var(--bg-surface)',
        color: 'var(--text-primary)',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 13,
        boxShadow: 'var(--shadow-hard)',
      }}>
        {children}
      </div>
    </div>
  )
}
