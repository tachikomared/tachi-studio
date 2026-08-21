// NOTE: Uses child_process — runs in Node.js (Electron main process) only.
// Never import this in renderer code.
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface BinaryProbeResult {
  found: boolean
  version?: string
  error?: string
}

export async function binaryProbe(
  binary: string,
  args: string[],
  timeoutMs = 5000
): Promise<BinaryProbeResult> {
  const whichCmd = process.platform === 'win32' ? 'where.exe' : 'which'
  try {
    await execFileAsync(whichCmd, [binary], { timeout: 3000 })
  } catch {
    return { found: false }
  }

  try {
    const { stdout } = await execFileAsync(binary, args, { timeout: timeoutMs })
    return { found: true, version: stdout.trim().split('\n')[0] }
  } catch (e) {
    return { found: true, error: String(e) }
  }
}
