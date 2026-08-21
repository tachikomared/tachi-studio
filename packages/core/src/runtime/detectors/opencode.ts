import { RuntimeDetector, RuntimeCardUpdate } from '../types.js'
import { BinaryExecutor } from './codex.js'

export function createOpenCodeDetector(executor: BinaryExecutor): RuntimeDetector {
  return {
    runtimeId: 'opencode',
    kind: 'coding_agent',
    displayName: 'OpenCode',
    async detect(): Promise<RuntimeCardUpdate> {
      const base = {
        runtimeId: 'opencode',
        kind: 'coding_agent' as const,
        displayName: 'OpenCode',
        endpoint: 'https://github.com/anomalyco/opencode',
      }
      const result = await executor.probe('opencode', ['--version'], 5000)
      if (!result.found) return { ...base, status: 'not_installed', checkedAt: new Date().toISOString() }
      return { ...base, status: 'installed', version: result.version, checkedAt: new Date().toISOString() }
    },
  }
}
