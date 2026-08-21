import { RuntimeDetector, RuntimeCardUpdate } from '../types.js'
import { BinaryExecutor } from './codex.js'

// Binary name: `aeon` — per aaronjmars/aeon README (`cargo install aeon` / releases ship as `aeon`).
export function createAeonDetector(executor: BinaryExecutor): RuntimeDetector {
  return {
    runtimeId: 'aeon',
    kind: 'coding_agent',
    displayName: 'Aeon',
    async detect(): Promise<RuntimeCardUpdate> {
      const base = {
        runtimeId: 'aeon',
        kind: 'coding_agent' as const,
        displayName: 'Aeon',
        endpoint: 'https://github.com/aaronjmars/aeon',
      }
      const result = await executor.probe('aeon', ['--version'], 5000)
      if (!result.found) return { ...base, status: 'not_installed', checkedAt: new Date().toISOString() }
      return { ...base, status: 'installed', version: result.version, checkedAt: new Date().toISOString() }
    },
  }
}
