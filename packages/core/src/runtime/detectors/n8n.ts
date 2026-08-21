import { RuntimeDetector, RuntimeCardUpdate } from '../types.js'
import { BinaryExecutor } from './codex.js'
import { httpProbe } from '../probes/http-probe.js'

// n8n can be installed as an npm global (`npm install -g n8n`, binary name `n8n`)
// OR run as a standalone webapp on default port 5678 with healthcheck at /healthz.
// We check the HTTP endpoint first (running = useful) then fall back to binary probe.
export function createN8nDetector(executor: BinaryExecutor, fetchFn: typeof fetch = fetch): RuntimeDetector {
  return {
    runtimeId: 'n8n',
    kind: 'custom_api',
    displayName: 'n8n',
    async detect(): Promise<RuntimeCardUpdate> {
      const base = {
        runtimeId: 'n8n',
        kind: 'custom_api' as const,
        displayName: 'n8n',
        endpoint: 'http://localhost:5678',
      }

      // HTTP probe first — if it's running that's the most useful signal
      const httpResult = await httpProbe('http://localhost:5678/healthz', fetchFn)
      if (httpResult.status === 'healthy') {
        return { ...base, status: 'healthy', checkedAt: new Date().toISOString() }
      }

      // Binary probe — tells us whether n8n is installed even if not running
      const binResult = await executor.probe('n8n', ['--version'], 5000)
      if (binResult.found) {
        return { ...base, status: 'installed', version: binResult.version, checkedAt: new Date().toISOString() }
      }

      // Neither running nor installed
      return { ...base, status: 'not_installed', checkedAt: new Date().toISOString() }
    },
  }
}
