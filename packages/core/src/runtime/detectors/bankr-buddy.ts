import { RuntimeDetector, RuntimeCardUpdate } from '../types.js'
import { httpProbe } from '../probes/http-probe.js'

export function createBankrBuddyDetector(port = 23444, fetchFn: typeof fetch = fetch): RuntimeDetector {
  return {
    runtimeId: 'bankr-buddy', kind: 'companion', displayName: 'Bankr Buddy',
    async detect(): Promise<RuntimeCardUpdate> {
      const probe = await httpProbe(`http://localhost:${port}`, fetchFn)
      return {
        runtimeId: 'bankr-buddy', kind: 'companion', displayName: 'Bankr Buddy',
        endpoint: `http://localhost:${port}`,
        status: probe.status === 'healthy' ? 'running' : probe.status,
        checkedAt: new Date().toISOString(),
      }
    },
  }
}
