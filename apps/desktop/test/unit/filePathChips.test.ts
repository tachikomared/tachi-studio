// apps/desktop/test/unit/filePathChips.test.ts
//
// extractFilePaths — the pure path scanner behind the CODE tab's
// "files right in the chat" chips (FilePathChips.tsx). Covers: backslash +
// forward-slash Windows paths, trailing-punctuation stripping, the
// PreviewPanel-supported extension filter, dedupe-preserving-order + the
// 8-chip cap, and the workingDir confinement filter (mirrors what the
// agent:read-file IPC enforces — no workingDir means no chips).
//
// Also covers the pure <img src> builders behind the INLINE THUMBNAILS:
// isImagePath (extension detection), svgTextToDataUrl (svg arrives as text
// from agent:read-file) and imageSrcFromRead (read-result → src, fail-closed).
import { describe, it, expect } from 'vitest'
import {
  extractFilePaths,
  isImagePath,
  svgTextToDataUrl,
  imageSrcFromRead,
  thumbImageStyle,
  expandedMaxHeightPx,
  canRetryRead,
  readRetryDelayMs,
  MAX_THUMB_READ_ATTEMPTS,
} from '../../src/pages/agent/FilePathChips'

const WD = 'D:\\projects\\x'

describe('extractFilePaths — path forms', () => {
  it('finds a backslash Windows path', () => {
    expect(extractFilePaths('Wrote D:\\projects\\x\\diagram.png for you', WD))
      .toEqual(['D:\\projects\\x\\diagram.png'])
  })

  it('finds a forward-slash drive-letter path', () => {
    expect(extractFilePaths('see D:/projects/x/index.html', WD))
      .toEqual(['D:/projects/x/index.html'])
  })

  it('finds a quoted path containing spaces', () => {
    expect(extractFilePaths('saved to "D:\\projects\\x\\my report.md" just now', WD))
      .toEqual(['D:\\projects\\x\\my report.md'])
  })

  it('finds a backticked path without duplicating it', () => {
    expect(extractFilePaths('open `D:\\projects\\x\\page.html` in a browser', WD))
      .toEqual(['D:\\projects\\x\\page.html'])
  })

  it('is case-insensitive on the extension', () => {
    expect(extractFilePaths('D:\\projects\\x\\shot.PNG', WD))
      .toEqual(['D:\\projects\\x\\shot.PNG'])
  })
})

describe('extractFilePaths — trailing punctuation', () => {
  it('strips a sentence-ending period', () => {
    expect(extractFilePaths('I wrote D:\\projects\\x\\a.html.', WD))
      .toEqual(['D:\\projects\\x\\a.html'])
  })

  it('strips a closing paren + period (markdown link)', () => {
    expect(extractFilePaths('![img](D:\\projects\\x\\diagram.png).', WD))
      .toEqual(['D:\\projects\\x\\diagram.png'])
  })

  it('strips commas, colons, semicolons, brackets and quotes', () => {
    const text = 'files: D:\\projects\\x\\a.txt, [D:\\projects\\x\\b.json]; "D:\\projects\\x\\c.md":'
    expect(extractFilePaths(text, WD)).toEqual([
      'D:\\projects\\x\\c.md',   // quoted pass runs first
      'D:\\projects\\x\\a.txt',
      'D:\\projects\\x\\b.json',
    ])
  })
})

describe('extractFilePaths — extension filter', () => {
  it('keeps only PreviewPanel-supported extensions', () => {
    const text = [
      'D:\\projects\\x\\ok.html',
      'D:\\projects\\x\\ok.png',
      'D:\\projects\\x\\no.pdf',
      'D:\\projects\\x\\no.mp4',
      'D:\\projects\\x\\no.exe',
      'D:\\projects\\x\\no.zip',
    ].join(' ')
    expect(extractFilePaths(text, WD)).toEqual([
      'D:\\projects\\x\\ok.html',
      'D:\\projects\\x\\ok.png',
    ])
  })

  it('ignores extensionless paths (directories, bare drives)', () => {
    expect(extractFilePaths('cd D:\\projects\\x\\subdir then D:\\', WD)).toEqual([])
  })
})

describe('extractFilePaths — dedupe and cap', () => {
  it('dedupes preserving first-occurrence order', () => {
    const text = 'D:\\projects\\x\\b.md then D:\\projects\\x\\a.md then D:\\projects\\x\\b.md again'
    expect(extractFilePaths(text, WD)).toEqual([
      'D:\\projects\\x\\b.md',
      'D:\\projects\\x\\a.md',
    ])
  })

  it('dedupes across separator style and case (same file on Windows)', () => {
    const text = 'D:\\projects\\x\\a.md and D:/projects/x/A.MD'
    expect(extractFilePaths(text, WD)).toEqual(['D:\\projects\\x\\a.md'])
  })

  it('caps at 8 paths', () => {
    const text = Array.from({ length: 10 }, (_, i) => `D:\\projects\\x\\f${i}.txt`).join(' ')
    const out = extractFilePaths(text, WD)
    expect(out).toHaveLength(8)
    expect(out[0]).toBe('D:\\projects\\x\\f0.txt')
    expect(out[7]).toBe('D:\\projects\\x\\f7.txt')
  })
})

describe('extractFilePaths — workingDir filter', () => {
  it('returns nothing without a workingDir (IPC would refuse every read)', () => {
    expect(extractFilePaths('D:\\projects\\x\\a.html', null)).toEqual([])
  })

  it('drops paths outside the workingDir', () => {
    const text = 'D:\\projects\\x\\in.html and D:\\other\\out.html and C:\\Windows\\evil.html'
    expect(extractFilePaths(text, WD)).toEqual(['D:\\projects\\x\\in.html'])
  })

  it('does not treat a sibling dir with the same prefix as inside', () => {
    expect(extractFilePaths('D:\\projects\\xy\\a.png', WD)).toEqual([])
  })

  it('matches workingDir case-insensitively and across separator styles', () => {
    expect(extractFilePaths('d:/PROJECTS/X/shot.png', 'D:\\projects\\x')).toEqual(['d:/PROJECTS/X/shot.png'])
    expect(extractFilePaths('D:\\projects\\x\\shot.png', 'D:/projects/x/')).toEqual(['D:\\projects\\x\\shot.png'])
  })

  it('returns nothing for empty text', () => {
    expect(extractFilePaths('', WD)).toEqual([])
  })
})

// ── Inline thumbnails ─────────────────────────────────────────────────────────

describe('isImagePath', () => {
  it('accepts the renderable image extensions', () => {
    for (const p of [
      'D:\\a\\shot.png', 'D:\\a\\shot.jpg', 'D:\\a\\shot.jpeg',
      'D:\\a\\shot.gif', 'D:\\a\\shot.webp', 'D:\\a\\shot.svg',
    ]) expect(isImagePath(p)).toBe(true)
  })

  it('is case-insensitive and tolerates forward slashes', () => {
    expect(isImagePath('D:/a/CRAB.PNG')).toBe(true)
  })

  it('rejects non-images, extensionless paths and dotfiles', () => {
    for (const p of [
      'D:\\a\\notes.md', 'D:\\a\\page.html', 'D:\\a\\clip.mp4',
      'D:\\a\\archive.pngx', 'D:\\a\\subdir', 'D:\\a\\.png',
    ]) expect(isImagePath(p)).toBe(false)
  })

  it('uses the LAST dot, not a dot inside a directory name', () => {
    expect(isImagePath('D:\\my.png.dir\\readme.md')).toBe(false)
    expect(isImagePath('D:\\my.dir\\out.v2.png')).toBe(true)
  })
})

describe('svgTextToDataUrl', () => {
  it('builds an <img>-loadable data URL from svg markup', () => {
    const url = svgTextToDataUrl('<svg viewBox="0 0 1 1"><rect/></svg>')
    expect(url).toBe(
      'data:image/svg+xml;charset=utf-8,' +
      encodeURIComponent('<svg viewBox="0 0 1 1"><rect/></svg>'),
    )
  })

  it('accepts an xml prolog and a doctype, and leading whitespace', () => {
    expect(svgTextToDataUrl('  <?xml version="1.0"?><svg></svg>')).toContain('data:image/svg+xml')
    expect(svgTextToDataUrl('<!DOCTYPE svg><svg></svg>')).toContain('data:image/svg+xml')
  })

  it('percent-encodes characters that would break a data URL', () => {
    const url = svgTextToDataUrl('<svg><text>a#b&c</text></svg>')!
    expect(url).not.toContain('#')
    expect(url).toContain('%23')
  })

  it('fails closed on empty, non-svg and oversized input', () => {
    expect(svgTextToDataUrl('')).toBeNull()
    expect(svgTextToDataUrl('   ')).toBeNull()
    expect(svgTextToDataUrl('not an svg at all')).toBeNull()
    expect(svgTextToDataUrl('<html><svg/></html>')).toBeNull()
    expect(svgTextToDataUrl('<svg>' + 'x'.repeat(50) + '</svg>', 20)).toBeNull()
  })
})

describe('imageSrcFromRead', () => {
  const PNG = 'D:\\projects\\x\\crab.png'

  it('passes through the data URL main returns for a raster image', () => {
    const src = imageSrcFromRead(PNG, { kind: 'image', content: 'data:image/png;base64,AAA' })
    expect(src).toBe('data:image/png;base64,AAA')
  })

  it('builds a data URL for an svg, which main returns as TEXT', () => {
    const src = imageSrcFromRead('D:\\projects\\x\\logo.svg', { kind: 'text', content: '<svg/>' })
    expect(src).toBe('data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg/>'))
  })

  it('returns null for a too-large image (main answers kind=binary)', () => {
    expect(imageSrcFromRead(PNG, { kind: 'binary' })).toBeNull()
  })

  it('returns null for a missing/failed read', () => {
    expect(imageSrcFromRead(PNG, null)).toBeNull()
    expect(imageSrcFromRead(PNG, undefined)).toBeNull()
    expect(imageSrcFromRead(PNG, { kind: 'image' })).toBeNull()
  })

  it('returns null when the path is not an image', () => {
    expect(imageSrcFromRead('D:\\projects\\x\\notes.md', { kind: 'text', content: '<svg/>' })).toBeNull()
  })

  it('refuses a non-data content for an image kind (no remote/file src ever)', () => {
    expect(imageSrcFromRead(PNG, { kind: 'image', content: 'https://evil.example/x.png' })).toBeNull()
    expect(imageSrcFromRead(PNG, { kind: 'image', content: 'file:///D:/x.png' })).toBeNull()
  })

  it('refuses text content that is not svg markup for an .svg path', () => {
    expect(imageSrcFromRead('D:\\projects\\x\\logo.svg', { kind: 'text', content: 'oops' })).toBeNull()
  })
})

// ── Enlarge must actually enlarge ─────────────────────────────────────────────
//
// THE BUG (driver run on the installed build): expanding only raised max-height
// 240px → 70vh with object-fit contain and NO width, so a 128×128 PNG — smaller
// than both caps — measured 128×128 in BOTH states. The click changed nothing
// but the tooltip. The fix derives an expanded WIDTH from the intrinsic size.

describe('thumbImageStyle — collapsed', () => {
  it('stays inside the 240px box and does not upscale', () => {
    const s = thumbImageStyle(false, { width: 128, height: 128 })
    expect(s.maxHeight).toBe(240)
    expect(s.maxWidth).toBe('100%')
    expect(s.width).toBe('auto')
    expect(s.height).toBe('auto')
    expect(s.objectFit).toBe('contain')
    expect(s.cursor).toBe('zoom-in')
    expect(s.imageRendering).toBeUndefined()
  })

  it('ignores the intrinsic size entirely (same box with or without it)', () => {
    expect(thumbImageStyle(false, null)).toEqual(thumbImageStyle(false, { width: 4000, height: 4000 }))
  })
})

describe('thumbImageStyle — expanded', () => {
  it('blows a small image up instead of leaving it at its intrinsic size', () => {
    const s = thumbImageStyle(true, { width: 128, height: 128 })
    // 128 × 4 = 512px, clamped to the bubble by max-width — never the 128px no-op.
    expect(s.width).toBe(512)
    expect(s.maxWidth).toBe('100%')
    expect(s.height).toBe('auto')
    expect(s.maxHeight).toBe('70vh')
    expect(s.cursor).toBe('zoom-out')
  })

  it('uses an absolute px width, never a percentage', () => {
    // The wrapper is a shrink-to-fit inline-block: a percentage width on a
    // replaced child resolves against the image's own intrinsic width there,
    // which is precisely the no-op this fix removes.
    for (const dims of [{ width: 16, height: 16 }, { width: 128, height: 128 }, { width: 3000, height: 2000 }, null]) {
      expect(typeof thumbImageStyle(true, dims).width).toBe('number')
    }
  })

  it('floors a tiny icon at 320px rather than 4× of nearly nothing', () => {
    expect(thumbImageStyle(true, { width: 16, height: 16 }).width).toBe(320)
    expect(thumbImageStyle(true, { width: 64, height: 64 }).width).toBe(320)
  })

  it('caps the box at 1200px for a big image (the column clamps it anyway)', () => {
    expect(thumbImageStyle(true, { width: 1920, height: 1080 }).width).toBe(1200)
    expect(thumbImageStyle(true, { width: 400, height: 300 }).width).toBe(1200)
  })

  it('falls back to the 320px floor while the intrinsic size is unknown', () => {
    for (const dims of [null, undefined, { width: 0, height: 0 }]) {
      expect(thumbImageStyle(true, dims).width).toBe(320)
    }
  })

  it('upscales pixel-art / icons with nearest-neighbour, photos smoothly', () => {
    expect(thumbImageStyle(true, { width: 128, height: 128 }).imageRendering).toBe('pixelated')
    expect(thumbImageStyle(true, { width: 256, height: 200 }).imageRendering).toBe('pixelated')
    expect(thumbImageStyle(true, { width: 257, height: 200 }).imageRendering).toBeUndefined()
    expect(thumbImageStyle(true, { width: 1920, height: 1080 }).imageRendering).toBeUndefined()
    // Unknown intrinsic ⇒ never guess at pixel art.
    expect(thumbImageStyle(true, null).imageRendering).toBeUndefined()
  })

  it('keeps a very tall image contained inside the box instead of stretched', () => {
    const s = thumbImageStyle(true, { width: 128, height: 4000 })
    expect(s.objectFit).toBe('contain')
    expect(s.maxWidth).toBe('100%')
    expect(s.maxHeight).toBe('70vh')
  })

  it('differs from the collapsed style for every size (the click is never a no-op)', () => {
    for (const dims of [{ width: 16, height: 16 }, { width: 128, height: 128 }, { width: 3000, height: 2000 }, null]) {
      expect(thumbImageStyle(true, dims)).not.toEqual(thumbImageStyle(false, dims))
    }
  })

  // The measured cap (see expandedMaxHeightPx below) has to actually reach the
  // style, otherwise the figure keeps overflowing the transcript it lives in.
  it('takes a measured px cap over the 70vh fallback', () => {
    expect(thumbImageStyle(true, { width: 128, height: 128 }, 412).maxHeight).toBe(412)
  })

  it('falls back to 70vh when nothing was measured', () => {
    for (const cap of [null, undefined, 0, -1, Number.NaN]) {
      expect(thumbImageStyle(true, { width: 128, height: 128 }, cap).maxHeight).toBe('70vh')
    }
  })

  it('never applies a cap to the collapsed box (that one is always 240)', () => {
    expect(thumbImageStyle(false, { width: 128, height: 128 }, 412).maxHeight).toBe(240)
  })
})

// ── Enlarged must FIT THE TRANSCRIPT, not the window ─────────────────────────
//
// THE BUG (driver-2 on the installed build, archived session): `max-height:70vh`
// resolves against the WINDOW, but the figure is clipped by the transcript's
// scroll container — which after header + toolbar + archive banner + composer is
// much shorter. The figure's box ran off the top of that container, so a click
// aimed at the middle of the image landed on the banner painted above it and did
// nothing; only the sliver still inside the container toggled back.

describe('expandedMaxHeightPx', () => {
  it('fits the SCROLL CONTAINER when that is the tighter box', () => {
    // 900px window ⇒ 70vh = 630, but the transcript is only 400 tall.
    expect(expandedMaxHeightPx(900, 400)).toBe(400 - 24)
  })

  it('keeps the 70vh rule when the container is the roomier box', () => {
    expect(expandedMaxHeightPx(900, 4000)).toBe(630)
  })

  it('leaves a gutter so the 2px border + row padding stay inside', () => {
    expect(expandedMaxHeightPx(10_000, 300)).toBeLessThan(300)
  })

  it('uses whichever box it could measure when the other is unknown', () => {
    expect(expandedMaxHeightPx(900, 0)).toBe(630)
    expect(expandedMaxHeightPx(0, 400)).toBe(400 - 24)
  })

  it('returns null (⇒ CSS 70vh) when nothing is measurable', () => {
    expect(expandedMaxHeightPx(0, 0)).toBeNull()
    expect(expandedMaxHeightPx(Number.NaN, Number.NaN)).toBeNull()
    expect(expandedMaxHeightPx(-100, -100)).toBeNull()
  })

  it('never returns a non-positive cap (a 0-height box would be unclickable)', () => {
    // A container smaller than the gutter itself falls back rather than
    // collapsing the figure to nothing.
    expect(expandedMaxHeightPx(0, 24)).toBeNull()
    expect(expandedMaxHeightPx(0, 12)).toBeNull()
    expect(expandedMaxHeightPx(0, 25)).toBe(1)
  })

  it('is a whole number of pixels', () => {
    expect(Number.isInteger(expandedMaxHeightPx(777, 0))).toBe(true)
  })
})

// ── First read must not be the only read ─────────────────────────────────────
//
// THE BUG (driver-2, archived session): the path was marked attempted BEFORE the
// await and never un-marked, so one transient miss — main's authorizedRoots Set
// is empty until the renderer registers the restored workingDir, and the child
// effect fires before the parent one — left a plain [IMG] chip for the whole
// mount, while a manual read of the same path answered kind:image instantly.

describe('read retry policy', () => {
  it('bounds the retries so an unreadable path settles into the plain chip', () => {
    expect(MAX_THUMB_READ_ATTEMPTS).toBe(3)
    expect(canRetryRead(0)).toBe(true)
    expect(canRetryRead(1)).toBe(true)
    expect(canRetryRead(2)).toBe(true)
    expect(canRetryRead(3)).toBe(false)
    expect(canRetryRead(99)).toBe(false)
  })

  it('backs off rather than hammering the IPC', () => {
    expect(readRetryDelayMs(1)).toBeGreaterThan(0)
    expect(readRetryDelayMs(2)).toBeGreaterThan(readRetryDelayMs(1))
  })

  it('stays inside a second of wall clock across the whole bounded sequence', () => {
    // Three tries total ⇒ two waits. A restored transcript must not sit on a
    // grey chip for a noticeable beat.
    const total = readRetryDelayMs(1) + readRetryDelayMs(2)
    expect(total).toBeLessThanOrEqual(1000)
  })
})
