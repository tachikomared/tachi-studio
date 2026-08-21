// apps/desktop/src/pages/catalog/CivitaiDetailPanel.tsx
//
// "this things in catalog aren't really useful, user should be able to open and
// read what about that checkpoint or lora"
//
// The grid card shows a thumbnail, three chips and Install. It never says what
// the model IS. This is the read: the uploader's own description, who they are,
// the samples, and every version with its own notes — plus the same verdict the
// card carried, in a place with room to print it as a sentence.
//
// ─── THREE RULES THIS FILE IS BUILT AROUND ───────────────────────────────────
//
// 1. THE DESCRIPTION IS NEVER innerHTML. `description` is HTML written by an
//    internet stranger. It is parsed into a block tree (civitaiHtml.ts) and
//    rendered as React children below. There is no dangerouslySetInnerHTML in
//    this file and there must never be one: the structure the parser emits
//    cannot express a tag, an attribute or a handler, which is what makes the
//    safety property structural instead of vigilant.
//
// 2. THE PANEL OPENS ON THE ROW. Name, type, base model, size, format, trigger
//    words, licence, verdict and thumbnail all arrive with the row the card
//    already had, so the header and the Install control are correct and clickable
//    on the first frame. Only the description, the creator and the sibling
//    versions are fetched — and a fetch failure is a line inside that region with
//    a Retry, never a blank panel, because everything else on screen is still
//    true.
//
// 3. THE HONESTY LAW HOLDS HERE TOO. A refused version gets NO button — the
//    reason takes the button's place, and in this panel it takes it prominently,
//    because "Needs an SDXL checkpoint — install one first and this LoRA runs on
//    top of it" is the answer to the question the reader opened the panel to ask.
//    Description links are TEXT, not controls: they point at arbitrary
//    third-party hosts that shell.ipc.ts's allowlist rejects, so a button would
//    silently no-op. Only "Open on Civitai" is a control, and its url is built in
//    MAIN from the resolved mode.

import React from 'react'
import { useTranslation } from 'react-i18next'
import { Modal } from '../../components/ui/Modal'
import type { CivitaiSearchRow } from '../../types/electron'
import {
  civitaiDescriptionBlocks,
  civitaiLinkPrintsHref,
  civitaiUrlBreakParts,
  type CivitaiBlock,
  type CivitaiInline,
} from './civitaiHtml'
import {
  civitaiCompactCount,
  civitaiDetailPreviewBlurred,
  civitaiFormatMb,
  civitaiGalleryImages,
  civitaiLeadVersion,
  civitaiOtherVersions,
  civitaiPublishedDate,
  civitaiShowsVerdictBanner,
  civitaiVersionAffordance,
  civitaiVersionFileLine,
  civitaiVersionNotice,
  type CivitaiDetailState,
} from './civitaiDetail'
import {
  civitaiLicenseBadges,
  civitaiNameParts,
  civitaiRowChips,
  civitaiTypeFilterIdForType,
} from './civitaiRow'

export function CivitaiDetailPanel({
  row, state, installed, installing, adultServed, requiresSignIn,
  onClose, onInstall, onRun, onRetry,
}: {
  /** The row the card was built from — the panel's instant, always-true half. */
  row: CivitaiSearchRow
  state: CivitaiDetailState
  /** Is THIS row's version already on disk? */
  installed: boolean
  /** Is this row's transfer in flight? (progress lives in the shared strip) */
  installing: boolean
  /** The mode the PAGE was served in — the outer gate on every blur below. */
  adultServed: boolean
  /**
   * Does this download need a Civitai account?
   *
   * OPTIONAL AND FED FROM OUTSIDE. A concurrent lane is wiring
   * `GET /api/v1/model-versions/mini/:id`'s documented `requireAuth` flag as the
   * download pre-flight; when it arrives, the button can say so BEFORE the click
   * instead of after a 401. Undefined means "not known", which prints nothing —
   * this panel never probes for it itself.
   */
  requiresSignIn?: boolean
  onClose: () => void
  onInstall: () => void
  onRun: () => void
  onRetry: () => void
}) {
  const { t } = useTranslation('catalog')
  const detail = state.detail
  const lead = civitaiLeadVersion(detail, state.versionId)

  // Header facts come from the ROW, with the detail's cleaner name preferred once
  // it lands: main joins `<model> - <version>` on a row, and the detail carries
  // the model name on its own.
  const nameParts = civitaiNameParts(row)
  const title = detail?.name?.trim() || nameParts.title
  const versionLabel = lead?.name?.trim() || nameParts.version
  const typeId = civitaiTypeFilterIdForType(row.type)
  const typeLabel = typeId ? t(`civitai.types.${typeId}`) : (row.type ?? '').trim()

  // The verdict is the LEAD VERSION's when the detail has landed, and the ROW's
  // until then — the same function either way, so the panel cannot contradict
  // the card that opened it.
  const affordance = civitaiVersionAffordance(lead ?? row, { installed, installing })
  const showBanner = civitaiShowsVerdictBanner(affordance)

  const gallery = civitaiGalleryImages(lead, row)
  const description = civitaiDescriptionBlocks(detail?.description)
  const versionNotice = civitaiVersionNotice(detail)
  const others = civitaiOtherVersions(detail, lead)
  const license = civitaiLicenseBadges(detail?.license ?? row.license)
  const chips = civitaiRowChips(row)
  const triggers = (lead?.trainedWords ?? row.trainedWords ?? [])
    .filter(w => typeof w === 'string' && w.trim() !== '')
  const published = civitaiPublishedDate(lead?.publishedAt)
  // THE ROW IS THE FIRST-FRAME ANSWER. Main builds this url from the resolved
  // mode on the row as well as on the detail (civitaiModelPageUrl, one builder),
  // so the button is live before the fetch and shows the same string after it.
  // The fetched values still come FIRST: if the unlock lapsed between the browse
  // and the click, the detail was served from the other host and its url is the
  // true one. Nothing here chooses a host — all three were built in main.
  const pageUrl = lead?.pageUrl ?? detail?.pageUrl ?? row.pageUrl ?? null

  return (
    <Modal
      title={t('civitai.detail.title')}
      onClose={onClose}
      width={760}
      style={{ fontSize: 11 }}
    >
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* ── identity ─────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.25 }}>
            {title}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
            {typeLabel !== '' && <span style={badge('var(--accent)')}>{typeLabel}</span>}
            {versionLabel !== '' && (
              <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{versionLabel}</span>
            )}
            {chips.map(chip => <span key={chip} style={badge('var(--border-strong)')}>{chip}</span>)}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, color: 'var(--text-muted)', fontSize: 10 }}>
            {/* The creator only exists once the detail lands. Until then the line
                simply has one fewer item — no placeholder, no shimmer for a
                twelve-character username. */}
            {detail?.creator && <span>{t('civitai.detail.by', { user: detail.creator.username })}</span>}
            <span aria-label={t('civitai.detail.downloadsLabel')}>
              ↓ {civitaiCompactCount(detail?.downloads ?? row.downloads)}
            </span>
            <span aria-label={t('civitai.detail.likesLabel')}>
              ♥ {civitaiCompactCount(detail?.likes ?? row.likes)}
            </span>
            {published && <span>{t('civitai.detail.published', { date: published.toLocaleDateString() })}</span>}
          </div>
        </div>

        {/* ── samples ──────────────────────────────────────────────────────── */}
        {gallery.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {gallery.map((image, i) => (
              <GalleryImage
                key={`${i}:${image.dataUri.slice(-24)}`}
                dataUri={image.dataUri}
                level={image.level}
                adult={adultServed}
                revealLabel={t('civitai.reveal')}
              />
            ))}
          </div>
        )}

        {/* ── THE VERDICT, where a reader is actually looking ───────────────
            A refused version gets no button anywhere in this panel; the reason
            goes here, in full, bordered so it reads as the answer rather than as
            fine print. */}
        {showBanner && affordance.kind === 'blocked' && (
          <div style={{
            border: 'var(--border-width) solid var(--border-strong)',
            borderLeft: '3px solid var(--accent)',
            padding: '8px 10px', color: 'var(--text-primary)',
            fontSize: 11, lineHeight: 1.5,
          }}>
            <div style={{
              fontSize: 8, fontWeight: 700, letterSpacing: '0.08em',
              textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 4,
            }}>{t('notAvailable')}</div>
            {affordance.reason}
          </div>
        )}

        {/* ── actions ──────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {affordance.kind === 'installed' ? (
            <button onClick={onRun} style={btn('var(--accent)')}>{t('run')}</button>
          ) : affordance.kind === 'installing' ? (
            <button disabled style={{ ...btn('var(--border-strong)'), opacity: 0.6, cursor: 'default' }}>
              {t('downloading')}
            </button>
          ) : affordance.kind === 'install' ? (
            <button onClick={onInstall} style={btn('var(--border-strong)')}>{t('civitai.install')}</button>
          ) : null /* blocked — the banner above is the whole answer */}
          {/* Said BEFORE the click when a sibling lane knows it, so a 401 is not
              how the user finds out. Never a reason to hide Install: the account
              is free and the download works once it exists. */}
          {affordance.kind === 'install' && requiresSignIn === true && (
            <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>
              {t('civitai.detail.signInRequired')}
            </span>
          )}
          {pageUrl && (
            <button
              onClick={() => { void window.tachi.shell.openExternal(pageUrl).catch(() => {}) }}
              title={pageUrl}
              style={{ ...btn('var(--border)'), color: 'var(--text-muted)' }}
            >{t('civitai.detail.openOnCivitai')}</button>
          )}
        </div>

        {/* ── the read ─────────────────────────────────────────────────────── */}
        <Section label={t('civitai.detail.about')}>
          {state.phase === 'loading' ? (
            <div style={{ color: 'var(--text-dim)', fontSize: 10 }}>{t('civitai.detail.loading')}</div>
          ) : state.phase === 'error' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
              <div style={{ color: 'var(--text-muted)', fontSize: 10, lineHeight: 1.5 }}>
                {state.error || t('civitai.detail.loadFailed')}
              </div>
              <button onClick={onRetry} style={{ ...btn('var(--border)'), fontSize: 10, padding: '3px 8px' }}>
                {t('civitai.tryAgain')}
              </button>
            </div>
          ) : description.blocks.length === 0 ? (
            <div style={{ color: 'var(--text-dim)', fontSize: 10 }}>{t('civitai.detail.noDescription')}</div>
          ) : (
            <>
              <DescriptionBlocks blocks={description.blocks} />
              {description.truncated && (
                <div style={{ color: 'var(--text-dim)', fontSize: 9, marginTop: 6 }}>
                  {t('civitai.detail.descriptionTruncated')}
                </div>
              )}
            </>
          )}
        </Section>

        {/* ── this version ─────────────────────────────────────────────────── */}
        <Section label={t('civitai.detail.thisVersion')}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              {versionLabel !== '' && (
                <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{versionLabel}</span>
              )}
              <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>
                {civitaiVersionFileLine({
                  sizeMb: lead?.sizeMb ?? row.sizeMb,
                  format: lead?.format ?? row.format,
                  fp: row.fp,
                })}
              </span>
            </div>
            {/* The exact file, so a user can recognise it on disk or on the site. */}
            {(lead?.fileName || row.fileName) && (
              <div style={{ color: 'var(--text-dim)', fontSize: 10, wordBreak: 'break-all' }}>
                {lead?.fileName || row.fileName}
              </div>
            )}
            {/* Trigger words. Click copies — these have to end up in a prompt and
                retyping `(best quality:1.2)` by eye is how they get typo'd. Same
                idiom as the card, with room here to show all of them. */}
            {triggers.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
                <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>{t('civitai.triggerWords')}</span>
                {triggers.map(word => (
                  <button
                    key={word}
                    onClick={() => { void copyText(word) }}
                    title={t('civitai.copyTrigger', { word })}
                    aria-label={t('civitai.copyTrigger', { word })}
                    style={{
                      padding: '1px 6px', border: 'var(--border-width) solid var(--accent)',
                      background: 'transparent', color: 'var(--accent)',
                      fontFamily: 'JetBrains Mono, monospace', fontSize: 10, cursor: 'pointer',
                      maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}
                  >{word}</button>
                ))}
              </div>
            )}
            {/* The version's OWN notes — usually where the recommended steps, CFG
                and sampler live, and the single most useful paragraph on the
                whole page. */}
            {lead?.description && <VersionNotes html={lead.description} />}
          </div>
        </Section>

        {/* ── the other versions ───────────────────────────────────────────── */}
        {(others.length > 0 || versionNotice) && (
          <Section label={t('civitai.detail.otherVersions')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {others.map(v => (
                <div key={v.id} style={{
                  display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline',
                  paddingBottom: 4, borderBottom: '1px solid var(--border)',
                }}>
                  <span style={{ color: 'var(--text-primary)', minWidth: 90 }}>{v.name}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{v.baseModel}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{civitaiFormatMb(v.sizeMb)}</span>
                  {/* No Install here, ever — installing a version other than the
                      one the card resolved to would need its own re-gate and its
                      own verdict, and a button that quietly installs something
                      else is worse than a list that only informs. */}
                  {v.installable !== true && v.reason && (
                    <span style={{ color: 'var(--text-dim)', fontSize: 9 }}>{v.reason}</span>
                  )}
                </div>
              ))}
              {versionNotice && (
                <div style={{ color: 'var(--text-dim)', fontSize: 10 }}>
                  {versionNotice.kind === 'hidden'
                    ? t('civitai.detail.versionsHidden', { count: versionNotice.count })
                    : t('civitai.detail.versionsCapped', {
                        shown: versionNotice.shown, total: versionNotice.total,
                      })}
                </div>
              )}
            </div>
          </Section>
        )}

        {/* ── licence: the app INFORMS, it does not enforce ─────────────────── */}
        {license.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {license.map(badgeId => (
              <span key={badgeId} title={t(`civitai.license.${badgeId}Hint`)} style={badge('var(--text-dim)')}>
                {t(`civitai.license.${badgeId}`)}
              </span>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

// ─── description rendering ───────────────────────────────────────────────────

/**
 * The block tree as React children. NO dangerouslySetInnerHTML — every string
 * below is a text node, which is what makes third-party HTML safe to show here.
 */
function DescriptionBlocks({ blocks }: { blocks: readonly CivitaiBlock[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7, lineHeight: 1.55 }}>
      {blocks.map((block, i) => {
        switch (block.kind) {
          case 'heading':
            return (
              <div key={i} style={{
                fontWeight: 700, color: 'var(--text-primary)',
                fontSize: block.level === 1 ? 13 : block.level === 2 ? 12 : 11,
                marginTop: i === 0 ? 0 : 4,
              }}><Inlines inline={block.inline} /></div>
            )
          case 'quote':
            return (
              <div key={i} style={{
                borderLeft: '2px solid var(--border-strong)', paddingLeft: 8,
                color: 'var(--text-muted)',
              }}><Inlines inline={block.inline} /></div>
            )
          case 'code':
            return (
              <pre key={i} style={{
                margin: 0, padding: 8, overflowX: 'auto',
                background: 'var(--bg-base)', border: 'var(--border-width) solid var(--border)',
                color: 'var(--text-primary)', fontSize: 10,
                fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'pre-wrap',
              }}>{block.text}</pre>
            )
          case 'list': {
            // `ordered` DECIDES THE ELEMENT. This used to render every list as a
            // <ul>, which silently turned the API's own <ol> into bullets — and
            // it would delete the numbers from a `1. / 2. / 3.` list the markdown
            // pass re-shapes, which is worse than leaving the digits as text.
            const List = block.ordered ? 'ol' : 'ul'
            return (
              <List key={i} style={{ margin: 0, paddingLeft: 18, color: 'var(--text-secondary, var(--text-primary))' }}>
                {block.items.map((item, j) => (
                  <li key={j} style={{ marginBottom: 2 }}><Inlines inline={item} /></li>
                ))}
              </List>
            )
          }
          default:
            return (
              <div key={i} style={{ color: 'var(--text-primary)' }}>
                <Inlines inline={block.inline} />
              </div>
            )
        }
      })}
    </div>
  )
}

/** The dim, small style the printed url gets. `break-word`, never `break-all`. */
const URL_TEXT: React.CSSProperties = {
  color: 'var(--text-dim)', fontSize: 9, overflowWrap: 'break-word',
}

/**
 * One inline run.
 *
 * A LINK IS TEXT PLUS ITS URL, NOT A CONTROL. Description links point at
 * arbitrary third-party hosts (mage.space, fictional.ai … measured on live
 * descriptions), and shell.ipc.ts's openExternal allowlist rejects those — so a
 * button here would reject and silently no-op, which is exactly the fabricated
 * affordance the catalog's honesty law exists to refuse. Printing the url next to
 * the anchor text means a reader can see and copy where it goes, and nothing
 * pretends to be clickable.
 *
 * PRINTED ONCE. When the anchor's text already IS its url — TipTap autolinks a
 * pasted one, so live descriptions are full of it — text + url was the same
 * 60-character string twice, back to back, breaking mid-token. That was the
 * driver's "ugliest line in any panel it opened"; civitaiLinkPrintsHref decides,
 * and BreakableUrl handles the wrapping either way.
 */
function Inlines({ inline }: { inline: readonly CivitaiInline[] }) {
  return (
    <>
      {inline.map((node, i) => node.kind === 'link' ? (
        <span key={i}>
          {civitaiLinkPrintsHref(node) ? (
            <>
              <span style={{ color: 'var(--accent)' }}>{node.text}</span>
              <span style={URL_TEXT} title={node.href}>
                {' ('}<BreakableUrl url={node.href} />{') '}
              </span>
            </>
          ) : (
            /* The anchor text IS the url — TipTap autolinks a pasted one, and
               live descriptions are full of them. Printing it once is not a
               shortcut: there is nothing else to print. */
            <span style={{ color: 'var(--accent)', overflowWrap: 'break-word' }} title={node.href}>
              <BreakableUrl url={node.text} />
            </span>
          )}
        </span>
      ) : (
        <span key={i}>{node.text}</span>
      ))}
    </>
  )
}

/**
 * A url that wraps at SANE POINTS.
 *
 * `word-break: break-all` (what this was) breaks mid-token — `https://exam` /
 * `ple.com/very-long-pa`. `<wbr>` marks a break OPPORTUNITY after each url
 * separator instead, and `overflow-wrap: break-word` only chops a part that
 * cannot fit a line on its own.
 * <https://developer.mozilla.org/en-US/docs/Web/HTML/Element/wbr>
 *
 * The DOM text is still exactly the url — `<wbr>` contributes nothing to
 * `textContent` — so selecting and copying yields a url that works, which is the
 * whole point of printing it (these hosts are not openExternal-allowlisted).
 */
function BreakableUrl({ url }: { url: string }) {
  return (
    <>
      {civitaiUrlBreakParts(url).map((part, i) => (
        <React.Fragment key={i}>{i > 0 && <wbr />}{part}</React.Fragment>
      ))}
    </>
  )
}

/** The version's own notes — the same parser, the same guarantees. */
function VersionNotes({ html }: { html: string }) {
  const { blocks } = civitaiDescriptionBlocks(html)
  if (blocks.length === 0) return null
  return (
    <div style={{ marginTop: 2 }}>
      <DescriptionBlocks blocks={blocks} />
    </div>
  )
}

// ─── bits ────────────────────────────────────────────────────────────────────

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{
        fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
        color: 'var(--text-dim)',
      }}>{label}</div>
      {children}
    </div>
  )
}

/**
 * One sample. The blur is the SAME two-level reveal the card uses — hover peeks
 * (transient, costs nothing to undo), a click commits — and it exists only while
 * something is actually blurred, so outside adult mode no dead control is drawn.
 */
function GalleryImage({ dataUri, level, adult, revealLabel }: {
  dataUri: string
  level: number
  adult: boolean
  revealLabel: string
}) {
  const [revealed, setRevealed] = React.useState(false)
  const [peeking, setPeeking] = React.useState(false)
  const eligible = civitaiDetailPreviewBlurred({ dataUri, level }, { adult })
  const blurNow = eligible && !revealed && !peeking
  return (
    <div
      style={{ position: 'relative', width: 168, height: 168 }}
      onMouseEnter={() => { if (eligible) setPeeking(true) }}
      onMouseLeave={() => setPeeking(false)}
    >
      <img
        src={dataUri}
        alt=""
        style={{
          width: 168, height: 168, objectFit: 'cover', display: 'block',
          border: 'var(--border-width) solid var(--border)', background: 'var(--bg-base)',
          filter: blurNow ? 'blur(16px)' : undefined,
          transition: 'filter .15s',
        }}
      />
      {eligible && !revealed && (
        <button
          onClick={() => setRevealed(true)}
          aria-label={revealLabel}
          title={revealLabel}
          style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace',
            fontSize: 10, textShadow: '0 0 6px var(--bg-base)',
          }}
        >{revealLabel}</button>
      )}
    </div>
  )
}

function badge(color: string): React.CSSProperties {
  return {
    padding: '1px 6px', border: `var(--border-width) solid ${color}`,
    color, fontSize: 10, whiteSpace: 'nowrap',
  }
}

function btn(border: string): React.CSSProperties {
  return {
    padding: '6px 10px', border: `var(--border-width) solid ${border}`,
    background: 'transparent', color: 'var(--text-primary)',
    fontFamily: 'JetBrains Mono, monospace', fontSize: 11, cursor: 'pointer',
  }
}

/** Silent on failure — the clipboard is unavailable in some window configs. */
async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text) } catch { /* clipboard blocked */ }
}

export default CivitaiDetailPanel
