import { RuntimeDetector, RuntimeCardUpdate } from '../types.js'
import { httpProbe } from '../probes/http-probe.js'

export function createJanDetector(fetchFn: typeof fetch = fetch): RuntimeDetector {
  return {
    runtimeId: 'jan', kind: 'local_model_server', displayName: 'Jan',
    async detect(): Promise<RuntimeCardUpdate> {
      const probe = await httpProbe('http://localhost:1337/v1/models', fetchFn)
      return {
        runtimeId: 'jan', kind: 'local_model_server', displayName: 'Jan',
        endpoint: 'http://localhost:1337',
        status: probe.status === 'healthy' ? 'healthy' : probe.status,
        checkedAt: new Date().toISOString(),
      }
    },
  }
}
