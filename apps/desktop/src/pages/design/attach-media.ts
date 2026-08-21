// apps/desktop/src/pages/design/attach-media.ts
//
// Media attachments for the Design composer. A video/audio/gif the user
// attaches is copied into the app's DesignAssets dir (design:add-asset) and the
// generated page references it as `assets/<name>` — served by tachi-preview://
// in the live preview and copied next to the saved HTML on auto-save.
//
// buildAssetPromptBlock is PURE (unit-tested): it produces the context block
// that tells the model the asset EXISTS and how to reference it — the model
// must never invent a placeholder URL or ask the user to upload the file again.

export interface MediaMeta {
  durationSec?: number
  width?: number
  height?: number
}

/** The context-chip text handed to the generator for one attached asset. */
export function buildAssetPromptBlock(name: string, mime: string, meta: MediaMeta = {}): string {
  const facts: string[] = [mime]
  if (typeof meta.durationSec === 'number' && isFinite(meta.durationSec) && meta.durationSec > 0) {
    facts.push(`${meta.durationSec.toFixed(1)}s`)
  }
  if (meta.width && meta.height) facts.push(`${meta.width}×${meta.height}`)
  const lines = [
    `USER-PROVIDED MEDIA ASSET — already available to the page, do NOT ask for it and do NOT use a placeholder:`,
    `- File: assets/${name} (${facts.join(', ')})`,
    `- Reference it EXACTLY as a relative URL: src="assets/${name}" — it is served in the live preview and copied next to the saved HTML.`,
    `- Never inline it as a data: URL and never substitute an external/stock URL for it.`,
  ]
  if (mime.startsWith('video/')) {
    // Cursor/scroll-scrub pages die on naive seeking: sparse H.264 keyframes
    // make every currentTime write an expensive seek, and writing it every
    // animation frame floods the decoder. Bake the known-good recipe into the
    // prompt so generated pages are smooth on the first try.
    lines.push(
      `- If the page SCRUBS this video (cursor/scroll mapped to video.currentTime):`,
      `  1. Preload it fully once — const blob = await (await fetch('assets/${name}')).blob(); video.src = URL.createObjectURL(blob); — then drive seeks only after 'canplaythrough'. ALWAYS keep src="assets/${name}" on the <video> element itself and treat the blob swap as an optional upgrade wrapped in .catch (fetch can be blocked in some hosting contexts; the element src streams fine).`,
      `  2. NEVER write video.currentTime on every animation frame. Gate on 'seeked': keep only the LATEST target time and issue the next seek only after the previous 'seeked' event fired (with a ~250ms watchdog reset). Skip writes when |currentTime - target| < 0.02s.`,
      `  3. H.264 keyframes are sparse — expect ~15-30 completed seeks/sec, which looks smooth WITH the gating above. For truly frame-perfect scrubbing, optionally pre-extract ~40 frames into ImageBitmaps at load (seek→drawImage into an offscreen canvas array) and paint by index on a visible canvas instead of seeking live.`,
    )
  }
  return lines.join('\n')
}

/** Compact chip label for one attached asset. */
export function assetChipLabel(name: string, meta: MediaMeta = {}): string {
  const parts = [name]
  if (typeof meta.durationSec === 'number' && isFinite(meta.durationSec) && meta.durationSec > 0) {
    parts.push(`${meta.durationSec.toFixed(1)}s`)
  }
  return `🎞 ${parts.join(' · ')}`
}

/** Probe duration/dimensions of a video or audio File via a detached media
 *  element. Best-effort: resolves {} on anything odd within the timeout. */
export function probeMediaMeta(file: File, timeoutMs = 4000): Promise<MediaMeta> {
  return new Promise((resolve) => {
    const isVideo = file.type.startsWith('video/')
    const isAudio = file.type.startsWith('audio/')
    if (!isVideo && !isAudio) { resolve({}); return }
    const url = URL.createObjectURL(file)
    const el = document.createElement(isVideo ? 'video' : 'audio') as HTMLVideoElement
    let done = false
    const finish = (meta: MediaMeta) => {
      if (done) return
      done = true
      URL.revokeObjectURL(url)
      el.removeAttribute('src')
      resolve(meta)
    }
    const timer = setTimeout(() => finish({}), timeoutMs)
    el.preload = 'metadata'
    el.onloadedmetadata = () => {
      clearTimeout(timer)
      finish({
        durationSec: isFinite(el.duration) ? el.duration : undefined,
        width: isVideo ? el.videoWidth || undefined : undefined,
        height: isVideo ? el.videoHeight || undefined : undefined,
      })
    }
    el.onerror = () => { clearTimeout(timer); finish({}) }
    el.src = url
  })
}

/** Grab a mid-clip poster frame of a video File as a JPEG data URL (for the
 *  vision reference image, so the model SEES the footage it designs around).
 *  Best-effort: resolves null on any failure within the timeout. */
export function videoPosterFrame(file: File, timeoutMs = 6000): Promise<string | null> {
  return new Promise((resolve) => {
    if (!file.type.startsWith('video/')) { resolve(null); return }
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    let done = false
    const finish = (dataUrl: string | null) => {
      if (done) return
      done = true
      URL.revokeObjectURL(url)
      video.removeAttribute('src')
      resolve(dataUrl)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    video.preload = 'auto'
    video.muted = true
    video.onloadedmetadata = () => {
      const t = isFinite(video.duration) && video.duration > 0 ? video.duration / 2 : 0
      try { video.currentTime = t } catch { clearTimeout(timer); finish(null) }
    }
    video.onseeked = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        if (!canvas.width || !canvas.height) { clearTimeout(timer); finish(null); return }
        canvas.getContext('2d')!.drawImage(video, 0, 0)
        clearTimeout(timer)
        finish(canvas.toDataURL('image/jpeg', 0.85))
      } catch { clearTimeout(timer); finish(null) }
    }
    video.onerror = () => { clearTimeout(timer); finish(null) }
    video.src = url
  })
}
