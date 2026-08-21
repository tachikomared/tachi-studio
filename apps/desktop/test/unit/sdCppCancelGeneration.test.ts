// apps/desktop/test/unit/sdCppCancelGeneration.test.ts
//
// «I CANT STOP IT.»
//
// The owner, at the machine, watching a local Wan render hold the GPU at 95%
// for seventy minutes with no cancel affordance anywhere in the app. The only
// way out was Task Manager — from outside the program that started it.
//
// A Stop button is only honest if three things are true, and all three are
// pinned here:
//
//   1. THE KILL LANDS. One child at a time (the client serialises for VRAM), so
//      one module-level handle is the whole mechanism — registered right after
//      spawn, cleared on `close`, so it can never name a pid the OS has already
//      recycled.
//   2. THE RUN REPORTS ITSELF. The killed generation dies down the SAME path
//      every other death uses (describeSdExit → the inline error row), saying it
//      was STOPPED rather than pretending to be a crash.
//   3. THE QUEUE IS NOT WEDGED. A Stop that left the promise chain stuck would
//      be a worse bug than the one it fixes: the next Generate would hang
//      forever with no process running at all.
//
// The child is faked; everything around it (the queue, the close handling, the
// message) is the real code.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  const { join: j } = require('node:path') as typeof import('node:path')
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return mk(j(td(), 'tachi-sdcancel-'))
})

// Every spawn the client (and killProcessTree) makes comes through here.
const spawned = vi.hoisted(() => ({ calls: [] as Array<{ cmd: string; args: string[] }>, procs: [] as unknown[] }))

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: class {},
  net: {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
}))

// NOTE: the factory is HOISTED above every import in this file, so it may only
// use `vi.hoisted` state and `require` — a `vi.fn()` or a top-level
// `EventEmitter` here dies with "cannot access before initialization".
vi.mock('child_process', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { EventEmitter: EE } = require('node:events') as typeof import('node:events')
  class FakeProc extends EE {
    stdout = new EE()
    stderr = new EE()
    pid = 4242
    killed: NodeJS.Signals[] = []
    kill(signal?: NodeJS.Signals): boolean { this.killed.push(signal ?? 'SIGTERM'); return true }
  }
  return {
    spawn: (cmd: string, args: string[]) => {
      spawned.calls.push({ cmd, args })
      const p = new FakeProc()
      // `taskkill` is the kill helper, not a generation — it is never awaited.
      if (cmd !== 'taskkill') spawned.procs.push(p)
      return p
    },
  }
})

vi.mock('../../electron/services/sd-cpp-installer', () => ({
  getSdCliPath: () => 'C:/engines/sd-cli.exe',
  isSdModelInstalled: () => true,
  listInstalledSdModels: () => [],
  modelComponentPaths: () => ({ model: 'C:/models/sd15.safetensors' }),
  // The disk/machine lookups the arg builder's env is read from. All four
  // answer "nothing installed / not CUDA", which is the pre-adapter argv — this
  // file is about the KILL, not about the flags.
  listInstalledSdAdapters: () => [],
  installedAdapterDirs: () => ({}),
  installedAdapterPath: () => null,
  findTaeFile: () => null,
  isCudaSdBuild: () => false,
  // …and the curated SPEED PACK lookup, which answers the same "nothing
  // installed": this file is about the KILL, not about the distill preset.
  installedSpeedAdapter: () => undefined,
  // …and the two the reference-image / typed-tag work added to the same env
  // lookup. An omission here is not a harmless gap: sdArgEnvFor calls whatever
  // the client imports, so a missing member is `undefined is not a function`
  // INSIDE the generation — which reads in this file as "nothing ever spawned"
  // and looks exactly like a kill-path bug. Same "nothing installed" answers.
  installedLoraNames: () => [],
  installedIpAdapterForFamily: () => null,
}))
vi.mock('../../electron/services/model-storage', () => ({ isEngineMigrating: () => false }))
vi.mock('../../electron/services/storage-root', () => ({ ensureStorageDir: () => USERDATA }))

import { generateImage, generateVideo, cancelGeneration, isGenerating, describeSdExit } from '../../electron/services/sd-cpp-client'
import { killProcessTree } from '../../electron/services/util/kill-tree'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number }

/** Let the promise queue turn until the client has actually spawned. */
async function untilSpawned(n: number): Promise<FakeChild> {
  for (let i = 0; i < 200 && spawned.procs.length < n; i++) await new Promise(r => setTimeout(r, 0))
  return spawned.procs[n - 1] as FakeChild
}

beforeEach(() => {
  spawned.calls.length = 0
  spawned.procs.length = 0
})

afterEach(() => {
  // Never leave the module-level handle pointing at a dead fake.
  expect(isGenerating()).toBe(false)
})

describe('cancelGeneration — the kill lands and the run says why it died', () => {
  it('kills the running IMAGE render; the promise rejects as STOPPED, not crashed', async () => {
    const p = generateImage({ modelId: 'sd15', prompt: 'a cat' })
    const proc = await untilSpawned(1)
    expect(isGenerating()).toBe(true)

    const r = cancelGeneration()
    expect(r).toEqual({ cancelled: true, pid: 4242 })
    // Windows: the whole tree, forced.
    expect(spawned.calls.some(c => c.cmd === 'taskkill' && c.args.join(' ') === '/PID 4242 /T /F')).toBe(true)

    // …the OS reaps it (taskkill /F surfaces as a non-zero exit on Windows)
    proc.emit('close', 1, null)
    await expect(p).rejects.toThrow('sd-cli was stopped before it finished.')
    expect(isGenerating()).toBe(false)
  })

  it('kills the running VIDEO render the same way — one client, one button', async () => {
    const p = generateVideo({ modelId: 'wan21-t2v-1.3b', prompt: 'a cat' })
    const proc = await untilSpawned(1)
    expect(cancelGeneration().cancelled).toBe(true)
    proc.emit('close', null, 'SIGTERM')
    await expect(p).rejects.toThrow('sd-cli vid_gen was stopped before it finished.')
  })

  it('the stopped message carries NO stderr tail — a stop is not a diagnosis', async () => {
    const p = generateVideo({ modelId: 'wan21-t2v-1.3b', prompt: 'a cat' })
    const proc = await untilSpawned(1)
    proc.stderr.emit('data', Buffer.from('step 7/20\nCUDA busy\n'))
    cancelGeneration()
    proc.emit('close', 1, null)
    await expect(p).rejects.toThrow(/^sd-cli vid_gen was stopped before it finished\.$/)
  })

  it('THE QUEUE IS NOT WEDGED: the next Generate runs immediately after a stop', async () => {
    const first = generateImage({ modelId: 'sd15', prompt: 'one' })
    const p1 = await untilSpawned(1)
    cancelGeneration()
    p1.emit('close', 1, null)
    await expect(first).rejects.toThrow('was stopped')

    const second = generateImage({ modelId: 'sd15', prompt: 'two' })
    const p2 = await untilSpawned(2)          // it really did spawn again
    expect(p2).not.toBe(p1)
    p2.emit('close', 1, null)
    await expect(second).rejects.toThrow('sd-cli exited 1.')   // a NORMAL failure again
  })

  it('a stop while nothing is running is a no-op, not an error', () => {
    expect(cancelGeneration()).toEqual({ cancelled: false })
    expect(spawned.calls.some(c => c.cmd === 'taskkill')).toBe(false)
  })

  it('the handle is dropped on a normal death too — Stop can never hit a stale pid', async () => {
    const p = generateImage({ modelId: 'sd15', prompt: 'a cat' })
    const proc = await untilSpawned(1)
    expect(isGenerating()).toBe(true)
    proc.emit('close', 2, null)               // died on its own, no cancel
    await expect(p).rejects.toThrow('sd-cli exited 2.')
    expect(isGenerating()).toBe(false)
    expect(cancelGeneration()).toEqual({ cancelled: false })
  })

  it('a queued run that has not spawned yet is not killable — and does not lie', async () => {
    const first  = generateImage({ modelId: 'sd15', prompt: 'one' })
    const p1 = await untilSpawned(1)
    const second = generateImage({ modelId: 'sd15', prompt: 'two' })
    // `second` is still behind `first` in the VRAM queue: one child exists.
    expect(spawned.procs).toHaveLength(1)
    cancelGeneration()                         // stops the RUNNING one
    p1.emit('close', 1, null)
    await expect(first).rejects.toThrow('was stopped')
    const p2 = await untilSpawned(2)
    p2.emit('close', 1, null)                  // the queued one ran normally
    await expect(second).rejects.toThrow('sd-cli exited 1.')
  })
})

describe('describeSdExit — the stopped path, without disturbing the other three', () => {
  it('names the stop and drops the tail', () => {
    expect(describeSdExit({ label: 'sd-cli', code: 1, signal: null, outputExists: false, stderr: 'boom\n', cancelled: true }))
      .toBe('sd-cli was stopped before it finished.')
    expect(describeSdExit({ label: 'sd-cli vid_gen', code: null, signal: 'SIGKILL', outputExists: false, stderr: '', cancelled: true }))
      .toBe('sd-cli vid_gen was stopped before it finished.')
  })

  it('a stop that raced a FINISHED render is still a success — the file exists', () => {
    expect(describeSdExit({ label: 'sd-cli', code: 0, signal: null, outputExists: true, stderr: '', cancelled: true })).toBeNull()
  })

  it('cancelled:false / absent behaves exactly as before (the VRAM kill still reads as one)', () => {
    expect(describeSdExit({ label: 'sd-cli', code: null, signal: 'SIGKILL', outputExists: false, stderr: '' }))
      .toBe('sd-cli was killed (SIGKILL) before it finished.')
    expect(describeSdExit({ label: 'sd-cli', code: 1, signal: null, outputExists: false, stderr: 'oom\n', cancelled: false }))
      .toBe('sd-cli exited 1. oom')
  })
})

describe('killProcessTree — the kill itself, on both platforms', () => {
  const fakeProc = () => ({ pid: 99, kill: vi.fn(() => true) })

  it('Windows: taskkill /PID <pid> /T /F, hidden', () => {
    const spawnFn = vi.fn()
    const proc = fakeProc()
    expect(killProcessTree(proc, { platform: 'win32', spawnFn })).toBe(true)
    expect(spawnFn).toHaveBeenCalledWith('taskkill', ['/PID', '99', '/T', '/F'], { windowsHide: true })
    expect(proc.kill).not.toHaveBeenCalled()
  })

  it('POSIX: the process GROUP, so a wrapper cannot orphan the real worker', () => {
    const killPid = vi.fn()
    expect(killProcessTree(fakeProc(), { platform: 'linux', killPid })).toBe(true)
    expect(killPid).toHaveBeenCalledWith(-99, 'SIGKILL')
  })

  it('falls back to the bare child when the group kill is refused', () => {
    const proc = fakeProc()
    const killPid = vi.fn(() => { throw new Error('ESRCH') })
    expect(killProcessTree(proc, { platform: 'linux', killPid })).toBe(true)
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('never throws on a process that is already gone', () => {
    expect(killProcessTree(null)).toBe(false)
    expect(killProcessTree(undefined)).toBe(false)
    expect(killProcessTree({ kill: () => { throw new Error('ESRCH') } })).toBe(false)
    expect(killProcessTree({ pid: 0, kill: () => false })).toBe(false)
  })
})

describe('the wiring: one IPC, one preload method, one button', () => {
  it('the IPC kills and logs, and never rejects at the renderer', () => {
    const ipc = read('electron/ipc/sd-cpp.ipc.ts')
    expect(ipc).toContain("ipcMain.handle('sd-cpp:cancel-generation', () => {")
    expect(ipc).toContain('const r = cancelGeneration()')
    expect(ipc).toContain("console.warn('[sd-cpp] generation stopped by the user (pid', r.pid, ')')")
  })

  it('the preload exposes it on the same sdCpp surface as generate', () => {
    const pre = read('electron/preload.ts')
    expect(pre).toContain("cancelGeneration: () => ipcRenderer.invoke('sd-cpp:cancel-generation')")
    const types = read('src/types/electron.d.ts')
    expect(types).toContain('cancelGeneration(): Promise<{ ok: boolean; cancelled: boolean; pid?: number }>')
  })

  it('the STOP button renders ONLY while a killable render is in flight', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    const block = page.slice(page.indexOf('{busy && run.cancellable && ('), page.indexOf('{/* Generation failure'))
    expect(block).toContain('onClick={() => void stopGeneration()}')
    expect(block).toContain('disabled={run.stopping}')
    expect(block).toContain("{run.stopping ? t('actions.stopping') : t('actions.stop')}")
    // …and it is driven by the STORE, so it is still there after a tab switch
    expect(page).toContain('{busy && run.cancellable && (')
  })

  it('stopGeneration latches, calls the IPC, and asserts nothing on its own', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    const fn = page.slice(page.indexOf('  const stopGeneration = async () => {'), page.indexOf('  // ── Remix'))
    expect(fn).toContain('if (!run.busy || !run.cancellable || run.stopping) return')
    expect(fn).toContain('markRunStopping()')
    expect(fn).toContain('await window.tachi.sdCpp.cancelGeneration()')
    // the real state change arrives with the child's death, not from here
    expect(fn).not.toContain('failRun(')
    expect(fn).not.toContain('endRun(')
  })

  it('the three Stop strings ship in every locale', () => {
    for (const loc of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh']) {
      const json = JSON.parse(read(`src/i18n/locales/${loc}/media.json`)) as Record<string, Record<string, string>>
      for (const k of ['stop', 'stopping', 'stopTitle']) {
        expect(json.actions?.[k], `${loc}/${k}`).toBeTruthy()
      }
    }
  })
})
