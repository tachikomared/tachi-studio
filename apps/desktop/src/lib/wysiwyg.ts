// apps/desktop/src/lib/wysiwyg.ts
//
// Direct-manipulation (WYSIWYG) text editing for the Design tab's HTML preview.
//
// The normal preview iframe is sandboxed `allow-scripts` WITHOUT
// `allow-same-origin` (opaque origin) so generated pages can't reach the app.
// We can't inject an editor script INTO it — a blob iframe inherits the parent
// CSP (`script-src 'self' …`, no `'unsafe-inline'`), so inline scripts are
// refused.
//
// Instead, WYSIWYG flips the trade-off: the iframe gets `allow-same-origin`
// but DROPS `allow-scripts`. The framed page therefore runs ZERO JavaScript (no
// sandbox-escape surface), while the PARENT — now same-origin with the blob —
// reaches into `contentDocument` and drives the editing itself. All edit logic
// runs in the trusted parent; nothing untrusted executes.
//
// `attachWysiwygEditor` wires hover/click-to-edit onto the live document and
// reports each commit as (elementIndex, newText). `applyTextEdit` maps that
// index onto the CLEAN source (same browser HTML parser → identical element
// order) and returns updated source. The saved source is never annotated.

/** Index of every element, in document order — matches a DOMParser parse of the
 *  same source, so the parent can map a live element back onto the source. */
function elementList(doc: Document): Element[] {
  return Array.from(doc.documentElement.querySelectorAll('*'))
}

function isEditable(el: EventTarget | null, doc: Document): el is HTMLElement {
  if (!el || (el as Node).nodeType !== 1) return false
  const e = el as HTMLElement
  if (e === doc.body || e === doc.documentElement) return false
  if (e.children.length > 0) return false // pure-text only → textContent is lossless
  return ((e.textContent ?? '').trim().length) > 0
}

/**
 * Attach click-to-edit text editing to a same-origin preview document. Returns
 * a cleanup function. `onEdit(index, text)` fires on commit (blur / Enter).
 */
export function attachWysiwygEditor(
  doc: Document,
  onEdit: (index: number, text: string) => void,
): () => void {
  let editing: HTMLElement | null = null
  const HOVER = '1.5px dashed #6366f1'
  const EDIT = '2px solid #6366f1'

  const clearStyle = (e: HTMLElement) => { e.style.outline = ''; e.style.background = ''; e.style.cursor = '' }

  const commit = () => {
    if (!editing) return
    const el = editing
    editing = null
    el.removeAttribute('contenteditable')
    clearStyle(el)
    const idx = elementList(doc).indexOf(el)
    if (idx >= 0) onEdit(idx, el.textContent ?? '')
  }

  const onOver = (ev: Event) => {
    const el = ev.target as HTMLElement
    if (el !== editing && isEditable(el, doc)) { el.style.outline = HOVER; el.style.cursor = 'text' }
  }
  const onOut = (ev: Event) => {
    const el = ev.target as HTMLElement
    if (el && el !== editing && el.style) { el.style.outline = ''; el.style.cursor = '' }
  }
  const onClick = (ev: MouseEvent) => {
    const t = ev.target as HTMLElement
    const link = t.closest?.('a')
    if (link) ev.preventDefault() // don't navigate while editing
    if (t === editing) return
    commit()
    if (isEditable(t, doc)) {
      editing = t
      t.style.outline = EDIT
      t.style.background = 'rgba(99,102,241,.06)'
      t.setAttribute('contenteditable', 'true')
      t.focus()
      try {
        const sel = doc.defaultView?.getSelection()
        const r = doc.createRange(); r.selectNodeContents(t)
        sel?.removeAllRanges(); sel?.addRange(r)
      } catch { /* selection best-effort */ }
      ev.preventDefault(); ev.stopPropagation()
    }
  }
  const onKey = (ev: KeyboardEvent) => {
    if (!editing) return
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); commit() }
    else if (ev.key === 'Escape') { const el = editing; editing = null; el.removeAttribute('contenteditable'); clearStyle(el) }
  }
  const onBlur = (ev: Event) => { if (editing && ev.target === editing) commit() }

  doc.addEventListener('mouseover', onOver, true)
  doc.addEventListener('mouseout', onOut, true)
  doc.addEventListener('click', onClick, true)
  doc.addEventListener('keydown', onKey, true)
  doc.addEventListener('blur', onBlur, true)

  return () => {
    try { commit() } catch { /* ignore */ }
    doc.removeEventListener('mouseover', onOver, true)
    doc.removeEventListener('mouseout', onOut, true)
    doc.removeEventListener('click', onClick, true)
    doc.removeEventListener('keydown', onKey, true)
    doc.removeEventListener('blur', onBlur, true)
  }
}

/**
 * Apply a text edit (by element index) onto the CLEAN source html. Returns the
 * new source, or null if the index is missing / not pure-text / a no-op.
 */
export function applyTextEdit(sourceHtml: string, index: number, text: string): string | null {
  try {
    if (!Number.isInteger(index) || index < 0) return null
    const doc = new DOMParser().parseFromString(sourceHtml, 'text/html')
    const el = doc.documentElement.querySelectorAll('*')[index]
    if (!el || el.children.length > 0) return null
    if ((el.textContent ?? '') === text) return null
    el.textContent = text
    return '<!doctype html>\n' + doc.documentElement.outerHTML
  } catch {
    return null
  }
}
