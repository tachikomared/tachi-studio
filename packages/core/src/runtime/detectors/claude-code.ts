import { RuntimeDetector, RuntimeCardUpdate } from '../types.js'
import { BinaryExecutor } from './codex.js'

export function createClaudeCodeDetector(executor: BinaryExecutor): RuntimeDetector {
  return {
    runtimeId: 'claude-code', kind: 'coding_agent', displayName: 'Claude Code',
    async detect(): Promise<RuntimeCardUpdate> {
      const base = { runtimeId: 'claude-code', kind: 'coding_agent' as const, displayName: 'Claude Code' }
      const result = await executor.probe('claude', ['--version'], 5000)
      if (!result.found) return { ...base, status: 'not_installed', checkedAt: new Date().toISOString() }
      return { ...base, status: 'installed', version: result.version, checkedAt: new Date().toISOString() }
    },
  }
}
