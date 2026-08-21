// apps/desktop/src/pages/catalog/ModelCard.tsx
import React from 'react'
import type { CatalogEntry, HardwareProfile } from '@tachi/core'
// Direct subpath import — see note in CatalogPage.tsx (avoids pulling the
// node-only core barrel into the browser bundle).
import { estimateFit } from '@tachi/core/src/catalog/fit'
import { useTranslation } from 'react-i18next'
import { findSiblings, type SiblingResult } from './familySiblings'
import { ProviderIcon } from '../../components/ProviderIcon'
import { computeLocalFitBadge, type LocalFitBadge } from './localFit'
import {
  showsFitVerdict, showsSizeChip, showsFavoriteControl, formatModelSize, rowSizeBytes,
  isMediaRow, mediaFitNote,
} from './rowMeta'
import {
  civitaiAffordance,
  civitaiLicenseBadges,
  civitaiNameParts,
  civitaiPreviewBlurred,
  civitaiRowChips,
  civitaiShowsFitVerdict,
  civitaiTypeFilterIdForType,
} from './civitaiRow'
import { civitaiCompactCount } from './civitaiDetail'
import type { CivitaiSearchRow } from '../../types/electron'

/**
 * One-verb RUN button state (UX-benchmark #9) for llama.cpp-servable cards:
 *   'run'         → click kicks download (if needed) → serve → chat
 *   'downloading' → GGUF download in flight (progress bar above the grid)
 *   'starting'    → llama-server spawning / model loading
 *   'openChat'    → server IS running with this model — click opens chat
 * Null/undefined = not llama.cpp-servable → legacy Run/Download behavior.
 */
export type RunState = 'run' | 'downloading' | 'starting' | 'openChat'

export const RUN_LABEL_KEY: Record<RunState, string> = {
  run: 'run',
  downloading: 'downloading',
  starting: 'starting',
  openChat: 'openChat',
}

export function ModelCard({
  entry, hw, installed, favorite, onDownload, onRun, onToggleFavorite, catalog, runState,
  civitai, installing, onInstall, adultServed, blockedReason, onOpenDetail,
}: {
  entry: CatalogEntry
  hw: HardwareProfile | null
  installed: boolean
  favorite: boolean
  onDownload: () => void
  onRun: () => void
  onToggleFavorite: () => void
  /** Full catalog (curated + hf) — enables family-sibling modality suggestions. */
  catalog?: CatalogEntry[]
  /** One-verb RUN state for llama.cpp-servable entries (null = legacy buttons). */
  runState?: RunState | null
  /**
   * The source row behind a `source: 'civitai'` card. Present ⇒ the card grows
   * the Civitai-only blocks (preview, base/format/precision chips, license
   * badges, trigger words) and its footer is decided by civitaiAffordance()
   * instead of the download/run pair.
   */
  civitai?: CivitaiSearchRow
  /** This Civitai row's install is in flight (progress lives in the shared strip). */
  installing?: boolean
  /** Install click for a Civitai row. */
  onInstall?: () => void
  /**
   * Whether the PAGE this row came back on was served in adult mode
   * (main's `result.adult`), not whether 18+ is switched on locally.
   *
   * It is the outer input to the preview blur: in SFW mode main requested
   * `nsfw=false`, which clamps previews to PG, so a blur there would be theatre
   * — and an older main build that predates `thumbnailNsfwLevel` would fog
   * every card in the safest mode there is.
   */
  adultServed?: boolean
  /**
   * A LOCAL row we refuse to ship, and WHY (blockedLocalRows). Present ⇒ the
   * footer is the reason and nothing else — the same honesty law the Civitai
   * branch below applies, reached through a different door because these rows
   * come from our own registry rather than a search result.
   */
  blockedReason?: string | null
  /**
   * Open the detail panel for a Civitai row.
   *
   * TWO WAYS IN, ON PURPOSE. The card BODY is clickable for the mouse (which is
   * what anyone expects of a card that has more to say), and the NAME is a real
   * focusable button for the keyboard and for a screen reader. The whole card is
   * deliberately NOT `role="button"`: it already contains buttons (the star, the
   * reveal, the trigger chips, Install), and nesting interactive elements is how
   * a card becomes unusable with assistive tech. The title is the natural
   * affordance and it costs no extra control.
   */
  onOpenDetail?: () => void
}) {
  const { t } = useTranslation('catalog')
  /**
   * Preview reveal. Two levels on purpose: HOVER peeks (transient, costs
   * nothing to undo), a CLICK commits for the life of the card. Neither exists
   * outside adult mode — civitaiPreviewBlurred() returns false there, so there
   * is nothing to reveal and no control is drawn.
   */
  const [revealed, setRevealed] = React.useState(false)
  const [peeking, setPeeking] = React.useState(false)
  // Card-level badge uses the smallest quant (best chance to fit).
  const quants = entry.quants ?? []
  const smallest = [...quants].sort((a, b) => a.sizeBytes - b.sizeBytes)[0]
  // Speech rows (piper voices / whisper STT weights) get NO fit verdict — the
  // estimator is a text-transformer heuristic and returned a confident "Fits in
  // GPU (fast)" for every 28-63 MB voice, which is a fabricated VRAM claim about
  // an engine that never offloads. They show their honest download size instead.
  // …and neither do Civitai rows that are not checkpoints: the same estimator
  // pointed at a 150 MB LoRA returns a confident "Fits in GPU (fast)" about a
  // file that never occupies VRAM on its own. The honest replacement — the
  // download-size chip — is already below.
  const fitApplies = showsFitVerdict(entry) && (!civitai || civitaiShowsFitVerdict(civitai))
  const fit = fitApplies && hw && smallest ? estimateFit({ sizeBytes: smallest.sizeBytes, hardware: hw }) : null
  // sd.cpp rows (curated local image/video models AND Civitai checkpoints —
  // both are tagged quants[0].runtime === 'sdcpp') never reach the branch
  // above: showsFitVerdict() suppresses them. This is their honest
  // replacement, gated by the SAME checkpoint-only rule civitaiShowsFitVerdict
  // already applies above (a Civitai LoRA/VAE never sits in VRAM on its own —
  // its honest line is already the size chip below, not a VRAM note).
  const mediaNoteApplies = isMediaRow(entry) && (!civitai || civitaiShowsFitVerdict(civitai))
  const mediaNote = mediaNoteApplies ? mediaFitNote(entry) : null
  // The size chip is decided INDEPENDENTLY of the fit verdict. Deriving it from
  // `fitApplies` meant an sd.cpp media row silently lost the only place its
  // multi-GB download size was shown (true when this chip was introduced and
  // sd.cpp still got the computed verdict; still true now that W4-B suppresses
  // that verdict and replaces it with mediaNote instead — the size chip must
  // stay its own decision either way). See showsSizeChip().
  const sizeLabel = showsSizeChip(entry) ? formatModelSize(rowSizeBytes(entry)) : null
  // VRAM-aware fit badge for local llama.cpp / ollama models (params+quant
  // estimate). Null for non-local rows or when params can't be parsed —
  // render nothing in that case (silent degrade).
  const localFit: LocalFitBadge | null = computeLocalFitBadge(entry, hw)
  // Defensive: data fetched from an older main-process build may lack these.
  const capabilities = entry.capabilities ?? []
  // Open-GenAI family-sibling coherence: suggest related-modality variants
  // (text->vision, image-gen<->video-gen, tts<->stt) from the loaded catalog.
  const siblings: SiblingResult[] = catalog ? findSiblings(entry, catalog) : []
  // Civitai extras. `affordance` is THE honesty gate: a blocked row renders the
  // reason where the button would be, and no button is drawn at all.
  const cvChips = civitai ? civitaiRowChips(civitai) : []
  const cvLicense = civitai ? civitaiLicenseBadges(civitai.license) : []
  const cvWords = civitai ? (civitai.trainedWords ?? []).filter(w => typeof w === 'string' && w.trim() !== '') : []
  const affordance = civitai ? civitaiAffordance(civitai, { installed, installing }) : null
  // Model name and version name, split back apart — main joins them, and one
  // run-on line is measurably harder to scan in a grid.
  const cvName = civitai ? civitaiNameParts(civitai) : null
  // The row's own type, said in the same words the filter chips use. Null =
  // a type we have no word for; the raw API string is then shown verbatim
  // rather than given an invented friendly name.
  const cvTypeId = civitai ? civitaiTypeFilterIdForType(civitai.type) : null
  const cvTypeLabel = civitai
    ? (cvTypeId ? t(`civitai.types.${cvTypeId}`) : (civitai.type ?? '').trim())
    : ''
  // THE 18+ BLUR. `adultServed` is the outer gate (see the prop's note); the
  // level bitmask decides inside it. Hover peeks, a click commits.
  const blurEligible = civitai ? civitaiPreviewBlurred(civitai, { adult: adultServed }) : false
  const blurNow = blurEligible && !revealed && !peeking
  /**
   * Card-body click → the detail panel.
   *
   * ONE GUARD instead of a stopPropagation on every child: if the click landed
   * on (or inside) a control, that control owns it. Without this, clicking
   * Install would ALSO open the panel — an install starting behind a panel the
   * user did not ask for is the kind of double-action that reads as a bug.
   */
  const openDetail = onOpenDetail
    ? (e: React.MouseEvent) => {
        const el = e.target as HTMLElement | null
        if (el?.closest?.('button, a, input, select, textarea')) return
        onOpenDetail()
      }
    : undefined
  return (
    <div
      onClick={openDetail}
      style={{
        border: 'var(--border-width) solid var(--border)', padding: 12,
        display: 'flex', flexDirection: 'column', gap: 6,
        fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
        background: 'var(--bg-elevated)',
        position: 'relative',
        cursor: openDetail ? 'pointer' : undefined,
      }}>
      {/* Star / favorite toggle — top-right corner.
          NOT drawn on a Civitai row, and not on a row we refuse to ship: you
          could otherwise favourite a model that can never be installed and pin a
          permanent "no" to the top of the rail. An ALREADY-pinned blocked row
          keeps its star so the pin can still be taken back — see
          showsFavoriteControl, which owns both rules. */}
      {showsFavoriteControl({ isCivitaiRow: !!civitai, blockedReason, favorite }) && (
        <button
          onClick={onToggleFavorite}
          title={favorite ? t('unfavorite') : t('favorite')}
          style={{
            position: 'absolute', top: 8, right: 8,
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: favorite ? 'var(--accent)' : 'var(--text-dim)',
            fontSize: 14, lineHeight: 1, padding: 2,
          }}
          aria-label={favorite ? t('unfavorite') : t('favorite')}
        >
          {favorite ? '★' : '☆'}
        </button>
      )}

      {/* THE NAME COMES FIRST IN THE DOM, the preview follows it and is pulled
          back up visually with `order: -1` (the card is a flex column, so CSS
          order and DOM order are free to disagree — and here they must).
          Driver-found: on a gated card the first text in the DOM was "Show 18+
          preview", so the reading order — and a screen reader's — began with the
          reveal control instead of with the model this card is about. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, color: 'var(--text-primary)', paddingRight: 22 }}>
        <ProviderIcon providerId={entry.family} size={14} />
        {/* The KEYBOARD door into the detail panel. A button rather than the
            whole card (see onOpenDetail): the card already holds buttons, and
            nesting interactive elements breaks assistive tech. Styled to look
            exactly like the heading it replaces — the affordance is the pointer
            cursor and the title, not a change of appearance. */}
        {onOpenDetail ? (
          <button
            onClick={onOpenDetail}
            title={t('civitai.detail.open')}
            /* The visible text IS the model name, which is a real accessible
               name — but a bare product name does not tell a screen-reader user
               that the control OPENS something, and the catalog's a11y guard
               rightly refuses a `title` as a substitute for a label. */
            aria-label={t('civitai.detail.openNamed', { name: cvName ? cvName.title : entry.name })}
            style={{
              background: 'none', border: 'none', padding: 0, margin: 0,
              font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer',
            }}
          >{cvName ? cvName.title : entry.name}</button>
        ) : (
          <span>{cvName ? cvName.title : entry.name}</span>
        )}
      </div>

      {/* Civitai preview. Always a `data:` URI resolved in main (the prod CSP
          has no https: in img-src, and a remote <img> would leak one request
          per card to their CDN). `alt=""` — the image is decorative, the name
          ABOVE it in the DOM is the label. A row with no PG preview gets an
          explicit neutral box, never a broken-image glyph or a collapsed layout.
          `order: -1` puts it back on top visually — see the note on the name. */}
      {civitai && (
        civitai.thumbnail ? (
          <div
            style={{ position: 'relative', width: '100%', height: 120, order: -1 }}
            onMouseEnter={() => { if (blurEligible) setPeeking(true) }}
            onMouseLeave={() => setPeeking(false)}
          >
            <img
              src={civitai.thumbnail}
              alt=""
              style={{
                width: '100%', height: 120, objectFit: 'cover', display: 'block',
                border: 'var(--border-width) solid var(--border)', background: 'var(--bg-base)',
                // A blur, not a black box: the composition is still readable
                // enough to tell one model from another, which is the whole
                // job of a thumbnail in a grid.
                filter: blurNow ? 'blur(14px)' : undefined,
                transition: 'filter .15s',
              }}
            />
            {/* The reveal control exists ONLY while something is actually
                blurred — outside adult mode there is nothing to reveal, so no
                button is drawn at all rather than a dead one. */}
            {blurEligible && !revealed && (
              <button
                onClick={() => setRevealed(true)}
                aria-label={t('civitai.reveal')}
                title={t('civitai.reveal')}
                style={{
                  position: 'absolute', inset: 0, width: '100%', height: '100%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 10, textShadow: '0 0 6px var(--bg-base)',
                }}
              >{t('civitai.reveal')}</button>
            )}
          </div>
        ) : (
          <div style={{
            width: '100%', height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: 'var(--border-width) solid var(--border)', background: 'var(--bg-base)',
            color: 'var(--text-dim)', fontSize: 10, order: -1,
          }}>{t('civitai.noPreview')}</div>
        )
      )}

      {/* What this row IS, plus which version of it — the two facts a Civitai
          card everywhere else in the world leads with, and the ones that decide
          whether the reason line below makes any sense. An unmapped type is
          printed verbatim; we never invent a friendly name for a type we do not
          understand. */}
      {civitai && (cvTypeLabel !== '' || cvName?.version) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
          {cvTypeLabel !== '' && (
            <span style={{
              padding: '1px 6px', border: 'var(--border-width) solid var(--accent)',
              color: 'var(--accent)', fontSize: 10, whiteSpace: 'nowrap',
            }}>{cvTypeLabel}</span>
          )}
          {cvName?.version && (
            <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{cvName.version}</span>
          )}
        </div>
      )}
      {/* family · params · runtimes — empty segments are DROPPED, not rendered
          as a gap. sd.cpp rows carry no params (`sd15 · · sdcpp` was a real
          card in the shipped build) and neither do some HF rows. */}
      <div style={{ color: 'var(--text-muted)' }}>{metaLine(entry, quants)}</div>
      {/* Popularity. The gate is the DATA, not the source: it used to read
          `entry.source === 'hf' && …`, which silently swallowed the download
          and like counts on every Civitai row even though the API hands them
          over in the same response. Curated rows carry neither field, so they
          are excluded by the same condition that used to name them. */}
      {(entry.downloads != null || entry.likes != null) && (
        <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>
          {entry.downloads != null && <span>↓ {civitaiCompactCount(entry.downloads)}</span>}
          {entry.downloads != null && entry.likes != null && <span>{'  ·  '}</span>}
          {entry.likes != null && <span>♥ {civitaiCompactCount(entry.likes)}</span>}
        </div>
      )}
      {/* base model · container format · precision — the three facts that
          decide whether this file runs in our engine at all. */}
      {cvChips.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {cvChips.map(chip => (
            <span key={chip} style={{
              padding: '1px 6px', border: 'var(--border-width) solid var(--border-strong)',
              color: 'var(--text-primary)', fontSize: 10, whiteSpace: 'nowrap',
            }}>{chip}</span>
          ))}
        </div>
      )}
      {capabilities.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {capabilities.map(cap => (
            <span key={cap} style={{
              padding: '1px 6px', border: 'var(--border-width) solid var(--border)',
              color: 'var(--text-muted)', fontSize: 10, whiteSpace: 'nowrap',
            }}>{t(`capabilities.${cap}`)}</span>
          ))}
        </div>
      )}
      {siblings.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
          <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>also:</span>
          {siblings.map(sib => (
            <span key={sib.siblingCap} title={sib.entries[0]?.name ?? ''} style={{
              padding: '1px 6px', border: 'var(--border-width) solid var(--accent)',
              color: 'var(--accent)', fontSize: 10, whiteSpace: 'nowrap',
            }}>{t(`capabilities.${sib.siblingCap}`)}</span>
          ))}
        </div>
      )}
      {localFit && (
        <div data-tour="catalog-fit" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            title={localFit.reason}
            style={{
              padding: '1px 6px',
              border: `var(--border-width) solid ${fitBadgeColor(localFit.verdict)}`,
              color: fitBadgeColor(localFit.verdict),
              fontSize: 10, fontWeight: 700, letterSpacing: 0.5, whiteSpace: 'nowrap',
            }}
          >{localFit.label}</span>
          <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>~{localFit.estVramGb} GB</span>
        </div>
      )}
      {fit && <div>{t(`fit.${fit.verdict}`)} · {quants.length} {quants.length === 1 ? t('quant') : t('quants')}</div>}
      {mediaNote && (
        mediaNote.kind === 'vram'
          ? <div style={{ color: 'var(--text-muted)' }}>{t('fit.sdcppVram', { gb: mediaNote.gb })}</div>
          : <div style={{ color: 'var(--text-dim)', fontSize: 10, lineHeight: 1.4 }}>{t('fit.sdcppNote')}</div>
      )}
      {sizeLabel && <div style={{ color: 'var(--text-muted)' }}>{t('downloadSize')} {sizeLabel}</div>}
      {/* License. The app INFORMS — it does not enforce, and it does not block
          an install over a licence. Badges appear only for a restriction the
          creator actually declared; a row with no licence data gets none. */}
      {cvLicense.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {cvLicense.map(badge => (
            <span key={badge} title={t(`civitai.license.${badge}Hint`)} style={{
              padding: '1px 6px', border: 'var(--border-width) solid var(--text-dim)',
              color: 'var(--text-dim)', fontSize: 10, whiteSpace: 'nowrap',
            }}>{t(`civitai.license.${badge}`)}</span>
          ))}
        </div>
      )}
      {/* Trigger words. Click copies one to the clipboard — these have to end up
          in a prompt, and retyping `masterpiece, (best quality:1.2)` by eye is
          how they get typo'd. Prompt-chip injection is phase 2; copy is the
          honest amount of help we can give today. */}
      {cvWords.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
          <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>{t('civitai.triggerWords')}</span>
          {cvWords.map(word => (
            <button
              key={word}
              onClick={() => { void copyText(word) }}
              title={t('civitai.copyTrigger', { word })}
              aria-label={t('civitai.copyTrigger', { word })}
              style={{
                padding: '1px 6px', border: 'var(--border-width) solid var(--accent)',
                background: 'transparent', color: 'var(--accent)',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
                cursor: 'pointer', maxWidth: '100%', overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >{word}</button>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        {blockedReason ? (
          // ── THE HONESTY LAW, LOCAL EDITION ────────────────────────────────
          // A curated row whose components we could not pin. Checked FIRST, so
          // no download / run branch below can draw a control for weights that
          // cannot be obtained — the same rule the Civitai `blocked` affordance
          // enforces, applied to our own registry. The badge is there so the
          // card is scannable in a grid; the reason underneath is main's own
          // text, which names exactly what is missing.
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{
              alignSelf: 'flex-start', padding: '1px 5px', fontSize: 8, fontWeight: 700,
              letterSpacing: '0.08em', textTransform: 'uppercase',
              border: 'var(--border-width) solid var(--border-strong)',
              color: 'var(--text-muted)',
            }}>{t('notAvailable')}</span>
            <div style={{ color: 'var(--text-dim)', fontSize: 10, lineHeight: 1.4 }}>
              {blockedReason}
            </div>
          </div>
        ) : affordance ? (
          // ── THE HONESTY LAW ──────────────────────────────────────────────
          // A row main refused gets its REASON here, in place of the button.
          // There is deliberately no disabled Install: a control that can never
          // do the thing it names is the fabricated affordance this whole
          // feature was specced to avoid (061112d / 2bd48fc).
          affordance.kind === 'blocked' ? (
            <div style={{ color: 'var(--text-dim)', fontSize: 10, lineHeight: 1.4 }}>
              {affordance.reason || t('civitai.blockedFallback')}
            </div>
          ) : affordance.kind === 'installed' ? (
            <button onClick={onRun} style={btn('var(--accent)')}>{t('run')}</button>
          ) : affordance.kind === 'installing' ? (
            <button disabled style={{ ...btn('var(--border-strong)'), opacity: 0.6, cursor: 'default' }}>
              {t('downloading')}
            </button>
          ) : (
            <button onClick={onInstall} style={btn('var(--border-strong)')}>{t('civitai.install')}</button>
          )
        ) : runState ? (
          // One-verb RUN: download → serve → chat in a single click. The button
          // is honest — OPEN CHAT only appears when the polled status says the
          // server is actually running with this model.
          <>
            <button
              onClick={onRun}
              disabled={runState === 'downloading' || runState === 'starting'}
              style={{
                ...btn('var(--accent)'),
                ...(runState === 'downloading' || runState === 'starting'
                  ? { opacity: 0.6, cursor: 'default' } : null),
              }}
            >{t(RUN_LABEL_KEY[runState])}</button>
            {!installed && (
              <button onClick={onDownload} data-tour="catalog-download" style={btn('var(--border-strong)')}>{t('download')}</button>
            )}
          </>
        ) : installed
          ? <button onClick={onRun} style={btn('var(--accent)')}>{t('run')}</button>
          : <button onClick={onDownload} data-tour="catalog-download" style={btn('var(--border-strong)')}>{t('download')}</button>}
      </div>
    </div>
  )
}

/** `family · params · runtimes`, skipping whatever the row doesn't have. */
function metaLine(
  entry: Pick<CatalogEntry, 'family' | 'params'>,
  quants: ReadonlyArray<{ runtime: string }>,
): string {
  const runtimes = quants.map(q => q.runtime).filter((v, i, a) => a.indexOf(v) === i).join(', ')
  return [entry.family, entry.params, runtimes]
    .map(part => (part ?? '').trim())
    .filter(part => part !== '')
    .join(' · ')
}

/** Theme-var color for a fit verdict chip (border + text). */
function fitBadgeColor(verdict: LocalFitBadge['verdict']): string {
  switch (verdict) {
    case 'fits-gpu': return 'var(--accent)'
    case 'fits-cpu': return 'var(--text-muted)'
    case 'tight':    return 'var(--border-strong)'
    case 'no-fit':   return 'var(--danger, var(--border-strong))'
  }
}

/** Copy a trigger word. Silent on failure — the clipboard is unavailable in
 *  some Electron window configs and a thrown promise here would be noise. */
async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text) } catch { /* clipboard blocked */ }
}

function btn(border: string): React.CSSProperties {
  return {
    padding: '6px 10px', border: `var(--border-width) solid ${border}`,
    background: 'transparent', color: 'var(--text-primary)',
    fontFamily: 'JetBrains Mono, monospace', fontSize: 11, cursor: 'pointer',
  }
}
