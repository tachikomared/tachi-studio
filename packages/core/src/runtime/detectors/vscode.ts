import { RuntimeDetector, RuntimeCardUpdate } from '../types.js'
import { BinaryExecutor } from './codex.js'

// VS Code CLI shim: installed when "Add to PATH" is checked during VS Code setup.
// Binary name: `code` on Linux/macOS, `code.cmd` on Windows — but `where.exe code` finds `code.cmd` fine.
// We probe `code` (the executor's where.exe/which handles the .cmd extension on Windows).
export function createVSCodeDetector(executor: BinaryExecutor): RuntimeDetector {
  return {
    runtimeId: 'vscode',
    kind: 'coding_agent',
    displayName: 'VS Code',
    async detect(): Promise<RuntimeCardUpdate> {
      const base = {
        runtimeId: 'vscode',
        kind: 'coding_agent' as const,
        displayName: 'VS Code',
        endpoint: 'https://github.com/microsoft/vscode',
      }
      const result = await executor.probe('code', ['--version'], 5000)
      if (!result.found) return { ...base, status: 'not_installed', checkedAt: new Date().toISOString() }
      return { ...base, status: 'installed', version: result.version, checkedAt: new Date().toISOString() }
    },
  }
}
