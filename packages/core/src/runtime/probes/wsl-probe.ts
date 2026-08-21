// packages/core/src/runtime/probes/wsl-probe.ts
import { execFile } from 'child_process'
import { promisify } from 'util'

const exec = promisify(execFile)

const WSL_TIMEOUT_MS = 5_000

export interface WslBinaryHit {
  distro:   string
  path:     string
  version?: string
}

/**
 * Enumerate installed WSL distributions on Windows.
 * Returns an empty array on non-Windows or when WSL isn't installed.
 *
 * `wsl -l -q` prints one distro name per line (quiet, no headers).
 * The output is UTF-16LE on some Windows builds; we strip BOM/nulls defensively.
 */
export async function listWslDistros(): Promise<string[]> {
  if (process.platform !== 'win32') return []
  try {
    const { stdout } = await exec('wsl.exe', ['-l', '-q'], { timeout: WSL_TIMEOUT_MS, windowsHide: true })
    return stdout
      .replace(/\0/g, '')      // strip UTF-16 null bytes emitted by some Windows builds
      .replace(/﻿/g, '')  // strip BOM (U+FEFF) that can prefix WSL output
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Look for `binary` inside each WSL distro.
 * Returns a list of hits (one per distro that has the binary).
 *
 * Uses `wsl -d <distro> -- which <binary>` then `wsl -d <distro> -- <binary> --version`
 * for the version string. Failures per-distro are silenced — only successes return.
 *
 * Defense: binary name must match `[a-zA-Z0-9_.-]+` to prevent shell metacharacter injection.
 */
export async function probeWslBinary(binary: string, versionArgs: string[] = ['--version']): Promise<WslBinaryHit[]> {
  if (process.platform !== 'win32') return []
  // Disallow shell metacharacters in the binary name — defense against caller mistakes
  if (!/^[a-zA-Z0-9_.-]+$/.test(binary)) return []

  const distros = await listWslDistros()
  if (distros.length === 0) return []

  const hits: WslBinaryHit[] = []
  for (const distro of distros) {
    let path: string
    try {
      const { stdout } = await exec('wsl.exe', ['-d', distro, '--', 'which', binary], {
        timeout: WSL_TIMEOUT_MS, windowsHide: true,
      })
      path = stdout.trim().replace(/\0/g, '')
      if (!path) continue
    } catch {
      continue
    }
    let version: string | undefined
    try {
      const { stdout } = await exec('wsl.exe', ['-d', distro, '--', binary, ...versionArgs], {
        timeout: WSL_TIMEOUT_MS, windowsHide: true,
      })
      version = stdout.trim().replace(/\0/g, '').split('\n')[0]
    } catch { /* version optional */ }
    hits.push({ distro, path, version })
  }
  return hits
}
