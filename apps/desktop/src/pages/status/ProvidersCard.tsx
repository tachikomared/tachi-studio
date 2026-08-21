import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  FREELLMAPI_PROVIDERS, providerKind, quotaLabel,
  relayRowState, isRelayConnected, RELAY_DENOMINATOR,
  type FreellmapiProvider, type RelayRowState,
} from './freellmapi-providers'
import { usePrivacyStore } from '../../store/privacy.store'
import { LlamaCppRow } from './LlamaCppRow'
import { ProviderIcon } from '../../components/ProviderIcon'

/** One row of the relay's own platform list (see freellmapi.ipc.ts). */
interface RelayPlatformRow {
  platform:    string
  modelCount:  number
  keyCount:    number
  healthyKeys: number
  invalidKeys: number
  hasProvider: boolean
}

export function ProvidersCard() {
  const navigate = useNavigate()
  const { t } = useTranslation('freellmapi')
  const privacyMode                     = usePrivacyStore(s => s.mode)
  const [connectedIds, setConnectedIds] = useState<Set<string>>(new Set())
  const [addingId, setAddingId]         = useState<string | null>(null)
  const [keyInput, setKeyInput]         = useState('')
  const [saving, setSaving]             = useState(false)

  /**
   * A provider is locked when PRIVATE MODE is on AND the provider is 'cloud'.
   * Local-runtime providers (none currently in this list — see freellmapi-providers.ts)
   * remain interactive.
   */
  const isLocked = (p: FreellmapiProvider): boolean =>
    privacyMode === 'private' && providerKind(p) === 'cloud'

  /** Toast the user when they tap a control on a locked card. */
  const notifyLocked = (): void => {
    window.dispatchEvent(new CustomEvent('tachi:toast', {
      detail: {
        kind: 'warning',
        ttl: 6000,
        text: 'Cannot configure cloud provider in PRIVATE MODE. Toggle off in Command Palette to enable.',
      },
    }))
  }

  const refresh = () =>
    window.tachi.settings.listKeys()
      .then(ids => setConnectedIds(new Set(ids)))
      .catch(() => {})

  useEffect(() => { refresh() }, [])

  // ── What the relay ACTUALLY carries ───────────────────────────────────────
  //
  // This card used to render its badges purely from FREELLMAPI_PROVIDERS, a
  // hardcoded list of what we EXPECT the relay to have. On 2026-08-01 that list
  // promised OpenCode Zen with [FREE · NO KEY] on a build whose relay had never
  // heard of `zen` — the vendor patch that adds it never ran, the anon seed for
  // it 400'd, and the failure was swallowed. The user was told a platform was
  // free and ready by a component that had never asked.
  //
  // Now the hardcoded list supplies only the things a relay cannot tell us —
  // label, signup URL, quota copy, the trains-on-prompts disclosure — and every
  // STATUS claim is derived from the relay's live platform list. A row we
  // expect and the relay does not have is shown as missing, out loud, because
  // silence is what let this ship.
  const [relayPlatforms, setRelayPlatforms] = useState<Map<string, RelayPlatformRow> | null>(null)
  const [relayError, setRelayError]         = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await window.tachi.freellmapi?.listPlatforms?.()
        if (cancelled) return
        if (res?.ok) {
          setRelayPlatforms(new Map(res.platforms.map(p => [p.platform, p])))
          setRelayError(null)
        } else {
          setRelayPlatforms(null)
          setRelayError(res?.error ?? 'free router not running')
        }
      } catch (e) {
        if (cancelled) return
        setRelayPlatforms(null)
        setRelayError(e instanceof Error ? e.message : String(e))
      }
    }
    void load()
    return () => { cancelled = true }
  }, [])

  /**
   * ONE state per row — the header count, every badge and every explanatory line
   * read THIS. See the denominator note in freellmapi-providers.ts: the card
   * used to show three different numbers for one install because the header, the
   * rows and the relay were each counting a different population.
   *
   * Still named `relayStatus` where it is used as the four-way badge answer
   * below; the states are documented on `relayRowState`.
   */
  const rowState = (id: string): RelayRowState => relayRowState({
    ...(relayPlatforms?.get(id) ? { row: relayPlatforms.get(id)! } : {}),
    relayAnswered: relayPlatforms !== null,
    // `connectedIds` is EVERY key in Tachi's keychain (settings:list-keys covers
    // search APIs and weights hosts too), so it only ever answers for the
    // platform id of the row asking — never as a total.
    hasSavedKey:   connectedIds.has(id),
  })
  /** Back-compat alias: the badges below read the row's state, nothing else. */
  const relayStatus = rowState

  const handleSave = async (providerId: string) => {
    const raw = keyInput.trim()
    if (!raw) return
    // Strip common paste mistakes — "from foo" prefix, NAME=, surrounding
    // quotes/parens — same as the freellmapi auto-seed sanitizer.
    const cleaned = raw
      .replace(/^\s*from\s+/i, '')
      .replace(/^[A-Z_]+\s*=\s*/, '')
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/^\(+|\)+$/g, '')
      .trim()
    // Validate: must be all-ASCII, no whitespace, 16+ chars, no quotes/parens.
    // Common bug: Cyrillic homoglyphs (Russian keyboard layout) — char `х`
    // (Cyrillic, codepoint 1093) looks identical to Latin `x` but fails as
    // HTTP header value. Reject the whole string if ANY char is non-ASCII.
    const nonAsciiIdx = [...cleaned].findIndex(c => c.charCodeAt(0) > 127)
    if (nonAsciiIdx !== -1) {
      const ch = cleaned.charCodeAt(nonAsciiIdx)
      window.dispatchEvent(new CustomEvent('tachi:toast', {
        detail: {
          kind: 'error',
          ttl: 9000,
          text: `Key rejected — non-ASCII character at position ${nonAsciiIdx} (codepoint ${ch}). `
            + `Likely Cyrillic homoglyph from Russian keyboard layout. Re-copy the key with English layout active.`,
        },
      }))
      return
    }
    if (!/^[A-Za-z0-9._-]{16,}$/.test(cleaned)) {
      window.dispatchEvent(new CustomEvent('tachi:toast', {
        detail: {
          kind: 'error',
          ttl: 7000,
          text: 'Key rejected — must be 16+ chars, only A-Z a-z 0-9 . _ - allowed. Paste only the literal API key, no quotes / no env var name / no code.',
        },
      }))
      return
    }
    setSaving(true)
    try {
      await window.tachi.settings.saveKey(providerId, cleaned)
      setConnectedIds(prev => new Set([...prev, providerId]))
      setAddingId(null)
      setKeyInput('')
    } finally { setSaving(false) }
  }

  const handleRemove = async (providerId: string) => {
    await window.tachi.settings.deleteKey(providerId).catch(() => {})
    setConnectedIds(prev => { const n = new Set(prev); n.delete(providerId); return n })
  }

  // The header counts the SAME rows the card renders, with the SAME predicate
  // the row badges use. It used to print `connectedIds.size`, which was every
  // credential in the keychain — Bankr, Venice, Tavily, Civitai — against a
  // denominator of free-router platforms, so "12 / 16 connected" sat above 16
  // rows carrying 6 connected badges.
  const relayAnswered = relayPlatforms !== null
  const connected     = FREELLMAPI_PROVIDERS.filter(p => isRelayConnected(rowState(p.id))).length
  const savedKeys     = FREELLMAPI_PROVIDERS.filter(p => connectedIds.has(p.id)).length
  // The relay's own total, shown rather than hidden: it legitimately carries
  // platforms this build does not list (migration-era ones), and that is the
  // third number this card used to contradict without ever printing.
  const relayCarries  = relayPlatforms?.size ?? 0

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <h2 style={cardTitle}>Free Providers</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            data-testid="freellmapi-connected-count"
            title={relayAnswered
              ? RELAY_DENOMINATOR
              : `The free router did not answer, so nothing here is verified. ${savedKeys} of these platforms have a key saved in Tachi.`}
            style={{ color: 'var(--text-muted)', fontSize: 12 }}
          >
            {relayAnswered ? connected : '—'} / {FREELLMAPI_PROVIDERS.length} connected
            {relayAnswered && relayCarries > FREELLMAPI_PROVIDERS.length && (
              <span style={{ color: 'var(--text-dim)' }}> · router carries {relayCarries}</span>
            )}
          </span>
          <button onClick={() => navigate('/freellmapi')} style={dashboardBtn}>
            Open Dashboard
          </button>
        </div>
      </div>

      {/* Banner: explains why cloud cards are locked. Only when private mode is active. */}
      {privacyMode === 'private' && (
        <div
          role="status"
          aria-label="Private mode active"
          style={{
            border: '2px solid var(--danger, #d43f00)',
            background: 'transparent',
            padding: '8px 10px',
            marginBottom: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
            fontFamily: 'JetBrains Mono, monospace',
          }}
        >
          <div style={{
            fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
            textTransform: 'uppercase', color: 'var(--danger, #d43f00)',
          }}>
            [ PRIVATE MODE ACTIVE ]
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4 }}>
            Cloud providers are blocked. Use a local provider, or toggle PRIVATE MODE off in the Command Palette (⌘K).
          </div>
        </div>
      )}

      {/* In-process MCP server row (Clauge-style). Sits above the provider
          list so it's visible without scrolling. Brutalist styling: 2px
          borders, no radius, JetBrains Mono. */}
      <McpServerRow />
      <ApiServerRow />

      {/* llama.cpp truly-local sidecar (Vitalik-aligned: SHA-verified binary
          + SHA-verified GGUF weights, zero external egress at chat time).
          Sits next to MCP so it's the second thing the user sees on the
          providers card — making "truly local" feel as first-class as
          "shared MCP". */}
      <LlamaCppRow />

      {/* ── The free route's disclosure ──────────────────────────────────────
          Kilo Gateway was a standalone provider until 2026-08-01, with its own
          Settings card carrying this warning. It is now an upstream INSIDE the
          local router, so a user who never picks Kilo can still be served by
          it. This banner (and the per-row badge below) is where that fact
          lives now — the router's own surface. Do not remove it while any
          upstream in FREELLMAPI_PROVIDERS carries trainsOnPrompts. */}
      {FREELLMAPI_PROVIDERS.some(p => p.trainsOnPrompts) && (
        <div
          data-testid="freellmapi-route-disclosure"
          style={{
            border: 'var(--border-width, 2px) solid var(--warning)',
            background: 'transparent',
            padding: '8px 10px',
            marginBottom: 12,
            fontFamily: 'JetBrains Mono, monospace',
          }}
        >
          <div style={{
            fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
            textTransform: 'uppercase', color: 'var(--warning)', marginBottom: 3,
          }}>
            {t('disclosure.title')}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.45 }}>
            {t('disclosure.trainsOnPrompts')}
          </div>
        </div>
      )}

      {FREELLMAPI_PROVIDERS.map(p => {
        const locked = isLocked(p)
        return (
        <div key={p.id} style={{ position: 'relative', borderBottom: 'var(--border-width) solid var(--border)', padding: '9px 0' }}>
          {/* Lock overlay — sits above the card content, captures clicks so the
              underlying buttons can never fire while private mode is active. */}
          {locked && (
            <div
              role="button"
              tabIndex={0}
              aria-label={`${p.label} — locked in PRIVATE MODE`}
              title="Blocked in PRIVATE MODE — use a local provider"
              onClick={notifyLocked}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); notifyLocked() } }}
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'transparent',
                cursor: 'not-allowed',
                zIndex: 2,
              }}
            >
              <span style={lockBadge}>[ LOCKED ]</span>
            </div>
          )}

          {/* Card body — dimmed when locked so the visual hierarchy reads "off". */}
          <div style={{ opacity: locked ? 0.5 : 1, pointerEvents: locked ? 'none' : undefined }}>
          {/* Anonymous / no-key providers: always connected via auto-seed */}
          {p.noKey ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <ProviderIcon providerId={p.id} size={14} style={{ marginRight: 6 }} />
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{p.label}</span>
                  {/* Raw, not quotaLabel(): the [FREE · NO KEY] badge beside it
                      already says "free", and these phrases describe access
                      ("Anonymous (no key) · …"), not a quota that needs the word. */}
                  <span style={{ color: 'var(--text-muted)', fontSize: 11, marginLeft: 7 }}>
                    {p.dailyFree}
                  </span>
                </div>
                {/* The badge is DERIVED, never asserted. See relayStatus(). */}
                {(() => {
                  const st = relayStatus(p.id)
                  if (st === 'ready')    return <span data-testid={`relay-badge-${p.id}`} style={anonBadge}>[FREE · NO KEY]</span>
                  if (st === 'missing')  return <span data-testid={`relay-badge-${p.id}`} style={missingBadge}>[NOT IN THIS BUILD]</span>
                  if (st === 'unseeded') return <span data-testid={`relay-badge-${p.id}`} style={missingBadge}>[NO KEY SEEDED]</span>
                  // The anon placeholder was seeded and the upstream refused it —
                  // present, keyed, and routing nothing.
                  if (st === 'rejected') return <span data-testid={`relay-badge-${p.id}`} style={missingBadge}>[KEY REJECTED]</span>
                  return <span data-testid={`relay-badge-${p.id}`} style={unknownBadge}>[UNVERIFIED]</span>
                })()}
              </div>
              {/* A promise the relay cannot keep, said plainly. This is the
                  line that would have surfaced the shipped-without-patch-#2
                  build on the very first look at this card. */}
              {relayStatus(p.id) === 'missing' && (
                <div
                  data-testid={`relay-missing-${p.id}`}
                  style={{ marginTop: 5, fontSize: 10, lineHeight: 1.45, color: 'var(--danger, #d43f00)' }}
                >
                  The free router does not carry this platform — it will not be used. Reinstall the
                  local engine from the dashboard to rebuild it with the bundled providers.
                </div>
              )}
              {relayStatus(p.id) === 'unseeded' && (
                <div style={{ marginTop: 5, fontSize: 10, lineHeight: 1.45, color: 'var(--warning)' }}>
                  Present in the router but with no key row, so the router skips it. Restart the free
                  router to re-seed it.
                </div>
              )}
              {relayStatus(p.id) === 'unknown' && relayError && (
                <div style={{ marginTop: 5, fontSize: 10, lineHeight: 1.45, color: 'var(--text-dim)' }}>
                  Not verified — {relayError}.
                </div>
              )}
              {/* The price of free, on the row that charges it. This used to be
                  a whole Settings card back when Kilo was its own provider; the
                  provider is gone, the fact is not. */}
              {p.trainsOnPrompts && (
                <div
                  data-testid={`freellmapi-trains-notice-${p.id}`}
                  style={{
                    marginTop: 5, fontSize: 10, lineHeight: 1.45,
                    color: 'var(--warning)',
                  }}
                >
                  ⚠ {t('disclosure.trainsBadge')}
                </div>
              )}
            </div>
          ) : addingId === p.id ? (
            /* Inline key paste form */
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontWeight: 700, fontSize: 13 }}>{p.label}</span>
                <button onClick={() => { setAddingId(null); setKeyInput('') }} style={cancelBtn}>✕</button>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="password" value={keyInput}
                  onChange={e => setKeyInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSave(p.id) }}
                  placeholder={`${p.label} API key…`} autoFocus
                  style={{
                    flex: 1, padding: '6px 10px', borderRadius: 0,
                    border: 'var(--border-width) solid var(--border)',
                    background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: 12,
                  }}
                />
                <button onClick={() => handleSave(p.id)} disabled={saving || !keyInput.trim()} style={saveBtn}>
                  {saving ? '…' : 'Save'}
                </button>
              </div>
            </div>
          ) : (
            /* Normal provider row */
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <ProviderIcon providerId={p.id} size={14} style={{ marginRight: 6 }} />
                <span style={{ fontWeight: 600, fontSize: 13 }}>{p.label}</span>
                <span style={{ color: 'var(--text-muted)', fontSize: 11, marginLeft: 7 }}>
                  {quotaLabel(p)}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {/* THE BADGE reads rowState — the same derivation the header
                    counts — and is rendered independently of the buttons, so a
                    row can never carry a badge the count refuses (or the other
                    way round). THE BUTTONS read the keychain, which answers a
                    different question: is there a key here to remove.
                    "Connected" used to mean only "a key exists in Tachi's
                    keychain", which is why a revoked OpenRouter key read as
                    connected right up until it 401'd inside the router and took
                    a send down with it. */}
                {(() => {
                  const st = rowState(p.id)
                  const hasKey = connectedIds.has(p.id)
                  if (isRelayConnected(st)) return (
                    <span data-testid={`relay-connected-${p.id}`} style={{ color: '#22c55e', fontSize: 12, fontWeight: 700 }}>✓ Connected</span>
                  )
                  if (st === 'rejected') return (
                    <span
                      data-testid={`relay-key-rejected-${p.id}`}
                      title="The provider rejected this key. The free router has stopped using it."
                      style={{ color: 'var(--danger, #d43f00)', fontSize: 12, fontWeight: 700 }}
                    >
                      ✕ Key rejected
                    </span>
                  )
                  if (st === 'key-saved') return (
                    <span
                      data-testid={`relay-key-saved-${p.id}`}
                      title="A key is saved here, but the free router did not answer — nothing about this row is verified."
                      style={{ color: 'var(--text-dim)', fontSize: 12, fontWeight: 700 }}
                    >
                      ✓ Key saved (unverified)
                    </span>
                  )
                  // 'missing' / 'unseeded' WITH a key of ours: the key is stored
                  // and the router cannot use it. Worth saying; "Connected"
                  // here would be the same lie the [FREE · NO KEY] badge told.
                  if (hasKey && (st === 'missing' || st === 'unseeded')) return (
                    <span
                      data-testid={`relay-key-unused-${p.id}`}
                      title={st === 'missing'
                        ? 'The free router does not carry this platform, so your key is never used.'
                        : 'The free router has no key row for this platform yet — restart it to re-seed.'}
                      style={{ color: 'var(--warning)', fontSize: 12, fontWeight: 700 }}
                    >
                      ! Key saved, router not using it
                    </span>
                  )
                  // Nothing set up and nothing to report — the buttons say it.
                  return null
                })()}
                {connectedIds.has(p.id) ? (
                  <button onClick={() => handleRemove(p.id)} style={removeBtn}>Remove</button>
                ) : (
                  <>
                    <button onClick={() => window.tachi.shell.openExternal(p.signupUrl)} style={getKeyBtn}>
                      Get key ↗
                    </button>
                    <button onClick={() => { setAddingId(p.id); setKeyInput('') }} style={addKeyBtn}>
                      + Add key
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
          </div>{/* /opacity-wrapper */}
        </div>
        )
      })}

      {/* Per-platform model breakdown — what the free router can ACTUALLY route
          to right now (keyed/seeded platforms only, live from the sidecar). */}
      <FreeRouterModelsBreakdown />
    </div>
  )
}

// ── Free-router models breakdown ─────────────────────────────────────────────
//
// Live view of freellmapi's fallback chain grouped by platform: which models
// are routable RIGHT NOW (keyCount > 0 && enabled), in priority order. Lazy:
// fetched when the user expands the section, refreshed on each expand.
function FreeRouterModelsBreakdown() {
  type FbModel = { platform: string; modelId: string; name: string; keyCount: number; priority: number; enabled: boolean }
  const [open, setOpen]       = useState(false)
  const [models, setModels]   = useState<FbModel[] | null>(null)
  const [err, setErr]         = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const load = async () => {
    try {
      const res = await window.tachi.freellmapi.listFallbackModels()
      if (res.ok) { setModels(res.models); setErr(null) }
      else { setModels([]); setErr(res.error ?? 'freellmapi not running') }
    } catch (e) {
      setModels([]); setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next) void load()
  }

  const groups = new Map<string, FbModel[]>()
  for (const m of models ?? []) {
    const arr = groups.get(m.platform) ?? []
    arr.push(m)
    groups.set(m.platform, arr)
  }
  const label = (id: string) => FREELLMAPI_PROVIDERS.find(p => p.id === id)?.label ?? id
  const quota = (id: string) => FREELLMAPI_PROVIDERS.find(p => p.id === id)?.dailyFree ?? ''

  return (
    <div style={{ marginTop: 12, fontFamily: 'JetBrains Mono, monospace' }}>
      <button
        onClick={toggle}
        style={{
          width: '100%', textAlign: 'left', padding: '7px 10px',
          border: '2px solid var(--border)', background: 'var(--bg-inset)',
          color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 11,
          fontWeight: 700, letterSpacing: '0.06em', cursor: 'pointer',
          display: 'flex', justifyContent: 'space-between',
        }}
      >
        <span>{open ? '▾' : '▸'} ROUTABLE MODELS</span>
        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
          {models === null ? '' : `${models.length} models · ${groups.size} platforms`}
        </span>
      </button>

      {open && (
        <div style={{ border: '2px solid var(--border)', borderTop: 'none' }}>
          {models === null && (
            <div style={{ padding: '8px 10px', fontSize: 10, color: 'var(--text-muted)' }}>Loading…</div>
          )}
          {err && (
            <div style={{ padding: '8px 10px', fontSize: 10, color: 'var(--danger, #d43f00)' }}>
              {err} — start the freellmapi service (chat once with the FreeLLM provider) and re-open.
            </div>
          )}
          {models !== null && !err && models.length === 0 && (
            <div style={{ padding: '8px 10px', fontSize: 10, color: 'var(--text-muted)' }}>
              No routable models — add a key (or use an anon provider) above.
            </div>
          )}
          {[...groups.entries()].map(([platform, list]) => {
            const isOpen = expanded.has(platform)
            return (
              <div key={platform} style={{ borderBottom: 'var(--border-width) solid var(--border)' }}>
                <button
                  onClick={() => setExpanded(prev => {
                    const n = new Set(prev)
                    if (n.has(platform)) n.delete(platform); else n.add(platform)
                    return n
                  })}
                  style={{
                    width: '100%', textAlign: 'left', padding: '6px 10px', border: 'none',
                    background: 'transparent', color: 'var(--text-primary)',
                    fontFamily: 'inherit', fontSize: 11, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 8,
                  }}
                >
                  <span style={{ color: 'var(--text-dim)' }}>{isOpen ? '▾' : '▸'}</span>
                  <ProviderIcon providerId={platform} size={12} />
                  <span style={{ fontWeight: 700 }}>{label(platform)}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{quota(platform)}</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{list.length}</span>
                </button>
                {isOpen && list.map(m => (
                  <div
                    key={`${m.platform}:${m.modelId}`}
                    style={{
                      display: 'flex', alignItems: 'baseline', gap: 8,
                      padding: '3px 10px 3px 30px', fontSize: 10,
                      color: 'var(--text-muted)',
                    }}
                  >
                    <span style={{ color: 'var(--text-dim)', minWidth: 26 }}>#{m.priority}</span>
                    <span style={{ color: 'var(--text-primary)' }}>{m.name}</span>
                    <span style={{ flex: 1 }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '45%' }}>{m.modelId}</span>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── In-process MCP server row ────────────────────────────────────────────────
//
// Renders a single brutalist row inside ProvidersCard showing:
//   [STATUS]  http://127.0.0.1:<port>/mcp
//   [Copy URL] [Reveal token] [Copy config] [Disable]    (when running)
//   [STATUS=DISABLED]                       [Enable]     (when disabled)
//
// "Reveal token" toggles inline display of the bearer token in monospace +
// Copy button. The token is fetched on demand via mcp:reveal-token and held
// in component state only.
function McpServerRow() {
  type Status = { running: boolean; enabled: boolean; url: string | null; port: number | null }
  const [status, setStatus]         = useState<Status>({ running: false, enabled: true, url: null, port: null })
  const [token, setToken]           = useState<string | null>(null)
  const [busy, setBusy]             = useState(false)
  const [copyHint, setCopyHint]     = useState<string | null>(null)

  const refresh = async () => {
    try {
      const s = await window.tachi.mcp.status()
      setStatus(s)
    } catch { /* ignore — main may not be ready yet */ }
  }

  useEffect(() => {
    refresh()
    // Poll a couple of times after mount so the row reflects the eventual
    // running state if main is still starting the server.
    const tA = setTimeout(refresh, 800)
    const tB = setTimeout(refresh, 2500)
    return () => { clearTimeout(tA); clearTimeout(tB) }
  }, [])

  const toast = (text: string, kind: 'success' | 'error' = 'success') => {
    window.dispatchEvent(new CustomEvent('tachi:toast', { detail: { kind, ttl: 4000, text } }))
  }

  const onCopyUrl = async () => {
    if (!status.url) return
    try { await navigator.clipboard.writeText(status.url); setCopyHint('URL copied'); setTimeout(() => setCopyHint(null), 1500) }
    catch { toast('Clipboard copy failed', 'error') }
  }

  const onRevealToken = async () => {
    if (token !== null) { setToken(null); return }
    try {
      const t = await window.tachi.mcp.revealToken()
      if (t) setToken(t)
      else toast('No token available — server not running', 'error')
    } catch { toast('Could not reveal token', 'error') }
  }

  const onCopyToken = async () => {
    if (!token) return
    try { await navigator.clipboard.writeText(token); setCopyHint('Token copied'); setTimeout(() => setCopyHint(null), 1500) }
    catch { toast('Clipboard copy failed', 'error') }
  }

  const onCopyConfig = async () => {
    try {
      const cfg = await window.tachi.mcp.copyClientConfig()
      if (!cfg) { toast('Server not running — start it first', 'error'); return }
      await navigator.clipboard.writeText(JSON.stringify(cfg.claudeDesktop, null, 2))
      setCopyHint('Claude config copied')
      setTimeout(() => setCopyHint(null), 1800)
    } catch { toast('Could not copy config', 'error') }
  }

  const onToggleEnabled = async () => {
    setBusy(true)
    try {
      const next = !status.enabled
      const s = await window.tachi.mcp.setEnabled(next)
      setStatus(s)
      setToken(null)  // hide any revealed token across enable/disable
    } catch { toast('Toggle failed', 'error') }
    finally { setBusy(false) }
  }

  const statusBadge = (() => {
    if (!status.enabled) return { label: '[ DISABLED ]', color: 'var(--text-muted)' }
    if (status.running)  return { label: '[ RUNNING ]',  color: 'var(--success, #22c55e)' }
    return { label: '[ STOPPED ]', color: 'var(--danger, #d43f00)' }
  })()

  return (
    <div style={mcpRowOuter}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 13, fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.04em' }}>
            MCP SERVER
          </span>
          <span style={{ ...mcpBadge, borderColor: statusBadge.color, color: statusBadge.color }}>
            {statusBadge.label}
          </span>
          {status.url && (
            <span style={mcpUrl} title={status.url}>{status.url}</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {status.enabled && status.running && (
            <>
              <button onClick={onCopyUrl} style={mcpBtn} title="Copy server URL">[Copy URL]</button>
              <button onClick={onRevealToken} style={mcpBtn} title="Show / hide the bearer token">
                {token === null ? '[Reveal token]' : '[Hide token]'}
              </button>
              <button onClick={onCopyConfig} style={mcpBtn} title="Copy a Claude Desktop mcpServers snippet">
                [Copy config]
              </button>
            </>
          )}
          <button onClick={onToggleEnabled} disabled={busy} style={status.enabled ? mcpBtn : mcpBtnPrimary}>
            {busy ? '...' : status.enabled ? '[Disable]' : '[Enable]'}
          </button>
        </div>
      </div>

      {/* Inline token reveal */}
      {token !== null && (
        <div style={tokenPanel}>
          <code style={tokenText}>{token}</code>
          <button onClick={onCopyToken} style={mcpBtn}>[Copy token]</button>
        </div>
      )}

      {/* Tiny copy-hint pill */}
      {copyHint && <div style={copyHintStyle}>{copyHint}</div>}
    </div>
  )
}

// ── Local OpenAI-compatible API server row ───────────────────────────────────
//
// Same brutalist row as McpServerRow, for the OTHER endpoint the app exposes:
// http://127.0.0.1:11435/v1 — any OpenAI-SDK tool can chat through FreeLLM +
// llama.cpp with the revealed key. "Copy example" puts a ready curl command
// (key included) on the clipboard.
function ApiServerRow() {
  type Status = { running: boolean; enabled: boolean; baseUrl: string | null; port: number | null }
  const [status, setStatus]     = useState<Status>({ running: false, enabled: true, baseUrl: null, port: null })
  const [token, setToken]       = useState<string | null>(null)
  const [busy, setBusy]         = useState(false)
  const [copyHint, setCopyHint] = useState<string | null>(null)

  const refresh = async () => {
    try { setStatus(await window.tachi.apiServer.status()) }
    catch { /* ignore — main may not be ready yet */ }
  }

  useEffect(() => {
    refresh()
    const tA = setTimeout(refresh, 800)
    const tB = setTimeout(refresh, 2500)
    return () => { clearTimeout(tA); clearTimeout(tB) }
  }, [])

  const toast = (text: string, kind: 'success' | 'error' = 'success') => {
    window.dispatchEvent(new CustomEvent('tachi:toast', { detail: { kind, ttl: 4000, text } }))
  }
  const hint = (text: string) => { setCopyHint(text); setTimeout(() => setCopyHint(null), 1500) }

  const onCopyUrl = async () => {
    if (!status.baseUrl) return
    try { await navigator.clipboard.writeText(status.baseUrl); hint('Base URL copied') }
    catch { toast('Clipboard copy failed', 'error') }
  }

  const onRevealToken = async () => {
    if (token !== null) { setToken(null); return }
    try {
      const t = await window.tachi.apiServer.revealToken()
      if (t) setToken(t)
      else toast('No key available — server not running', 'error')
    } catch { toast('Could not reveal key', 'error') }
  }

  const onCopyToken = async () => {
    if (!token) return
    try { await navigator.clipboard.writeText(token); hint('API key copied') }
    catch { toast('Clipboard copy failed', 'error') }
  }

  const onCopyExample = async () => {
    try {
      const s = await window.tachi.apiServer.copySnippet()
      if (!s) { toast('Server not running — enable it first', 'error'); return }
      await navigator.clipboard.writeText(s.curl)
      hint('curl example copied')
    } catch { toast('Could not copy example', 'error') }
  }

  const onToggleEnabled = async () => {
    setBusy(true)
    try {
      const s = await window.tachi.apiServer.setEnabled(!status.enabled)
      setStatus(s)
      setToken(null)
    } catch { toast('Toggle failed', 'error') }
    finally { setBusy(false) }
  }

  const statusBadge = (() => {
    if (!status.enabled) return { label: '[ DISABLED ]', color: 'var(--text-muted)' }
    if (status.running)  return { label: '[ RUNNING ]',  color: 'var(--success, #22c55e)' }
    return { label: '[ STOPPED ]', color: 'var(--danger, #d43f00)' }
  })()

  return (
    <div style={mcpRowOuter}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 13, fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.04em' }}>
            OPENAI API
          </span>
          <span style={{ ...mcpBadge, borderColor: statusBadge.color, color: statusBadge.color }}>
            {statusBadge.label}
          </span>
          {status.baseUrl && (
            <span style={mcpUrl} title={status.baseUrl}>{status.baseUrl}</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {status.enabled && status.running && (
            <>
              <button onClick={onCopyUrl} style={mcpBtn} title="Copy the OpenAI-compatible base URL">[Copy base URL]</button>
              <button onClick={onRevealToken} style={mcpBtn} title="Show / hide the API key">
                {token === null ? '[Reveal key]' : '[Hide key]'}
              </button>
              <button onClick={onCopyExample} style={mcpBtn} title="Copy a working curl example (key included)">
                [Copy example]
              </button>
            </>
          )}
          <button onClick={onToggleEnabled} disabled={busy} style={status.enabled ? mcpBtn : mcpBtnPrimary}>
            {busy ? '...' : status.enabled ? '[Disable]' : '[Enable]'}
          </button>
        </div>
      </div>

      {token !== null && (
        <div style={tokenPanel}>
          <code style={tokenText}>{token}</code>
          <button onClick={onCopyToken} style={mcpBtn}>[Copy key]</button>
        </div>
      )}

      {copyHint && <div style={copyHintStyle}>{copyHint}</div>}
    </div>
  )
}

const mcpRowOuter: React.CSSProperties = {
  border: '2px solid var(--border)',
  padding: '10px 12px',
  marginBottom: 14,
  background: 'transparent',
  fontFamily: 'JetBrains Mono, monospace',
}
const mcpBadge: React.CSSProperties = {
  display: 'inline-block',
  padding: '2px 7px',
  border: '2px solid currentColor',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
}
const mcpUrl: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-muted)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  maxWidth: '50%',
}
const mcpBtn: React.CSSProperties = {
  padding: '3px 8px',
  border: '2px solid var(--border)',
  background: 'transparent',
  color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  cursor: 'pointer',
}
const mcpBtnPrimary: React.CSSProperties = {
  ...mcpBtn,
  borderColor: 'var(--accent, #22c55e)',
  color: 'var(--accent, #22c55e)',
}
const tokenPanel: React.CSSProperties = {
  marginTop: 8,
  padding: '6px 8px',
  border: '2px solid var(--border)',
  background: 'var(--bg-base)',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}
const tokenText: React.CSSProperties = {
  flex: 1,
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  color: 'var(--text-primary)',
  wordBreak: 'break-all',
  background: 'transparent',
}
const copyHintStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 10,
  color: 'var(--success, #22c55e)',
  fontFamily: 'JetBrains Mono, monospace',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
}

const card: React.CSSProperties = {
  background: 'var(--bg-surface)', borderRadius: 0,
  border: 'var(--border-width) solid var(--border)', padding: 20, marginBottom: 20,
}
const cardTitle: React.CSSProperties  = { fontSize: 15, fontWeight: 700, margin: 0 }
const cancelBtn: React.CSSProperties  = { background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, padding: 0 }
const saveBtn: React.CSSProperties    = { padding: '5px 10px', borderRadius: 0, border: 'none', background: 'var(--accent)', color: 'var(--bg-base)', fontWeight: 700, cursor: 'pointer', fontSize: 12 }
const getKeyBtn: React.CSSProperties  = { padding: '3px 8px', borderRadius: 0, border: 'var(--border-width) solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer' }
const addKeyBtn: React.CSSProperties  = { padding: '3px 8px', borderRadius: 0, border: 'none', background: 'var(--accent)', color: 'var(--bg-base)', fontSize: 11, cursor: 'pointer', fontWeight: 700 }
const removeBtn: React.CSSProperties    = { padding: '3px 8px', borderRadius: 0, border: 'var(--border-width) solid var(--border)', background: 'transparent', color: 'var(--danger)', fontSize: 11, cursor: 'pointer' }
const dashboardBtn: React.CSSProperties = { padding: '3px 10px', border: '2px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer' }
const anonBadge: React.CSSProperties    = { padding: '2px 7px', border: '2px solid var(--success, #22c55e)', background: 'transparent', color: 'var(--success, #22c55e)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap' }
const lockBadge: React.CSSProperties    = { padding: '3px 9px', border: '2px solid var(--danger, #d43f00)', background: 'var(--bg-base)', color: 'var(--danger, #d43f00)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', whiteSpace: 'nowrap' }
// A platform we expect and the relay does not have — the badge that would have
// caught a build shipped without its vendor patch.
const missingBadge: React.CSSProperties = { padding: '2px 7px', border: '2px solid var(--danger, #d43f00)', background: 'transparent', color: 'var(--danger, #d43f00)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap' }
// The relay did not answer. We know nothing, so the badge claims nothing.
const unknownBadge: React.CSSProperties = { padding: '2px 7px', border: '2px solid var(--border)', background: 'transparent', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap' }
