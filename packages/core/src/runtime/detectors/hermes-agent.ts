import { RuntimeDetector, RuntimeCardUpdate } from '../types.js'
import { BinaryExecutor } from './codex.js'

// Binary name: `hermes` — per NousResearch/hermes-agent README install instructions
// (`npm install -g hermes-agent` installs the `hermes` binary on PATH).
export function createHermesAgentDetector(executor: BinaryExecutor): RuntimeDetector {
  return {
    runtimeId: 'hermes-agent',
    kind: 'coding_agent',
    displayName: 'Hermes Agent',
    async detect(): Promise<RuntimeCardUpdate> {
      const base = {
        runtimeId: 'hermes-agent',
        kind: 'coding_agent' as const,
        displayName: 'Hermes Agent',
        endpoint: 'https://github.com/NousResearch/hermes-agent',
      }
      const result = await executor.probe('hermes', ['--version'], 5000)
      if (!result.found) return { ...base, status: 'not_installed', checkedAt: new Date().toISOString() }
      return { ...base, status: 'installed', version: result.version, checkedAt: new Date().toISOString() }
    },
  }
}
