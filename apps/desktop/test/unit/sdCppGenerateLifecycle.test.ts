// apps/desktop/test/unit/sdCppGenerateLifecycle.test.ts
//
// A DEAD LOCAL RENDER IS NEVER SILENT.
//
// Driver finding: a 49-frame Wan render overflowed 12 GB of VRAM, the OS reaped
// sd-cli, and the app went back to an idle "Generate" button with nothing to
// show for it — no error, no gallery entry, no log line. Seventy minutes of GPU
// time, zero evidence.
//
// Three distinct deaths have to be caught at the `close` boundary or the
// renderer has nothing to surface:
//
//   1. NON-ZERO EXIT — sd-cli refused the job or crashed itself. (Already
//      handled, and still pinned here so the refactor cannot lose it.)
//   2. DEATH BY SIGNAL — `close` reports code === null plus a signal name. The
//      old `code === 0` test rejected it only by accident, and the message it
//      built read "sd-cli exited null", naming neither the signal nor the fact
//      that something outside the process killed it.
//   3. EXIT ZERO, NO OUTPUT FILE — the failure mode that is silent by
//      construction: the process claims success and there is simply nothing on
//      disk to read.
//
// The far side is pinned too: the IPC must RESOLVE { ok:false, error } (never
// reject) and log, and MediaPage must render the message in a row that survives
// the user walking away — a toast cannot outlive a 70-minute render.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// hoisted: sd-cpp-client pulls in storage-root, which reads app.getPath() at
// IMPORT time (the idiom sdCppArchiveReuse.test.ts already uses in this dir).
const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  const { join: j } = require('node:path') as typeof import('node:path')
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return mk(j(td(), 'tachi-sdgen-'))
})

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: class {},
  net: {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
}))

import { describeSdExit } from '../../electron/services/sd-cpp-client'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')

describe('describeSdExit — a run only "succeeded" if it exited 0 AND left a file', () => {
  it('returns null for the one shape that is actually a success', () => {
    expect(describeSdExit({ label: 'sd-cli', code: 0, signal: null, outputExists: true, stderr: '' })).toBeNull()
    // …even when sd-cli chattered on stderr the whole way (it writes progress there)
    expect(describeSdExit({ label: 'sd-cli', code: 0, signal: null, outputExists: true, stderr: 'step 20/20\n' })).toBeNull()
  })

  it('DEATH 1 — a non-zero exit names the code', () => {
    const msg = describeSdExit({ label: 'sd-cli', code: 1, signal: null, outputExists: false, stderr: 'error: bad arg\n' })!
    expect(msg).toContain('sd-cli exited 1.')
    expect(msg).toContain('error: bad arg')
  })

  it('DEATH 2 — a SIGNAL kill says it was killed, and which signal (not "exited null")', () => {
    const msg = describeSdExit({ label: 'sd-cli vid_gen', code: null, signal: 'SIGKILL', outputExists: false, stderr: '' })!
    expect(msg).toBe('sd-cli vid_gen was killed (SIGKILL) before it finished.')
    expect(msg).not.toContain('null')
    // Windows reaps with SIGTERM/SIGABRT too — the name is passed through verbatim.
    expect(describeSdExit({ label: 'sd-cli', code: null, signal: 'SIGTERM', outputExists: false, stderr: '' }))
      .toContain('(SIGTERM)')
  })

  it('DEATH 2b — code null with no signal at all is still an error, never a success', () => {
    expect(describeSdExit({ label: 'sd-cli', code: null, signal: null, outputExists: false, stderr: '' }))
      .toBe('sd-cli exited unexpectedly.')
    // and a null code cannot be rescued by a stale file from an earlier run
    expect(describeSdExit({ label: 'sd-cli', code: null, signal: 'SIGKILL', outputExists: true, stderr: '' }))
      .toContain('was killed')
  })

  it('DEATH 3 — exit ZERO with no output file is reported, not swallowed', () => {
    // THE silent one: nothing else in the pipeline can tell this from a success.
    const msg = describeSdExit({ label: 'sd-cli vid_gen', code: 0, signal: null, outputExists: false, stderr: '' })!
    expect(msg).toBe('sd-cli vid_gen exited 0 but wrote no output file.')
  })

  it('carries the TAIL of stderr — the last real lines, not the trailing blanks', () => {
    // sd-cli ends its output with newlines, so a naive slice(-6) of split('\n')
    // hands back nothing but empty strings and the message says nothing at all.
    const noisy = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n\n\n'
    const msg = describeSdExit({ label: 'sd-cli', code: 2, signal: null, outputExists: false, stderr: noisy })!
    expect(msg).toContain('line 39')
    expect(msg).toContain('line 34')
    expect(msg).not.toContain('line 33')      // exactly six lines of tail
    expect(msg.trimEnd()).toBe(msg)
  })

  it('drops the CR of a Windows CRLF, and keeps the message on one head line', () => {
    const msg = describeSdExit({ label: 'sd-cli', code: 3, signal: null, outputExists: false, stderr: 'cuda error\r\nout of memory\r\n' })!
    expect(msg).not.toContain('\r')
    expect(msg.split('\n')[0]).toBe('sd-cli exited 3. cuda error')
    expect(msg).toContain('out of memory')
  })

  it('treats a BARE \\r as a line break — sd-cli redraws its progress bar in place', () => {
    // Without this the whole redraw history is one glued line and the real last
    // state (the one a terminal would be showing) is unreadable inside it.
    const inPlace = 'step 1/20\rstep 2/20\rstep 3/20\rCUDA out of memory\n'
    const msg = describeSdExit({ label: 'sd-cli vid_gen', code: null, signal: 'SIGKILL', outputExists: false, stderr: inPlace })!
    expect(msg).not.toContain('\r')
    expect(msg).toContain('CUDA out of memory')
    expect(msg).not.toContain('step 1/20step 2/20')
    // head + first rewrite share a line; the other three follow
    expect(msg.split('\n')).toHaveLength(4)
    expect(msg.split('\n')[0]).toBe('sd-cli vid_gen was killed (SIGKILL) before it finished. step 1/20')
  })

  it('is still a complete sentence when the child said nothing at all', () => {
    expect(describeSdExit({ label: 'sd-cli', code: 137, signal: null, outputExists: false, stderr: '   \n \n' }))
      .toBe('sd-cli exited 137.')
  })

  it('labels image and video runs distinctly (one client, two modalities)', () => {
    const img = describeSdExit({ label: 'sd-cli', code: 1, signal: null, outputExists: false, stderr: '' })!
    const vid = describeSdExit({ label: 'sd-cli vid_gen', code: 1, signal: null, outputExists: false, stderr: '' })!
    expect(img).not.toBe(vid)
    expect(vid).toContain('vid_gen')
  })
})

describe('the lifecycle wiring: both paths route `close` through describeSdExit', () => {
  const client = () => read('electron/services/sd-cpp-client.ts')

  it('the IMAGE path checks the signal and the output file, not just the code', () => {
    const src = client()
    const img = src.slice(src.indexOf('export function generateImage'), src.indexOf('// ── Video (Wan via'))
    expect(img).toContain("proc.on('close', (code, signal) => {")
    // …and, since the Stop button landed, whether WE were the ones who killed it.
    // `outputExists` is ALL the expected files now, not the one `-o` named: a
    // `--batch-count` run writes `_0…_{N-1}` and never the un-suffixed path, so
    // asking about that path alone reported every good batch as the silent
    // "exited 0 but wrote no output file" death.
    expect(img).toContain('const wrote = outPaths.some(p => existsSync(p))')
    expect(img).toContain("describeSdExit({ label: 'sd-cli', code, signal, outputExists: wrote, stderr, cancelled: me.cancelled })")
    // the old two-branch test that could not name a signal must be gone
    expect(img).not.toContain('if (code === 0 && existsSync(outPath)) resolve()')
  })

  it('the VIDEO path does the same — the VRAM death happened here', () => {
    const src = client()
    const vid = src.slice(src.indexOf('export function generateVideo'), src.length)
    expect(vid).toContain("proc.on('close', (code, signal) => {")
    expect(vid).toContain("describeSdExit({ label: 'sd-cli vid_gen', code, signal, outputExists: existsSync(outPath), stderr, cancelled: me.cancelled })")
    expect(vid).not.toContain('if (code === 0 && existsSync(outPath)) resolve()')
  })

  // W5-A added a THIRD spawner: `upscaleImage` (`sd-cli -M upscale`). It is a
  // different MODE, not a generation — no diffusion model, no prompt, no seed —
  // but it spawns the same binary, so it owes the same three deaths, the same
  // Stop handle and the same heartbeat discipline.
  it('the UPSCALE path routes close through describeSdExit too', () => {
    const src = client()
    const up = src.slice(src.indexOf('export function upscaleImage'), src.length)
    expect(up).toContain("proc.on('close', (code, signal) => {")
    expect(up).toContain("describeSdExit({ label: 'sd-cli upscale', code, signal, outputExists: existsSync(outputPath), stderr, cancelled: me.cancelled })")
    // The Stop handle is registered and dropped like the other two, or Stop kills
    // whatever the OS recycled that pid into.
    expect(up).toContain('const me: ActiveRun = { proc, cancelled: false }')
    expect(up).toContain('if (active === me) active = null')
  })

  it('a spawn error still rejects, and the heartbeat timer is cleared on every exit', () => {
    const src = client()
    // image + video + upscale
    expect(src.match(/proc\.on\('error', reject\)/g)).toHaveLength(3)
    // clearInterval fires in the close handler AND in the outer catch, per path
    expect(src.match(/clearInterval\(hbTimer\)/g)!.length).toBeGreaterThanOrEqual(6)
  })

  it('the generation IPCs RESOLVE the failure (never reject) and LOG it', () => {
    const ipc = read('electron/ipc/sd-cpp.ipc.ts')
    const gen = ipc.slice(ipc.indexOf("ipcMain.handle('sd-cpp:generate'"), ipc.length)
    expect(gen).toContain("console.error('[sd-cpp] image generation failed:', error)")
    expect(gen).toContain("console.error('[sd-cpp] video generation failed:', error)")
    // The upscale handler follows the same rule: a gallery tile renders the
    // failure inline, so a rejection there would surface as an unhandled promise.
    expect(gen).toContain("console.error('[sd-cpp] upscale failed:', error)")
    expect(gen.match(/return \{ ok: false as const, error \}/g)).toHaveLength(3)
  })
})

describe('the renderer surfaces the death inline — a toast cannot outlive the render', () => {
  const page = () => read('src/pages/media/MediaPage.tsx')

  it('the generate catch fills a PERSISTENT error row as well as the toast', () => {
    const src = page()
    const tail = src.slice(src.indexOf('  const generate = async () => {'), src.indexOf('const pushEntry ='))
    // The row now lives in the media STORE, not in this component's useState —
    // a tab switch used to unmount the page and erase a running render with it
    // (see mediaRunState.test.ts). The contract it pins is unchanged.
    expect(tail).toContain('failRun(text)')
    // The toast still fires with the same text; only its SEVERITY is now
    // derived rather than hardcoded, because a run the user STOPPED is not a
    // fault (mediaStopToastA11y.test.ts owns that mapping).
    expect(tail).toContain('showToast({ kind, text })')
    expect(tail).toContain('runFailureToastKind(')
    // …and every new run clears the previous failure (beginRun resets to IDLE)
    expect(tail).toContain('beginRun({ cancellable:')
    const store = read('src/store/media.store.ts')
    expect(store).toContain('set({ run: { ...IDLE_RUN, busy: true')
  })

  it('the row renders the message with a DISMISS and no fake RETRY', () => {
    const src = page()
    const row = src.slice(src.indexOf('{genError && ('), src.indexOf('{/* ── Right: persistent result gallery'))
    // `alert` for a real failure — and `status` for a stop the user asked for,
    // which is not an emergency to interrupt them about (mediaStopInlineRow).
    expect(row).toContain("role={genErrorIsStop ? 'status' : 'alert'}")
    expect(row).toContain("t('genError.title')")
    expect(row).toContain('{genError}')
    expect(row).toContain("t('genError.hint')")
    expect(row).toContain('onClick={() => clearRunError()}')
    // Re-running a job that died on memory is another hour to the same death.
    expect(row).not.toContain('retry')
    expect(row).not.toContain('Retry')
  })

  it('it covers BOTH local paths (one catch, one row) — image and video', () => {
    const src = page()
    const body = src.slice(src.indexOf('  const generate = async () => {'), src.indexOf('const pushEntry ='))
    // both local calls throw into that same catch
    expect(body).toContain("throw new Error(r.error || 'Local generation failed')")
    expect(body).toContain("throw new Error(r.error || 'Local video generation failed')")
    expect(body.match(/} catch \(err\) \{/g)).toHaveLength(1)
  })

  it('the genError strings exist in every shipped locale', () => {
    // Six now: the row says two different things depending on whether the run
    // FAILED or the user STOPPED it, and the failure hint ("needed more GPU
    // memory") is exactly the wrong sentence for a deliberate stop.
    // mediaStopInlineRow.test.ts owns that pair's content.
    const locales = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh']
    for (const loc of locales) {
      const json = JSON.parse(read(`src/i18n/locales/${loc}/media.json`)) as Record<string, Record<string, string>>
      expect(Object.keys(json.genError ?? {}).sort())
        .toEqual(['dismiss', 'hint', 'stoppedHint', 'stoppedTitle', 'title', 'unknown'])
      for (const v of Object.values(json.genError)) expect(v.trim().length).toBeGreaterThan(0)
    }
  })
})

describe('the SOFT ceiling: the duration hint admits GPU memory is a limit too', () => {
  it('the local duration description warns without inventing per-GPU numbers', () => {
    const src = read('electron/services/surplus-media-service.ts')
    const block = src.slice(src.indexOf("if (localVid && p.name === 'duration')"), src.indexOf("if (modality === 'image' && p.name === 'size')"))
    // the STRING the user reads, not the surrounding rationale comment
    // "Wan" left the sentence when the frame rate became per-row: it now says
    // "this checkpoint renders ${localVid.fps} fps clips", because Wan 2.2
    // TI2V-5B renders at 24 and the old copy hard-coded 16.
    const hint = /description: `(Local engine: this checkpoint[^`]*)`/.exec(block)![1]
    expect(hint).toContain('Longer clips also need more GPU memory')
    // the HARD ceiling it already stated is still derived from the model's law
    expect(hint).toContain('${WAN_FRAMES_MAX} frames')
    // no invented VRAM arithmetic — the service cannot know the free memory
    expect(hint).not.toMatch(/\d+\s?(GB|GiB|MB|VRAM)/)
    // one added sentence, not a paragraph
    expect(hint.split('. ').length).toBeLessThanOrEqual(4)
  })
})
