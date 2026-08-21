// apps/desktop/src/components/console/ObservabilityTab.tsx
//
// Per-run observability: token + cost + tool-call rollup for the active chat
// conversation and the local run-trace spans, plus the SMART ROUTER savings
// breakdown (one read-only IPC — router:stats; no network, no egress).
// twenty PanelChrome-inspired, brutalist monospace (2px borders, hard rows).
//
// Honesty note: cost is estimated only for models in the shared @tachi/core
// price table (the single source of truth); any
// other model (Surplus / Venice / Ollama / local) shows "--" rather than a
// fabricated number. Sidecar agent (OpenClaude) sessions don't emit token usage,
// so the RUN TRACE section shows token N/A there and falls back to span/tool
// counts as a proxy.

import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore, conversationUsageSummary } from '../../store/chat.store'
import { useRunTraceStore, selectRunTokenStats, selectToolSuccessRates } from '../../store/run-trace.store'
import { Sparkline } from '../Sparkline'
import { runStats } from '../../utils/runStats'
import { isLegacyHarnessRow, spendRowLabel } from './spendRows'
// Subpath import (NOT the '@tachi/core' barrel) — the barrel pulls Node-only
// modules that break the renderer bundle; pricing.ts is pure. See index.ts note.
import { costUsd as costUsdForModel } from '@tachi/core/src/pricing'

// Relative cost weights per tier vs always-routing-to-TOP. Order-of-magnitude
// price ratios across the catalogs we route (opus-class : sonnet-class :
// haiku-class is roughly 1 : 0.2 : 0.04 per token) — an ESTIMATE, labeled so.
const TIER_COST_WEIGHT = { SIMPLE: 0.04, MID: 0.2, TOP: 1 } as const

type RouterStats = {
  routes: { SIMPLE: number; MID: number; TOP: number }
  arms: Array<{ bucket: string; model: string; ok: number; err: number; mean: number }>
  // Compactor savings (headroom-inspired) — delivered over this same router:stats
  // channel; optional so an older main process without the field never crashes.
  compaction?: { charsSaved: number; tokensSaved: number; reductions: number }
  // Provider prompt-cache hits (CACHE-ALIGN 2026-07-21) — cached input tokens the
  // gateway served instead of re-charging. `reported:false` → render "--" (the
  // gateway told us nothing), never a fabricated 0. Optional for old-main safety.
  cache?: { cachedInputTokens: number; totalInputTokens: number; hitRatio: number | null; samples: number; reported: boolean }
}

/** Estimated % saved vs sending every routed message to the TOP tier. */
function estSavingsPct(r: RouterStats['routes']): number | null {
  const total = r.SIMPLE + r.MID + r.TOP
  if (total === 0) return null
  const spent = r.SIMPLE * TIER_COST_WEIGHT.SIMPLE + r.MID * TIER_COST_WEIGHT.MID + r.TOP * TIER_COST_WEIGHT.TOP
  return (1 - spent / total) * 100
}

// $/M-token cost estimate via the shared price table in @tachi/core (the single
// source of truth, also used by the main-process cost ledger). Unknown → null.
function estimateCost(model: string | undefined, pt: number, ct: number): number | null {
  if (!model) return null
  return costUsdForModel(model, pt, ct)
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

const LABEL_STYLE: React.CSSProperties = { color: 'var(--text-dim)' }
const VALUE_STYLE: React.CSSProperties = { color: 'var(--text-primary)', fontWeight: 700 }

// `title` is optional and supplementary ONLY: a row whose label needs a
// sentence of provenance gets it on hover, but the label alone still has to say
// what the row is. A native tooltip is not reachable by keyboard, so nothing
// load-bearing may live there.
function Row({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div title={title} style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      padding: '4px 12px', borderBottom: 'var(--border-width) solid var(--border)',
      fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
    }}>
      <span style={LABEL_STYLE}>{label}</span>
      <span style={VALUE_STYLE}>{value}</span>
    </div>
  )
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div style={{
      padding: '6px 12px', fontSize: 9, color: 'var(--text-dim)',
      textTransform: 'uppercase', letterSpacing: '0.12em',
      background: 'var(--bg-inset)', borderBottom: '2px solid var(--border)',
      fontFamily: 'JetBrains Mono, monospace',
    }}>{title}</div>
  )
}

/**
 * 30-DAY SPEND — persistent cost-ledger rollup (STEAL 2026-06-12 cluster A).
 * Unlike the per-session estimates below, this survives restarts: every usage
 * chunk is recorded to userData/cost-ledger.jsonl and capped by the
 * llmBudgetUsd30d setting.
 */
function SpendSection() {
  const { t } = useTranslation('common')
  const [data, setData] = useState<{
    totalUsd: number; budgetUsd: number
    byProvider: Record<string, { usd: number; events: number; unpricedEvents: number }>
    byTaskType?: Record<string, { usd: number; events: number }>
  } | null>(null)

  useEffect(() => {
    let alive = true
    window.tachi.cost?.summary().then(s => { if (alive) setData(s) }).catch(() => {})
    return () => { alive = false }
  }, [])

  if (!data) return null
  const providers = Object.entries(data.byProvider).sort((a, b) => b[1].usd - a[1].usd).slice(0, 5)
  // "by task type" (STEAL 2026-07-09, codeburn) — what am I spending tokens ON.
  const tasks = Object.entries(data.byTaskType ?? {}).sort((a, b) => b[1].events - a[1].events).slice(0, 6)
  return (
    <>
      <SectionHeader title="30-DAY SPEND" />
      <Row label="total (priced)" value={`$${data.totalUsd.toFixed(2)}`} />
      <Row label="budget cap" value={data.budgetUsd > 0 ? `$${data.budgetUsd.toFixed(2)}` : '-- (no cap set)'} />
      {/* A 'tachi' row is the harness naming ITSELF instead of the gateway that
          served the request — the defect `64c837d` closed for the loop itself on
          2026-08-01, with the remaining self-label call sites following in
          `6256c92`. The
          events are real history and are neither deleted nor re-attributed (a
          ledger is not edited after the fact), so the row keeps its id, its
          money and its place in the total, and gains only a tag saying what it
          is. Without it the dashboard reads as if 'tachi' were a provider you
          could still be billed by, which it never was. */}
      {providers.map(([id, p]) => (
        <Row
          key={id}
          label={spendRowLabel(id, t('observability.legacyHarnessTag', { defaultValue: 'legacy harness' }))}
          title={isLegacyHarnessRow(id)
            ? t('observability.legacyHarnessNote', { defaultValue: 'Harness spend recorded before it was attributed to the gateway that served it. Kept as history — a ledger is not edited after the fact.' })
            : undefined}
          value={`$${p.usd.toFixed(2)} | ${p.events} calls${p.unpricedEvents > 0 ? ` (${p.unpricedEvents} unpriced)` : ''}`}
        />
      ))}
      {tasks.length > 0 && (
        <>
          <SectionHeader title="BY TASK TYPE" />
          {tasks.map(([tt, p]) => (
            <Row key={tt} label={tt} value={`${p.events} calls${p.usd > 0 ? ` | $${p.usd.toFixed(2)}` : ''}`} />
          ))}
        </>
      )}
    </>
  )
}

// ── RECENT RUNS (per-task run log, STEAL 2026-06-21 #2) ───────────────────────
function fmtAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
function fmtDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`
}

function RecentRunsSection() {
  const [runs, setRuns] = useState<Array<{
    ts: number; task: string; harness: string; outcome: 'done' | 'error' | 'abort'; durationMs: number
  }> | null>(null)

  useEffect(() => {
    let alive = true
    window.tachi.cost?.recentRuns?.(10).then(r => { if (alive) setRuns(r) }).catch(() => {})
    return () => { alive = false }
  }, [])

  if (!runs || runs.length === 0) return null
  const glyph = (o: string) => (o === 'done' ? '✓' : o === 'error' ? '✕' : '⊘')
  const color = (o: string) => (o === 'done' ? 'var(--success)' : o === 'error' ? 'var(--destructive)' : 'var(--text-dim)')
  const now = Date.now()
  const s7 = runStats(runs, now, 7)
  const s30 = runStats(runs, now, 30)
  return (
    <>
      <SectionHeader title="RECENT RUNS" />
      <Row label="last 7d" value={s7.runs > 0 ? `${s7.runs} runs · ${s7.okPct}% ok · ~${fmtDur(s7.avgDurationMs)} avg` : '—'} />
      <Row label="last 30d" value={s30.runs > 0 ? `${s30.runs} runs · ${s30.okPct}% ok` : '—'} />
      {runs.map((r, i) => (
        <div key={i} style={{
          display: 'flex', alignItems: 'baseline', gap: 6,
          padding: '4px 12px', borderBottom: 'var(--border-width) solid var(--border)',
          fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
        }}>
          <span style={{ color: color(r.outcome) }}>{glyph(r.outcome)}</span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)' }} title={r.task}>
            {r.task || '(no task)'}
          </span>
          <span style={{ color: 'var(--text-dim)' }}>{r.harness}</span>
          <span style={{ color: 'var(--text-dim)' }}>{fmtDur(r.durationMs)}</span>
          <span style={{ color: 'var(--text-dim)' }}>{fmtAgo(r.ts)}</span>
        </div>
      ))}
    </>
  )
}

export function ObservabilityTab() {
  const { t } = useTranslation('common')
  const conversations = useChatStore(s => s.conversations)
  const activeId      = useChatStore(s => s.activeConversationId)
  const spans         = useRunTraceStore(s => s.spans)
  const clearSpans    = useRunTraceStore(s => s.clear)
  const [router, setRouter] = useState<RouterStats | null>(null)

  // Refresh router telemetry on mount and every 10s while the tab is open.
  useEffect(() => {
    let alive = true
    const pull = () => {
      window.tachi.routerStats?.get()
        .then(s => { if (alive) setRouter(s) })
        .catch(() => { /* main not ready / no stats yet */ })
    }
    pull()
    const t = setInterval(pull, 10_000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const conv  = useMemo(() => conversations.find(c => c.id === activeId) ?? null, [conversations, activeId])
  const chat  = useMemo(() => conversationUsageSummary(conv), [conv])
  const trace = useMemo(() => selectRunTokenStats(spans), [spans])
  const cost  = useMemo(() => estimateCost(conv?.model, chat.promptTokens, chat.completionTokens), [conv, chat])
  const toolRates = useMemo(() => selectToolSuccessRates(spans), [spans])

  // Per-LLM-span completion-token samples for the throughput sparkline.
  const tokenSamples = useMemo(
    () => spans
      .filter(sp => sp.kind === 'llm' && typeof sp.attrs.completionTokens === 'number')
      .map(sp => sp.attrs.completionTokens as number),
    [spans],
  )

  return (
    <div style={{ height: '100%', overflowY: 'auto', fontFamily: 'JetBrains Mono, monospace' }}>
      {/* Header row */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 12px', borderBottom: '2px solid var(--border)',
        fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.12em',
      }}>
        <span style={{ color: 'var(--accent)' }}>OBSERVABILITY</span>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => clearSpans()}
          title="Clear run-trace spans"
          style={{
            padding: '2px 8px', border: '2px solid var(--border)', background: 'var(--bg-inset)',
            color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
            letterSpacing: '0.08em', textTransform: 'uppercase', cursor: 'pointer',
          }}
        >clear trace</button>
      </div>

      {/* 30-DAY SPEND (persistent cost ledger) */}
      <SpendSection />

      {/* RECENT RUNS (per-task run log) */}
      <RecentRunsSection />

      {/* CHAT SESSION */}
      <SectionHeader title={conv ? `Chat session — ${conv.title || '(untitled)'}` : 'Chat session — none active'} />
      <Row label="Model" value={conv?.model || '--'} />
      <Row label="Messages" value={String(chat.messageCount)} />
      <Row label="Prompt tokens" value={fmtTokens(chat.promptTokens)} />
      <Row label="Completion tokens" value={fmtTokens(chat.completionTokens)} />
      <Row label="Total tokens" value={fmtTokens(chat.totalTokens)} />
      <Row label="Est. cost (USD)" value={cost === null ? '--' : `$${cost.toFixed(cost < 0.01 ? 5 : 4)}`} />

      {/* RUN TRACE */}
      <SectionHeader title="Run trace (current session)" />
      {tokenSamples.length >= 2 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '5px 12px', borderBottom: 'var(--border-width) solid var(--border)',
          fontSize: 10, color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace',
        }}>
          <span>token throughput</span>
          <Sparkline values={tokenSamples} width={80} height={16} color="var(--accent)" />
        </div>
      )}
      <Row label="Spans" value={String(trace.spanCount)} />
      <Row label="Tool calls" value={String(trace.toolCalls)} />
      <Row label="Prompt tokens" value={trace.promptTokens > 0 ? fmtTokens(trace.promptTokens) : 'N/A'} />
      <Row label="Completion tokens" value={trace.completionTokens > 0 ? fmtTokens(trace.completionTokens) : 'N/A'} />
      <Row label="Total tokens" value={trace.totalTokens > 0 ? fmtTokens(trace.totalTokens) : 'N/A'} />

      {/* TOOL SUCCESS — per-tool ok-rate over the current session's tool spans.
          (idea: ColeMurray/claude-code-otel — tool_result success / total.) */}
      {toolRates.length > 0 && (
        <>
          <SectionHeader title="Tool success" />
          {toolRates.map(t => {
            const pct = Math.round(t.okRate * 100)
            // Green when mostly succeeding, amber under 50%, no fabricated color
            // for a single-sample tool — keep it simple and honest.
            const color = pct >= 80 ? 'var(--success, #22c55e)'
              : pct >= 50 ? 'var(--warning, #d4a200)'
              : 'var(--danger, #d43f00)'
            return (
              <div key={t.tool} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                padding: '4px 12px', borderBottom: 'var(--border-width) solid var(--border)',
                fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
              }}>
                <span style={{ color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: 8 }}>{t.tool}</span>
                <span style={{ color, fontWeight: 700, flexShrink: 0 }}>{pct}% ok · {t.total}</span>
              </div>
            )
          })}
        </>
      )}

      {/* SMART ROUTER — savings + learned arms */}
      <SectionHeader title="Smart router (all time)" />
      {(() => {
        const r = router?.routes
        const total = r ? r.SIMPLE + r.MID + r.TOP : 0
        const pct = r ? estSavingsPct(r) : null
        return (
          <>
            <Row label="Routed requests" value={String(total)} />
            <Row label="SIMPLE tier" value={r && total > 0 ? `${r.SIMPLE} (${Math.round((r.SIMPLE / total) * 100)}%)` : '0'} />
            <Row label="MID tier" value={r && total > 0 ? `${r.MID} (${Math.round((r.MID / total) * 100)}%)` : '0'} />
            <Row label="TOP tier" value={r && total > 0 ? `${r.TOP} (${Math.round((r.TOP / total) * 100)}%)` : '0'} />
            <Row label="Est. saved vs always-TOP" value={pct === null ? '--' : `~${pct.toFixed(0)}%`} />
          </>
        )
      })()}
      {router && router.arms.length > 0 && (
        <>
          <div style={{
            padding: '5px 12px', fontSize: 9, color: 'var(--text-dim)',
            borderBottom: 'var(--border-width) solid var(--border)',
            fontFamily: 'JetBrains Mono, monospace',
          }}>
            bandit — learned (bucket · model · ok/err)
          </div>
          {router.arms.map(a => (
            <div key={`${a.bucket}|${a.model}`} style={{
              display: 'flex', gap: 8, alignItems: 'baseline',
              padding: '3px 12px', borderBottom: 'var(--border-width) solid var(--border)',
              fontSize: 10, fontFamily: 'JetBrains Mono, monospace',
            }}>
              <span style={{ color: 'var(--text-dim)', minWidth: 110 }}>{a.bucket}</span>
              <span style={{ color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.model}</span>
              <span style={{ color: a.err > a.ok ? 'var(--danger, #d43f00)' : 'var(--success, #22c55e)' }}>{a.ok}/{a.err}</span>
            </div>
          ))}
        </>
      )}

      {/* COMPACTION — tokens the deterministic tool-output crusher saved this
          process (headroom-inspired). Rides the router:stats channel above. */}
      <SectionHeader title={t('observability.compaction', { defaultValue: 'Compaction' })} />
      <Row
        label={t('observability.tokensSaved', { defaultValue: 'tokens saved (est)' })}
        value={router?.compaction ? `~${fmtTokens(router.compaction.tokensSaved)}` : '--'}
      />
      <Row
        label={t('observability.charsSaved', { defaultValue: 'chars saved' })}
        value={router?.compaction ? `${fmtTokens(router.compaction.charsSaved)} · ${router.compaction.reductions}×` : '--'}
      />

      {/* PROMPT CACHE — provider cache HITS (input tokens served from the gateway's
          prompt-cache). "--" when the gateway reported nothing (honest: never
          0-as-fact). CACHE-ALIGN-AUDIT-2026-07-21 recommendation #2. */}
      <SectionHeader title={t('observability.promptCache', { defaultValue: 'Prompt cache' })} />
      <Row
        label={t('observability.cachedInputTokens', { defaultValue: 'cached input tokens' })}
        value={router?.cache?.reported ? fmtTokens(router.cache.cachedInputTokens) : '--'}
      />
      <Row
        label={t('observability.cacheHitRatio', { defaultValue: 'hit ratio (cached / input)' })}
        value={router?.cache?.reported && router.cache.hitRatio !== null ? `${(router.cache.hitRatio * 100).toFixed(0)}%` : '--'}
      />

      <div style={{ padding: '10px 12px', fontSize: 9, color: 'var(--text-dim)', lineHeight: 1.5 }}>
        Cost is estimated only for known model pricing; other models show "--".
        Sidecar agent (OpenClaude) and node runs do not emit token usage yet, so trace tokens show N/A.
        Router savings are a rough estimate from tier price ratios (TOP 1.0 / MID 0.2 / SIMPLE 0.04) vs sending everything to the TOP tier.
        Prompt-cache figures come straight from the gateway; a gateway that reports no cache field shows "--" (never a fabricated 0).
      </div>
    </div>
  )
}
