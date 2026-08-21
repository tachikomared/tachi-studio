// apps/desktop/src/pages/chat/ProviderPicker.tsx
import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { usePrivacyStore } from '../../store/privacy.store'
import { useProviderHealth } from '../../hooks/useProviderHealth'
import { isProbeable, type ProviderHealth } from '../../store/provider-health.store'
import { ProviderIcon } from '../../components/ProviderIcon'
// Single source of truth for providers (shared by chat, agents, nodes).
// Subpath import keeps the Node-only core barrel out of the renderer bundle.
import { listProviders, providerLocality, localityOf, type ProviderLocality } from '@tachi/core/src/providers/registry'
// AUTO's live answer to "what runs right now" — the SAME gather + ladder the
// send path uses, so the line under the AUTO row cannot drift from the route.
import { gatherAutoModelInputs } from './autoModelGather'
import { resolveAutoModel, AUTO_HARD_FALLBACK } from '../../utils/autoModel'
// User-added custom OpenAI-compatible endpoints (USER-PAINS T17). Same subpath
// pattern — pure helpers, no Node-only barrel.
import { customProviderId, endpointLocality } from '@tachi/core/src/providers/custom-endpoint'

export type ProviderTier = 'local' | 'cloud' | 'github'

export interface ProviderOption {
  id: string
  label: string
  /**
   * GROUPING ONLY — mirrors the registry's `tier`. It may not drive a badge,
   * a colour, or any other locality claim; `providerLocality(id)` does that.
   */
  tier: ProviderTier
  /** Private-mode egress class. 'local' = truly offline; 'cloud' = reaches the internet. */
  egress?: 'local' | 'cloud'
  /** Required key in keychain (settings:list-keys). Empty = no key required. */
  requiresKey?: string
  /** Default model name to send when this provider is picked. */
  defaultModel?: string
  hint?: string
  /** User-added custom OpenAI-compatible endpoint — renders a LAN-LOCAL/CLOUD badge. */
  custom?: boolean
}

/**
 * Synthetic provider id for the AUTO router. Not a real backend provider — at
 * SEND time it resolves to a concrete provider+model via the AUTO ladder
 * (local-fit → free → paid-default). See src/utils/autoModel.ts.
 */
export const AUTO_PROVIDER_ID = 'auto'

// Derived from the unified provider registry (packages/core) so chat, agents,
// and nodes all offer the SAME providers. `requiresKey` maps to the descriptor's
// keychainId; `egress` drives the private-mode filter below.
export const PROVIDER_OPTIONS: ProviderOption[] = listProviders().map(p => ({
  id:           p.id,
  label:        p.label,
  tier:         p.tier,
  egress:       p.egress,
  requiresKey:  p.keychainId,
  defaultModel: p.defaultModel,
  hint:         p.hint,
}))

// ── Egress chip ───────────────────────────────────────────────────────────────
//
// THE CHIP IS A PRIVACY CLAIM, SO IT READS `egress`, NOT `tier`. This used to be
// a TierChip: freellmapi-local is tier 'local' (a sidecar really does run here)
// but egress 'cloud' (it proxies every prompt to a free cloud provider), so the
// picker showed a green LOCAL badge over the default provider of every starter
// template — the same false sentence 64c837d removed from the cost chip.
//
// A localhost sidecar that proxies to the cloud is a real category and gets its
// own honest word: RELAY, ambered like CLOUD because the prompt leaves either
// way. Green is reserved for egress 'local' and nothing else.

const LOCALITY_COLOR: Record<ProviderLocality, string> = {
  local: 'var(--success)',
  relay: 'var(--warning)',
  cloud: 'var(--warning)',
}

export function EgressChip({ providerId, small = false }: { providerId: string; small?: boolean }) {
  const { t } = useTranslation('chat')
  // Derived from the id, not from a prop: a caller cannot hand this component a
  // locality that disagrees with the registry.
  const locality = providerLocality(providerId)
  const color = LOCALITY_COLOR[locality]
  return (
    <span
      title={t(`provider.locality.${locality}.title`)}
      style={{
        padding: small ? '0px 3px' : '1px 4px',
        border: `2px solid ${color}`,
        background: 'transparent',
        color,
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        lineHeight: 1.4,
        flexShrink: 0,
        whiteSpace: 'nowrap',
      }}
    >
      {t(`provider.locality.${locality}.badge`)}
    </span>
  )
}

// ── Custom endpoint locality chip (LAN-LOCAL / CLOUD) ─────────────────────────
// A user-added custom endpoint isn't a registry provider, so it gets its own
// badge derived from the hostname: loopback / RFC1918 / LAN → LAN-LOCAL (green),
// everything else → CLOUD (amber). Same brutalist chip idiom as EgressChip, and
// already egress-derived. It keeps its own wording because LAN-LOCAL is the MORE
// precise claim: on your network is not the same as on this machine.

export function LocalityChip({ egress, small = false }: { egress: 'local' | 'cloud'; small?: boolean }) {
  const { t } = useTranslation('chat')
  const local = egress === 'local'
  const color = local ? 'var(--success)' : 'var(--warning)'
  return (
    <span style={{
      padding: small ? '0px 3px' : '1px 4px',
      border: `2px solid ${color}`,
      background: 'transparent',
      color,
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 9,
      fontWeight: 700,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      lineHeight: 1.4,
      flexShrink: 0,
      whiteSpace: 'nowrap',
    }}>
      {local ? t('customEndpoint.lanBadge', { defaultValue: 'LAN-LOCAL' }) : t('customEndpoint.cloudBadge', { defaultValue: 'CLOUD' })}
    </span>
  )
}

// ── Health dot ──────────────────────────────────────────────────────────────
// Tiny status badge next to each probeable provider:
//   ok       → solid --success (green)
//   error    → solid --danger (red)
//   checking → --warning (amber), pulsing via the existing shared
//              .tachi-pulse-dot class in globals.css
//   unknown  → hollow --border ring (we couldn't measure it)
// Providers with no cheap probe render nothing at all.

const HEALTH_COLOR: Record<Exclude<ProviderHealth, 'unknown'>, string> = {
  ok:       'var(--success)',
  error:    'var(--danger)',
  checking: 'var(--warning)',
}

export function HealthDot({ providerId, health }: { providerId: string; health: ProviderHealth }) {
  const { t } = useTranslation('chat')
  // No cheap probe for this provider → render nothing (never a misleading dot).
  if (!isProbeable(providerId)) return null

  const isChecking = health === 'checking'
  const color = health === 'unknown' ? 'var(--border-strong, var(--border))' : HEALTH_COLOR[health]
  const filled = health !== 'unknown'

  return (
    <span
      title={t(`health.${health}`)}
      aria-label={t('health.ariaLabel', { status: health })}
      className={isChecking ? 'tachi-pulse-dot' : undefined}
      style={{
        width: 7,
        height: 7,
        flexShrink: 0,
        border: `2px solid ${color}`,
        background: filled ? color : 'transparent',
        // square dot to match the brutalist hard-edged design language
        boxShadow: filled ? `0 0 0 1px var(--bg-elevated)` : 'none',
      }}
    />
  )
}

// ── Picker ────────────────────────────────────────────────────────────────────

interface Props {
  value: string
  onChange: (providerId: string, defaultModel?: string) => void
  disabled?: boolean
}

// ── Locality grouping ─────────────────────────────────────────────────────────
//
// THE ORGANISATION IS THE FIRST PASS OF THE EXPLAINING. The badges stay — they
// carry the claim per row — but a newcomer should not have to decode eleven of
// them to learn that this app can answer without the internet. Three headings
// do that before a single chip is read.
//
// The RELAY is its own group and never folded into either extreme: it is a
// process on this machine that forwards the prompt onward, which is neither
// "local" (the prompt leaves) nor plainly "cloud" (the software is yours). The
// group note is the SAME sentence the badge's tooltip already carried.
//
// Order is local → relay → cloud: least egress first, so what the machine can
// do by itself is the first thing on screen.
const LOCALITY_GROUP_ORDER: readonly ProviderLocality[] = ['local', 'relay', 'cloud']

export function ProviderPicker({ value, onChange, disabled }: Props) {
  const { t } = useTranslation('chat')
  const [storedKeys, setStoredKeys] = useState<string[]>([])
  const [customOptions, setCustomOptions] = useState<ProviderOption[]>([])
  const [open, setOpen]             = useState(false)
  // What AUTO would actually send RIGHT NOW. Null until resolved — until then
  // the row claims nothing beyond its static hint.
  const [autoRoute, setAutoRoute]   = useState<{ provider: string; model: string } | null>(null)
  const privateMode                 = usePrivacyStore(s => s.mode === 'private')
  // Background per-provider health (5-min sweep + on-mount). Resilient: never
  // throws, never blocks render. Missing key === 'unknown'.
  const health                      = useProviderHealth()
  const healthFor = (id: string): ProviderHealth => health[id] ?? 'unknown'

  useEffect(() => {
    window.tachi.settings.listKeys()
      .then(setStoredKeys)
      .catch(() => setStoredKeys([]))
    // User-added custom OpenAI-compatible endpoints (USER-PAINS T17): built from
    // persisted settings each time the picker opens, so a newly-added endpoint
    // shows up without a reload. Locality (LAN vs cloud) drives both the badge
    // and the PRIVATE MODE egress filter below.
    window.tachi.settings.load()
      .then((s) => {
        const opts: ProviderOption[] = (s.providers ?? [])
          .filter(p => p.kind === 'custom-openai' && p.enabled && p.baseUrl?.trim())
          .map(p => {
            const local = endpointLocality(p.baseUrl) === 'lan-local'
            let host = p.baseUrl
            try { host = new URL(p.baseUrl).host } catch { /* keep raw on parse fail */ }
            return {
              id: customProviderId(p.id),
              label: p.displayName || t('customEndpoint.defaultName', { defaultValue: 'Custom endpoint' }),
              tier: (local ? 'local' : 'cloud') as ProviderTier,
              egress: (local ? 'local' : 'cloud') as 'local' | 'cloud',
              defaultModel: p.selectedModel,
              hint: host,
              custom: true,
            }
          })
        setCustomOptions(opts)
      })
      .catch(() => setCustomOptions([]))
  }, [open, t])

  // ── "Which route works right now?" — the question a user with no key pastes
  // in has, and the one the picker used to answer with a wall of greyed rows.
  //
  // Resolved on OPEN, from gatherAutoModelInputs() + resolveAutoModel() — the
  // exact pair InputBar calls on send, seeded with the same store fallback — so
  // the sentence under AUTO is the route, not a description of the route. It
  // stays null (and prints nothing) if anything fails.
  useEffect(() => {
    if (!open) return
    let alive = true
    ;(async () => {
      try {
        const { useChatStore } = await import('../../store/chat.store')
        const fb = useChatStore.getState().autoFallback ?? {
          providerId: AUTO_HARD_FALLBACK.provider, model: AUTO_HARD_FALLBACK.model,
        }
        const input = await gatherAutoModelInputs(
          { provider: fb.providerId, model: fb.model },
          { privateMode },
        )
        const picked = resolveAutoModel(input)
        if (alive) setAutoRoute({ provider: picked.provider, model: picked.model })
      } catch {
        /* unknown → the AUTO row keeps its static hint and claims nothing */
      }
    })()
    return () => { alive = false }
  }, [open, privateMode])

  // AUTO router pseudo-provider, pinned at the top of the picker. Selecting it
  // persists 'auto' as the conversation's provider; the concrete provider+model
  // is chosen per-send by the AUTO ladder (see src/utils/autoModel.ts).
  const autoOption: ProviderOption = {
    id: AUTO_PROVIDER_ID,
    label: t('provider.autoLabel', { defaultValue: 'Auto' }),
    // AUTO renders its own AUTO badge and never an EgressChip — but where it
    // routes is unknown until send, so the field carries the safe value rather
    // than a latent 'local' waiting for someone to render it.
    tier: 'cloud',
    hint: t('provider.autoHint', { defaultValue: 'Auto-pick: on-device model if it fits, else free, else your default.' }),
  }
  const isAuto = value === AUTO_PROVIDER_ID

  // Registry providers + user-added custom endpoints. Custom endpoints come last.
  const allOptions = [...PROVIDER_OPTIONS, ...customOptions]

  // Filter providers based on private mode. Use EGRESS (not tier): the
  // freellmapi / free-claude-code sidecars run on localhost but proxy to cloud,
  // so they are correctly hidden in PRIVATE MODE even though their tier is local.
  // Custom endpoints on non-local hosts are hidden here too (egress === 'cloud').
  const visibleOptions = privateMode
    ? allOptions.filter(p => p.egress === 'local')
    : allOptions

  const current = isAuto
    ? autoOption
    : (visibleOptions.find(p => p.id === value)
        ?? allOptions.find(p => p.id === value)
        ?? PROVIDER_OPTIONS[0])

  const isReady = (p: ProviderOption): boolean =>
    !p.requiresKey || storedKeys.includes(p.requiresKey)

  // Locality of a row. Registry rows go through providerLocality(id); a custom
  // endpoint is not in the registry, so its descriptor-shaped {tier, egress}
  // goes through localityOf() — the SAME derivation, applied to the same two
  // fields. Neither path may consult a name.
  const localityOfOption = (p: ProviderOption): ProviderLocality =>
    p.custom
      ? localityOf({ tier: p.tier === 'local' ? 'local' : 'cloud', egress: p.egress ?? 'cloud' })
      : providerLocality(p.id)

  const localityGroups = useMemo(
    () => LOCALITY_GROUP_ORDER
      .map(loc => ({ loc, items: visibleOptions.filter(p => localityOfOption(p) === loc) }))
      .filter(g => g.items.length > 0),
    [visibleOptions],
  )

  // How many routes need nothing pasted before they will answer. Counted, not
  // claimed: a provider with no keychainId is one the app can call today.
  const keylessCount = visibleOptions.filter(p => !p.requiresKey).length

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        title={t('provider.changeTitle')}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          padding: '3px 10px',
          border: '2px solid var(--border)',
          background: 'var(--bg-elevated)',
          color: 'var(--text-primary)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.04em',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          textTransform: 'uppercase',
          boxShadow: 'none',
        }}
      >
        <span style={{ color: 'var(--text-dim)' }}>{t('provider.label')}</span>
        {isAuto ? (
          <span title={current.hint} style={{
            padding: '0 4px', border: '2px solid var(--accent)', color: 'var(--accent-text)',
            background: 'var(--accent-muted)', fontWeight: 700, letterSpacing: '0.06em', lineHeight: 1.4,
          }}>{t('provider.autoBadge', { defaultValue: 'AUTO' })}</span>
        ) : (
          <>
            <ProviderIcon providerId={current.id} size={12} />
            <span>{current.label}</span>
            <HealthDot providerId={current.id} health={healthFor(current.id)} />
            {current.custom
              ? <LocalityChip egress={current.egress ?? 'cloud'} small />
              : <EgressChip providerId={current.id} small />}
          </>
        )}
        <span style={{ color: 'var(--text-dim)', fontSize: 8 }}>▾</span>
      </button>

      {open && (
        <>
          {/* Click-outside backdrop */}
          <div
            onClick={() => setOpen(false)}
            style={{
              position: 'fixed', inset: 0, zIndex: 9,
              background: 'transparent',
            }}
          />
          <div
            style={{
              position: 'absolute',
              bottom: 'calc(100% + 4px)',
              left: 0,
              minWidth: 320,
              maxHeight: 460,
              overflowY: 'auto',
              border: '2px solid var(--border)',
              background: 'var(--bg-surface)',
              boxShadow: 'var(--shadow-hard, 4px 4px 0 var(--border))',
              zIndex: 10,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {/* First line of the first screen: how many of these answer without
                a key. Counted from `requiresKey`, not asserted. */}
            <div style={{
              padding: '5px 10px',
              fontSize: 9,
              lineHeight: 1.4,
              color: 'var(--text-dim)',
              background: 'var(--bg-inset)',
              borderBottom: 'var(--border-width) solid var(--border)',
            }}>
              {t('provider.readyNow', { count: keylessCount, total: visibleOptions.length })}
            </div>

            <div role="listbox" aria-label={t('provider.listAria')} style={{ display: 'flex', flexDirection: 'column' }}>
              {/* AUTO router — pinned at the top; always available (routes to
                  local-only in private mode). */}
              <button
                key={AUTO_PROVIDER_ID}
                type="button"
                role="option"
                aria-selected={isAuto}
                onClick={() => { onChange(AUTO_PROVIDER_ID); setOpen(false) }}
                style={{
                  textAlign: 'left',
                  padding: '8px 12px',
                  border: 'none',
                  borderBottom: '2px solid var(--border-strong, var(--border))',
                  background: isAuto ? 'var(--accent-muted)' : 'transparent',
                  color: 'var(--text-primary)',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 11,
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  width: '100%',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: isAuto ? 700 : 500 }}>
                  <span style={{
                    padding: '0 4px', border: '2px solid var(--accent)', color: 'var(--accent-text)',
                    background: 'var(--accent-muted)', fontWeight: 700, letterSpacing: '0.06em', fontSize: 9,
                  }}>{t('provider.autoBadge', { defaultValue: 'AUTO' })}</span>
                  {autoOption.label}
                </span>
                <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>{autoOption.hint}</span>
                {/* The resolved route, once known. Same functions the send path
                    runs, so this line IS what the next message would take. */}
                {autoRoute && (
                  <span style={{ fontSize: 9, color: 'var(--accent)' }}>
                    {t('provider.autoRouteNow', {
                      provider: allOptions.find(o => o.id === autoRoute.provider)?.label ?? autoRoute.provider,
                      model: autoRoute.model,
                    })}
                  </span>
                )}
              </button>

              {localityGroups.map(({ loc, items }) => (
                <div key={loc} role="group" aria-label={t(`provider.localityGroup.${loc}`)}>
                  <div aria-hidden="true" style={{
                    padding: '5px 10px 4px',
                    background: 'var(--bg-elevated)',
                    borderBottom: 'var(--border-width) solid var(--border)',
                  }}>
                    <div style={{
                      fontSize: 8,
                      color: 'var(--text-dim)',
                      letterSpacing: '0.1em',
                      textTransform: 'uppercase',
                      fontWeight: 700,
                    }}>
                      {t(`provider.localityGroup.${loc}`)}
                    </div>
                    {/* The group's one honest sentence — the SAME copy the
                        per-row badge tooltip carries, so heading and chip can
                        never say different things. */}
                    <div style={{ fontSize: 9, color: 'var(--text-dim)', lineHeight: 1.35, marginTop: 2 }}>
                      {t(`provider.locality.${loc}.title`)}
                    </div>
                  </div>

                  {items.map(p => {
                    const ready    = isReady(p)
                    const selected = p.id === value
                    return (
                      <button
                        key={p.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        disabled={!ready}
                        onClick={() => {
                          onChange(p.id, p.defaultModel)
                          setOpen(false)
                        }}
                        style={{
                          textAlign: 'left',
                          padding: '8px 12px',
                          border: 'none',
                          borderBottom: 'var(--border-width) solid var(--border)',
                          background: selected ? 'var(--accent-muted)' : 'transparent',
                          color: ready ? 'var(--text-primary)' : 'var(--text-dim)',
                          fontFamily: 'JetBrains Mono, monospace',
                          fontSize: 11,
                          cursor: ready ? 'pointer' : 'not-allowed',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 4,
                          width: '100%',
                        }}
                      >
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontWeight: selected ? 700 : 500 }}>
                          <ProviderIcon providerId={p.id} size={14} />
                          {p.label}{!ready && ` ${t('provider.needsKey')}`}
                          {/* NO KEY marks the rows a newcomer can use this
                              second. Derived from the absence of a keychainId,
                              which is what "keyless" means in the registry. */}
                          {!p.requiresKey && (
                            <span style={{
                              padding: '0 3px',
                              border: 'var(--border-width) solid var(--success)',
                              color: 'var(--success)',
                              fontSize: 8, fontWeight: 700, letterSpacing: '0.04em',
                              textTransform: 'uppercase', lineHeight: 1.5, whiteSpace: 'nowrap',
                            }}>{t('provider.noKeyBadge')}</span>
                          )}
                          <HealthDot providerId={p.id} health={healthFor(p.id)} />
                          {p.custom
                            ? <LocalityChip egress={p.egress ?? 'cloud'} />
                            : <EgressChip providerId={p.id} />}
                        </span>
                        {p.hint && (
                          <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>
                            {p.hint}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
