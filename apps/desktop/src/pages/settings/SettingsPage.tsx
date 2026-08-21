import React, { useState, useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useConfirm } from '../../components/ConfirmProvider'
import { ProvidersCard } from '../status/ProvidersCard'
import { useThemeStore } from '../../store/theme.store'
import type { Theme } from '../../store/theme.store'
import { collectRootVariables, extractTheme, type ExtractedTheme } from '@tachi/core/src/design/theme-extract'
import { validateThemeCss, type ThemeValidation } from '@tachi/core/src/design/theme-validate'
import { MCPServersSection } from './MCPServersSection'
import { ConnectorsSection } from './ConnectorsSection'
import { MemorySection } from './MemorySection'
import { RouterSection } from './RouterSection'
import { PrivacySection } from './PrivacySection'
import { ContextRecallSection } from './ContextRecallSection'
import { LocalEngineSection } from './LocalEngineSection'
import { DeleteAllDataSection } from './DeleteAllDataSection'
import { BackupSection } from './BackupSection'
import { WhisperSection } from './WhisperSection'
import { ModelStorageSection } from './ModelStorageSection'
import { SchedulerSection } from './SchedulerSection'
import { ShortcutsSection } from './ShortcutsSection'
import { FusionSection } from './FusionSection'
import { SkillsCard } from './SkillsCard'
import { CustomEndpointsCard } from './CustomEndpointsCard'
import { Section } from '../../components/ui/Section'
import { SettingsCard } from '../../components/ui/SettingsCard'
import { ConnectionsRail, type RailSectionId } from './ConnectionsRail'
import { Switch } from '../../components/Switch'
import { CivitaiAdultDialog } from '../../components/CivitaiAdultDialog'
import {
  civitaiAdultStatus,
  civitaiAdultLockPatch,
  formatCivitaiAcceptedAt,
  type CivitaiAdultState,
} from '../../components/civitaiAdultPolicy'

// ── Web Search Card ───────────────────────────────────────────────────────────

const WEB_SEARCH_KEY_PROVIDERS = [
  { id: 'brave-search', label: 'Brave',  hintKey: 'webSearch.braveHint',  placeholder: 'BSA-...',  url: 'https://api.search.brave.com/app/keys', host: 'api.search.brave.com' },
  { id: 'tavily',       label: 'Tavily', hintKey: 'webSearch.tavilyHint', placeholder: 'tvly-...', url: 'https://app.tavily.com/home',           host: 'app.tavily.com' },
] as const

function WebSearchProviderRow({ provider, hasKey, onChanged }: {
  provider: typeof WEB_SEARCH_KEY_PROVIDERS[number]
  hasKey: boolean
  onChanged: () => void
}) {
  const { t } = useTranslation('settings')
  const [key, setKey]       = React.useState('')
  const [saving, setSaving] = React.useState(false)

  const save = async () => {
    if (!key.trim()) return
    setSaving(true)
    try {
      await window.tachi.settings.saveKey(provider.id, key.trim())
      setKey('')
      onChanged()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
        <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{provider.label}</span>
        {' — '}{t(provider.hintKey)}{' '}
        <a
          href="#"
          onClick={(e) => { e.preventDefault(); window.tachi.shell.openExternal(provider.url) }}
          style={{ color: 'var(--accent)' }}
        >
          {provider.host}
        </a>
      </div>
      {hasKey ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 10, color: 'var(--success, var(--accent))' }}>{t('webSearch.keySet')}</span>
          <button
            onClick={async () => { await window.tachi.settings.deleteKey(provider.id); onChanged() }}
            style={{
              fontSize: 9, padding: '4px 10px',
              border: 'var(--border-width) solid var(--destructive)',
              background: 'transparent', color: 'var(--destructive)',
              cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace',
            }}
          >{t('webSearch.removeKey')}</button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="password"
            value={key}
            onChange={e => setKey(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && save()}
            placeholder={provider.placeholder}
            data-testid={`websearch-key-${provider.id}`}
            style={{
              flex: 1, padding: '5px 8px', fontSize: 10,
              border: 'var(--border-width) solid var(--border)',
              background: 'var(--bg-base)', color: 'var(--text-primary)',
              fontFamily: 'JetBrains Mono, monospace',
            }}
          />
          <button
            onClick={save}
            disabled={!key.trim() || saving}
            style={{
              fontSize: 9, fontWeight: 700, padding: '5px 12px',
              border: 'var(--border-width) solid var(--border)',
              background: 'var(--accent)', color: '#fff',
              boxShadow: 'var(--shadow-hard)', cursor: 'pointer',
              fontFamily: 'JetBrains Mono, monospace',
              textTransform: 'uppercase', letterSpacing: '0.08em',
              opacity: key.trim() && !saving ? 1 : 0.5,
            }}
          >{saving ? '…' : t('webSearch.save')}</button>
        </div>
      )}
    </div>
  )
}

function WebSearchCard() {
  const { t } = useTranslation('settings')
  const [keys, setKeys]       = React.useState<string[]>([])
  const [enabled, setEnabled] = React.useState(false)
  const [refresh, setRefresh] = React.useState(0)

  React.useEffect(() => {
    window.tachi.settings.listKeys().then((ids: string[]) => setKeys(ids))
    window.tachi.settings.load().then((s) => setEnabled(!!s.webSearchEnabled))
  }, [refresh])

  const hasAnyKey = WEB_SEARCH_KEY_PROVIDERS.some(p => keys.includes(p.id))

  const toggle = async (v: boolean) => {
    setEnabled(v)
    await window.tachi.settings.save({ webSearchEnabled: v } as Parameters<typeof window.tachi.settings.save>[0])
  }

  const onChanged = async () => {
    const ids: string[] = await window.tachi.settings.listKeys()
    const stillHasKey = WEB_SEARCH_KEY_PROVIDERS.some(p => ids.includes(p.id))
    if (!stillHasKey && enabled) await toggle(false)
    setRefresh(r => r + 1)
  }

  return (
    <div style={{
      border: 'var(--border-width) solid var(--border)',
      background: 'var(--bg-elevated)',
      boxShadow: 'var(--shadow-hard)',
      padding: 12,
      fontFamily: 'JetBrains Mono, monospace',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6, color: 'var(--text-primary)' }}>
        {t('webSearch.title')}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 10 }}>
        {t('webSearch.intro')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {WEB_SEARCH_KEY_PROVIDERS.map(p => (
          <WebSearchProviderRow key={p.id} provider={p} hasKey={keys.includes(p.id)} onChanged={onChanged} />
        ))}
        {hasAnyKey && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', fontSize: 10 }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={e => toggle(e.target.checked)}
            />
            {t('webSearch.enable')}
          </label>
        )}
      </div>
    </div>
  )
}

// ── The key cards' shared replace path ───────────────────────────────────────
//
// ONE credential, TWO ways in: the empty state, and — since 2026-08-01 —
// REPLACING a key that is already stored. Rotation was the case these cards
// could not do at all: with a key saved they rendered only "✓ stored" and
// "Remove", so a user whose key had been rotated or revoked upstream had to
// DESTROY the working credential before they could paste its successor. If the
// new one then turned out to be bad they were left with nothing, having thrown
// away a secret the app cannot recover. It also made the validate-before-save
// rule pointless in exactly the case that needed it most: the validator could
// only protect a paste that had nothing to lose.
//
// THE ORDERING RULE, and it is the entire reason this lives in one function:
// the new value is validated while the OLD one is still the stored key, and a
// REJECTED value never reaches saveKey. Note what is NOT a parameter here —
// there is no delete. This function CANNOT remove-then-add, so no later
// refactor can open a window where neither key is stored. saveKey overwrites in
// place, and that single write is the only transition.
//
// ── AND THE HAZARD THAT RULE CREATED, closed 2026-08-01 ──────────────────────
//
// Until today this function blocked the save on EVERY failure. That is right
// for one of them and dangerous for the rest:
//
//   REJECTED   the provider answered, about the credential: "I do not accept
//              this". Never store it — unchanged, this is the whole feature.
//   UNVERIFIED we could not ask. Offline laptop, provider outage, timeout, a
//              402 payment challenge, an unparseable answer. We learned NOTHING
//              about the key — and refusing the save on that basis strands a
//              perfectly good credential the user cannot store at all, while
//              telling them it is bad. So: STORE IT, and say plainly on screen
//              that it was saved without being checked.
//
// A failure with no verdict at all is treated as UNVERIFIED, deliberately: only
// an AFFIRMATIVE rejection may cost the user a save. The vocabulary and the
// HTTP→verdict rule live in electron/services/provider-key-probe.ts, which all
// six validators import; this function only acts on the answer.
//
// UNVERIFIED STILL CANNOT LOSE A KEY. There is one write, it is an overwrite in
// place, and nothing is ever removed first — the same property that already
// made a rejection safe.

type KeyCardProbe = { ok: boolean; verdict?: 'rejected' | 'unverified'; status?: number }

/**
 * Validate `value`, then store it unless the provider REJECTED it.
 *
 * `stored: false` means NOTHING WAS WRITTEN — whatever was in the keychain
 * before this call is still there and still in force. `stored: true` with a
 * failed `probe` is the unverified case: the key IS now stored, and the card
 * must say it could not be checked. `probe` is the validator's answer verbatim.
 */
export async function validateThenStoreKey<P extends KeyCardProbe>(deps: {
  value: string
  validate: (value: string) => Promise<P>
  save: (value: string) => Promise<unknown>
}): Promise<{ stored: boolean; probe: P | null }> {
  const value = deps.value.trim()
  if (!value) return { stored: false, probe: null }

  // 1. ASK FIRST. The stored key is untouched here, and stays untouched on
  //    every path that leaves this block.
  let probe: P
  try {
    probe = await deps.validate(value)
  } catch {
    // A transport/IPC failure is "we could not ask", not "the key is bad" — and
    // an escaping throw used to leave the card silent instead of saying so.
    probe = { ok: false, verdict: 'unverified' } as unknown as P
  }
  // 2. THE ONLY THING THAT BLOCKS A WRITE is the provider affirmatively saying
  //    the credential is invalid.
  if (!probe.ok && probe.verdict === 'rejected') return { stored: false, probe }

  // 3. ONLY NOW, and only ever as an overwrite-in-place.
  await deps.save(value)
  return { stored: true, probe }
}

/**
 * Which of the three things a probe line is saying — so no card has to
 * re-derive it, and none of them can colour an unverified save like a success
 * or like a rejection.
 */
export function keyProbeTone(probe: KeyCardProbe | null | undefined): 'ok' | 'rejected' | 'unverified' {
  if (!probe) return 'unverified'
  if (probe.ok) return 'ok'
  return probe.verdict === 'rejected' ? 'rejected' : 'unverified'
}

/**
 * THREE OUTCOMES, THREE COLOURS. The unverified line must not read as a green
 * tick (nothing was checked) and must not read as a red rejection (nothing was
 * refused) — it is a warning about what we do not know.
 */
const KEY_PROBE_COLOR: Record<'ok' | 'rejected' | 'unverified', string> = {
  ok:         'var(--success, var(--accent))',
  rejected:   'var(--destructive)',
  unverified: 'var(--warning, var(--text-primary))',
}

/**
 * Backing out of a replace. Returns the card to its stored state and DROPS the
 * typed value — a half-typed secret must not sit in a mounted input waiting to
 * be submitted by the next stray Enter.
 *
 * `setProbe` is OPTIONAL because ONE of the seven key cards has no probe to
 * clear: OpenGateway exposes no endpoint that can tell a bad key from no key
 * (measured — see that card), so it renders no probe line at all. It still
 * shares this reset, so there is exactly ONE definition of what backing out
 * means.
 *
 * `setValue` and `setReplacing` are NOT optional, because dropping the typed
 * secret is the part that matters.
 */
export function cancelKeyReplace(reset: {
  setValue: (value: string) => void
  setProbe?: (probe: null) => void
  setReplacing: (replacing: boolean) => void
  /** Second field, imgnAI only (key + secret). Cleared with the first. */
  setSecondValue?: (value: string) => void
}): void {
  reset.setReplacing(false)
  reset.setValue('')
  reset.setSecondValue?.('')
  reset.setProbe?.(null)
}

/**
 * The secondary control on a key card (Replace / Cancel). Neutral on purpose:
 * Save owns the accent, Remove owns the destructive red, and neither of these
 * two is either of those things.
 */
const KEY_CARD_SECONDARY_BTN: React.CSSProperties = {
  fontSize: 9, padding: '4px 10px',
  border: 'var(--border-width) solid var(--border)',
  background: 'transparent', color: 'var(--text-primary)',
  cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace',
}

/** The line under a revealed input explaining that the old key still holds. */
const KEY_CARD_REPLACE_HINT: React.CSSProperties = {
  fontSize: 9, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.45,
}

// ── AND THE FIVE PROVIDER CARDS BELOW, where the hint is not the same hint ───
//
// Every key card in this file offers Replace. SIX of the seven can now offer
// validate-before-store; pretending the seventh can is the specific harm this
// comment exists to prevent: a green tick on a garbage key is worse than no
// tick, because the user stops looking for the real problem.
//
// Measured 2026-08-01 with no-header, an obviously fake bearer and a
// plausibly-shaped fake — never with a real key. Full status tables live in
// electron/services/provider-key-probe.ts; the verdicts:
//
//   civitai      ✅ GET /api/v1/me            → names the account
//   huggingface  ✅ GET /api/whoami-v2        → names the account
//   bankr        ✅ GET /v1/credits           → 401 "API key required" with no
//                   header, 401 "Invalid or inactive API key" with a fake one;
//                   200 carries the wallet's USD credit. Free, documented.
//   imgnai       ✅ GET /v1/me/balance        → 401 "Missing API credentials"
//                   for a lone half, 401 "Invalid API credentials" for a fake
//                   pair. Judges BOTH fields, which no other free endpoint does.
//   venice       ✅ GET /api/v1/api_keys/rate_limits — the inference surface is
//                   all public, but this account read is not: no header → 402
//                   x402 challenge, fake bearer → 401. 200 carries tier and
//                   balance; 403 is Venice's DOCUMENTED code for a valid key
//                   without rights, so it counts as accepted-but-limited.
//                   ITS 401 IS NOT FINAL — see the Venice card.
//   surplus      ✅ POST /anthropic/v1/messages/count_tokens — reads the buyer
//                   key and runs NO inference ("a heuristic estimate (no
//                   upstream round-trip)"), so nothing is spent and nothing
//                   settles. 401 for a fake inf_ key, 200 → an estimate.
//   opengateway  ❌ /v1/models answers 200 to any string INCLUDING no header;
//                   every other path 404s with "Use POST /v1/chat/completions".
//                   The only key-reading endpoint is the PAID completion, and
//                   there is no docs site, OpenAPI or llms.txt to overturn that.
//
// So the one ❌ card gets the replace path WITHOUT a validator, and its hint
// (`keyCard.replaceHintPlain`) says out loud that saving overwrites immediately
// and nothing was checked. A plain overwrite is still strictly better than the
// Remove-then-paste it replaces — the old key is never destroyed on its own.
//
// EVERY validated card renders THREE outcomes, never two: accepted, rejected
// (nothing stored), and saved-but-unchecked. The third is the one that used to
// be a lie — see `validateThenStoreKey` above.

const OPENGATEWAY_KEY_ID = 'opengateway'
const VENICE_KEY_ID      = 'venice'
const IMGNAI_KEY_ID      = 'imgnai'
const BANKR_KEY_ID       = 'bankr-gateway'
const SURPLUS_KEY_ID     = 'surplus'

// ── Civitai Card ──────────────────────────────────────────────────────────────
//
// Civitai is a WEIGHTS SOURCE, not an inference provider — it has no row in the
// provider registry, which is exactly why its keychain id had to be listed in
// settings.ipc.ts's NON_PROVIDER_KEY_IDS alongside brave-search/tavily. Without
// that line `settings:list-keys` would never report it and this card could
// never show "key stored", however well the key saved (the shipped imgnai bug,
// recorded in that file's own comment).
//
// It lives next to the web-search keys and NOT in the Providers rail: putting a
// weights host among the inference providers would imply you can chat with it.
//
// THE HONEST HINT: browsing and the overwhelming majority of downloads need NO
// key at all (live probes returned unauthenticated 307s even for adult-flagged
// models). The key buys account-gated downloads — the versions whose documented
// `requireAuth` is true — and NOT higher rate limits: that claim was in this
// card's hint until 2026-08-01 and it is uncited, because
// <https://developer.civitai.com/site/guide/errors.md> publishes no rate-limit
// contract and no authenticated tier (the same correction civitaiAuthHeaders
// carries). Saying "required" would be a lie that costs the user a signup they
// do not need.
//
// AND THE KEY IS VALIDATED BEFORE IT IS STORED. See `save` below: Civitai's
// public endpoints answer 200 to a garbage bearer, so the card asks
// /api/v1/me over IPC and refuses to keep a key Civitai rejects.
//
// ─── AND THE 18+ SECTION UNDER IT ────────────────────────────────────────────
// The two sit in ONE card because they are one decision: the key is half of the
// 18+ unlock, and removing it silently returns browsing to SFW. Separating them
// would put the cause on one screen and the effect on another. The switch here
// does NOT write the setting — it opens CivitaiAdultDialog, which is the only
// control in the app that can turn adult browsing on. Turning it OFF is
// immediate and needs no dialog (and resets the timestamp, so re-enabling
// always goes back through the affirmation).

const CIVITAI_KEY_ID = 'civitai'

function CivitaiCard() {
  const { t, i18n } = useTranslation('settings')
  const [key, setKey]             = React.useState('')
  const [saving, setSaving]       = React.useState(false)
  const [hasStored, setHasStored] = React.useState(false)
  const [refresh, setRefresh]     = React.useState(0)
  // Rotation: reveals the SAME input the empty state uses, over the same `key`
  // state. Two inputs would be two things to drift apart and two places a
  // secret could be left mounted.
  const [replacing, setReplacing] = React.useState(false)
  // MAIN's answer, never recomputed here: `unlocked` folds in a keychain read
  // the renderer cannot make.
  const [adult, setAdult]         = React.useState<CivitaiAdultState | null>(null)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const adultTitleId = React.useId()
  // The validation ping's answer: the account the key belongs to, or the honest
  // failure. Null = not asked yet. Same shape as the HuggingFace card.
  const [probe, setProbe] = React.useState<
    { ok: boolean; username?: string; verdict?: 'rejected' | 'unverified'; status?: number } | null
  >(null)

  React.useEffect(() => {
    window.tachi.settings.listKeys().then((ids: string[]) => setHasStored(ids.includes(CIVITAI_KEY_ID)))
    // Re-read on EVERY refresh, including after a key is removed — that is the
    // moment a lit switch would otherwise start lying.
    window.tachi.civitai.adultState().then(setAdult).catch(() => setAdult(null))
  }, [refresh])

  // VALIDATE THE TYPED KEY, THEN SAVE — the HuggingFace card's rule, applied to
  // the credential that needed it more. Civitai's public endpoints answer 200 to
  // a garbage bearer (measured 2026-08-01, table in validateCivitaiKey), so a
  // typo used to sail into the keychain and resurface hours later as "Civitai
  // rejected the stored API key for this download (401)". `/api/v1/me` is the one
  // endpoint that reacts to the caller, and it answers with the ACCOUNT NAME —
  // which is what the user can actually check, "valid" being a claim they cannot.
  // A rejected key is NOT stored.
  // ONE handler for both ways in — the empty state and a replace run the exact
  // same sequence, so the validate-before-store rule cannot hold on one path and
  // lapse on the other.
  const save = async () => {
    if (!key.trim()) return
    setSaving(true)
    setProbe(null)
    try {
      const res = await validateThenStoreKey({
        value: key,
        validate: (v) => window.tachi.civitai.validateKey(v),
        save:     (v) => window.tachi.settings.saveKey(CIVITAI_KEY_ID, v),
      })
      setProbe(res.probe)
      // NOT STORED = Civitai rejected it. The previous key is still stored and
      // still in force — the copy below says so, because a user looking at a red
      // line needs to know whether they still have a key. An UNVERIFIED answer
      // does not land here: the key was written, and the card closes as usual
      // while the probe line explains that nothing could be checked.
      if (!res.stored) return
      setKey('')
      setReplacing(false)
      setRefresh(r => r + 1)
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    await window.tachi.settings.deleteKey(CIVITAI_KEY_ID)
    // Remove does exactly what it always did. This only closes an OPEN replace:
    // there is no longer a stored key for the hint to be promising about, and a
    // half-typed value must not outlive the credential it was meant to succeed.
    cancelKeyReplace({ setValue: setKey, setProbe, setReplacing })
    // The refresh re-reads adultState too, so the 18+ line immediately says
    // "no key stored — browsing stays SFW" instead of staying lit.
    setRefresh(r => r + 1)
  }

  const startReplace = () => { setProbe(null); setReplacing(true) }
  const cancelReplace = () => cancelKeyReplace({ setValue: setKey, setProbe, setReplacing })

  // OFF is immediate and dialog-free; ON always goes through the affirmation.
  const toggleAdult = async (next: boolean) => {
    if (next) { setDialogOpen(true); return }
    try { await window.tachi.settings.save(civitaiAdultLockPatch()) } finally { setRefresh(r => r + 1) }
  }

  const status = civitaiAdultStatus(adult)
  const acceptedAt = formatCivitaiAcceptedAt(adult?.acceptedAt, i18n.language)

  return (
    <div style={{
      border: 'var(--border-width) solid var(--border)',
      background: 'var(--bg-elevated)',
      boxShadow: 'var(--shadow-hard)',
      padding: 12,
      fontFamily: 'JetBrains Mono, monospace',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6, color: 'var(--text-primary)' }}>
        {t('civitai.title')}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 10 }}>
        {t('civitai.hint')}{' '}
        <a
          href="#"
          onClick={(e) => { e.preventDefault(); window.tachi.shell.openExternal('https://civitai.com/user/account') }}
          style={{ color: 'var(--accent)' }}
        >
          civitai.com/user/account
        </a>
      </div>
      {/* STORED. The ✓ stays on screen THROUGH a replace: the one thing a user
          mid-rotation needs to know is that they still have a working key. */}
      {hasStored ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, color: 'var(--success, var(--accent))' }}>{t('civitai.keySet')}</span>
          {!replacing && (
            <button
              onClick={startReplace}
              data-testid="civitai-replace"
              style={KEY_CARD_SECONDARY_BTN}
            >{t('civitai.replaceKey')}</button>
          )}
          <button
            onClick={remove}
            style={{
              fontSize: 9, padding: '4px 10px',
              border: 'var(--border-width) solid var(--destructive)',
              background: 'transparent', color: 'var(--destructive)',
              cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace',
            }}
          >{t('civitai.removeKey')}</button>
        </div>
      ) : null}

      {/* THE INPUT — one element, one piece of state, both ways in. */}
      {(!hasStored || replacing) && (
        <div style={{ display: 'flex', gap: 6, marginTop: hasStored ? 8 : 0 }}>
          <input
            type="password"
            value={key}
            onChange={e => setKey(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && save()}
            placeholder={t('civitai.placeholder')}
            data-testid="civitai-key"
            style={{
              flex: 1, padding: '5px 8px', fontSize: 10,
              border: 'var(--border-width) solid var(--border)',
              background: 'var(--bg-base)', color: 'var(--text-primary)',
              fontFamily: 'JetBrains Mono, monospace',
            }}
          />
          <button
            onClick={save}
            disabled={!key.trim() || saving}
            style={{
              fontSize: 9, fontWeight: 700, padding: '5px 12px',
              border: 'var(--border-width) solid var(--border)',
              background: 'var(--accent)', color: '#fff',
              boxShadow: 'var(--shadow-hard)', cursor: 'pointer',
              fontFamily: 'JetBrains Mono, monospace',
              textTransform: 'uppercase', letterSpacing: '0.08em',
              opacity: key.trim() && !saving ? 1 : 0.5,
            }}
          >{saving ? '…' : t('civitai.save')}</button>
          {replacing && (
            <button
              onClick={cancelReplace}
              data-testid="civitai-cancel-replace"
              style={KEY_CARD_SECONDARY_BTN}
            >{t('civitai.cancelReplace')}</button>
          )}
        </div>
      )}

      {/* Why it is safe to be standing here with a half-typed secret: the key
          Civitai is currently answering to has not been touched. */}
      {replacing && (
        <div data-testid="civitai-replace-hint" style={KEY_CARD_REPLACE_HINT}>
          {t('civitai.replaceHint')}
        </div>
      )}

      {/* The ping's answer, in THREE outcomes. Naming the ACCOUNT is the point:
          it proves the key is live AND that it is the one the user meant to
          paste. `verdict === 'rejected'` is Civitai saying no, and nothing was
          stored — when a key WAS already stored the copy says so out loud,
          because "nothing changed" is the fact the user needs and cannot
          otherwise see. UNVERIFIED is the third: we could not ask, so the key
          WAS saved and the line says exactly that instead of accusing it. */}
      {probe && (
        <div
          data-testid="civitai-probe"
          style={{
            fontSize: 10, marginTop: 8, lineHeight: 1.45,
            color: KEY_PROBE_COLOR[keyProbeTone(probe)],
          }}
        >
          {probe.ok
            ? t('civitai.probeOk', { username: probe.username || '?' })
            : probe.verdict === 'rejected'
              ? t(hasStored ? 'civitai.probeRejectedKept' : 'civitai.probeRejected')
              : t('civitai.probeUnverified')}
        </div>
      )}

      {/* ── 18+ ────────────────────────────────────────────────────────────── */}
      <div style={{
        marginTop: 12, paddingTop: 10,
        borderTop: 'var(--border-width) solid var(--border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div
              id={adultTitleId}
              style={{
                fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: '0.08em', color: 'var(--text-primary)',
              }}
            >
              {t('civitai.adult.title')}
            </div>
            <div
              data-testid="civitai-adult-status"
              style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.45 }}
            >
              {t(`civitai.adult.status.${status}`)}
              {status === 'unlocked' && acceptedAt
                ? ` · ${t('civitai.adult.confirmedOn', { date: acceptedAt })}`
                : ''}
            </div>
          </div>
          {/* aria-checked follows MAIN's `unlocked`, not the raw setting — the
              switch reports the state the app is actually in. */}
          <Switch
            checked={status === 'unlocked'}
            onChange={v => { void toggleAdult(v) }}
            onLabel={t('civitai.adult.on')}
            offLabel={t('civitai.adult.off')}
            labelledBy={adultTitleId}
          />
        </div>
      </div>

      {dialogOpen && (
        <CivitaiAdultDialog
          hasKey={hasStored}
          onCancel={() => setDialogOpen(false)}
          onConfirmed={() => { setDialogOpen(false); setRefresh(r => r + 1) }}
        />
      )}
    </div>
  )
}

// ── HuggingFace Card ──────────────────────────────────────────────────────────
//
// The SECOND weights-host credential, built to the Civitai card's shape on
// purpose — same keychain plumbing, same masked input, same Remove control —
// because two credentials that behave differently is how one of them gets
// mishandled.
//
// WHAT IT BUYS, stated honestly and no more: HF search and public downloads
// work with NO token at all. A token raises the anonymous rate limit and lets
// downloads reach repos THIS USER has personally accepted the terms for
// (Llama, Gemma, FLUX-dev …). It is not a login and it unlocks nothing the
// user has not already agreed to on huggingface.co.
//
// WHERE IT GOES — and this is the load-bearing half:
//   • huggingface.co/api/…        yes (search, whoami)
//   • huggingface.co/…/resolve/…  yes, on the FIRST hop only
//   • the CDN that hop redirects to   NEVER. Measured 2026-07-31: a resolve URL
//     302s to `us.aws.cdn.hf.co` with a CloudFront presign (Policy + Signature
//     + Key-Pair-Id). The presign IS the authentication there; a Bearer would
//     be pure leakage to a host we do not control. download-manager's host
//     table decides where it is attached and installer-kit's same-origin guard
//     drops it on every cross-origin hop — the same two-line defence the
//     Civitai key has.
//   • disk                        NEVER. downloads.json is plaintext under
//     userData; the token lives in the DPAPI-encrypted keychain and is
//     re-attached per download run.

const HF_KEY_ID = 'huggingface'

function HuggingFaceCard() {
  const { t } = useTranslation('settings')
  const [key, setKey]             = React.useState('')
  const [saving, setSaving]       = React.useState(false)
  const [hasStored, setHasStored] = React.useState(false)
  const [refresh, setRefresh]     = React.useState(0)
  // Rotation, same as the Civitai card: reveals the SAME input the empty state
  // uses, over the same `key` state.
  const [replacing, setReplacing] = React.useState(false)
  // The validation ping's answer: the username the token belongs to, or the
  // honest failure. Null = not asked yet.
  const [probe, setProbe] = React.useState<
    { ok: boolean; name?: string; verdict?: 'rejected' | 'unverified'; status?: number } | null
  >(null)

  React.useEffect(() => {
    window.tachi.settings.listKeys()
      .then((ids: string[]) => setHasStored(ids.includes(HF_KEY_ID)))
      .catch(() => setHasStored(false))
  }, [refresh])

  // VALIDATE THE TYPED TOKEN, THEN SAVE. Pinging after the save would report
  // success for a token we already committed; pinging the stored copy would
  // report on the one being replaced. A rejected token is NOT saved — silently
  // storing a dead credential is how "downloads still 401" becomes unexplainable.
  // ONE handler for both ways in: the empty state and a replace.
  const save = async () => {
    if (!key.trim()) return
    setSaving(true)
    setProbe(null)
    try {
      const res = await validateThenStoreKey({
        value: key,
        validate: (v) => window.tachi.hf.validateToken(v),
        save:     (v) => window.tachi.settings.saveKey(HF_KEY_ID, v),
      })
      setProbe(res.probe)
      // NOT STORED = HuggingFace rejected it; on a replace the previous token is
      // still stored and still in force, and the copy below says so. An
      // UNVERIFIED answer stores the token and explains it was not checked.
      if (!res.stored) return
      setKey('')
      setReplacing(false)
      setRefresh(r => r + 1)
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    await window.tachi.settings.deleteKey(HF_KEY_ID)
    // As in the Civitai card: unchanged behaviour, plus it closes an open
    // replace so no hint keeps promising a stored token that is now gone.
    cancelKeyReplace({ setValue: setKey, setProbe, setReplacing })
    setRefresh(r => r + 1)
  }

  const startReplace = () => { setProbe(null); setReplacing(true) }
  const cancelReplace = () => cancelKeyReplace({ setValue: setKey, setProbe, setReplacing })

  return (
    <div style={{
      border: 'var(--border-width) solid var(--border)',
      background: 'var(--bg-elevated)',
      boxShadow: 'var(--shadow-hard)',
      padding: 12,
      fontFamily: 'JetBrains Mono, monospace',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6, color: 'var(--text-primary)' }}>
        {t('huggingface.title')}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.5 }}>
        {t('huggingface.hint')}{' '}
        <a
          href="#"
          onClick={(e) => { e.preventDefault(); window.tachi.shell.openExternal('https://huggingface.co/settings/tokens') }}
          style={{ color: 'var(--accent)' }}
        >
          huggingface.co/settings/tokens
        </a>
      </div>
      {/* STORED. The ✓ stays on screen THROUGH a replace — see the Civitai card. */}
      {hasStored ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, color: 'var(--success, var(--accent))' }}>{t('huggingface.keySet')}</span>
          {!replacing && (
            <button
              onClick={startReplace}
              data-testid="huggingface-replace"
              style={KEY_CARD_SECONDARY_BTN}
            >{t('huggingface.replaceKey')}</button>
          )}
          <button
            onClick={remove}
            style={{
              fontSize: 9, padding: '4px 10px',
              border: 'var(--border-width) solid var(--destructive)',
              background: 'transparent', color: 'var(--destructive)',
              cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace',
            }}
          >{t('huggingface.removeKey')}</button>
        </div>
      ) : null}

      {/* THE INPUT — one element, one piece of state, both ways in. */}
      {(!hasStored || replacing) && (
        <div style={{ display: 'flex', gap: 6, marginTop: hasStored ? 8 : 0 }}>
          <input
            type="password"
            value={key}
            onChange={e => setKey(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && save()}
            placeholder={t('huggingface.placeholder')}
            data-testid="huggingface-key"
            style={{
              flex: 1, padding: '5px 8px', fontSize: 10,
              border: 'var(--border-width) solid var(--border)',
              background: 'var(--bg-base)', color: 'var(--text-primary)',
              fontFamily: 'JetBrains Mono, monospace',
            }}
          />
          <button
            onClick={save}
            disabled={!key.trim() || saving}
            style={{
              fontSize: 9, fontWeight: 700, padding: '5px 12px',
              border: 'var(--border-width) solid var(--border)',
              background: 'var(--accent)', color: '#fff',
              boxShadow: 'var(--shadow-hard)', cursor: 'pointer',
              fontFamily: 'JetBrains Mono, monospace',
              textTransform: 'uppercase', letterSpacing: '0.08em',
              opacity: key.trim() && !saving ? 1 : 0.5,
            }}
          >{saving ? '…' : t('huggingface.save')}</button>
          {replacing && (
            <button
              onClick={cancelReplace}
              data-testid="huggingface-cancel-replace"
              style={KEY_CARD_SECONDARY_BTN}
            >{t('huggingface.cancelReplace')}</button>
          )}
        </div>
      )}

      {/* The token HuggingFace is currently answering to has not been touched. */}
      {replacing && (
        <div data-testid="huggingface-replace-hint" style={KEY_CARD_REPLACE_HINT}>
          {t('huggingface.replaceHint')}
        </div>
      )}

      {/* The ping's answer, in THREE outcomes. Naming the ACCOUNT is the point:
          it proves the token is live AND that it is the one the user meant to
          paste. With a token already stored, the REJECTED copy states that
          nothing changed; UNVERIFIED means the token was saved unchecked. */}
      {probe && (
        <div
          data-testid="huggingface-probe"
          style={{
            fontSize: 10, marginTop: 8, lineHeight: 1.45,
            color: KEY_PROBE_COLOR[keyProbeTone(probe)],
          }}
        >
          {probe.ok
            ? t('huggingface.probeOk', { name: probe.name ?? '?' })
            : probe.verdict === 'rejected'
              ? t(hasStored ? 'huggingface.probeRejectedKept' : 'huggingface.probeRejected')
              : t('huggingface.probeUnverified')}
        </div>
      )}
    </div>
  )
}

// ── OpenGateway Card ──────────────────────────────────────────────────────────
//
// REPLACE: yes. VALIDATE: no, and it is measured, not skipped.
// `GET /v1/models` returns the identical catalogue for no header, for `Bearer
// nope` and for a plausibly-shaped `ogw_live_…` fake; every other path answers
// 404 "Not found. Use POST /v1/chat/completions." The only endpoint that reads
// the key is the pay-as-you-go completion, so a validator here would spend the
// user's money on every paste — and the free-model list it could aim at has
// already drifted once (MiMo went paid 2026-07-16). A format check would prove
// nothing at all, so there is none.

function OpenGatewayCard() {
  const { t } = useTranslation('settings')
  const [key, setKey]           = React.useState('')
  const [saved, setSaved]       = React.useState(false)
  const [hasStored, setHasStored] = React.useState(false)
  // Rotation. The same input, the same `key` state, both ways in — see "The key
  // cards' shared replace path" above.
  const [replacing, setReplacing] = React.useState(false)

  React.useEffect(() => {
    window.tachi.settings.listKeys().then((ids: string[]) => {
      setHasStored(ids.includes(OPENGATEWAY_KEY_ID))
    })
  }, [saved])

  // ONE handler for both ways in — the empty state and a replace — so the two
  // paths cannot drift. There is nothing to validate first (see above), so this
  // is a single overwrite-in-place: the previous key is never deleted, and the
  // hint on screen says plainly that nothing was checked.
  const save = async () => {
    if (!key.trim()) return
    await window.tachi.settings.saveKey(OPENGATEWAY_KEY_ID, key.trim())
    setKey('')
    setReplacing(false)
    setSaved(s => !s)
  }

  const remove = async () => {
    await window.tachi.settings.deleteKey(OPENGATEWAY_KEY_ID)
    // Unchanged behaviour, plus it closes an open replace: no hint may keep
    // promising a stored key that is now gone, and a half-typed secret must not
    // outlive the credential it was meant to succeed.
    cancelKeyReplace({ setValue: setKey, setReplacing })
    setSaved(s => !s)
  }

  const startReplace = () => { setReplacing(true) }
  const cancelReplace = () => cancelKeyReplace({ setValue: setKey, setReplacing })

  return (
    <div style={{
      border: 'var(--border-width) solid var(--border)',
      background: 'var(--bg-elevated)',
      boxShadow: 'var(--shadow-hard)',
      padding: 12,
      fontFamily: 'JetBrains Mono, monospace',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8, color: 'var(--text-primary)' }}>
        {t('openGateway.title')}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8 }}>
        {t('openGateway.description')}{' '}
        <a href="#" onClick={(e) => { e.preventDefault(); window.tachi.shell.openExternal('https://gitlawb.com/opengateway') }} style={{ color: 'var(--accent)' }}>
          gitlawb.com/opengateway
        </a>
      </div>
      {/* STORED. The ✓ stays on screen THROUGH a replace — the one thing a user
          mid-rotation needs to know is that they still have a key. */}
      {hasStored ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, color: 'var(--accent)' }}>{t('keyCard.keyStored')}</span>
          {!replacing && (
            <button
              onClick={startReplace}
              data-testid="opengateway-replace"
              style={KEY_CARD_SECONDARY_BTN}
            >{t('keyCard.replace')}</button>
          )}
          <button onClick={remove} style={{
            fontSize: 9, padding: '4px 10px',
            border: 'var(--border-width) solid var(--destructive)',
            background: 'transparent', color: 'var(--destructive)',
            cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace',
          }}>{t('keyCard.remove')}</button>
        </div>
      ) : null}

      {/* THE INPUT — one element, one piece of state, both ways in. */}
      {(!hasStored || replacing) && (
        <div style={{ display: 'flex', gap: 6, marginTop: hasStored ? 8 : 0 }}>
          <input
            type="password" value={key}
            onChange={e => setKey(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && save()}
            placeholder="ogw_live_..."
            data-testid="opengateway-key"
            style={{
              flex: 1, padding: '5px 8px', fontSize: 10,
              border: 'var(--border-width) solid var(--border)',
              background: 'var(--bg-base)', color: 'var(--text-primary)',
              fontFamily: 'JetBrains Mono, monospace',
            }}
          />
          <button onClick={save} disabled={!key.trim()} style={{
            fontSize: 9, fontWeight: 700, padding: '5px 12px',
            border: 'var(--border-width) solid var(--border)',
            background: 'var(--accent)', color: '#fff',
            boxShadow: 'var(--shadow-hard)', cursor: 'pointer',
            fontFamily: 'JetBrains Mono, monospace',
            textTransform: 'uppercase', letterSpacing: '0.08em',
            opacity: key.trim() ? 1 : 0.5,
          }}>{t('keyCard.save')}</button>
          {replacing && (
            <button
              onClick={cancelReplace}
              data-testid="opengateway-cancel-replace"
              style={KEY_CARD_SECONDARY_BTN}
            >{t('keyCard.cancelReplace')}</button>
          )}
        </div>
      )}

      {/* THE HONEST HINT. Not the Civitai one: nothing is checked here, so this
          says the save overwrites straight away. Promising a validation that
          does not exist would be the worse bug. */}
      {replacing && (
        <div data-testid="opengateway-replace-hint" style={KEY_CARD_REPLACE_HINT}>
          {t('keyCard.replaceHintPlain')}
        </div>
      )}
    </div>
  )
}

// ── Venice Card ───────────────────────────────────────────────────────────────
//
// REPLACE: yes. VALIDATE: YES — the refusal shipped an hour ago was overturned
// by Venice's own documentation, and this card is what replaced it.
//
// The premise was right and the conclusion was wrong. Venice's whole INFERENCE
// surface really is public (/models, /models/traits, /compatibility_mapping,
// /image/styles and /crypto/rpc/networks all 200 for a garbage bearer AND for no
// header — the swagger even declares `security: [{}, BearerAuth]` there), and
// Venice really does split key types ("Admin keys have full access to the API
// while inference keys are only able to call inference endpoints"), with their
// key-generation guide telling users to prefer Inference Only. What the refusal
// missed is that <https://docs.venice.ai/api-reference/error-codes> separates
// the two cases a flat "auth error" merges:
//     401 AUTHENTICATION_FAILED  "Authentication failed"   → bad credential
//     403 UNAUTHORIZED           "Unauthorized access"     → VALID key, no rights
//     403 API_ACCESS_DISABLED    "API access has been disabled for this account"
// 403 is their documented answer for a working key that may not do a thing, so
// a scope-limited key is ACCEPTED here, with no balance claimed for it.
//
// The endpoint is GET /api/v1/api_keys/rate_limits — the spec's "Return details
// about user balances and rate limits", carrying no `x-payment-info`, i.e. a
// free metadata read. Measured today: no header → 402 x402 challenge, fake
// bearer → 401 {"error":"Authentication failed"}.
//
// ⚠ AND ITS 401 IS NOT FINAL. Nobody could establish what an INFERENCE-type key
// gets from that path, and Venice's two documents disagree about whether a 401
// is even possible for a live key: the error-code page says an entitled-but-
// unauthorised caller gets 403, while the swagger's per-path response list for
// this endpoint declares only 200/401/500 and no 403 at all. A strict validator
// would therefore risk rejecting a working credential. So a Venice 401 comes
// back UNVERIFIED — the key IS saved, with a line saying Venice answered
// "authentication failed" and what that can mean — instead of a red line
// telling the user their key is bad when we do not know that. The full argument
// and how to close the question live in `validateVeniceKey`
// (electron/services/provider-key-probe.ts).

function VeniceCard() {
  const { t } = useTranslation('settings')
  const [key, setKey]             = React.useState('')
  const [saving, setSaving]       = React.useState(false)
  const [saved, setSaved]         = React.useState(false)
  const [hasStored, setHasStored] = React.useState(false)
  // Rotation, the shared shape.
  const [replacing, setReplacing] = React.useState(false)
  // The rate-limit ping's answer: tier + balance, the scope-limited 403, or the
  // honest failure. Null = not asked yet.
  const [probe, setProbe] = React.useState<{
    ok: boolean
    limited?: boolean
    accessPermitted?: boolean
    tier?: string
    usd?: string
    verdict?: 'rejected' | 'unverified'
    status?: number
  } | null>(null)

  React.useEffect(() => {
    window.tachi.settings.listKeys().then((ids: string[]) => {
      setHasStored(ids.includes(VENICE_KEY_ID))
    })
  }, [saved])

  // VALIDATE THE TYPED KEY, THEN SAVE — one handler for the empty state and for
  // a replace. Venice can never answer `rejected` (see the card comment), so in
  // practice this always stores; it still goes through the shared helper,
  // because the ordering rule must not acquire a second implementation.
  const save = async () => {
    if (!key.trim()) return
    setSaving(true)
    setProbe(null)
    try {
      const res = await validateThenStoreKey({
        value: key,
        validate: (v) => window.tachi.provider.validateVeniceKey(v),
        save:     (v) => window.tachi.settings.saveKey(VENICE_KEY_ID, v),
      })
      setProbe(res.probe)
      if (!res.stored) return
      setKey('')
      setReplacing(false)
      setSaved(s => !s)
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    await window.tachi.settings.deleteKey(VENICE_KEY_ID)
    cancelKeyReplace({ setValue: setKey, setProbe, setReplacing })
    setSaved(s => !s)
  }

  const startReplace = () => { setProbe(null); setReplacing(true) }
  const cancelReplace = () => cancelKeyReplace({ setValue: setKey, setProbe, setReplacing })

  return (
    <div style={{
      border: 'var(--border-width) solid var(--border)',
      background: 'var(--bg-elevated)',
      boxShadow: 'var(--shadow-hard)',
      padding: 12,
      fontFamily: 'JetBrains Mono, monospace',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8, color: 'var(--text-primary)' }}>
        {t('venice.title')}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8 }}>
        {t('venice.description')}{' '}
        <a href="#" onClick={(e) => { e.preventDefault(); window.tachi.shell.openExternal('https://venice.ai/settings/api') }} style={{ color: 'var(--accent)' }}>
          venice.ai/settings/api
        </a>
      </div>
      {/* STORED — the ✓ survives a replace. */}
      {hasStored ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, color: 'var(--accent)' }}>{t('keyCard.keyStored')}</span>
          {!replacing && (
            <button
              onClick={startReplace}
              data-testid="venice-replace"
              style={KEY_CARD_SECONDARY_BTN}
            >{t('keyCard.replace')}</button>
          )}
          <button onClick={remove} style={{
            fontSize: 9, padding: '4px 10px',
            border: 'var(--border-width) solid var(--destructive)',
            background: 'transparent', color: 'var(--destructive)',
            cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace',
          }}>{t('keyCard.remove')}</button>
        </div>
      ) : null}

      {/* THE INPUT — one element, one piece of state, both ways in. */}
      {(!hasStored || replacing) && (
        <div style={{ display: 'flex', gap: 6, marginTop: hasStored ? 8 : 0 }}>
          <input
            type="password" value={key}
            onChange={e => setKey(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && save()}
            placeholder={t('venice.placeholder')}
            data-testid="venice-key"
            style={{
              flex: 1, padding: '5px 8px', fontSize: 10,
              border: 'var(--border-width) solid var(--border)',
              background: 'var(--bg-base)', color: 'var(--text-primary)',
              fontFamily: 'JetBrains Mono, monospace',
            }}
          />
          <button onClick={save} disabled={!key.trim() || saving} style={{
            fontSize: 9, fontWeight: 700, padding: '5px 12px',
            border: 'var(--border-width) solid var(--border)',
            background: 'var(--accent)', color: '#fff',
            boxShadow: 'var(--shadow-hard)', cursor: 'pointer',
            fontFamily: 'JetBrains Mono, monospace',
            textTransform: 'uppercase', letterSpacing: '0.08em',
            opacity: key.trim() && !saving ? 1 : 0.5,
          }}>{saving ? '…' : t('keyCard.save')}</button>
          {replacing && (
            <button
              onClick={cancelReplace}
              data-testid="venice-cancel-replace"
              style={KEY_CARD_SECONDARY_BTN}
            >{t('keyCard.cancelReplace')}</button>
          )}
        </div>
      )}

      {/* The key Venice is currently answering to has not been touched. */}
      {replacing && (
        <div data-testid="venice-replace-hint" style={KEY_CARD_REPLACE_HINT}>
          {t('keyCard.replaceHintChecked')}
        </div>
      )}

      {/* THE PING'S ANSWER — four lines, because Venice has four things to say.
          A 200 names the TIER and the USD balance (checkable facts, the same
          shape the imgnAI card shows) unless `accessPermitted` is false, which
          is the one case a plain tick would hide: authenticated, but not
          allowed to run inference. A 403 is accepted-but-scope-limited and
          claims no balance. A 401 is NOT a rejection here — the key was saved
          and the copy says what Venice's answer can and cannot mean. */}
      {probe && (
        <div
          data-testid="venice-probe"
          style={{
            fontSize: 10, marginTop: 8, lineHeight: 1.45,
            color: KEY_PROBE_COLOR[keyProbeTone(probe)],
          }}
        >
          {probe.ok
            ? probe.limited
              ? t('venice.probeOkLimited')
              : probe.accessPermitted === false
                ? t('venice.probeOkNoAccess', { tier: probe.tier || '?' })
                : t('venice.probeOk', { tier: probe.tier || '?', usd: probe.usd || '0.00' })
            : probe.status === 401
              ? t('venice.probeUnverifiedAuth')
              : t('venice.probeUnverified')}
        </div>
      )}
    </div>
  )
}

// ── imgnAI Katana Card ────────────────────────────────────────────────────────
// TWO fields (API key + API secret). Storage stays ONE combined "key:secret"
// keychain entry under 'imgnai' so every downstream consumer is unchanged:
// text sends it whole as a bearer, the media service splits it on the first ':'.
//
// REPLACE: yes — and because the renderer never sees the stored secret, a
// replace overwrites the WHOLE credential from both fields. There is no merging
// a new key onto the saved secret, and the hint says so rather than letting a
// user assume otherwise and lose half of a working pair.
//
// VALIDATE: yes, WHEN BOTH FIELDS ARE FILLED, and no when only one is.
// `GET /v1/me/balance` is the only free imgnAI endpoint that reacts to the
// credential at all — /v1/models answers 200 to a garbage bearer, reacting to
// the header's PRESENCE and never to its value — and the balance read wants the
// PAIR: a lone key gets 401 "Missing API credentials" while a fake pair gets 401
// "Invalid API credentials" (measured 2026-08-01). So the pair is checked with
// the same X-API-Key / X-API-Secret headers the media engine will use, and a
// single-field credential — which this card has always allowed, because text
// works with the key alone — is saved unchecked exactly as before, with the
// on-screen hint stating that nothing was verified. Inventing a check for it
// would be worse than admitting there is none.

function ImgnaiCard() {
  const { t } = useTranslation('settings')
  const [key, setKey]             = React.useState('')
  const [secret, setSecret]       = React.useState('')
  const [saving, setSaving]       = React.useState(false)
  const [saved, setSaved]         = React.useState(false)
  const [hasStored, setHasStored] = React.useState(false)
  // Rotation, the shared shape — one pair of inputs, revealed for both ways in.
  const [replacing, setReplacing] = React.useState(false)
  // The balance ping's answer: the account's credits, or the honest failure.
  // Null = not asked (which includes every one-field save).
  const [probe, setProbe] = React.useState<
    { ok: boolean; credits?: string; verdict?: 'rejected' | 'unverified'; status?: number } | null
  >(null)

  React.useEffect(() => {
    window.tachi.settings.listKeys().then((ids: string[]) => {
      setHasStored(ids.includes(IMGNAI_KEY_ID))
    })
  }, [saved])

  const canSave = key.trim().length > 0 || secret.trim().length > 0
  /** The only shape /v1/me/balance can judge — see the card comment. */
  const bothHalves = key.trim().length > 0 && secret.trim().length > 0

  // ONE handler for both ways in. TWO save call sites, deliberately: the
  // validated one is the shared helper's own `save` dep, which is what makes
  // "validated before stored" structural rather than a convention, and the
  // second is the one-field case the endpoint cannot judge. Splitting the
  // validation away from its save to merge them would undo exactly that.
  const save = async () => {
    const k = key.trim(), s = secret.trim()
    if (!k && !s) return
    setSaving(true)
    setProbe(null)
    try {
      if (k && s) {
        const res = await validateThenStoreKey({
          value: `${k}:${s}`,
          // The PAIR goes over IPC as two fields — main sends them as the
          // X-API-Key / X-API-Secret headers the media engine uses.
          validate: () => window.tachi.provider.validateImgnaiCredential(k, s),
          save:     (v) => window.tachi.settings.saveKey(IMGNAI_KEY_ID, v),
        })
        setProbe(res.probe)
        // NOT STORED = imgnAI rejected the pair; on a replace the previous
        // credential is still stored and still in force, and the copy below says
        // so. An UNVERIFIED answer stores the pair and says it was not checked.
        if (!res.stored) return
      } else {
        // Either half alone still unlocks text (bearer); image/video need both.
        // Unvalidatable, so this is a plain overwrite-in-place — never a delete.
        await window.tachi.settings.saveKey(IMGNAI_KEY_ID, k || s)
      }
      setKey('')
      setSecret('')
      setReplacing(false)
      setSaved(x => !x)
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    await window.tachi.settings.deleteKey(IMGNAI_KEY_ID)
    // Both fields are dropped, not just the first: half a secret left mounted is
    // still a secret left mounted.
    cancelKeyReplace({ setValue: setKey, setSecondValue: setSecret, setProbe, setReplacing })
    setSaved(s => !s)
  }

  const startReplace = () => { setProbe(null); setReplacing(true) }
  const cancelReplace = () => cancelKeyReplace({ setValue: setKey, setSecondValue: setSecret, setProbe, setReplacing })

  return (
    <div style={{
      border: 'var(--border-width) solid var(--border)',
      padding: 12, marginBottom: 10,
      background: 'var(--bg-surface)',
      fontFamily: 'JetBrains Mono, monospace',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8, color: 'var(--text-primary)' }}>
        {t('imgnai.title')}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8 }}>
        {t('imgnai.description')}{' '}
        <a href="#" onClick={(e) => { e.preventDefault(); window.tachi.shell.openExternal('https://app.imgnai.com/katana-api') }} style={{ color: 'var(--accent)' }}>
          app.imgnai.com/katana-api
        </a>
      </div>
      {/* STORED — the ✓ survives a replace. */}
      {hasStored ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, color: 'var(--accent)' }}>{t('keyCard.keyStored')}</span>
          {!replacing && (
            <button
              onClick={startReplace}
              data-testid="imgnai-replace"
              style={KEY_CARD_SECONDARY_BTN}
            >{t('keyCard.replace')}</button>
          )}
          <button onClick={remove} style={{
            fontSize: 9, padding: '4px 10px',
            border: 'var(--border-width) solid var(--destructive)',
            background: 'transparent', color: 'var(--destructive)',
            cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace',
          }}>{t('keyCard.remove')}</button>
        </div>
      ) : null}

      {/* THE TWO INPUTS — the same pair, the same state, both ways in. */}
      {(!hasStored || replacing) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: hasStored ? 8 : 0 }}>
          <input
            type="password" value={key}
            onChange={e => setKey(e.target.value)}
            placeholder={t('imgnai.keyPlaceholder')}
            data-testid="imgnai-key"
            style={{
              padding: '5px 8px', fontSize: 10,
              border: 'var(--border-width) solid var(--border)',
              background: 'var(--bg-base)', color: 'var(--text-primary)',
              fontFamily: 'JetBrains Mono, monospace',
            }}
          />
          <input
            type="password" value={secret}
            onChange={e => setSecret(e.target.value)}
            placeholder={t('imgnai.secretPlaceholder')}
            data-testid="imgnai-secret"
            style={{
              padding: '5px 8px', fontSize: 10,
              border: 'var(--border-width) solid var(--border)',
              background: 'var(--bg-base)', color: 'var(--text-primary)',
              fontFamily: 'JetBrains Mono, monospace',
            }}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ flex: 1, fontSize: 9, color: 'var(--text-muted)' }}>{t('imgnai.mediaHint')}</span>
            <button onClick={save} disabled={!canSave || saving} style={{
              fontSize: 9, fontWeight: 700, padding: '5px 12px',
              border: 'var(--border-width) solid var(--border)',
              background: 'var(--accent)', color: '#fff',
              boxShadow: 'var(--shadow-hard)', cursor: 'pointer',
              fontFamily: 'JetBrains Mono, monospace',
              textTransform: 'uppercase', letterSpacing: '0.08em',
              opacity: canSave && !saving ? 1 : 0.5,
            }}>{saving ? '…' : t('keyCard.save')}</button>
            {replacing && (
              <button
                onClick={cancelReplace}
                data-testid="imgnai-cancel-replace"
                style={KEY_CARD_SECONDARY_BTN}
              >{t('keyCard.cancelReplace')}</button>
            )}
          </div>
        </div>
      )}

      {/* THE HINT SWITCHES ON WHAT IS ACTUALLY TYPED. With both fields filled the
          pair is checked before it replaces anything; with one field there is no
          free endpoint that can judge it, and the copy must not imply there is.
          Either way both fields replace the stored credential together. */}
      {replacing && (
        <div data-testid="imgnai-replace-hint" style={KEY_CARD_REPLACE_HINT}>
          {t(bothHalves ? 'imgnai.replaceHintChecked' : 'imgnai.replaceHintPlain')}
        </div>
      )}

      {/* The balance ping's answer, in THREE outcomes. Naming the CREDITS is the
          point: it proves both halves are live AND that they belong to the
          account the user meant. `verdict === 'rejected'` is imgnAI saying no
          and nothing was stored; UNVERIFIED means we could not ask, so the pair
          WAS stored and the line says exactly that. */}
      {probe && (
        <div
          data-testid="imgnai-probe"
          style={{
            fontSize: 10, marginTop: 8, lineHeight: 1.45,
            color: KEY_PROBE_COLOR[keyProbeTone(probe)],
          }}
        >
          {probe.ok
            ? t('imgnai.probeOk', { credits: probe.credits || '?' })
            : probe.verdict === 'rejected'
              ? t(hasStored ? 'imgnai.probeRejectedKept' : 'imgnai.probeRejected')
              : t('imgnai.probeUnverified')}
        </div>
      )}
    </div>
  )
}

// ── Bankr Gateway Card ────────────────────────────────────────────────────────
//
// REPLACE: yes. VALIDATE: yes — GET /v1/credits. Measured 2026-08-01:
//   GET https://llm.bankr.bot/v1/credits no header → 401 "API key required"
//                                        Bearer bk_live_…(fake) → 401 "Invalid
//                                        or inactive API key"
// Free, no completion, no spend — and it separates "you sent nothing" from "I
// reject what you sent", which is exactly the discrimination a validator needs.
//
// It used to ask /v1/models, which is authenticated in the same way and gives
// the same two 401s. /v1/credits replaced it because the fact it returns is one
// the user can act on: <https://docs.bankr.bot/llm-gateway/api-reference> —
// "Returns the current LLM credit balance for the API key's wallet. Requires
// authentication" — with `effectiveBalanceUsd` documented as the truest
// available balance (it nets out in-flight usage). A model count told the user
// nothing about whether their next request would go through.
//
// IT DOES NOT GO THROUGH `provider:test-key`, and that is not an oversight:
// packages/core/.../bankr-health.ts probes `https://llm.bankr.bot/health` with
// NO Authorization header at all and returns 'healthy' if it answers — which it
// does, 200, anonymously — before the authenticated /v1/models check is ever
// reached. That path reports healthy for any string typed into any box. Reported
// separately; this card asks the authenticated endpoint directly.

function BankrCard() {
  const { t } = useTranslation('settings')
  const [key, setKey]             = React.useState('')
  const [saving, setSaving]       = React.useState(false)
  const [saved, setSaved]         = React.useState(false)
  const [hasStored, setHasStored] = React.useState(false)
  // Rotation, the shared shape.
  const [replacing, setReplacing] = React.useState(false)
  // The ping's answer: the wallet's credit balance for this key, or the honest
  // failure. Null = not asked yet.
  const [probe, setProbe] = React.useState<
    { ok: boolean; balanceUsd?: string; verdict?: 'rejected' | 'unverified'; status?: number } | null
  >(null)

  React.useEffect(() => {
    window.tachi.settings.listKeys().then((ids: string[]) => {
      setHasStored(ids.includes(BANKR_KEY_ID))
    })
  }, [saved])

  // VALIDATE THE TYPED KEY, THEN SAVE — the Civitai/HuggingFace rule, one
  // handler for the empty state and for a replace, so the ordering cannot hold
  // on one path and lapse on the other. A rejected key is NOT stored.
  const save = async () => {
    if (!key.trim()) return
    setSaving(true)
    setProbe(null)
    try {
      const res = await validateThenStoreKey({
        value: key,
        validate: (v) => window.tachi.provider.validateBankrKey(v),
        save:     (v) => window.tachi.settings.saveKey(BANKR_KEY_ID, v),
      })
      setProbe(res.probe)
      // NOT STORED = Bankr rejected it; on a replace the previous key is still
      // stored and still in force, and the copy below says so. An UNVERIFIED
      // answer stores the key and says it could not be checked.
      if (!res.stored) return
      setKey('')
      setReplacing(false)
      setSaved(s => !s)
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    await window.tachi.settings.deleteKey(BANKR_KEY_ID)
    cancelKeyReplace({ setValue: setKey, setProbe, setReplacing })
    setSaved(s => !s)
  }

  const startReplace = () => { setProbe(null); setReplacing(true) }
  const cancelReplace = () => cancelKeyReplace({ setValue: setKey, setProbe, setReplacing })

  return (
    <div style={{
      border: 'var(--border-width) solid var(--border)',
      background: 'var(--bg-elevated)',
      boxShadow: 'var(--shadow-hard)',
      padding: 12,
      marginTop: 12,
      fontFamily: 'JetBrains Mono, monospace',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8, color: 'var(--text-primary)' }}>
        {t('bankr.title')}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8 }}>
        {t('bankr.description')}{' '}
        <a href="#" onClick={(e) => { e.preventDefault(); window.tachi.shell.openExternal('https://docs.bankr.bot/llm-gateway/overview') }} style={{ color: 'var(--accent)' }}>
          docs.bankr.bot
        </a>
      </div>
      {/* STORED — the ✓ survives a replace. */}
      {hasStored ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, color: 'var(--accent)' }}>{t('keyCard.keyStored')}</span>
          {!replacing && (
            <button
              onClick={startReplace}
              data-testid="bankr-replace"
              style={KEY_CARD_SECONDARY_BTN}
            >{t('keyCard.replace')}</button>
          )}
          <button onClick={remove} style={{
            fontSize: 9, padding: '4px 10px',
            border: 'var(--border-width) solid var(--destructive)',
            background: 'transparent', color: 'var(--destructive)',
            cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace',
          }}>{t('keyCard.remove')}</button>
        </div>
      ) : null}

      {/* THE INPUT — one element, one piece of state, both ways in. */}
      {(!hasStored || replacing) && (
        <div style={{ display: 'flex', gap: 6, marginTop: hasStored ? 8 : 0 }}>
          <input
            type="password" value={key}
            onChange={e => setKey(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && save()}
            placeholder="bk_..."
            data-testid="bankr-key"
            style={{
              flex: 1, padding: '5px 8px', fontSize: 10,
              border: 'var(--border-width) solid var(--border)',
              background: 'var(--bg-base)', color: 'var(--text-primary)',
              fontFamily: 'JetBrains Mono, monospace',
            }}
          />
          <button onClick={save} disabled={!key.trim() || saving} style={{
            fontSize: 9, fontWeight: 700, padding: '5px 12px',
            border: 'var(--border-width) solid var(--border)',
            background: 'var(--accent)', color: '#fff',
            boxShadow: 'var(--shadow-hard)', cursor: 'pointer',
            fontFamily: 'JetBrains Mono, monospace',
            textTransform: 'uppercase', letterSpacing: '0.08em',
            opacity: key.trim() && !saving ? 1 : 0.5,
          }}>{saving ? '…' : t('keyCard.save')}</button>
          {replacing && (
            <button
              onClick={cancelReplace}
              data-testid="bankr-cancel-replace"
              style={KEY_CARD_SECONDARY_BTN}
            >{t('keyCard.cancelReplace')}</button>
          )}
        </div>
      )}

      {/* The key Bankr is currently answering to has not been touched. */}
      {replacing && (
        <div data-testid="bankr-replace-hint" style={KEY_CARD_REPLACE_HINT}>
          {t('keyCard.replaceHintChecked')}
        </div>
      )}

      {/* The ping's answer, in THREE outcomes. The CREDIT BALANCE is the
          checkable fact: an accepted key on an empty wallet is a different
          problem from a rejected one, and only one of them is fixed by pasting a
          different key. With a key already stored the REJECTED copy states that
          nothing changed; UNVERIFIED means the key was saved unchecked. */}
      {probe && (
        <div
          data-testid="bankr-probe"
          style={{
            fontSize: 10, marginTop: 8, lineHeight: 1.45,
            color: KEY_PROBE_COLOR[keyProbeTone(probe)],
          }}
        >
          {probe.ok
            ? t('bankr.probeOk', { balance: probe.balanceUsd || '?' })
            : probe.verdict === 'rejected'
              ? t(hasStored ? 'bankr.probeRejectedKept' : 'bankr.probeRejected')
              : t('bankr.probeUnverified')}
        </div>
      )}
    </div>
  )
}

// ── Surplus Intelligence Card ─────────────────────────────────────────────────
//
// REPLACE: yes. VALIDATE: YES — the refusal shipped an hour ago rested on a
// claim about their API that was simply not true, and this card is the fix.
//
// The measurements were right: /v1/models, /v1/prices, /api/markets and the
// Anthropic skin's /anthropic/v1/models all answer 200 with no header and with a
// fake `inf_…` bearer, and there is no /me, /credits, /balance, /usage or /key
// (404 "Cannot GET /v1/…"). What was wrong was the conclusion — "the only thing
// that reads a buyer key is a request that settles USDC". It is not:
//   POST https://api.surplusintelligence.ai/anthropic/v1/messages/count_tokens
// reads the buyer key and performs NO inference. Their docs call the answer "a
// heuristic estimate (no upstream round-trip)", so no seller is called and
// nothing settles; the same page pins the failure mode — "An unauthenticated or
// non-buyer request returns an Anthropic-shaped 401 authentication_error" —
// which a fake inf_ key reproduced exactly today. Free-ness is INFERRED from
// that mechanism, not documented in words, and the probe module says so.
//
// ⚠ It is the only validator in this file that does not talk to the host in the
// provider registry: our `surplus.baseUrl` is www…/api/inference/v1, where this
// endpoint answers 410 "endpoint_removed · Call https://api.surplusintelligence
// .ai directly". The registry is deliberately left alone — see the HOST
// DISCREPANCY note in electron/services/provider-key-probe.ts.

function SurplusCard() {
  const { t } = useTranslation('settings')
  const [key, setKey]             = React.useState('')
  const [saving, setSaving]       = React.useState(false)
  const [saved, setSaved]         = React.useState(false)
  const [hasStored, setHasStored] = React.useState(false)
  // Rotation, the shared shape.
  const [replacing, setReplacing] = React.useState(false)
  // The count_tokens ping's answer: the estimate it returned, or the honest
  // failure. Null = not asked yet.
  const [probe, setProbe] = React.useState<
    { ok: boolean; tokens?: number; verdict?: 'rejected' | 'unverified'; status?: number } | null
  >(null)

  React.useEffect(() => {
    window.tachi.settings.listKeys().then((ids: string[]) => {
      setHasStored(ids.includes(SURPLUS_KEY_ID))
    })
  }, [saved])

  // VALIDATE THE TYPED KEY, THEN SAVE — one handler for the empty state and for
  // a replace, so the ordering cannot hold on one path and lapse on the other.
  // A rejected key is NOT stored.
  const save = async () => {
    if (!key.trim()) return
    setSaving(true)
    setProbe(null)
    try {
      const res = await validateThenStoreKey({
        value: key,
        validate: (v) => window.tachi.provider.validateSurplusKey(v),
        save:     (v) => window.tachi.settings.saveKey(SURPLUS_KEY_ID, v),
      })
      setProbe(res.probe)
      // NOT STORED = Surplus rejected it; the previous key is untouched.
      if (!res.stored) return
      setKey('')
      setReplacing(false)
      setSaved(s => !s)
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    await window.tachi.settings.deleteKey(SURPLUS_KEY_ID)
    cancelKeyReplace({ setValue: setKey, setProbe, setReplacing })
    setSaved(s => !s)
  }

  const startReplace = () => { setProbe(null); setReplacing(true) }
  const cancelReplace = () => cancelKeyReplace({ setValue: setKey, setProbe, setReplacing })

  return (
    <div style={{
      border: 'var(--border-width) solid var(--border)',
      background: 'var(--bg-elevated)',
      boxShadow: 'var(--shadow-hard)',
      padding: 12,
      marginTop: 12,
      fontFamily: 'JetBrains Mono, monospace',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8, color: 'var(--text-primary)' }}>
        {t('surplus.title')}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.5 }}>
        {t('surplus.description')}{' '}
        <a href="#" onClick={(e) => { e.preventDefault(); window.tachi.shell.openExternal('https://www.surplusintelligence.ai/buy') }} style={{ color: 'var(--accent)' }}>
          surplusintelligence.ai/buy
        </a>
        {' '}{t('surplus.descriptionSuffix')}
      </div>
      {/* STORED — the ✓ survives a replace. */}
      {hasStored ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, color: 'var(--accent)' }}>{t('keyCard.keyStored')}</span>
          {!replacing && (
            <button
              onClick={startReplace}
              data-testid="surplus-replace"
              style={KEY_CARD_SECONDARY_BTN}
            >{t('keyCard.replace')}</button>
          )}
          <button onClick={remove} style={{
            fontSize: 9, padding: '4px 10px',
            border: 'var(--border-width) solid var(--destructive)',
            background: 'transparent', color: 'var(--destructive)',
            cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace',
          }}>{t('keyCard.remove')}</button>
        </div>
      ) : null}

      {/* THE INPUT — one element, one piece of state, both ways in. */}
      {(!hasStored || replacing) && (
        <div style={{ display: 'flex', gap: 6, marginTop: hasStored ? 8 : 0 }}>
          <input
            type="password" value={key}
            onChange={e => setKey(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && save()}
            placeholder="inf_..."
            data-testid="surplus-key"
            style={{
              flex: 1, padding: '5px 8px', fontSize: 10,
              border: 'var(--border-width) solid var(--border)',
              background: 'var(--bg-base)', color: 'var(--text-primary)',
              fontFamily: 'JetBrains Mono, monospace',
            }}
          />
          <button onClick={save} disabled={!key.trim() || saving} style={{
            fontSize: 9, fontWeight: 700, padding: '5px 12px',
            border: 'var(--border-width) solid var(--border)',
            background: 'var(--accent)', color: '#fff',
            boxShadow: 'var(--shadow-hard)', cursor: 'pointer',
            fontFamily: 'JetBrains Mono, monospace',
            textTransform: 'uppercase', letterSpacing: '0.08em',
            opacity: key.trim() && !saving ? 1 : 0.5,
          }}>{saving ? '…' : t('keyCard.save')}</button>
          {replacing && (
            <button
              onClick={cancelReplace}
              data-testid="surplus-cancel-replace"
              style={KEY_CARD_SECONDARY_BTN}
            >{t('keyCard.cancelReplace')}</button>
          )}
        </div>
      )}

      {/* The key Surplus is currently answering to has not been touched. */}
      {replacing && (
        <div data-testid="surplus-replace-hint" style={KEY_CARD_REPLACE_HINT}>
          {t('keyCard.replaceHintChecked')}
        </div>
      )}

      {/* The ping's answer, in THREE outcomes. The TOKEN ESTIMATE is the
          checkable fact — small, but it is the number their own docs show for
          this call, so a user can see the marketplace answered them personally.
          A 401 is Surplus rejecting the buyer key and nothing was stored;
          anything else means we could not ask, and the key WAS stored. */}
      {probe && (
        <div
          data-testid="surplus-probe"
          style={{
            fontSize: 10, marginTop: 8, lineHeight: 1.45,
            color: KEY_PROBE_COLOR[keyProbeTone(probe)],
          }}
        >
          {probe.ok
            ? t('surplus.probeOk', { tokens: probe.tokens ?? 0 })
            : probe.verdict === 'rejected'
              ? t(hasStored ? 'surplus.probeRejectedKept' : 'surplus.probeRejected')
              : t('surplus.probeUnverified')}
        </div>
      )}
    </div>
  )
}

// ── FreeClaudeCode Card ───────────────────────────────────────────────────────

function FreeClaudeCodeCard() {
  const { t } = useTranslation('settings')
  const [installed, setInstalled] = React.useState<'unknown' | 'yes' | 'no'>('unknown')

  // Probe via the main-process sidecar health IPC instead of renderer fetch.
  // Renderer fetch() logs `net::ERR_CONNECTION_REFUSED` to the console even
  // when the .catch() handles it — there's no way to silence that from JS.
  // The main-process health probe has no such console spam.
  React.useEffect(() => {
    let cancelled = false
    window.tachi.sidecar.health('freeclaudecode')
      .then((alive: boolean) => { if (!cancelled) setInstalled(alive ? 'yes' : 'no') })
      .catch(() => { if (!cancelled) setInstalled('no') })
    return () => { cancelled = true }
  }, [])

  return (
    <div style={{
      border: 'var(--border-width) solid var(--border)',
      background: 'var(--bg-elevated)',
      boxShadow: 'var(--shadow-hard)',
      padding: 12,
      marginTop: 12,
      fontFamily: 'JetBrains Mono, monospace',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8, color: 'var(--text-primary)' }}>
        {t('freeClaudeCode.title')}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8 }}>
        {t('freeClaudeCode.description')}{' '}
        <a
          href="#"
          onClick={(e) => { e.preventDefault(); window.tachi.shell.openExternal('https://github.com/Alishahryar1/free-claude-code') }}
          style={{ color: 'var(--accent)' }}
        >
          github.com/Alishahryar1/free-claude-code
        </a>
      </div>
      {installed === 'yes' ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 10, color: 'var(--accent)' }}>{t('freeClaudeCode.detected')}</span>
          <button
            onClick={() => window.tachi.shell.openExternal('http://127.0.0.1:8082/admin')}
            style={{
              fontSize: 9, padding: '4px 10px',
              border: 'var(--border-width) solid var(--border)',
              background: 'var(--accent)', color: '#fff',
              cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace',
              boxShadow: 'var(--shadow-hard)',
            }}
          >
            {t('freeClaudeCode.openAdmin')}
          </button>
        </div>
      ) : (
        <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>
          {installed === 'unknown' ? t('freeClaudeCode.checking') : t('freeClaudeCode.notDetected')}
        </div>
      )}
    </div>
  )
}

// ── Codex Worker Card ─────────────────────────────────────────────────────────
// OpenAI Codex CLI sidecar: install once, sign in once (ChatGPT OAuth in the
// browser) — the TACHI harness then gains the gated codex_worker delegation
// tool for the CODE agent.

function CodexWorkerCard() {
  const { t } = useTranslation('settings')
  const [st, setSt]             = React.useState<{ installed: boolean; version: string; loggedIn: boolean; detail: string; strayAuthAt?: string | null } | null>(null)
  const [busy, setBusy]         = React.useState<'install' | 'login' | null>(null)
  const [progress, setProgress] = React.useState('')
  const [error, setError]       = React.useState<string | null>(null)
  const unsubRef = React.useRef<(() => void) | null>(null)

  const refresh = React.useCallback(() => {
    window.tachi.codex.status().then(setSt).catch((err: unknown) => {
      setSt({ installed: false, version: '', loggedIn: false, detail: err instanceof Error ? err.message : String(err) })
    })
  }, [])
  React.useEffect(() => { refresh() }, [refresh])
  React.useEffect(() => () => { unsubRef.current?.() }, [])

  const doInstall = async () => {
    setBusy('install'); setProgress(''); setError(null)
    unsubRef.current = window.tachi.codex.onInstallProgress(p => setProgress(`${p.message} — ${p.percent}%`))
    try {
      const res = await window.tachi.codex.install()
      if (!res.ok) setError(res.error ?? 'install failed')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      unsubRef.current?.(); unsubRef.current = null
      setBusy(null); setProgress(''); refresh()
    }
  }

  const doLogin = async () => {
    setBusy('login'); setProgress(''); setError(null)
    unsubRef.current = window.tachi.codex.onLoginProgress(p => setProgress(p.line))
    try {
      const res = await window.tachi.codex.login()
      if (!res.ok) setError(res.detail)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      unsubRef.current?.(); unsubRef.current = null
      setBusy(null); setProgress(''); refresh()
    }
  }

  const btnBase: React.CSSProperties = {
    fontSize: 9, fontWeight: 700, padding: '5px 12px',
    border: 'var(--border-width) solid var(--border)',
    cursor: busy === null ? 'pointer' : 'default',
    opacity: busy === null ? 1 : 0.5,
    fontFamily: 'JetBrains Mono, monospace',
    textTransform: 'uppercase', letterSpacing: '0.08em',
  }
  const chip: React.CSSProperties = {
    fontSize: 9, fontWeight: 700, padding: '2px 8px',
    border: 'var(--border-width) solid var(--border)',
    textTransform: 'uppercase', letterSpacing: '0.08em',
  }

  return (
    <div id="codex-worker-card" style={{
      border: 'var(--border-width) solid var(--border)',
      background: 'var(--bg-elevated)',
      boxShadow: 'var(--shadow-hard)',
      padding: 12,
      marginTop: 12,
      fontFamily: 'JetBrains Mono, monospace',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, color: 'var(--text-primary)' }}>
        {t('codex.title')}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8 }}>
        {t('codex.subtitle')}
      </div>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        {st === null ? (
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t('codex.checking')}</span>
        ) : (
          <>
            <span style={{ ...chip, color: st.installed ? 'var(--accent)' : 'var(--text-muted)' }}>
              {st.installed ? `${t('codex.installed')}${st.version ? ` v${st.version}` : ''}` : t('codex.notInstalled')}
            </span>
            {st.installed && (
              <span style={{ ...chip, color: st.loggedIn ? 'var(--accent)' : 'var(--text-muted)' }}>
                {st.loggedIn ? t('codex.loggedIn') : t('codex.loggedOut')}
              </span>
            )}
            {st.detail && (
              <span title={st.detail} style={{ fontSize: 9, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 260 }}>
                {st.detail}
              </span>
            )}
          </>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {st !== null && !st.installed && (
          <button onClick={doInstall} disabled={busy !== null} style={{
            ...btnBase,
            background: 'var(--accent)', color: '#fff',
            boxShadow: 'var(--shadow-hard)',
          }}>{busy === 'install' ? t('codex.installing') : t('codex.install')}</button>
        )}
        {st?.installed && !st.loggedIn && (
          <button onClick={doLogin} disabled={busy !== null} style={{
            ...btnBase,
            background: 'var(--accent)', color: '#fff',
            boxShadow: 'var(--shadow-hard)',
          }}>{t('codex.login')}</button>
        )}
        {st?.installed && !st.loggedIn && st.strayAuthAt && (
          // Troubleshooting: a login exists in the NON-active codex home
          // (moved CODEX_HOME / tool that ignored the var) — adopt it instead
          // of forcing a fresh browser login.
          <button
            onClick={async () => { await window.tachi.codex.adoptAuth().catch(() => null); await refresh() }}
            disabled={busy !== null}
            title={t('codex.strayFixTitle', { path: st.strayAuthAt })}
            style={{ ...btnBase, background: 'var(--warning)', color: 'var(--bg-base)', boxShadow: 'var(--shadow-hard)' }}
          >{t('codex.strayFix')}</button>
        )}
        {st?.installed && st.loggedIn && (
          // The escape hatch for a consumed refresh token ("logged in" locally
          // but every run 401s): clear the auth so LOG IN comes back.
          <button
            onClick={async () => { await window.tachi.codex.logout().catch(() => null); await refresh() }}
            disabled={busy !== null}
            style={{ ...btnBase, background: 'transparent', color: 'var(--destructive)', borderColor: 'var(--destructive)' }}
          >{t('codex.logout')}</button>
        )}
        {st?.installed && (
          <button onClick={refresh} disabled={busy !== null} style={{
            ...btnBase,
            background: 'transparent', color: 'var(--text-primary)',
          }}>{t('codex.recheck')}</button>
        )}
      </div>

      {busy !== null && (
        <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {progress || (busy === 'login' ? t('codex.waiting') : t('codex.installing'))}
        </div>
      )}
      {error && (
        <div style={{ fontSize: 9, color: 'var(--destructive)', marginTop: 6 }}>{error}</div>
      )}

      <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 8 }}>
        {t('codex.hint')}
      </div>
    </div>
  )
}

// ── Telegram Card ─────────────────────────────────────────────────────────────
// Remote-control channel into the CODE agent: chat with TACHI from your phone.
// The bot token lives in main only (status just reports hasToken); the bridge
// never runs in private mode.

type TelegramStatus = {
  enabled: boolean; running: boolean; hasToken: boolean; paired: boolean
  chatId: string; pairingCode: string | null; workspace: string; lastError: string
}

function TelegramCard() {
  const { t } = useTranslation('settings')
  const [st, setSt]       = React.useState<TelegramStatus | null>(null)
  const [token, setToken] = React.useState('')

  const refresh = React.useCallback(() => {
    window.tachi.telegram.status().then(setSt).catch(() => {})
  }, [])
  React.useEffect(() => { refresh() }, [refresh])
  // While a pairing code is showing, poll so the card flips to PAIRED live.
  React.useEffect(() => {
    if (!st?.pairingCode) return
    const id = window.setInterval(refresh, 5000)
    return () => window.clearInterval(id)
  }, [st?.pairingCode, refresh])

  const run = async (p: Promise<TelegramStatus>) => {
    try { setSt(await p) } catch { refresh() }
  }

  const btnBase: React.CSSProperties = {
    fontSize: 9, fontWeight: 700, padding: '5px 12px',
    border: 'var(--border-width) solid var(--border)',
    cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace',
    textTransform: 'uppercase', letterSpacing: '0.08em',
  }
  const chip: React.CSSProperties = {
    fontSize: 9, fontWeight: 700, padding: '2px 8px',
    border: 'var(--border-width) solid var(--border)',
    textTransform: 'uppercase', letterSpacing: '0.08em',
  }

  return (
    <div style={{
      border: 'var(--border-width) solid var(--border)',
      background: 'var(--bg-elevated)',
      boxShadow: 'var(--shadow-hard)',
      padding: 12,
      marginTop: 12,
      fontFamily: 'JetBrains Mono, monospace',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, color: 'var(--text-primary)' }}>
        Telegram
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8 }}>
        {t('telegram.subtitle')}
      </div>

      {/* Token row */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <input
          type="password"
          placeholder={t('telegram.tokenPlaceholder')}
          value={token}
          onChange={e => setToken(e.target.value)}
          style={{
            flex: 1, fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
            padding: '5px 8px',
            border: 'var(--border-width) solid var(--border)',
            background: 'var(--bg-base)', color: 'var(--text-primary)',
          }}
        />
        <button
          onClick={() => { if (token.trim()) { run(window.tachi.telegram.setToken(token.trim())); setToken('') } }}
          disabled={!token.trim()}
          style={{ ...btnBase, background: 'var(--accent)', color: '#fff', boxShadow: 'var(--shadow-hard)', opacity: token.trim() ? 1 : 0.5 }}
        >{t('telegram.save')}</button>
      </div>
      {st?.hasToken && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: 10, color: 'var(--success)' }}>{t('telegram.tokenStored')}</span>
          <button onClick={() => run(window.tachi.telegram.setToken(''))} style={{ ...btnBase, background: 'transparent', color: 'var(--text-primary)' }}>
            {t('telegram.removeToken')}
          </button>
        </div>
      )}

      {/* Enable toggle + status chip */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <button
          onClick={() => { if (st) run(window.tachi.telegram.setEnabled(!st.enabled)) }}
          disabled={st === null}
          style={{ ...btnBase, background: st?.enabled ? 'transparent' : 'var(--accent)', color: st?.enabled ? 'var(--text-primary)' : '#fff', boxShadow: st?.enabled ? 'none' : 'var(--shadow-hard)' }}
        >{st?.enabled ? t('telegram.disable') : t('telegram.enable')}</button>
        <span style={{ ...chip, color: st?.running ? 'var(--success)' : 'var(--text-muted)' }}>
          {st?.running ? t('telegram.running') : t('telegram.stopped')}
        </span>
        {st?.lastError ? (
          <span title={st.lastError} style={{ fontSize: 9, color: 'var(--destructive)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 260 }}>
            {st.lastError}
          </span>
        ) : null}
      </div>

      {/* Pairing */}
      {st?.enabled && st.hasToken && !st.paired && st.pairingCode && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '0.35em', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-primary)', marginBottom: 4 }}>
            {st.pairingCode}
          </div>
          <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{t('telegram.pairingHint')}</div>
        </div>
      )}
      {st?.paired && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <span style={{ ...chip, color: 'var(--success)' }}>{t('telegram.paired', { chatId: st.chatId })}</span>
          <button onClick={() => run(window.tachi.telegram.unpair())} style={{ ...btnBase, background: 'transparent', color: 'var(--text-primary)' }}>
            {t('telegram.unpair')}
          </button>
        </div>
      )}

      {/* Workspace */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{t('telegram.workspace')}</span>
        <span title={st?.workspace} style={{ flex: 1, fontSize: 10, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {st?.workspace ?? '…'}
        </span>
        <button onClick={() => run(window.tachi.telegram.chooseWorkspace())} style={{ ...btnBase, background: 'transparent', color: 'var(--text-primary)' }}>
          {t('telegram.change')}
        </button>
      </div>

      <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{t('telegram.setupHint')}</div>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 4 }}>{t('telegram.privateNote')}</div>
    </div>
  )
}

// ── Anthropic OAuth Card ──────────────────────────────────────────────────────

function AnthropicOAuthCard() {
  const { t } = useTranslation('settings')
  const [step, setStep]   = React.useState<'idle' | 'waiting-code' | 'connected'>('idle')
  const [code, setCode]   = React.useState('')
  const [error, setError] = React.useState<string | null>(null)

  const start = async () => {
    setError(null)
    await window.tachi.oauth.anthropicStart()
    setStep('waiting-code')
  }

  const complete = async () => {
    if (!code.trim()) return
    setError(null)
    try {
      await window.tachi.oauth.anthropicComplete(code.trim())
      setStep('connected')
      setCode('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div style={{
      border: 'var(--border-width) solid var(--border)',
      background: 'var(--bg-elevated)',
      boxShadow: 'var(--shadow-hard)',
      padding: 12,
      marginTop: 12,
      fontFamily: 'JetBrains Mono, monospace',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, color: 'var(--text-primary)' }}>
        {t('anthropicOAuth.title')}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8 }}>
        {t('anthropicOAuth.description')}
      </div>

      {step === 'idle' && (
        <button
          onClick={start}
          style={{
            fontSize: 9, fontWeight: 700, padding: '5px 12px',
            border: 'var(--border-width) solid var(--border)',
            background: 'var(--accent)', color: '#fff',
            boxShadow: 'var(--shadow-hard)', cursor: 'pointer',
            fontFamily: 'JetBrains Mono, monospace',
            textTransform: 'uppercase', letterSpacing: '0.08em',
          }}
        >
          {t('anthropicOAuth.signIn')}
        </button>
      )}

      {step === 'waiting-code' && (
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>
            {t('anthropicOAuth.browserOpened')}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              placeholder={t('anthropicOAuth.codePlaceholder')}
              value={code}
              onChange={e => setCode(e.target.value)}
              style={{
                flex: 1, fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
                padding: '5px 8px',
                border: 'var(--border-width) solid var(--border)',
                background: 'var(--bg-base)', color: 'var(--text-primary)',
              }}
            />
            <button
              onClick={complete}
              disabled={!code.trim()}
              style={{
                fontSize: 9, fontWeight: 700, padding: '5px 12px',
                border: 'var(--border-width) solid var(--border)',
                background: 'var(--accent)', color: '#fff',
                boxShadow: 'var(--shadow-hard)', cursor: 'pointer',
                fontFamily: 'JetBrains Mono, monospace',
                textTransform: 'uppercase', letterSpacing: '0.08em',
                opacity: code.trim() ? 1 : 0.5,
              }}
            >
              {t('anthropicOAuth.submit')}
            </button>
          </div>
        </div>
      )}

      {step === 'connected' && (
        <span style={{ fontSize: 10, color: 'var(--accent)' }}>{t('anthropicOAuth.signedIn')}</span>
      )}

      {error && (
        <div style={{ fontSize: 9, color: 'var(--destructive)', marginTop: 6 }}>{error}</div>
      )}
    </div>
  )
}

// ── OpenRouter OAuth Card ─────────────────────────────────────────────────────

function OpenRouterOAuthCard() {
  const { t } = useTranslation('settings')
  const [busy, setBusy]           = React.useState(false)
  const [connected, setConnected] = React.useState(false)
  const [error, setError]         = React.useState<string | null>(null)

  const connect = async () => {
    setBusy(true)
    setError(null)
    const res = await window.tachi.oauth.openrouterStart()
    setBusy(false)
    if (res.ok) {
      setConnected(true)
    } else {
      setError(res.error ?? t('openRouterOAuth.unknownError'))
    }
  }

  return (
    <div style={{
      border: 'var(--border-width) solid var(--border)',
      background: 'var(--bg-elevated)',
      boxShadow: 'var(--shadow-hard)',
      padding: 12,
      marginTop: 12,
      fontFamily: 'JetBrains Mono, monospace',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, color: 'var(--text-primary)' }}>
        OpenRouter
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8 }}>
        {t('openRouterOAuth.description')}
      </div>
      {/* Measured free-tier facts (their docs, quoted in
          notes/FREE-FLEET-SWEEP-2026-08-01.md §3): 14 live-priced $0 models,
          20 requests/min, 50/day without purchased credits. Per-model — the
          provider itself stays paid; the picker shows which rows are free. */}
      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 8 }}>
        {t('openRouterOAuth.freeTier')}
      </div>

      {connected ? (
        <span style={{ fontSize: 10, color: 'var(--accent)' }}>{t('openRouterOAuth.connected')}</span>
      ) : (
        <button
          onClick={connect}
          disabled={busy}
          style={{
            fontSize: 9, fontWeight: 700, padding: '5px 12px',
            border: 'var(--border-width) solid var(--border)',
            background: 'var(--accent)', color: '#fff',
            boxShadow: 'var(--shadow-hard)', cursor: 'pointer',
            fontFamily: 'JetBrains Mono, monospace',
            textTransform: 'uppercase', letterSpacing: '0.08em',
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? t('openRouterOAuth.waiting') : t('openRouterOAuth.signIn')}
        </button>
      )}

      {error && (
        <div style={{ fontSize: 9, color: 'var(--destructive)', marginTop: 6 }}>{error}</div>
      )}
    </div>
  )
}

// ── Storage Card ──────────────────────────────────────────────────────────────
// Where user-facing files land (media, designs, renders, audio, flows).
// App internals (keys, settings, caches, models) stay in userData regardless.

function StorageCard() {
  const { t } = useTranslation('settings')
  const [info, setInfo] = React.useState<{ root: string; defaultRoot: string } | null>(null)

  const refresh = React.useCallback(() => {
    window.tachi.storage.info().then(i => setInfo({ root: i.root, defaultRoot: i.defaultRoot }))
  }, [])
  React.useEffect(() => { refresh() }, [refresh])

  const choose = async () => {
    const res = await window.tachi.storage.choose()
    if (res.root) refresh() // null root = dialog cancelled → no-op
  }
  const reset = async () => {
    await window.tachi.storage.reset()
    refresh()
  }

  const isDefault = !!info && info.root === info.defaultRoot
  const btnBase: React.CSSProperties = {
    fontSize: 9, fontWeight: 700, padding: '5px 12px',
    border: 'var(--border-width) solid var(--border)',
    cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace',
    textTransform: 'uppercase', letterSpacing: '0.08em',
  }

  return (
    <div style={{
      border: 'var(--border-width) solid var(--border)',
      background: 'var(--bg-elevated)',
      boxShadow: 'var(--shadow-hard)',
      padding: 12,
      fontFamily: 'JetBrains Mono, monospace',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8, color: 'var(--text-primary)' }}>
        {t('storage.title')}
      </div>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
        {t('storage.current')}
      </div>
      <div
        title={info?.root}
        style={{
          fontSize: 10, color: 'var(--text-primary)',
          border: 'var(--border-width) solid var(--border)',
          background: 'var(--bg-base)', padding: '5px 8px', marginBottom: 8,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}
      >
        {info ? info.root : '…'}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        <button onClick={choose} style={{
          ...btnBase,
          background: 'var(--accent)', color: '#fff',
          boxShadow: 'var(--shadow-hard)',
        }}>{t('storage.change')}</button>
        <button onClick={() => window.tachi.storage.open()} style={{
          ...btnBase,
          background: 'transparent', color: 'var(--text-primary)',
        }}>{t('storage.open')}</button>
        <button onClick={reset} disabled={isDefault} style={{
          ...btnBase,
          background: 'transparent', color: 'var(--text-primary)',
          cursor: isDefault ? 'default' : 'pointer',
          opacity: isDefault ? 0.4 : 1,
        }}>{t('storage.reset')}</button>
      </div>
      <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>
        {t('storage.hint')}
      </div>
    </div>
  )
}

type Tab = 'connections' | 'appearance' | 'shortcuts' | 'advanced'

// Anchor-rail sections for the Connections tab, in scroll order. Each renders
// as a wrapper div with id `settings-section-<id>` — the rail smooth-scrolls
// to these and the scroll-spy walks them top-down to highlight the current one.
const CONN_SECTION_IDS: RailSectionId[] = ['local', 'providers', 'agents', 'api-keys', 'search', 'other']

interface ThemePreview {
  id: Theme; label: string
  accent: string; bg: string; surface: string; text: string
}

// Fallback preview colors per theme. These used to be the ONLY source, which
// made this list an eighth, undetectable theme-registration point: it is typed
// as Theme, so a theme whose CSS sheet exists but was never added here simply
// never appeared in Settings, and neither typecheck nor tests noticed
// (notes/DESIGN-VERTICAL-RESEARCH-2026-07-26.md). The colors are now DERIVED
// from the sheets below; this array survives only as the labels + order + a
// safety net if a sheet ever stops parsing.
const THEME_PREVIEW_FALLBACK: ThemePreview[] = [
  { id: 'tachi-dark', label: 'Dark',  accent: '#d43f00', bg: '#0d0d0d', surface: '#111111', text: '#e8e8e8' },
  // Label says "Light" (not the internal id "bankr") — the sidebar footer
  // toggle calls this theme Light, and two names for one theme confused QA.
  { id: 'bankr',      label: 'Light', accent: '#6b38d4', bg: '#fcf9f8', surface: '#ffffff', text: '#1c1b1b' },
  { id: 'tachi-neon', label: 'Neon',  accent: '#ff2d95', bg: '#0b0a16', surface: '#13111f', text: '#f7f0ff' },
  { id: 'comic',      label: 'Comic', accent: '#6b38d4', bg: '#f4f1e8', surface: '#fbfaf4', text: '#12100a' },
]

// Every shipped palette sheet, read at BUILD time by Vite. Structure layers
// (themes/<id>-structure.css) carry geometry, not a palette, and are skipped:
// their rules are scoped selectors, never a bare `:root[data-theme="…"]`, so
// collectRootVariables returns nothing for them anyway.
const THEME_SHEETS = import.meta.glob('../../themes/*.css', {
  eager: true, query: '?raw', import: 'default',
}) as unknown as Record<string, string>

/** Title-case a theme id for a sheet that has no entry in the fallback list. */
const prettifyThemeId = (id: string) =>
  id.replace(/^tachi-/, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

/**
 * Derive the swatch colors of every built-in theme from its own stylesheet,
 * and pick up any sheet that isn't in the fallback list at all — a new
 * themes/<id>.css now shows up in Settings by existing.
 */
function deriveThemePreviews(): ThemePreview[] {
  const byId = new Map<string, ThemePreview>(THEME_PREVIEW_FALLBACK.map(p => [p.id, { ...p }]))
  for (const css of Object.values(THEME_SHEETS)) {
    if (typeof css !== 'string') continue
    const id = /:root\[data-theme="([^"]+)"\]\s*\{/.exec(css)?.[1]
    if (!id) continue
    const { vars } = collectRootVariables(css)
    const accent  = vars['--accent']
    const bg      = vars['--bg-base']
    const surface = vars['--bg-surface']
    const text    = vars['--text-primary']
    if (!accent || !bg || !surface || !text) continue // keep the fallback entry
    byId.set(id, {
      id: id as Theme,
      label: byId.get(id)?.label ?? prettifyThemeId(id),
      accent, bg, surface, text,
    })
  }
  // Fallback order first, then anything newly discovered.
  const order = THEME_PREVIEW_FALLBACK.map(p => p.id as string)
  return [...byId.values()].sort((a, b) => {
    const ia = order.indexOf(a.id as string)
    const ib = order.indexOf(b.id as string)
    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib)
  })
}

const THEME_PREVIEWS: ThemePreview[] = deriveThemePreviews()

/** The mini "app screenshot" shared by built-in and imported theme cards. */
function ThemeSwatch({ p }: { p: Omit<ThemePreview, 'id' | 'label'> }) {
  return (
    <div style={{ background: p.bg, height: 84, position: 'relative', overflow: 'hidden' }}>
      {/* Fake sidebar strip */}
      <div style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: 22,
        background: p.surface,
        borderRight: `var(--border-width) solid ${p.accent}22`,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        paddingTop: 8, gap: 5,
      }}>
        <div style={{ width: 10, height: 10, borderRadius: 0, background: p.accent }} />
        <div style={{ width: 10, height: 10, borderRadius: 0, background: `${p.text}22` }} />
        <div style={{ width: 10, height: 10, borderRadius: 0, background: `${p.text}22` }} />
      </div>
      {/* Fake content area */}
      <div style={{ marginLeft: 30, paddingTop: 10, paddingRight: 8 }}>
        <div style={{ background: `${p.text}33`, borderRadius: 0, height: 6, width: '75%', marginBottom: 6 }} />
        <div style={{ background: `${p.text}22`, borderRadius: 0, height: 4, width: '55%', marginBottom: 5 }} />
        <div style={{ background: `${p.text}22`, borderRadius: 0, height: 4, width: '68%' }} />
      </div>
      {/* Accent dot (send button approximation) */}
      <div style={{
        position: 'absolute', bottom: 8, right: 8,
        width: 18, height: 18, borderRadius: 0, background: p.accent,
      }} />
    </div>
  )
}

// ── Custom themes (imported design mockups) ─────────────────────────────────

/** Swatch colors of a stored theme, read back out of its own generated CSS. */
function customThemeColors(css: string): Omit<ThemePreview, 'id' | 'label'> {
  const { vars } = collectRootVariables(css)
  return {
    accent:  vars['--accent']       ?? '#888888',
    bg:      vars['--bg-base']      ?? '#111111',
    surface: vars['--bg-surface']   ?? '#1a1a1a',
    text:    vars['--text-primary'] ?? '#f5f5f5',
  }
}

interface PendingImport {
  theme: ExtractedTheme
  validation: ThemeValidation
}

/**
 * Import a Claude-Design-style HTML mockup (or a bare .css) and turn it into a
 * live theme: extract -> validate -> apply. Errors block APPLY; warnings are
 * listed and ignored. Applying injects the sheet immediately (no rebuild) and
 * persists it under AppSettings.customThemes.
 */
function CustomThemesSection() {
  const { t } = useTranslation('settings')
  const confirm = useConfirm()
  const { theme, customThemes, setTheme, addCustomTheme, removeCustomTheme } = useThemeStore()
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [pending, setPending] = useState<PendingImport | null>(null)
  const [readError, setReadError] = useState('')

  /**
   * A real Claude Design handoff is TWO sheets — `<name>.css` (the palette) and
   * `<name>-structure.css` (the chassis) — so the picker takes several files.
   * The MAIN one is the first mockup, else the first sheet that is not a
   * structure companion; everything left over is merged into the structure
   * layer. One file still works exactly as before.
   */
  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = '' // let the same file be picked twice in a row
    if (files.length === 0) return
    setReadError('')
    try {
      const isStructure = (f: File) => /structure\.css$/i.test(f.name)
      const main = files.find(f => /\.html?$/i.test(f.name)) ?? files.find(f => !isStructure(f)) ?? files[0]!
      const text = await main.text()
      const structureSource = (await Promise.all(files.filter(f => f !== main).map(f => f.text()))).join('\n')
      const name = main.name.replace(/\.[^.]+$/, '')
      const extracted = extractTheme(text, { id: name, label: name, structureSource })
      setPending({
        theme: extracted,
        validation: validateThemeCss(extracted.css, { themeId: extracted.themeId }),
      })
    } catch {
      setPending(null)
      setReadError(t('appearance.custom.readFailed'))
    }
  }

  const applyPending = () => {
    if (!pending || !pending.validation.ok) return
    const { slug, label, css, structureCss, themeId } = pending.theme
    addCustomTheme({ id: slug, label, css, ...(structureCss ? { structureCss } : {}) })
    setTheme(themeId)
    setPending(null)
  }

  const remove = async (id: string, label: string) => {
    const ok = await confirm({ message: t('appearance.custom.deleteConfirm', { label }) })
    if (ok) removeCustomTheme(id)
  }

  const btn: React.CSSProperties = {
    border: 'var(--border-width) solid var(--border)',
    background: 'transparent', color: 'var(--text-primary)',
    fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
    textTransform: 'uppercase', letterSpacing: '0.08em',
    padding: '6px 10px', cursor: 'pointer', borderRadius: 0,
  }

  return (
    <div style={{ marginTop: 32 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <h3 style={{ fontSize: 11, fontWeight: 700, margin: 0, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          {t('appearance.custom.section')}
        </h3>
        <button style={btn} onClick={() => fileRef.current?.click()}>{t('appearance.custom.import')}</button>
        <input
          ref={fileRef}
          type="file"
          accept=".html,.htm,.css"
          multiple
          onChange={onPick}
          style={{ display: 'none' }}
        />
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 12, maxWidth: 520 }}>
        {t('appearance.custom.hint')}
      </div>

      {readError && (
        <div style={{ fontSize: 10, color: 'var(--danger)', marginBottom: 12 }}>{readError}</div>
      )}

      {/* Import report — the gate between a mockup and a live theme. */}
      {pending && (
        <div style={{
          border: 'var(--border-width) solid var(--border)',
          padding: 12, marginBottom: 16, maxWidth: 560,
          background: 'var(--bg-elevated)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 700 }}>{pending.theme.label}</span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
              {t('appearance.custom.counts', {
                mapped: pending.theme.report.mapped.length,
                synthesized: pending.theme.report.synthesized.length,
                missing: pending.theme.report.missing.length,
              })}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div style={{ width: 140, border: 'var(--border-width) solid var(--border)' }}>
              <ThemeSwatch p={customThemeColors(pending.theme.css)} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {pending.validation.errors.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--danger)', marginBottom: 4 }}>
                    {t('appearance.custom.errors')}
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 16, fontSize: 10, color: 'var(--danger)' }}>
                    {pending.validation.errors.map((issue, i) => <li key={i}>{issue.message}</li>)}
                  </ul>
                </div>
              )}
              {pending.validation.warnings.length > 0 && (
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--warning)', marginBottom: 4 }}>
                    {t('appearance.custom.warnings')}
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 16, fontSize: 10, color: 'var(--text-muted)' }}>
                    {pending.validation.warnings.map((issue, i) => <li key={i}>{issue.message}</li>)}
                  </ul>
                </div>
              )}
              {pending.validation.ok && pending.validation.warnings.length === 0 && (
                <div style={{ fontSize: 10, color: 'var(--success)' }}>{t('appearance.custom.clean')}</div>
              )}
              {/* Structure layer — reported separately: it is guarded by the
                  extractor, not by validateThemeCss (which bans at-rules). */}
              {pending.theme.structure.errors.length > 0 && (
                <div style={{ fontSize: 10, color: 'var(--warning)', marginTop: 6 }}>
                  {t('appearance.custom.structureRefused', { reason: pending.theme.structure.errors[0] })}
                </div>
              )}
              {pending.theme.structureCss && (
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6, fontFamily: 'JetBrains Mono, monospace' }}>
                  {t('appearance.custom.structureCounts', {
                    rules: pending.theme.structure.rules,
                    keyframes: pending.theme.structure.keyframes.length,
                    dropped: pending.theme.structure.dropped.length,
                  })}
                </div>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
            <button
              onClick={applyPending}
              disabled={!pending.validation.ok}
              style={{
                ...btn,
                borderColor: pending.validation.ok ? 'var(--accent)' : 'var(--border)',
                color: pending.validation.ok ? 'var(--accent-text)' : 'var(--text-dim)',
                cursor: pending.validation.ok ? 'pointer' : 'default',
              }}
            >{t('appearance.custom.apply')}</button>
            <button onClick={() => setPending(null)} style={btn}>{t('appearance.custom.discard')}</button>
            {!pending.validation.ok && (
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t('appearance.custom.blocked')}</span>
            )}
          </div>
        </div>
      )}

      {/* Stored themes */}
      {customThemes.length === 0 ? (
        <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{t('appearance.custom.empty')}</div>
      ) : (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {customThemes.map(ct => {
            const id = `custom:${ct.id}` as Theme
            const colors = customThemeColors(ct.css)
            const active = theme === id
            return (
              <div key={ct.id} style={{
                width: 160,
                border: active ? `2px solid ${colors.accent}` : '2px solid var(--border)',
                boxShadow: active ? `0 0 0 2px ${colors.accent}33` : 'none',
              }}>
                <button
                  onClick={() => setTheme(id)}
                  title={t('appearance.switchTo', { theme: ct.label })}
                  style={{ display: 'block', width: '100%', padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                >
                  <ThemeSwatch p={colors} />
                </button>
                <div style={{
                  background: colors.surface, padding: '7px 10px',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
                }}>
                  {/* The STRUCTURE badge eats ~64px of a 160px card, which used
                      to crush a one-line label into "tachiko…". Two-line clamp
                      + a title tooltip: the name stays readable, the card keeps
                      its width, and the badge group never shrinks. */}
                  <span
                    title={ct.label}
                    style={{
                      flex: '1 1 auto', minWidth: 0,
                      fontSize: 11, fontWeight: 600, lineHeight: 1.25, color: colors.text,
                      display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2,
                      overflow: 'hidden', overflowWrap: 'anywhere',
                    }}
                  >
                    {ct.label}
                  </span>
                  <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                    {/* This import brought a chassis, not just a recolour. */}
                    {ct.structureCss && (
                      <span
                        title={t('appearance.custom.structureTitle')}
                        style={{
                          fontSize: 8, fontWeight: 700, letterSpacing: '0.08em',
                          fontFamily: 'JetBrains Mono, monospace', flexShrink: 0,
                          padding: '1px 3px', color: colors.accent,
                          border: `1px solid ${colors.accent}66`,
                        }}
                      >{t('appearance.custom.structure')}</span>
                    )}
                    {active && <span style={{ fontSize: 10, fontWeight: 700, color: colors.accent }}>✓</span>}
                    <button
                      onClick={() => remove(ct.id, ct.label)}
                      title={t('appearance.custom.delete')}
                      style={{
                        border: 'none', background: 'none', cursor: 'pointer', padding: 0,
                        fontSize: 10, fontWeight: 700, color: colors.text, opacity: 0.6,
                      }}
                    >✕</button>
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const TAB_IDS: Tab[] = ['connections', 'appearance', 'shortcuts', 'advanced']

export function SettingsPage() {
  const { t } = useTranslation('settings')
  // Deep-linkable: /settings?tab=appearance — sidebar "Providers"/"Customize"
  // links land on the RIGHT settings tab instead of both dumping on the default.
  const [searchParams] = useSearchParams()
  const requested = searchParams.get('tab') as Tab | null
  const [tab, setTab]             = useState<Tab>(requested && TAB_IDS.includes(requested) ? requested : 'connections')
  const { theme, setTheme }       = useThemeStore()

  // Deep-link from the CODE-tab CODEX chip: land on Connections and scroll the
  // buried card into view (it sits below ~20 provider rows otherwise).
  // Also serves the Flows rail's "schedule this flow" link, which lands on
  // Advanced and scrolls the scheduler card into view (SchedulerSection reads
  // `tachi:schedule-flow` itself to pre-fill the form).
  useEffect(() => {
    const target = sessionStorage.getItem('tachi:settings-scroll')
    // 'api-keys' is the Catalog tab's deep link: a Civitai search that fails
    // (routinely a rate limit) offers "where's my key?", and landing on the
    // Connections tab at the top would drop the user above ~20 provider cards
    // with the thing they came for off-screen.
    if (target !== 'codex' && target !== 'scheduler' && target !== 'api-keys') return
    sessionStorage.removeItem('tachi:settings-scroll')
    setTab(target === 'scheduler' ? 'advanced' : 'connections')
    const anchor = target === 'codex' ? 'codex-worker-card'
      : target === 'scheduler' ? 'scheduler-card'
      : 'settings-section-api-keys'
    const timer = setTimeout(() => {
      document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 350)
    return () => clearTimeout(timer)
  }, [])
  const [resetDone, setResetDone] = useState(false)
  const [resetting, setResetting] = useState(false)
  const confirm                   = useConfirm()

  // ── Connections anchor rail: filter + scroll-spy ────────────────────────────
  const scrollRef                             = useRef<HTMLDivElement | null>(null)
  const [connFilter, setConnFilter]           = useState('')
  const [activeConnSection, setActiveConnSection] = useState<RailSectionId>('local')

  // Scroll-spy: walk the five section wrappers top-down; the last one whose top
  // has passed a 96px line below the container top is "in view". Plain scroll
  // listener + rAF throttle — 5 getBoundingClientRect calls per frame, cheap.
  useEffect(() => {
    if (tab !== 'connections') return
    const el = scrollRef.current
    if (!el) return
    let raf = 0
    const measure = () => {
      raf = 0
      const container = scrollRef.current
      if (!container) return
      const topEdge = container.getBoundingClientRect().top
      let current: RailSectionId | null = null
      for (const id of CONN_SECTION_IDS) {
        const node = document.getElementById(`settings-section-${id}`)
        if (!node) continue
        const rect = node.getBoundingClientRect()
        if (rect.height === 0) continue // hidden by the name filter
        if (current === null || rect.top - topEdge <= 96) current = id
      }
      const next = current
      if (next !== null) setActiveConnSection(prev => (prev === next ? prev : next))
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure) }
    measure()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => { el.removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf) }
  }, [tab, connFilter])

  const jumpToConnSection = (id: RailSectionId) => {
    document.getElementById(`settings-section-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const openDataFolder = async () => {
    try {
      const p = await window.tachi.app.getDataPath()
      await window.tachi.shell.openExternal(p)
    } catch { /* silently ignore — IPC or shell open failure */ }
  }

  const resetOnboarding = async () => {
    const ok = await confirm({ message: t('advanced.onboarding.confirm') })
    if (!ok) return
    setResetDone(false)
    setResetting(true)
    await window.tachi.app.resetOnboarding().catch(() => {})
    setResetDone(true)
    setResetting(false)
  }

  const openDevTools = () => window.tachi.app.openDevTools().catch(() => {})

  // ── Connections: card → section mapping (app glossary) ─────────────────────
  // Every card lands in exactly one rail section. `title` is the searchable
  // name the filter matches against (case-insensitive substring) — it mirrors
  // the card's visible heading, plus visible sub-row names for composite cards
  // (e.g. the Free Providers card also shows llama.cpp / MCP / OpenAI API rows).
  // Cards are wrapped, never modified; hidden via display:none so their state
  // (probes, half-typed keys) survives filtering.
  const connSections: Array<{
    id: RailSectionId
    label: string
    cards: Array<{ key: string; title: string; node: React.ReactNode }>
  }> = [
    {
      id: 'local',
      label: t('connections.rail.local', { defaultValue: 'Local Servers' }),
      cards: [
        { key: 'free-providers',  title: 'Free Providers · FreeLLM · llama.cpp · MCP Server · OpenAI API', node: <ProvidersCard /> },
        { key: 'free-claude-code', title: t('freeClaudeCode.title'), node: <FreeClaudeCodeCard /> },
        { key: 'claude-code-router', title: t('router.heading'), node: <RouterSection /> },
        { key: 'mcp-servers',     title: t('mcp.heading'), node: <MCPServersSection /> },
        { key: 'whisper',         title: t('whisper.heading'), node: <WhisperSection /> },
      ],
    },
    {
      id: 'providers',
      label: t('connections.rail.providers', { defaultValue: 'Providers' }),
      cards: [
        { key: 'opengateway', title: t('openGateway.title'), node: <OpenGatewayCard /> },
        { key: 'bankr',       title: t('bankr.title'), node: <BankrCard /> },
        { key: 'surplus',     title: t('surplus.title'), node: <SurplusCard /> },
        { key: 'venice',      title: t('venice.title'), node: <VeniceCard /> },
        { key: 'imgnai',      title: t('imgnai.title'), node: <ImgnaiCard /> },
        { key: 'custom-endpoint', title: `${t('customEndpoint.title', { defaultValue: 'Custom endpoint (OpenAI-compatible)' })} · LM Studio · Ollama · llama.cpp · vLLM · LAN`, node: <CustomEndpointsCard /> },
        { key: 'anthropic',   title: t('anthropicOAuth.title'), node: <AnthropicOAuthCard /> },
        { key: 'openrouter',  title: 'OpenRouter', node: <OpenRouterOAuthCard /> },
      ],
    },
    {
      id: 'agents',
      label: t('connections.rail.agents', { defaultValue: 'Agents' }),
      cards: [
        { key: 'codex', title: t('codex.title'), node: <CodexWorkerCard /> },
        { key: 'skills', title: `${t('skills.title')} · SKILL.md`, node: <SkillsCard /> },
      ],
    },
    {
      // THE SECTION THE OWNER COULD NOT FIND. Both cards here are WEIGHTS-HOST
      // credentials: not inference providers (nothing here is chattable, so the
      // Providers rail would imply the wrong thing) and not web search (where
      // they used to live, which is why they were invisible).
      //
      // The titles carry the words someone would actually type into the rail's
      // filter box — "API key", "token", "models", "download" — because that
      // filter matches on the TITLE and a card called just "Civitai" answers
      // none of the queries a lost user makes.
      id: 'api-keys',
      label: t('connections.rail.apiKeys', { defaultValue: 'API Keys' }),
      cards: [
        { key: 'civitai', title: `${t('civitai.title')} · API key · Models · Downloads`, node: <CivitaiCard /> },
        { key: 'huggingface', title: `${t('huggingface.title')} · API key · Token · Models · Downloads`, node: <HuggingFaceCard /> },
      ],
    },
    {
      id: 'search',
      label: t('connections.rail.search', { defaultValue: 'Search' }),
      cards: [
        { key: 'web-search', title: `${t('webSearch.title')} · Brave · Tavily`, node: <WebSearchCard /> },
      ],
    },
    {
      id: 'other',
      label: t('connections.rail.other', { defaultValue: 'Sign-in / Other' }),
      cards: [
        { key: 'telegram',   title: 'Telegram', node: <TelegramCard /> },
        { key: 'connectors', title: `${t('connectors.heading')} · GitHub`, node: <ConnectorsSection /> },
        { key: 'memory',     title: t('memory.title'), node: <MemorySection /> },
        { key: 'fusion',     title: 'Fusion', node: <FusionSection /> },
      ],
    },
  ]

  const connQuery = connFilter.trim().toLowerCase()
  const cardMatches = (title: string) => connQuery === '' || title.toLowerCase().includes(connQuery)
  const connSectionsWithVis = connSections.map(s => ({
    ...s,
    visibleCount: s.cards.filter(c => cardMatches(c.title)).length,
  }))
  const anyConnVisible = connSectionsWithVis.some(s => s.visibleCount > 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-base)', color: 'var(--text-primary)' }}>

      {/* ── Header ── */}
      <div style={{
        padding: '14px 20px', borderBottom: 'var(--border-width) solid var(--border)',
        background: 'var(--bg-surface)', flexShrink: 0,
      }}>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Settings</h1>
      </div>

      {/* ── Tab bar ── */}
      <div style={{
        display: 'flex', padding: '0 20px',
        borderBottom: 'var(--border-width) solid var(--border)',
        background: 'var(--bg-surface)', flexShrink: 0,
      }}>
        {(['connections', 'appearance', 'shortcuts', 'advanced'] as Tab[]).map(tabId => (
          <button
            key={tabId}
            onClick={() => setTab(tabId)}
            style={{
              padding: '10px 16px', border: 'none', cursor: 'pointer',
              background: 'transparent', fontSize: 13, fontWeight: 600,
              color: tab === tabId ? 'var(--accent)' : 'var(--text-muted)',
              borderBottom: tab === tabId ? '2px solid var(--accent)' : '2px solid transparent',
              textTransform: 'capitalize',
            }}
          >
            {t(`tabs.${tabId}`)}
          </button>
        ))}
      </div>

      {/* ── Content ── */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 20 }}>

        {/* Connections — anchor rail + filter over the grouped cards.
            Cards are reused untouched (ProvidersCard still owns key CRUD and
            the "N / M connected" counter; #codex-worker-card keeps its id for
            the sessionStorage deep-link). */}
        {tab === 'connections' && (
          <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
            <ConnectionsRail
              items={connSectionsWithVis.map(s => ({ id: s.id, label: s.label, visibleCount: s.visibleCount }))}
              activeId={activeConnSection}
              filter={connFilter}
              onFilterChange={setConnFilter}
              onJump={jumpToConnSection}
            />
            <div style={{ flex: 1, maxWidth: 640, minWidth: 0 }}>
              <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '0 0 16px' }}>
                {t('connections.intro')}
              </p>
              {connSectionsWithVis.map(s => (
                <div
                  key={s.id}
                  id={`settings-section-${s.id}`}
                  style={{ display: s.visibleCount > 0 ? undefined : 'none', scrollMarginTop: 8 }}
                >
                  <Section title={s.label}>
                    {s.cards.map(c => (
                      <div key={c.key} style={{ display: cardMatches(c.title) ? undefined : 'none' }}>
                        {c.node}
                      </div>
                    ))}
                  </Section>
                </div>
              ))}
              {!anyConnVisible && (
                <div style={{
                  border: 'var(--border-width) solid var(--border)',
                  padding: '10px 12px',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 10, color: 'var(--text-muted)',
                  textTransform: 'uppercase', letterSpacing: '0.08em',
                }}>
                  {t('connections.filterNoMatches', { defaultValue: 'No connections match — clear the filter.' })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Shortcuts — keyboard shortcut remapping */}
        {tab === 'shortcuts' && (
          <ShortcutsSection />
        )}

        {/* Appearance — visual theme picker */}
        {tab === 'appearance' && (
          <div style={{ maxWidth: 600 }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 16px' }}>{t('appearance.theme')}</h2>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              {THEME_PREVIEWS.map(tp => (
                <button
                  key={tp.id}
                  onClick={() => setTheme(tp.id)}
                  title={t('appearance.switchTo', { theme: tp.label })}
                  style={{
                    width: 160, padding: 0, cursor: 'pointer',
                    borderRadius: 0, overflow: 'hidden',
                    border: theme === tp.id ? `2px solid ${tp.accent}` : '2px solid var(--border)',
                    boxShadow: theme === tp.id ? `0 0 0 2px ${tp.accent}33` : 'none',
                    background: 'none',
                    transition: 'border 0.15s, box-shadow 0.15s',
                  }}
                >
                  {/* Mini app preview */}
                  <ThemeSwatch p={tp} />
                  {/* Label row */}
                  <div style={{
                    background: tp.surface, padding: '7px 10px',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: tp.text }}>{tp.label}</span>
                    {theme === tp.id && (
                      <span style={{ fontSize: 10, fontWeight: 700, color: tp.accent }}>✓</span>
                    )}
                  </div>
                </button>
              ))}
            </div>

            {/* Imported themes: design mockup -> extract -> validate -> live. */}
            <CustomThemesSection />
          </div>
        )}

        {/* Advanced — data folder, onboarding reset, devtools */}
        {tab === 'advanced' && (
          <div style={{ maxWidth: 560 }}>
            {/* Privacy — strict mode + provider gating */}
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
              {t('advanced.privacy')}
            </div>
            <div style={{ marginBottom: 24 }}>
              <PrivacySection />
            </div>

            {/* Agent context recall — history recap + saved-chat excerpts, budgeted. */}
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
              {t('contextRecall.section')}
            </div>
            <div style={{ marginBottom: 24 }}>
              <ContextRecallSection />
            </div>

            {/* Local engine — llama.cpp KV-cache precision (VRAM, not speed). */}
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
              {t('localEngine.section')}
            </div>
            <div style={{ marginBottom: 24 }}>
              <LocalEngineSection />
            </div>

            {/* Backup & export — everything out, everything back (no keys). */}
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
              {t('advanced.backup.section')}
            </div>
            <div style={{ marginBottom: 24 }}>
              <BackupSection />
            </div>

            {/* Danger zone — delete all data */}
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--danger, var(--text-muted))', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
              {t('advanced.dangerZone')}
            </div>
            <div style={{ marginBottom: 24 }}>
              <DeleteAllDataSection />
            </div>

            <Section title={t('storage.section')}>
              <StorageCard />
            </Section>

            <Section title={t('modelStorage.section', { defaultValue: 'Model weights' })}>
              <ModelStorageSection />
            </Section>

            {/* Local scheduler — saved flows / prompts on a timer, offline. */}
            <Section title={t('scheduler.section', { defaultValue: 'Scheduled' })}>
              <SchedulerSection />
            </Section>

            <Section title={t('advanced.data.section')}>
              <SettingsCard
                title={t('advanced.data.title')}
                description={t('advanced.data.description')}
                status={<span>{t('advanced.data.status')}</span>}
                onClick={openDataFolder}
              />
            </Section>

            <Section title={t('advanced.onboarding.section')}>
              <SettingsCard
                title={t('advanced.onboarding.title')}
                description={t('advanced.onboarding.description')}
                status={<span>{resetting ? '…' : resetDone ? t('advanced.onboarding.done') : t('advanced.onboarding.reset')}</span>}
                onClick={resetOnboarding}
                disabled={resetting}
              />
            </Section>

            <Section title={t('advanced.developer.section')}>
              <SettingsCard
                title={t('advanced.developer.title')}
                description={t('advanced.developer.description')}
                status={<span>{t('advanced.developer.status')}</span>}
                onClick={openDevTools}
              />
            </Section>

            <NotificationsSection />
            <AboutSection />
          </div>
        )}

      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h3 style={{
        fontSize: 11, fontWeight: 700, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.08em',
        margin: '0 0 8px',
      }}>
        {title}
      </h3>
      <div style={{
        background: 'var(--bg-surface)', borderRadius: 0,
        border: 'var(--border-width) solid var(--border)', overflow: 'hidden',
      }}>
        {children}
      </div>
    </div>
  )
}

function SettingsRow({ label, desc, action }: { label: string; desc: string; action: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 16px', borderBottom: 'var(--border-width) solid var(--border)',
    }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{desc}</div>
      </div>
      <div style={{ marginLeft: 16, flexShrink: 0 }}>{action}</div>
    </div>
  )
}

const actionBtn: React.CSSProperties = {
  padding: '5px 12px', borderRadius: 0, fontSize: 12, fontWeight: 600, cursor: 'pointer',
  border: 'var(--border-width) solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)',
}

// ── Notifications section ─────────────────────────────────────────────────────

function NotificationsSection() {
  const { t } = useTranslation('settings')
  const [enabled, setEnabled] = React.useState(true)

  React.useEffect(() => {
    window.tachi.settings.load().then((s: { notificationsEnabled?: boolean }) => {
      setEnabled(s.notificationsEnabled !== false)
    }).catch(() => {})
  }, [])

  const toggle = async (v: boolean) => {
    setEnabled(v)
    await window.tachi.settings.save({ notificationsEnabled: v } as Parameters<typeof window.tachi.settings.save>[0])
  }

  return (
    <SettingsSection title={t('notifications.section')}>
      <SettingsRow
        label={t('notifications.label')}
        desc={t('notifications.desc')}
        action={
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12 }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={e => toggle(e.target.checked)}
            />
            {enabled ? t('notifications.on') : t('notifications.off')}
          </label>
        }
      />
    </SettingsSection>
  )
}

// ── About / Updates section ───────────────────────────────────────────────────

function AboutSection() {
  const { t } = useTranslation('settings')
  const [checking, setChecking]   = React.useState(false)
  const [updateState, setUpdateState] = React.useState<{ state: string; version?: string } | null>(null)

  const checkForUpdates = async () => {
    setChecking(true)
    try {
      const result = await window.tachi.app.checkForUpdates()
      // Honest states: 'current' = up to date, 'unconfigured' = no update feed
      // for this build (never claim up-to-date in that case), 'error' = check
      // failed. A genuinely-newer build arrives via the onUpdateStatus listener
      // ('available'/'ready'), so only overwrite when this check is conclusive.
      if (result.state !== 'available') {
        setUpdateState({ state: result.state })
      }
    } catch {
      setUpdateState({ state: 'error' })
    } finally {
      setChecking(false)
    }
  }

  const install = () => window.tachi.app.quitAndInstall().catch(() => {})

  return (
    <SettingsSection title={t('about.section')}>
      <SettingsRow
        label={t('about.label')}
        desc={
          updateState?.state === 'available'
            ? t('about.available', { version: updateState.version ?? '?' })
            : updateState?.state === 'ready'
              ? t('about.ready', { version: updateState.version ?? '?' })
              : updateState?.state === 'current'
                ? t('about.upToDate')
                : updateState?.state === 'unconfigured'
                  ? t('about.unconfigured', { defaultValue: 'Automatic updates are not configured for this build — download new versions manually.' })
                  : updateState?.state === 'error'
                    ? t('about.error', { defaultValue: 'Update check failed. Check your connection and try again.' })
                    : t('about.default')
        }
        action={
          <div style={{ display: 'flex', gap: 6 }}>
            {updateState?.state === 'available' && (
              <button
                onClick={() => window.tachi.app.downloadUpdate().catch(() => {})}
                style={actionBtn}
              >{t('about.download')}</button>
            )}
            {updateState?.state === 'ready' && (
              <button onClick={install} style={actionBtn}>{t('about.restart')}</button>
            )}
            <button onClick={checkForUpdates} disabled={checking} style={actionBtn}>
              {checking ? t('about.checking') : t('about.check')}
            </button>
          </div>
        }
      />
    </SettingsSection>
  )
}
