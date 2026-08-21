import { RuntimeDetector, RuntimeCardUpdate } from '../types.js'
import { httpProbe } from '../probes/http-probe.js'

export function createOllamaDetector(fetchFn: typeof fetch = fetch): RuntimeDetector {
  return {
    runtimeId: 'ollama',
    kind: 'local_model_server',
    displayName: 'Ollama',
    async detect(): Promise<RuntimeCardUpdate> {
      const base = {
        runtimeId: 'ollama',
        kind: 'local_model_server' as const,
        displayName: 'Ollama',
        endpoint: 'http://localhost:11434',
      }
      const probe = await httpProbe('http://localhost:11434/api/tags', fetchFn)
      if (probe.status === 'healthy') return { ...base, status: 'healthy', checkedAt: new Date().toISOString() }
      if (probe.status === 'not_running') return { ...base, status: 'not_running', checkedAt: new Date().toISOString() }
      return { ...base, status: probe.status, checkedAt: new Date().toISOString() }
    },
  }
}
