import { RuntimeDetector, RuntimeCardUpdate } from '../types.js'
import { httpProbe } from '../probes/http-probe.js'

// ComfyUI is a Python webapp with no CLI binary. Default port: 8188.
// Probe /system_stats — returns JSON with system info when the server is up.
export function createComfyUIDetector(fetchFn: typeof fetch = fetch): RuntimeDetector {
  return {
    runtimeId: 'comfyui',
    kind: 'local_model_server',
    displayName: 'ComfyUI',
    async detect(): Promise<RuntimeCardUpdate> {
      const base = {
        runtimeId: 'comfyui',
        kind: 'local_model_server' as const,
        displayName: 'ComfyUI',
        endpoint: 'http://localhost:8188',
      }
      const probe = await httpProbe('http://localhost:8188/system_stats', fetchFn)
      if (probe.status === 'healthy') return { ...base, status: 'healthy', checkedAt: new Date().toISOString() }
      if (probe.status === 'not_running') return { ...base, status: 'not_running', checkedAt: new Date().toISOString() }
      return { ...base, status: probe.status, checkedAt: new Date().toISOString() }
    },
  }
}
