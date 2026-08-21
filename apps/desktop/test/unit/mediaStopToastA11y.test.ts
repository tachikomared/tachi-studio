// apps/desktop/test/unit/mediaStopToastA11y.test.ts
//
// TWO DRIVER FINDINGS ABOUT THE SAME LITTLE BOX IN THE CORNER.
//
// 1. THE STOP TOAST IS LABELLED "ERR".
//    The owner pressed STOP on a local render. The kill landed, sd-cli died,
//    and the run rejected through the ordinary failure path — which showed a
//    red ERR toast reading "sd-cli was stopped before it finished." Nothing
//    went wrong: the user asked for exactly that, got exactly that, and the app
//    reported it as a fault. describeSdExit already tells the two apart (the
//    `cancelled` flag has existed since a403875 and drops the stderr tail for
//    precisely this reason) — only the SEVERITY the renderer picked was blind
//    to it.
//
// 2. THE TOAST REGION IS NOT ANNOUNCED.
//    The fallback notice ("SURPLUS cannot serve MUSIC…") is a toast, and a
//    toast is the only place some of this app's state changes are ever said. A
//    screen reader gets none of them: the container carried aria-live but was
//    UNMOUNTED whenever the list was empty, and a live region that does not
//    exist at the moment content arrives announces nothing at all — the reader
//    has to be observing the node BEFORE it changes. `role="status"` plus a
//    region that is always in the tree is the whole fix.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runFailureToastKind } from '../../src/pages/media/mediaHelpers'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')

// The exact strings main produces (describeSdExit in sd-cpp-client.ts). Pinned
// against the source below so a reworded message cannot quietly go back to ERR.
const STOPPED_IMAGE = 'sd-cli was stopped before it finished.'
const STOPPED_VIDEO = 'sd-cli vid_gen was stopped before it finished.'
const KILLED        = 'sd-cli was killed (SIGKILL) before it finished.'
const CRASHED       = 'sd-cli exited 1. CUDA error: out of memory'

describe('a stop the USER asked for is not an error', () => {
  it('THE REPRO: the stop message is INFO, not ERR', () => {
    expect(runFailureToastKind({ message: STOPPED_IMAGE, stopping: true })).toBe('info')
    expect(runFailureToastKind({ message: STOPPED_VIDEO, stopping: true })).toBe('info')
  })

  it('reads the latched Stop button even if main words the message differently', () => {
    // `stopping` is set the instant Stop is clicked (markRunStopping) and is the
    // renderer's OWN evidence — it does not depend on main's copy.
    expect(runFailureToastKind({ message: 'sd-cli exited 3221225786.', stopping: true })).toBe('info')
  })

  it('reads the message even if the button never latched', () => {
    // The canvas surface has no Stop button of its own; a cancel issued
    // elsewhere still comes back through this path.
    expect(runFailureToastKind({ message: STOPPED_IMAGE, stopping: false })).toBe('info')
  })

  it('a REAL failure is still an error — that is the whole risk of this change', () => {
    expect(runFailureToastKind({ message: CRASHED, stopping: false })).toBe('error')
    expect(runFailureToastKind({ message: '', stopping: false })).toBe('error')
  })

  it('a KILL from outside is an error — it is not something the user asked for', () => {
    // Both sentences end "before it finished."; only one of them is a stop.
    // An OOM reaper or Task Manager killing the child IS a fault to report.
    expect(runFailureToastKind({ message: KILLED, stopping: false })).toBe('error')
  })

  it('main still produces the sentence this maps on', () => {
    const client = read('electron/services/sd-cpp-client.ts')
    expect(client).toMatch(/if \(cancelled\) return `\$\{label\} was stopped before it finished\.`/)
    // …and the kill line it must NOT be confused with.
    expect(client).toMatch(/was killed \(\$\{signal\}\) before it finished\./)
  })
})

describe('MediaPage wiring', () => {
  const page = read('src/pages/media/MediaPage.tsx')

  it('picks the toast severity through the helper, not a hardcoded error', () => {
    expect(page).toMatch(/runFailureToastKind/)
    expect(page).toMatch(/showToast\(\{ kind, text \}\)/)
  })

  it('reads `stopping` BEFORE failRun clears it', () => {
    // failRun sets stopping:false as part of settling the run, so the flag has
    // to be sampled first or the evidence is gone by the time it is needed.
    const idx = {
      sample: page.search(/runFailureToastKind/),
      fail:   page.search(/\n\s*failRun\(text\)/),
    }
    expect(idx.sample).toBeGreaterThan(-1)
    expect(idx.fail).toBeGreaterThan(-1)
    expect(idx.sample).toBeLessThan(idx.fail)
  })
})

describe('the toast region is announced', () => {
  const toaster = read('src/components/Toaster.tsx')

  it('carries role="status" and aria-live="polite"', () => {
    expect(toaster).toMatch(/role="status"/)
    expect(toaster).toMatch(/aria-live="polite"/)
  })

  it('is ALWAYS mounted — an empty list no longer unmounts the live region', () => {
    // The old `if (toasts.length === 0) return null` meant the region was
    // created at the same moment its first child appeared, which is exactly the
    // case assistive tech is documented not to announce.
    expect(toaster).not.toMatch(/if \(toasts\.length === 0\) return null/)
  })

  it('the empty region cannot swallow clicks', () => {
    // It spans a fixed corner of the window; with nothing in it, it must stay
    // transparent to the pointer.
    expect(toaster).toMatch(/pointerEvents: 'none'/)
  })
})
