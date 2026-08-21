// apps/desktop/src/pages/nodes/canvas/nodeTypes/WebhookNode.tsx
//
// BATCH35 lane B — TradingView WEBHOOK TRIGGER node (adopted community idea).
//
// An INBOUND SIGNAL source. While armed, the local API server answers
// `POST /webhooks/tradingview/<hookId>?token=<secret>` and the alert body lands
// here as this node's output — indistinguishable downstream from a Text node, so
// every existing reference path (`@`, `{{node:<id>}}`, the media prompt plug)
// works with no special-casing.
//
// WHAT IT DOES NOT DO: place orders, size positions, touch a wallet, or reach a
// broker. The app's money-path caps are a hard law; a trigger that could trade
// would be a way around them. An alert becomes TEXT. What happens next is
// whatever agents the user wired downstream, under the same budget rules as any
// other run.
//
// HONESTY ABOUT REACHABILITY: the endpoint is 127.0.0.1 and stays that way.
// TradingView's servers live on the internet and cannot reach a loopback
// address, so the node says out loud that reaching it from TradingView needs a
// tunnel the USER chooses to run. Silently pretending a localhost URL is
// internet-reachable would be the worst possible failure mode for a trading
// alert — the one that looks armed and never fires.
//
// SECRETS: the token is NEVER written into the node's data (flows get exported
// and shared). It lives in the main process and is fetched for display only,
// masked on screen, revealed only through an explicit Copy.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type NodeProps } from '@xyflow/react'
import type { TachiWebhookNode } from '../../types'
import { useNodesStore } from '../../store/nodes.store'
import { EightHandles } from '../EightHandles'
import {
  alertSummary,
  canCopyUrl,
  emitWebhookFired,
  isValidHookId,
  maskToken,
  newHookId,
  webhookNodeState,
  WEBHOOK_SOURCE_LABELS,
  type WebhookNodeState,
} from '../../webhookTrigger'

const COLOR = 'var(--warning)'

/** How often to retry arming while the local API server is not (yet) up. */
const ARM_RETRY_MS = 4000

const nodeStyle: React.CSSProperties = {
  position: 'relative', background: 'var(--bg-surface)', border: `2px solid ${COLOR}`,
  fontFamily: 'JetBrains Mono, monospace', width: 250, boxShadow: `4px 4px 0 ${COLOR}`,
}
const headerStyle: React.CSSProperties = {
  padding: '4px 8px', borderBottom: `2px solid ${COLOR}`, background: COLOR, color: 'var(--bg-base)',
  fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
}
const bodyStyle: React.CSSProperties = { padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }
const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 }
const labelStyle: React.CSSProperties = {
  fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
  color: 'var(--text-dim)',
}
const btnStyle: React.CSSProperties = {
  padding: '3px 7px', border: '2px solid var(--border)', background: 'var(--bg-elevated)',
  color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace',
  fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
}
const urlStyle: React.CSSProperties = {
  padding: '4px 6px', border: '2px solid var(--border)', background: 'var(--bg-inset)',
  color: 'var(--text-dim)', fontSize: 9, lineHeight: 1.35, wordBreak: 'break-all',
  maxHeight: 48, overflow: 'hidden',
}
const hintStyle: React.CSSProperties = { fontSize: 8, lineHeight: 1.4, color: 'var(--text-dim)' }

/** Status pill colour per state — one glance tells you whether it is live. */
const STATE_COLOR: Record<WebhookNodeState, string> = {
  listening:     'var(--success)',
  disarmed:      'var(--text-dim)',
  'server-off':  'var(--danger)',
  'server-down': 'var(--warning)',
  error:         'var(--danger)',
}

interface ServerStatus { enabled: boolean; running: boolean }

export function WebhookNode({ id, data }: NodeProps<TachiWebhookNode>) {
  const { t } = useTranslation('nodes')
  const updateNodeData = useNodesStore(s => s.updateNodeData)
  const deleteNode     = useNodesStore(s => s.deleteNode)
  const [hover, setHover] = useState(false)

  // v1 ships one provider; the field exists so a second one is data, not a fork.
  const source: 'tradingview' = 'tradingview'
  const armed   = data.armed !== false            // new nodes arm themselves
  const autoRun = data.autoRun === true

  const [server, setServer] = useState<ServerStatus>({ enabled: true, running: false })
  const [url, setUrl]       = useState<string | null>(null)
  const [token, setToken]   = useState<string | null>(null)
  const [error, setError]   = useState<string | undefined>(undefined)
  const [copied, setCopied] = useState(false)

  // A flow saved before this node existed (or hand-edited) may carry no hookId;
  // mint one ONCE so the URL is stable for the life of the node.
  const hookId = isValidHookId(data.hookId) ? data.hookId : ''
  useEffect(() => {
    if (!hookId) updateNodeData(id, { hookId: newHookId() })
  }, [hookId, id, updateNodeData])

  // ── arm / disarm ───────────────────────────────────────────────────────────
  // Effect-driven so the route's lifetime is tied to the node being ON SCREEN:
  // closing the canvas (or the flow) takes the path off the air by construction.
  const armedRef = useRef(false)
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const api = window.tachi?.nodes?.webhooks
    if (!api || !hookId) return

    const sync = async () => {
      try {
        const status = await api.status()
        if (cancelled) return
        setServer({ enabled: status.serverEnabled, running: status.serverRunning })
        if (!armed || !status.serverRunning) {
          if (armedRef.current) { await api.disarm(hookId); armedRef.current = false }
          setUrl(null); setToken(null); setError(undefined)
        } else {
          const res = await api.arm(hookId, source)
          if (cancelled) return
          if (res.ok) {
            armedRef.current = true
            setUrl(res.url); setToken(res.token); setError(undefined)
          } else {
            armedRef.current = false
            setUrl(null); setToken(null); setError(res.error)
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
      // Keep trying while we WANT to be listening but are not: the local API
      // server boots a moment after the app and can be toggled in Settings at
      // any time. Without this a node dropped during startup would sit on
      // "SERVER DOWN" until the user poked the toggle.
      if (!cancelled && armed && !armedRef.current) {
        timer = window.setTimeout(() => { void sync() }, ARM_RETRY_MS)
      }
    }
    void sync()
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer) }
  }, [armed, hookId, source])

  // Disarm on unmount — the node leaving the canvas closes its route.
  useEffect(() => () => {
    const api = window.tachi?.nodes?.webhooks
    if (api && armedRef.current && hookId) { void api.disarm(hookId); armedRef.current = false }
  }, [hookId])

  // ── inbound alerts ─────────────────────────────────────────────────────────
  // The counter lives in a ref, not in the effect's deps: depending on data.hits
  // would tear down and re-subscribe on every alert, and an alert arriving in
  // that gap would be dropped.
  const hitsRef = useRef(typeof data.hits === 'number' ? data.hits : 0)
  useEffect(() => {
    const api = window.tachi?.nodes?.webhooks
    if (!api?.onAlert || !hookId) return
    return api.onAlert(alert => {
      if (alert.hookId !== hookId) return
      hitsRef.current += 1
      // The alert body IS the output — mirrored into lastOutput so downstream
      // nodes resolve it through the ordinary reference paths with no run.
      updateNodeData(id, {
        lastOutput: alert.text,
        lastAlertAt: alert.receivedAt,
        hits: hitsRef.current,
        lastError: undefined,
      })
      // Auto-run is opt-in per node; NodesPage decides whether a run may start
      // (mayAutoRun gates on state + "already running" there).
      emitWebhookFired({ nodeId: id, hookId, text: alert.text, receivedAt: alert.receivedAt })
    })
  }, [hookId, id, updateNodeData])

  const state = webhookNodeState({
    serverEnabled: server.enabled,
    serverRunning: server.running,
    armed,
    live: !!url,
    error,
  })

  const copyUrl = useCallback(() => {
    if (!url) return
    navigator.clipboard.writeText(url).then(
      () => { setCopied(true); window.setTimeout(() => setCopied(false), 1600) },
      () => { /* clipboard denied — the URL is still on screen */ },
    )
  }, [url])

  const rotate = useCallback(() => {
    const api = window.tachi?.nodes?.webhooks
    if (!api || !hookId) return
    void api.rotate(hookId, source).then(res => {
      if (res.ok) { setUrl(res.url); setToken(res.token); setError(undefined) }
      else setError(res.error)
    })
  }, [hookId, source])

  const lastAt = typeof data.lastAlertAt === 'number' ? data.lastAlertAt : 0
  const last = lastAt
    ? alertSummary({ receivedAt: lastAt, text: typeof data.lastOutput === 'string' ? data.lastOutput : '' })
    : ''
  const hits = typeof data.hits === 'number' ? data.hits : 0

  return (
    <div
      style={nodeStyle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={hover ? 'tachi-node-hover' : undefined}
    >
      <div style={headerStyle}>
        <span>{t('webhookNode.header', { source: WEBHOOK_SOURCE_LABELS[source] ?? source })}</span>
        {hover && (
          <button
            onClick={(e) => { e.stopPropagation(); deleteNode(id) }}
            className="nodrag" title={t('node.delete')} aria-label={t('node.delete')}
            style={{ width: 16, height: 16, padding: 0, border: 'var(--border-width) solid var(--bg-base)', background: 'transparent', color: 'var(--bg-base)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 800, lineHeight: 1, cursor: 'pointer' }}
          >×</button>
        )}
      </div>

      <div style={bodyStyle}>
        {/* Status + arm toggle */}
        <div style={{ ...rowStyle, justifyContent: 'space-between' }}>
          <span style={{ ...labelStyle, color: STATE_COLOR[state] }}>
            {t(`webhookNode.state.${state}`)}
          </span>
          <button
            className="nodrag"
            onClick={() => updateNodeData(id, { armed: !armed })}
            aria-pressed={armed}
            aria-label={armed ? t('webhookNode.disarmAria') : t('webhookNode.armAria')}
            style={{ ...btnStyle, borderColor: armed ? 'var(--success)' : 'var(--border)' }}
          >
            {armed ? t('webhookNode.disarm') : t('webhookNode.arm')}
          </button>
        </div>

        {/* The copyable endpoint. Only rendered when there IS one. */}
        {canCopyUrl(state, url) ? (
          <>
            <div style={urlStyle}>{url}</div>
            <div style={rowStyle}>
              <button
                className="nodrag" onClick={copyUrl}
                aria-label={t('webhookNode.copyUrlAria')}
                style={btnStyle}
              >
                {copied ? t('webhookNode.copied') : t('webhookNode.copyUrl')}
              </button>
              <button
                className="nodrag" onClick={rotate}
                aria-label={t('webhookNode.rotateAria')}
                style={btnStyle}
              >
                {t('webhookNode.rotate')}
              </button>
              <span style={{ ...hintStyle, marginLeft: 'auto' }}>{maskToken(token)}</span>
            </div>
          </>
        ) : (
          // No copyable endpoint → say WHY, and show main's own words when it
          // refused the arm (a generic "error" tells the user nothing).
          <div style={hintStyle}>
            {state === 'error' && error ? error : t(`webhookNode.help.${state}`)}
          </div>
        )}

        {/* Auto-run opt-in. OFF by default: an external party controls WHEN this
            fires, so spending tokens on it has to be a deliberate choice. */}
        <label style={{ ...rowStyle, ...hintStyle, cursor: 'pointer' }}>
          <input
            type="checkbox" className="nodrag" checked={autoRun}
            onChange={(e) => updateNodeData(id, { autoRun: e.target.checked })}
          />
          {t('webhookNode.autoRun')}
        </label>

        {/* Last alert + counter */}
        <div style={hintStyle}>
          {last
            ? t('webhookNode.lastAlert', { summary: last, count: hits })
            : t('webhookNode.noAlerts')}
        </div>

        {/* Loopback honesty — TradingView's servers cannot reach 127.0.0.1. */}
        <div style={hintStyle}>{t('webhookNode.loopbackHint')}</div>
        {/* Not a trading integration. Said once, on the node itself. */}
        <div style={{ ...hintStyle, color: 'var(--text-dim)' }}>{t('webhookNode.signalOnly')}</div>
      </div>

      {/* Source-only: a trigger feeds downstream nodes, it never receives. */}
      <EightHandles role="source" color={COLOR} />
    </div>
  )
}
