import { RuntimeDetector, RuntimeCardUpdate } from '../types.js'
import { existsSync } from 'fs'
import { join } from 'path'
import { probeWslBinary } from '../probes/wsl-probe.js'

export interface BinaryExecutor {
  probe(binary: string, args: string[], timeoutMs?: number): Promise<{ found: boolean; version?: string }>
  /** Run `npm root -g` and return the trimmed stdout, or undefined on failure. */
  npmGlobalRoot?(): Promise<string | undefined>
}

/**
 * Candidate locations for a globally-installed codex binary on Windows.
 * `%APPDATA%/npm/codex.cmd` (npm install -g on Windows) or
 * `%APPDATA%/npm/codex.ps1`
 */
function windowsNpmGlobalCandidates(npmRoot: string): string[] {
  // npmRoot is typically C:\Users\<user>\AppData\Roaming\npm\node_modules
  // The bin shims live one level up
  const binDir = join(npmRoot, '..')
  return [
    join(binDir, 'codex.cmd'),
    join(binDir, 'codex.ps1'),
    join(binDir, 'codex'),
  ]
}

/**
 * Candidate locations on macOS/Linux npm global bin.
 * We try common global prefix locations in addition to the resolved npm root.
 */
function unixNpmGlobalCandidates(npmRoot: string): string[] {
  const binDir = join(npmRoot, '..', '..', 'bin')
  return [
    join(binDir, 'codex'),
    '/usr/local/bin/codex',
    '/usr/bin/codex',
    join(process.env['HOME'] ?? '~', '.npm-global', 'bin', 'codex'),
  ]
}

export function createCodexDetector(executor: BinaryExecutor): RuntimeDetector {
  return {
    runtimeId: 'codex', kind: 'coding_agent', displayName: 'Codex CLI',
    async detect(): Promise<RuntimeCardUpdate> {
      const base = { runtimeId: 'codex', kind: 'coding_agent' as const, displayName: 'Codex CLI' }

      // 1. Probe native PATH (works if codex is in PATH)
      const result = await executor.probe('codex', ['--version'], 5000)
      if (result.found) {
        return { ...base, status: 'installed', version: result.version, checkedAt: new Date().toISOString() }
      }

      // 2. Check npm global install location
      try {
        const npmRoot = executor.npmGlobalRoot
          ? await executor.npmGlobalRoot()
          : undefined
        if (npmRoot) {
          const candidates = process.platform === 'win32'
            ? windowsNpmGlobalCandidates(npmRoot)
            : unixNpmGlobalCandidates(npmRoot)
          for (const candidate of candidates) {
            if (existsSync(candidate)) {
              return {
                ...base,
                status: 'installed',
                endpoint: 'npm global',
                checkedAt: new Date().toISOString(),
              }
            }
          }
        }
      } catch { /* ignore npm errors */ }

      // 3. WSL fallback (Windows only — no-ops on other platforms)
      const wslHits = await probeWslBinary('codex')
      if (wslHits.length > 0) {
        const hit = wslHits[0]
        return {
          ...base,
          status: 'installed',
          version: hit.version,
          endpoint: `WSL/${hit.distro}`,
          checkedAt: new Date().toISOString(),
        }
      }

      return { ...base, status: 'not_installed', checkedAt: new Date().toISOString() }
    },
  }
}
