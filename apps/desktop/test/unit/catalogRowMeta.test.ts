// apps/desktop/test/unit/catalogRowMeta.test.ts
//
// BATCH35 LANE A — the Catalog row-classification decisions extracted into
// src/pages/catalog/rowMeta.ts:
//   1. which in-flight downloads may honestly show a Stop button, and
//   2. which rows may honestly show a VRAM fit verdict.
//
// (2) is the regression that motivated the module: every piper voice and
// whisper weight rendered "Fits in GPU (fast)" because estimateFit is a
// text-transformer heuristic and 63 MB fits in anything. That is a fabricated
// hardware claim about engines that never touch the GPU offload path.
//
// Pure node-env: rowMeta has no react / electron / i18n imports. The two
// source-assertion blocks at the end pin the CALL SITES, because a correct
// helper nobody calls fixes nothing.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  STOPPABLE_RUNTIMES, SPEECH_RUNTIMES, MEDIA_RUNTIMES, canStopDownload, isSpeechRow,
  isMediaRow, showsFitVerdict, showsSizeChip, stopAvailability, formatModelSize, rowSizeBytes,
  mediaFitNote,
} from '../../src/pages/catalog/rowMeta'

type Q = { label: string; sizeBytes: number; runtime: string; ref: string }
const entry = (kind: string, quants: Q[]) =>
  ({ kind, quants } as unknown as Parameters<typeof isSpeechRow>[0])
const q = (runtime: string, sizeBytes: number): Q =>
  ({ label: 'X', sizeBytes, runtime, ref: 'r' })

const MB = 1024 * 1024
const GB = 1024 * MB

describe('STOPPABLE_RUNTIMES / canStopDownload', () => {
  it('covers exactly the four runtimes whose weights run through the download-manager', () => {
    expect([...STOPPABLE_RUNTIMES].sort()).toEqual(['llamacpp', 'piper', 'sdcpp', 'whisper'])
  })

  it('stops piper and whisper — they were ungated on a "too small to matter" call, but whisper medium.en is ~1.5 GB', () => {
    expect(canStopDownload('piper')).toBe(true)
    expect(canStopDownload('whisper')).toBe(true)
  })

  it('keeps stopping llamacpp and sdcpp (unchanged contract)', () => {
    expect(canStopDownload('llamacpp')).toBe(true)
    expect(canStopDownload('sdcpp')).toBe(true)
  })

  it('never offers Stop for an Ollama pull — the daemon owns it, we have no pause handle', () => {
    expect(canStopDownload('ollama')).toBe(false)
  })

  it('is false for an absent/unknown runtime rather than throwing', () => {
    expect(canStopDownload(undefined)).toBe(false)
    expect(canStopDownload(null)).toBe(false)
    expect(canStopDownload('')).toBe(false)
    expect(canStopDownload('not-a-runtime')).toBe(false)
  })
})

// ─── Stop during the "⏳ Starting…" window ────────────────────────────────────
//
// CatalogPage puts the progress strip on screen the instant DOWNLOAD is
// clicked — before the IPC round-trip, before the installer takes its lock,
// before runManagedDownload registers anything. Inside that window
// pauseManagedDownload returns false twice over (no task at all, then a task in
// state 'queued' — it only pauses 'active'), so a live-looking Stop button did
// precisely nothing and a user slower than instant on the mouse read the
// silence as a broken button.

describe('stopAvailability — Stop is never drawn as live before it can work', () => {
  const dl = (over: Partial<Parameters<typeof stopAvailability>[0]> = {}) =>
    ({ runtime: 'llamacpp', ref: 'qwen2.5-3b', pct: 0, ...over })

  it('is PENDING for the exact strip CatalogPage paints on the download click', () => {
    // download() seeds { ref, pct: 0, label: 'Starting…', runtime } and nothing else.
    expect(stopAvailability(dl())).toBe('pending')
  })

  it('flips to READY on the first byte of real progress', () => {
    expect(stopAvailability(dl({ pct: 1 }))).toBe('ready')
    expect(stopAvailability(dl({ pct: 99 }))).toBe('ready')
  })

  it('also flips on a reported speed — percent can lag on a huge file', () => {
    expect(stopAvailability(dl({ pct: 0, speedBytesPerSec: 1 }))).toBe('ready')
  })

  it('is HIDDEN for a runtime with no pause handle, at any progress', () => {
    expect(stopAvailability(dl({ runtime: 'ollama' }))).toBe('hidden')
    expect(stopAvailability(dl({ runtime: 'ollama', pct: 50 }))).toBe('hidden')
  })

  it('is HIDDEN without a ref — there is no id to send to the cancel IPC', () => {
    expect(stopAvailability(dl({ ref: '' }))).toBe('hidden')
    expect(stopAvailability(dl({ ref: null }))).toBe('hidden')
    expect(stopAvailability(dl({ ref: undefined }))).toBe('hidden')
  })

  it('is HIDDEN for no download at all rather than throwing', () => {
    expect(stopAvailability(null)).toBe('hidden')
    expect(stopAvailability(undefined)).toBe('hidden')
  })

  it('is PENDING again during post-transfer verification', () => {
    // The installers report verification as percent -1, which CatalogPage's
    // progress handler floors to 0. Nothing is pausable there either — this is
    // the window the "nothing to stop" notice was originally written for.
    expect(stopAvailability(dl({ pct: 0, speedBytesPerSec: 0 }))).toBe('pending')
  })

  it('agrees with canStopDownload on every runtime — one gate, not two', () => {
    for (const runtime of ['llamacpp', 'sdcpp', 'piper', 'whisper', 'ollama', 'nope']) {
      const visible = stopAvailability(dl({ runtime, pct: 5 })) !== 'hidden'
      expect(visible, runtime).toBe(canStopDownload(runtime))
    }
  })

  it('reaches ready for all four stoppable runtimes once bytes move', () => {
    for (const runtime of STOPPABLE_RUNTIMES) {
      expect(stopAvailability(dl({ runtime, pct: 3 })), runtime).toBe('ready')
      expect(stopAvailability(dl({ runtime, pct: 0 })), runtime).toBe('pending')
    }
  })
})

describe('isSpeechRow', () => {
  it('classifies by the explicit kind the store builders set', () => {
    expect(isSpeechRow(entry('speech', [q('piper', 63 * MB)]))).toBe(true)
    expect(isSpeechRow(entry('speech', [q('whisper', 142 * MB)]))).toBe(true)
  })

  it('falls back to the runtime when kind is missing (older main-process build)', () => {
    expect(isSpeechRow(entry('text', [q('piper', 63 * MB)]))).toBe(true)
    expect(isSpeechRow(entry('text', [q('whisper', 142 * MB)]))).toBe(true)
  })

  it('is false for text models and for sd.cpp media rows', () => {
    expect(isSpeechRow(entry('text', [q('llamacpp', 4 * GB)]))).toBe(false)
    expect(isSpeechRow(entry('text', [q('ollama', 4 * GB)]))).toBe(false)
    expect(isSpeechRow(entry('text', [q('sdcpp', 6 * GB)]))).toBe(false)
  })

  it('is false for a quant-less row rather than vacuously true on every()', () => {
    expect(isSpeechRow(entry('text', []))).toBe(false)
  })

  it('lists exactly the two speech runtimes', () => {
    expect([...SPEECH_RUNTIMES].sort()).toEqual(['piper', 'whisper'])
  })
})

describe('showsFitVerdict — no fabricated VRAM verdicts on speech or sd.cpp rows', () => {
  it('suppresses the verdict for a piper voice', () => {
    expect(showsFitVerdict(entry('speech', [q('piper', 63 * MB)]))).toBe(false)
  })

  it('suppresses the verdict for a whisper weight, including the 1.5 GB one', () => {
    expect(showsFitVerdict(entry('speech', [q('whisper', 1.5 * GB)]))).toBe(false)
  })

  it('keeps the verdict for llama.cpp / ollama text models — that is where it is true', () => {
    expect(showsFitVerdict(entry('text', [q('llamacpp', 4 * GB)]))).toBe(true)
    expect(showsFitVerdict(entry('text', [q('ollama', 4 * GB)]))).toBe(true)
  })

  // W4-B FIX: this used to assert `true` ("VRAM genuinely decides there") —
  // that was the fabricated-verdict bug. estimateFit()'s sizeBytes*1.2
  // overhead is a text-transformer KV-cache heuristic; it has nothing to do
  // with a diffusion/video model's real peak (resolution, frame count, and
  // which offload flags are on decide that instead). It produced a Flux
  // checkpoint reading "too big" on hardware that runs it fine, right next to
  // a Wan 1.4 GB DiT reading "Fits in GPU (fast)" on a card whose VAE decode
  // is the actual peak — the same class of lie that got speech rows
  // suppressed above. See mediaFitNote() for the honest replacement.
  it('suppresses the verdict for sd.cpp rows too — same fabricated-verdict class as speech', () => {
    expect(showsFitVerdict(entry('text', [q('sdcpp', 6 * GB)]))).toBe(false)
  })
})

// ─── The missing size chip on media rows ─────────────────────────────────────
//
// The size line was born as a REPLACEMENT for the suppressed speech verdict, so
// it was written as `fitApplies ? null : formatModelSize(...)`. That made the
// two decisions one decision, and sd.cpp media rows fell in the gap: the
// shipped sd-turbo card rendered `sd15 · · sdcpp`, a (fabricated) fit verdict,
// and no size at all, for the single biggest download in the app. Since W4-B
// the fit verdict is ALSO suppressed for these rows (see above), but the size
// chip stays its own independent decision — it must not regress back to being
// gated on the verdict, because the two were never the same question.

describe('isMediaRow', () => {
  it('classifies sd.cpp image/video rows by RUNTIME', () => {
    // catalog.store's sdCatalogEntry writes kind:'text' as a placeholder and
    // carries the modality in `capabilities`, so `kind` cannot classify these.
    expect(isMediaRow(entry('text', [q('sdcpp', 5 * GB)]))).toBe(true)
  })

  it('is false for text, speech and mixed rows', () => {
    expect(isMediaRow(entry('text', [q('llamacpp', 4 * GB)]))).toBe(false)
    expect(isMediaRow(entry('speech', [q('piper', 61 * MB)]))).toBe(false)
    expect(isMediaRow(entry('text', [q('sdcpp', 5 * GB), q('llamacpp', 4 * GB)]))).toBe(false)
  })

  it('is false for a quant-less row rather than vacuously true on every()', () => {
    expect(isMediaRow(entry('text', []))).toBe(false)
  })

  it('lists exactly the one media runtime', () => {
    expect([...MEDIA_RUNTIMES]).toEqual(['sdcpp'])
  })
})

describe('showsSizeChip — the download size is not hostage to the fit verdict', () => {
  it('shows the size on an sd.cpp media row — the verdict is suppressed there now (W4-B), the size chip is not', () => {
    const sd = entry('text', [q('sdcpp', 5 * GB)])
    expect(showsSizeChip(sd)).toBe(true)
    expect(showsFitVerdict(sd)).toBe(false)
  })

  it('keeps showing it on speech rows (where the chip started)', () => {
    expect(showsSizeChip(entry('speech', [q('piper', 61 * MB)]))).toBe(true)
    expect(showsSizeChip(entry('speech', [q('whisper', 1.5 * GB)]))).toBe(true)
  })

  it('stays off text rows — their size rides the params + quant line', () => {
    expect(showsSizeChip(entry('text', [q('llamacpp', 4 * GB)]))).toBe(false)
    expect(showsSizeChip(entry('text', [q('ollama', 4 * GB)]))).toBe(false)
  })

  // Historical note: before W4-B this asserted showsSizeChip was NOT the
  // strict inverse of showsFitVerdict, because sd.cpp rows kept a (fabricated)
  // verdict alongside their size chip. Now that the verdict is honestly
  // suppressed for sd.cpp rows too, the two ARE each other's inverse again for
  // every row shape — that is a coincidence of the current suppression set,
  // not a re-coupling: the functions remain two independent decisions (see
  // mediaFitNote() taking over the "verdict" question sd.cpp rows still need
  // answered, just not through showsFitVerdict/estimateFit).
  it('happens to equal !showsFitVerdict for every row today — independent functions, not a re-coupling', () => {
    for (const e of [
      entry('text', [q('sdcpp', 5 * GB)]),
      entry('speech', [q('piper', 61 * MB)]),
      entry('text', [q('llamacpp', 4 * GB)]),
    ]) {
      expect(showsSizeChip(e)).toBe(!showsFitVerdict(e))
    }
  })

  it('an sd.cpp row renders a real size string, not nothing', () => {
    const sd = entry('text', [q('sdcpp', Math.round(4.86 * GB))])
    expect(showsSizeChip(sd) ? formatModelSize(rowSizeBytes(sd)) : null).toBe('4.9 GB')
  })
})

// ─── mediaFitNote — the honest replacement for the suppressed verdict ────────
//
// showsFitVerdict() now says "no" for every sd.cpp row, but "no computed
// verdict" must not mean "no information at all" — that would be a silent
// downgrade, the same complaint an invisible weight or a swallowed download
// failure earns elsewhere in this app. mediaFitNote() is what the card shows
// INSTEAD: a real minVramGb estimate when the payload carries one
// (feature-detected — an older payload simply omits the field), else the
// honest sentence naming what actually decides the peak.

describe('mediaFitNote — honest per-row replacement, never a fabricated number', () => {
  it('is null for a non-media row — the computed verdict already covers it', () => {
    expect(mediaFitNote(entry('text', [q('llamacpp', 4 * GB)]))).toBeNull()
  })

  it('is null for a speech row too — that suppression has its own replacement (the size chip)', () => {
    expect(mediaFitNote(entry('speech', [q('piper', 63 * MB)]))).toBeNull()
  })

  it('falls back to the honest sentence when no structured estimate rode along', () => {
    const flux = entry('text', [q('sdcpp', 6 * GB)])
    expect(mediaFitNote(flux)).toEqual({ kind: 'sentence' })
  })

  it('prefers a real minVramGb estimate when the payload carries one', () => {
    const wan = { ...entry('text', [q('sdcpp', 1.4 * GB)]), minVramGb: 8 }
    expect(mediaFitNote(wan)).toEqual({ kind: 'vram', gb: 8 })
  })

  it('rounds the estimate to one decimal', () => {
    const row = { ...entry('text', [q('sdcpp', 5 * GB)]), minVramGb: 7.849 }
    expect(mediaFitNote(row)).toEqual({ kind: 'vram', gb: 7.8 })
  })

  it('ignores a non-positive or non-finite minVramGb — falls back to the sentence rather than showing "needs ~0 GB"', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const row = { ...entry('text', [q('sdcpp', 5 * GB)]), minVramGb: bad }
      expect(mediaFitNote(row)).toEqual({ kind: 'sentence' })
    }
  })

  it('ignores an absent minVramGb (older payload) — the exact feature-detection case', () => {
    const row = entry('text', [q('sdcpp', 5 * GB)]) // no minVramGb field at all
    expect(mediaFitNote(row)).toEqual({ kind: 'sentence' })
  })
})

// ─── The suppression matrix, per family ──────────────────────────────────────
//
// showsFitVerdict/mediaFitNote must not special-case a family name — the
// whole point of the fix is that the estimator is wrong for the RUNTIME
// class (sd.cpp), not for any one model. Pin every curated family the app
// actually ships against the same two functions so a future family addition
// (another Wan tier, another Flux variant) inherits the honest behavior for
// free instead of silently reading a fabricated verdict again.

describe('the sd.cpp fit-suppression matrix holds across every shipped family', () => {
  const FAMILIES: Array<{ family: string; sizeBytes: number }> = [
    { family: 'sd15',   sizeBytes: 2   * GB },
    { family: 'sdxl',   sizeBytes: 6.5 * GB },
    { family: 'flux',   sizeBytes: 12  * GB }, // reads "too big" pre-fix despite running fine
    { family: 'flux2',  sizeBytes: 8   * GB },
    { family: 'zimage', sizeBytes: 6   * GB },
    { family: 'wan',    sizeBytes: 1.4 * GB }, // reads "Fits (fast)" pre-fix despite the VAE-decode peak
    { family: 'ltx2',   sizeBytes: 22  * GB },
  ]

  it.each(FAMILIES)('never shows a computed verdict for $family, always an honest note', ({ family, sizeBytes }) => {
    const row = { ...entry('text', [q('sdcpp', sizeBytes)]), family }
    expect(showsFitVerdict(row)).toBe(false)
    expect(mediaFitNote(row)).toEqual({ kind: 'sentence' })
  })

  it.each(FAMILIES)('renders the real minVramGb for $family once the payload carries one', ({ family, sizeBytes }) => {
    const row = { ...entry('text', [q('sdcpp', sizeBytes)]), family, minVramGb: 4 }
    expect(mediaFitNote(row)).toEqual({ kind: 'vram', gb: 4 })
  })
})

describe('formatModelSize', () => {
  it('renders a piper voice in MB, not as "0.1 GB"', () => {
    expect(formatModelSize(63 * MB)).toBe('63 MB')
    expect(formatModelSize(28 * MB)).toBe('28 MB')
  })

  it('renders sub-10 MB with one decimal', () => {
    expect(formatModelSize(Math.round(1.5 * MB))).toBe('1.5 MB')
  })

  it('switches to GB at 1 GiB with one decimal under 10 GB', () => {
    expect(formatModelSize(Math.round(1.5 * GB))).toBe('1.5 GB')
    expect(formatModelSize(GB)).toBe('1 GB')
  })

  it('drops the decimal at and above 10 GB', () => {
    expect(formatModelSize(Math.round(43.2 * GB))).toBe('43 GB')
  })

  it('returns null (render nothing) for an unknown size instead of "0 MB"', () => {
    expect(formatModelSize(0)).toBeNull()
    expect(formatModelSize(-1)).toBeNull()
    expect(formatModelSize(Number.NaN)).toBeNull()
  })

  it('round-trips the whisper registry size labels the store parses', () => {
    // parseSizeLabel('~1.5 GB') -> 1.5 * 1024^3 -> back to '1.5 GB'
    expect(formatModelSize(Math.round(1.5 * GB))).toBe('1.5 GB')
    expect(formatModelSize(Math.round(547 * MB))).toBe('547 MB')
    expect(formatModelSize(Math.round(75 * MB))).toBe('75 MB')
  })
})

describe('rowSizeBytes', () => {
  it('uses the smallest quant — the one the card actually offers', () => {
    expect(rowSizeBytes({ quants: [q('llamacpp', 8 * GB), q('llamacpp', 4 * GB)] } as never)).toBe(4 * GB)
  })

  it('is 0 for a quant-less row (formatModelSize then renders nothing)', () => {
    expect(rowSizeBytes({ quants: [] } as never)).toBe(0)
    expect(formatModelSize(rowSizeBytes({ quants: [] } as never))).toBeNull()
  })
})

// ─── Call-site pins ──────────────────────────────────────────────────────────

const read = (rel: string): string =>
  fs.readFileSync(path.resolve(__dirname, '../../src/pages/catalog', rel), 'utf8')

describe('ModelCard wires the fit suppression (source)', () => {
  const src = read('ModelCard.tsx')

  it('gates estimateFit behind showsFitVerdict instead of calling it for every row', () => {
    expect(src).toMatch(/const fitApplies = showsFitVerdict\(entry\)/)
    expect(src).toMatch(/const fit = fitApplies && hw && smallest \? estimateFit\(/)
  })

  it('renders an honest size line decided INDEPENDENTLY of the fit verdict', () => {
    expect(src).toMatch(/const sizeLabel = showsSizeChip\(entry\) \? formatModelSize\(rowSizeBytes\(entry\)\) : null/)
    // the old coupling — the whole of finding 4 — must not come back
    expect(src).not.toMatch(/sizeLabel = fitApplies \? null :/)
    expect(src).toContain("t('downloadSize')")
  })

  it('drops empty meta segments instead of rendering `family · · runtime`', () => {
    expect(src).toContain('metaLine(entry, quants)')
    expect(src).not.toContain('{entry.family} · {entry.params} · {')
  })

  // W4-B: sd.cpp rows no longer fall through the estimateFit branch above —
  // showsFitVerdict() suppresses them — so the card must render mediaFitNote's
  // honest replacement instead of silently going blank where the verdict used
  // to be.
  it('renders mediaFitNote instead of a computed verdict for sd.cpp rows', () => {
    expect(src).toContain('isMediaRow, mediaFitNote')
    expect(src).toMatch(/const mediaNoteApplies = isMediaRow\(entry\) && \(!civitai \|\| civitaiShowsFitVerdict\(civitai\)\)/)
    expect(src).toMatch(/const mediaNote = mediaNoteApplies \? mediaFitNote\(entry\) : null/)
    expect(src).toContain("t('fit.sdcppVram', { gb: mediaNote.gb })")
    expect(src).toContain("t('fit.sdcppNote')")
  })

  it('never calls estimateFit for a row mediaFitNote also covers — one verdict source per row', () => {
    // the honest note is a separate branch from `fit`, never feeding the same
    // estimateFit() call the speech/media suppression exists to avoid
    expect(src).not.toMatch(/mediaNote[\s\S]{0,80}estimateFit\(/)
  })
})

describe('CatalogPage wires Stop through the rowMeta gate (source)', () => {
  const src = read('CatalogPage.tsx')

  it('no longer hardcodes the llamacpp/sdcpp pair in the Stop gate', () => {
    expect(src).toContain('stopAvailability(s.download)')
    expect(src).not.toMatch(/download\.runtime === 'llamacpp' \|\| s\.download\.runtime === 'sdcpp'/)
  })

  it('disables the button (not just the handler) during the pending window', () => {
    expect(src).toContain("stopAvailability(s.download) === 'pending'")
    expect(src).toContain('disabled={pending}')
    expect(src).toContain('aria-disabled={pending}')
    // and the title says WHY, rather than repeating the label
    expect(src).toContain("title={pending ? t('notice.stopNotYet') : label}")
  })

  it('the click is a second gate — a stale render must not fire a doomed IPC', () => {
    expect(src).toMatch(/if \(!d\?\.ref \|\| stopAvailability\(d\) !== 'ready'\) return/)
  })

  it('routes Stop to the piper and whisper cancel IPCs', () => {
    expect(src).toContain('window.tachi.piper.cancelDownload(d.ref)')
    expect(src).toContain('window.tachi.whisper.cancelDownload(d.ref as never)')
  })

  it('reports "nothing to stop" when the IPC says nothing was pausable', () => {
    expect(src).toContain('r.cancelled === false')
    expect(src).toContain("t('notice.nothingToStop')")
  })

  it('keeps the visibility-gated status poller (lane V) intact', () => {
    expect(src).toMatch(/useVisibilityGatedInterval\(\(\) => \{[\s\S]{0,120}refreshLlamaStatus\(\) \}, 2500\)/)
  })
})

// ─── No native modals in the renderer ────────────────────────────────────────
//
// `window.confirm` in a PACKAGED Electron build opens a NATIVE modal that
// blocks the renderer's event loop until it is dismissed: the window stops
// painting and the CDP target goes dark (and it is not a CDP-visible dialog —
// Page.handleJavaScriptDialog answers "no dialog"), so REMOVE looked like a
// hard hang to a driver and to any user slower than instant on the mouse. The
// repo already ships the replacement: ConfirmProvider + useConfirm().

describe('CatalogPage removes models through the in-app confirm (source)', () => {
  const src = read('CatalogPage.tsx')

  it('has no window.confirm / alert / prompt left anywhere in the page', () => {
    expect(src).not.toMatch(/window\.(confirm|alert|prompt)\s*\(/)
  })

  it('uses the house useConfirm() hook, awaited, before deleting anything', () => {
    expect(src).toContain("import { useConfirm } from '../../components/ConfirmProvider'")
    expect(src).toContain('const confirm = useConfirm()')
    expect(src).toMatch(/const ok = await confirm\(\{[\s\S]{0,160}\}\)\s*\n\s*if \(!ok\) return/)
  })

  it('keeps the translated question and marks the dialog destructive', () => {
    expect(src).toContain("t('confirmRemove')")
    expect(src).toContain('danger:  true')
  })
})

describe('the in-app confirm is a real dialog, not a styled div (source)', () => {
  const dialog = fs.readFileSync(
    path.resolve(__dirname, '../../src/components/ConfirmDialog.tsx'), 'utf8')

  it('is a11y-labelled and modal', () => {
    expect(dialog).toContain('role="dialog"')
    expect(dialog).toContain('aria-modal="true"')
    expect(dialog).toContain('aria-labelledby="confirm-title"')
  })

  it('Escape closes it as a cancel — the thing a native modal gave for free', () => {
    expect(dialog).toMatch(/e\.key === 'Escape'[\s\S]{0,120}onCancel\(\)/)
  })
})

describe('catalog i18n — the pending-Stop title exists in all 8 locales', () => {
  const LANGS = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const

  it('notice.stopNotYet is present and non-empty everywhere', () => {
    for (const lang of LANGS) {
      const j = JSON.parse(fs.readFileSync(
        path.resolve(__dirname, `../../src/i18n/locales/${lang}/catalog.json`), 'utf8'))
      expect(typeof j.notice?.stopNotYet, lang).toBe('string')
      expect(j.notice.stopNotYet.trim().length, lang).toBeGreaterThan(0)
    }
  })

  it('the REMOVE ok-label the confirm dialog uses exists everywhere too', () => {
    for (const lang of LANGS) {
      const j = JSON.parse(fs.readFileSync(
        path.resolve(__dirname, `../../src/i18n/locales/${lang}/catalog.json`), 'utf8'))
      expect(typeof j.remove, lang).toBe('string')
      expect(j.remove.trim().length, lang).toBeGreaterThan(0)
      expect(typeof j.confirmRemove, lang).toBe('string')
    }
  })
})
