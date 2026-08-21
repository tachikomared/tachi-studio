// apps/desktop/src/pages/chat/TemplateSlotLayer.tsx
//
// The fill-in-the-blanks highlight layer (batch36).
//
// WHY THIS AND NOT A RICH-TEXT EDITOR: the batch measured @tiptap/core +
// /react + /starter-kit + /extension-mention at 420 KB minified / 134 KB gzip
// (101.9 KB gzip even hand-trimmed to document+paragraph+text+mention), pulling
// 13 prosemirror packages, against a chat chunk that is 8.8 KB gzip today and
// an app that just dieted 619 -> 355 MB. Rejected. This file is the light path:
// **the textarea is never replaced**. It stays the same uncontrolled-height
// <textarea> it has always been, so IME / RU input / paste / undo all keep the
// browser's native behaviour verbatim. This layer only PAINTS BACKGROUNDS
// behind it, and only while a template with blanks is armed.
//
// THE ALIGNMENT CONTRACT (the one thing that can visibly break):
// every glyph painted here must land on the exact pixel of the same glyph in
// the textarea above. That means this layer and the textarea must agree on
// font-family, font-size, line-height, padding, border WIDTH and wrapping — the
// shared constants below are imported by InputBar so the two boxes cannot drift
// — and the chip spans must have ZERO layout impact: background, border-radius
// and box-shadow only. A border or padding on a chip would advance the text
// after it by a pixel or two and smear the whole rest of the message.

import React, { useEffect, useRef } from 'react'
import { segmentBySlots } from '@tachi/core/src/prompts/template'

/**
 * Type metrics shared with the composer textarea. Exported (and asserted in
 * templateSlots.test.ts) so the layer can never be styled independently of the
 * box it has to line up with.
 */
export const SLOT_TYPE_METRICS = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 13,
  lineHeight: 1.5,
  padding: '8px 10px',
} as const

export function TemplateSlotLayer(props: {
  /** The composer text, verbatim. */
  text: string
  /** Live scrollTop of the textarea, so the paint follows a scrolled message. */
  scrollTop: number
}) {
  const ref = useRef<HTMLDivElement>(null)

  // Scroll sync is imperative on purpose: driving it through React state would
  // re-render the whole composer on every scroll frame.
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = props.scrollTop
  }, [props.scrollTop, props.text])

  return (
    <div
      ref={ref}
      className="tachi-slot-layer"
      /* Decorative: the real text (and its accessible name) lives on the
         textarea stacked above. Announcing this copy too would double every
         message for a screen reader. The blank COUNT is announced separately,
         by the composer's own live region. */
      aria-hidden="true"
      data-testid="slot-layer"
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
        // Matches the textarea's own box so the text origin is identical. The
        // border is TRANSPARENT (the textarea paints the visible one) but must
        // still occupy its 2px, and border-right is none there too.
        border: '2px solid transparent',
        borderRight: 'none',
        background: 'var(--bg-inset)',
        backgroundClip: 'padding-box',
        padding: SLOT_TYPE_METRICS.padding,
        fontFamily: SLOT_TYPE_METRICS.fontFamily,
        fontSize: SLOT_TYPE_METRICS.fontSize,
        lineHeight: SLOT_TYPE_METRICS.lineHeight,
        // Wrap exactly like a textarea does.
        whiteSpace: 'pre-wrap',
        overflowWrap: 'break-word',
        wordBreak: 'normal',
        // The glyphs come from the textarea on top; this copy is invisible and
        // exists only to place the chip backgrounds.
        color: 'transparent',
      }}
    >
      {segmentBySlots(props.text).map((seg, i) =>
        seg.slot
          ? (
            <span
              key={i}
              /* Layout-neutral by contract: background + radius + box-shadow
                 only. box-shadow is used instead of a border because it paints
                 outside the box model and therefore shifts nothing. */
              style={{
                background: 'var(--accent-muted)',
                borderRadius: 2,
                boxShadow: '0 0 0 1px var(--accent)',
              }}
            >{seg.text}</span>
          )
          : <React.Fragment key={i}>{seg.text}</React.Fragment>,
      )}
      {/* A textarea reserves a line box after a trailing newline; a div does
          not. Without this the layer scrolls a line short of the textarea. */}
      {'\n'}
    </div>
  )
}
