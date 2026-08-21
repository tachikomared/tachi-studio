// apps/desktop/electron/services/piper-client.ts
//
// Runs the piper binary ONE-SHOT per synthesis: text in on stdin → a .wav file
// out. Serialized (one piper at a time). piper is fast + CPU-only, so no GPU
// concerns. The .onnx.json config must sit next to the .onnx (the installer
// places it there); we also pass --espeak_data explicitly.

import { spawn } from 'child_process'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { ensureStorageDir } from './storage-root'
import { getPiperBinaryPath, isVoiceInstalled, listInstalledVoices, voiceOnnxPath, espeakDataDir } from './piper-installer'
import { isEngineMigrating } from './model-storage'
import { TaskFSM } from './util/task-fsm'

export interface PiperSynthInput { voiceId: string; text: string }
export interface PiperSynthResult { path: string; b64: string; mime: string }

function outDir(): string {
  // Final artifact location — the returned `path` IS what the renderer reveals
  // and serves, so it lives in the user-visible Media folder (legacy
  // userData/piper/out files are unaffected; only new synths land here).
  //
  // ensureStorageDir, not a bare mkdir: piper writes the .wav itself, so the
  // only moment we can heal a storage root that went unwritable mid-session
  // (Defender Controlled Folder Access on Documents — LANE J/L) is before the
  // binary is spawned — the probe moves the synth to a writable root.
  return ensureStorageDir('media', 'piper')
}

export function piperStatus(): { installed: boolean; voices: { id: string }[] } {
  return { installed: getPiperBinaryPath() !== null, voices: listInstalledVoices() }
}

let queue: Promise<unknown> = Promise.resolve()

export function synthesize(input: PiperSynthInput): Promise<PiperSynthResult> {
  const run = async (): Promise<PiperSynthResult> => {
    const bin = getPiperBinaryPath()
    if (!bin) throw new Error('piper is not installed. Click Install first.')
    if (isEngineMigrating('piper')) throw new Error('Piper voices are being moved to the storage folder — try again in a moment.')
    if (!isVoiceInstalled(input.voiceId)) throw new Error(`Voice "${input.voiceId}" is not downloaded.`)
    const text = (input.text ?? '').trim()
    if (!text) throw new Error('No text to speak.')
    const outPath = join(outDir(), `piper-${Date.now()}.wav`)
    const args = ['--model', voiceOnnxPath(input.voiceId), '--espeak_data', espeakDataDir(), '--output_file', outPath]

    const fsm = new TaskFSM(`piper-synth-${Date.now()}`)
    try {
      fsm.transition('running')
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
        let stderr = ''
        proc.stderr.on('data', (d: Buffer) => { stderr += String(d) })
        proc.on('error', reject)
        proc.on('close', code => {
          if (code === 0 && existsSync(outPath)) resolve()
          else reject(new Error(`piper exited ${code}. ${stderr.split('\n').slice(-6).join('\n').trim()}`))
        })
        // Feed the text on stdin, then EOF.
        proc.stdin.write(text)
        proc.stdin.end()
      })
      fsm.transition('processing')
      const bytes = readFileSync(outPath)
      fsm.transition('completed')
      return { path: outPath, b64: bytes.toString('base64'), mime: 'audio/wav' }
    } catch (err) {
      if (!fsm.isTerminal) fsm.transition('failed', err instanceof Error ? err.message : String(err))
      throw err
    }
  }
  const next = queue.then(run, run)
  queue = next.catch(() => {})
  return next
}
