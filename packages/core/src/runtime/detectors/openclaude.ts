import { RuntimeDetector, RuntimeCardUpdate } from '../types.js'
import { BinaryExecutor } from './codex.js'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export interface OpenClaudeDetectorOptions {
  /** Electron userData path — if provided, checks the bundled sidecar install. */
  userDataPath?: string
}

/**
 * Try to read version from the bundled sidecar package.json.
 * Path: <userData>/sidecars/openclaude/node_modules/@gitlawb/openclaude/package.json
 */
function checkBundledInstall(userDataPath: string): { found: true; version?: string } | { found: false } {
  try {
    const pkgPath = join(
      userDataPath,
      'sidecars', 'openclaude', 'node_modules', '@gitlawb', 'openclaude', 'package.json',
    )
    if (!existsSync(pkgPath)) return { found: false }
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
    return { found: true, version: pkg.version }
  } catch {
    return { found: false }
  }
}

export function createOpenClaudeDetector(
  executor: BinaryExecutor,
  options: OpenClaudeDetectorOptions = {},
): RuntimeDetector {
  return {
    runtimeId: 'openclaude', kind: 'coding_agent', displayName: 'OpenClaude',
    async detect(): Promise<RuntimeCardUpdate> {
      const base = { runtimeId: 'openclaude', kind: 'coding_agent' as const, displayName: 'OpenClaude' }

      // 1. Check native PATH first (globally installed openclaude binary)
      const result = await executor.probe('openclaude', ['--version'], 5000)
      if (result.found) {
        return { ...base, status: 'installed', version: result.version, checkedAt: new Date().toISOString() }
      }

      // 2. Check the bundled sidecar install at <userData>/sidecars/openclaude/
      if (options.userDataPath) {
        const bundled = checkBundledInstall(options.userDataPath)
        if (bundled.found) {
          return {
            ...base,
            status: 'installed',
            version: bundled.version,
            endpoint: 'https://github.com/Gitlawb/openclaude',
            checkedAt: new Date().toISOString(),
          }
        }
      }

      return { ...base, status: 'not_installed', checkedAt: new Date().toISOString() }
    },
  }
}
