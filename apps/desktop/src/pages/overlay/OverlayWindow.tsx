// apps/desktop/src/pages/overlay/OverlayWindow.tsx
//
// Region-selection overlay. Mounts inside a frameless, transparent BrowserWindow
// created by overlay-service.ts. Tracks a single drag (mousedown → mousemove →
// mouseup) and emits the resulting rectangle via window.tachi.overlay.captureRegion.
//
// Visual model:
//   - Backdrop is a 55% black fill over the whole viewport.
//   - During a drag, the selection rectangle is "cut out" — we draw four solid
//     black panels around the marquee so the inside reads as the live pixels.
//   - A 2px accent border traces the marquee, plus a small live "WxH" badge.
//   - Top-center hint badge: "drag to select · esc to cancel".
//
// Esc → overlay.cancel. Mouseup with a non-trivial region → captureRegion.

import React, { useEffect, useRef, useState } from 'react'

interface Rect { x: number; y: number; w: number; h: number }

function rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const w = Math.abs(a.x - b.x)
  const h = Math.abs(a.y - b.y)
  return { x, y, w, h }
}

export function OverlayWindow() {
  const [start, setStart] = useState<{ x: number; y: number } | null>(null)
  const [current, setCurrent] = useState<{ x: number; y: number } | null>(null)
  const [capturing, setCapturing] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Esc to cancel. Listen at document level so it works regardless of focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        window.tachi.overlay.cancel().catch(() => {})
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onMouseDown = (e: React.MouseEvent) => {
    if (capturing) return
    if (e.button !== 0) return
    setStart({ x: e.clientX, y: e.clientY })
    setCurrent({ x: e.clientX, y: e.clientY })
  }

  const onMouseMove = (e: React.MouseEvent) => {
    if (!start) return
    setCurrent({ x: e.clientX, y: e.clientY })
  }

  /**
   * Grab one frame from a MediaStream into a cropped PNG data URL.
   * Shared between the getDisplayMedia (modern) and getUserMedia (legacy) paths.
   */
  async function streamToCroppedPng(
    stream: MediaStream,
    rect: Rect,
    displaySize: { width: number; height: number },
  ): Promise<string> {
    const track = stream.getVideoTracks()[0]
    try {
      const video = document.createElement('video')
      video.srcObject = stream
      video.muted = true
      await new Promise<void>(res => {
        video.onloadedmetadata = () => { video.play().then(() => res(), () => res()) }
      })
      // Give the compositor 1-2 frames so the buffer isn't blank black.
      await new Promise(r => requestAnimationFrame(r))
      await new Promise(r => requestAnimationFrame(r))
      const vw = video.videoWidth  || displaySize.width
      const vh = video.videoHeight || displaySize.height

      // Map renderer CSS rect → video pixel rect
      const sx = vw / displaySize.width
      const sy = vh / displaySize.height
      const cx = Math.max(0, Math.round(rect.x * sx))
      const cy = Math.max(0, Math.round(rect.y * sy))
      const cw = Math.max(1, Math.min(Math.round(rect.w * sx), vw - cx))
      const ch = Math.max(1, Math.min(Math.round(rect.h * sy), vh - cy))

      const canvas = document.createElement('canvas')
      canvas.width  = cw
      canvas.height = ch
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(video, cx, cy, cw, ch, 0, 0, cw, ch)
      return canvas.toDataURL('image/png')
    } finally {
      try { track.stop() } catch { /* swallow */ }
    }
  }

  /**
   * Primary capture path: navigator.mediaDevices.getDisplayMedia.
   * Electron 31 routes this through session.setDisplayMediaRequestHandler in
   * main.ts which hands back a desktopCapturer source — this is the documented
   * current path and avoids the all-black thumbnail bug entirely.
   */
  async function captureViaDisplayMedia(rect: Rect): Promise<string> {
    // Hide the overlay BEFORE requesting the stream so the captured frame is
    // the live desktop, not our 55%-black backdrop.
    const { displaySize } = await window.tachi.overlay.getSourceId()
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
    return streamToCroppedPng(stream, rect, displaySize)
  }

  /**
   * Legacy fallback: Chromium's non-standard chromeMediaSource constraints.
   * Kept around because some Electron versions still need it on Linux/older Win.
   */
  async function captureViaGetUserMedia(rect: Rect): Promise<string> {
    const { sourceId, displaySize, scaleFactor } =
      await window.tachi.overlay.getSourceId()
    const pxW = Math.round(displaySize.width  * scaleFactor)
    const pxH = Math.round(displaySize.height * scaleFactor)

    // Chrome's non-standard constraint API for desktop capture in Electron.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const constraints: any = {
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          minWidth:  pxW, maxWidth:  pxW,
          minHeight: pxH, maxHeight: pxH,
        },
      },
    }
    const stream = await navigator.mediaDevices.getUserMedia(constraints)
    return streamToCroppedPng(stream, rect, displaySize)
  }

  const onMouseUp = async (e: React.MouseEvent) => {
    if (!start) return
    const end = { x: e.clientX, y: e.clientY }
    const rect = rectFromPoints(start, end)
    setStart(null)
    setCurrent(null)
    // Trivial / accidental click — just cancel.
    if (rect.w < 4 || rect.h < 4) {
      window.tachi.overlay.cancel().catch(() => {})
      return
    }
    setCapturing(true)
    const intRect: Rect = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.w),
      h: Math.round(rect.h),
    }
    try {
      // PRIMARY (Electron 31, documented path): getDisplayMedia routed through
      // main's setDisplayMediaRequestHandler. Works on Windows + Hi-DPI.
      const dataUrl = await captureViaDisplayMedia(intRect)
      await window.tachi.overlay.reportCapture(dataUrl)
    } catch (errA) {
      console.warn('[overlay] getDisplayMedia failed, trying getUserMedia:', errA)
      try {
        // FALLBACK 1: chromeMediaSource constraints (older Electron / Linux).
        const dataUrl = await captureViaGetUserMedia(intRect)
        await window.tachi.overlay.reportCapture(dataUrl)
      } catch (errB) {
        console.warn('[overlay] getUserMedia failed, trying thumbnail fallback:', errB)
        try {
          // FALLBACK 2: legacy desktopCapturer.thumbnail crop (non-Windows).
          await window.tachi.overlay.captureRegion(intRect)
        } catch (errC) {
          console.warn('[overlay] all capture paths failed:', errC)
          window.tachi.overlay.cancel().catch(() => {})
        }
      }
    }
  }

  const liveRect = start && current ? rectFromPoints(start, current) : null

  // Render four black panels around the marquee for the "cut-out" look.
  // When no drag is active, draw a single full backdrop instead.
  return (
    <div
      ref={rootRef}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      style={{
        position: 'fixed',
        inset: 0,
        cursor: capturing ? 'wait' : 'crosshair',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        overflow: 'hidden',
      }}
    >
      {liveRect ? (
        <>
          {/* Top panel */}
          <div style={{
            position: 'absolute',
            left: 0, top: 0, right: 0,
            height: liveRect.y,
            background: 'rgba(0,0,0,0.55)',
          }} />
          {/* Bottom panel */}
          <div style={{
            position: 'absolute',
            left: 0, top: liveRect.y + liveRect.h, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.55)',
          }} />
          {/* Left panel */}
          <div style={{
            position: 'absolute',
            left: 0, top: liveRect.y,
            width: liveRect.x, height: liveRect.h,
            background: 'rgba(0,0,0,0.55)',
          }} />
          {/* Right panel */}
          <div style={{
            position: 'absolute',
            left: liveRect.x + liveRect.w, top: liveRect.y,
            right: 0, height: liveRect.h,
            background: 'rgba(0,0,0,0.55)',
          }} />
          {/* Marquee border */}
          <div style={{
            position: 'absolute',
            left: liveRect.x, top: liveRect.y,
            width: liveRect.w, height: liveRect.h,
            border: '2px solid var(--accent, #f78c2c)',
            boxSizing: 'border-box',
            pointerEvents: 'none',
          }} />
          {/* Size badge */}
          <div style={{
            position: 'absolute',
            left: liveRect.x + 2,
            top:  liveRect.y + liveRect.h + 6,
            padding: '2px 6px',
            background: 'var(--bg-surface, #141414)',
            border: '2px solid var(--border, #2a2a2a)',
            color: 'var(--text-primary, #fafafa)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 10,
            letterSpacing: '0.04em',
            pointerEvents: 'none',
            boxShadow: 'var(--shadow-hard, 4px 4px 0 rgba(0,0,0,0.5))',
          }}>
            {Math.round(liveRect.w)} × {Math.round(liveRect.h)}
          </div>
        </>
      ) : (
        <div style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0,0,0,0.55)',
        }} />
      )}

      {/* Hint badge top-center */}
      <div style={{
        position: 'fixed',
        top: 14,
        left: '50%',
        transform: 'translateX(-50%)',
        padding: '6px 12px',
        background: 'var(--bg-surface, #141414)',
        border: '2px solid var(--border, #2a2a2a)',
        color: 'var(--text-primary, #fafafa)',
        boxShadow: 'var(--shadow-hard, 4px 4px 0 rgba(0,0,0,0.5))',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 11,
        letterSpacing: '0.04em',
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
      }}>
        {capturing
          ? 'capturing…'
          : 'drag to select · esc to cancel'}
      </div>
    </div>
  )
}
