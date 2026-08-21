import { RuntimeDetector, RuntimeCardUpdate } from '../types.js'
import { httpProbe } from '../probes/http-probe.js'

export function createLMStudioDetector(fetchFn: typeof fetch = fetch): RuntimeDetector {
  return {
    runtimeId: 'lmstudio', kind: 'local_model_server', displayName: 'LM Studio',
    async detect(): Promise<RuntimeCardUpdate> {
      const probe = await httpProbe('http://localhost:1234/v1/models', fetchFn)
      return {
        runtimeId: 'lmstudio', kind: 'local_model_server', displayName: 'LM Studio',
        endpoint: 'http://localhost:1234',
        status: probe.status === 'healthy' ? 'healthy' : probe.status === 'not_running' ? 'not_running' : probe.status,
        checkedAt: new Date().toISOString(),
      }
    },
  }
}
