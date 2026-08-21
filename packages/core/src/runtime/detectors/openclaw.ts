import { RuntimeDetector, RuntimeCardUpdate } from '../types.js'
import { BinaryExecutor } from './codex.js'
import { probeWslBinary } from '../probes/wsl-probe.js'

/**
 * Probe the OpenClaw gateway HTTP dashboard.
 * `openclaw gateway status` shows it listens on http://127.0.0.1:18789/ by
 * default. A simple GET / returns 200 when the gateway is up; this works
 * whether openclaw is installed natively or inside WSL, since WSL forwards
 * localhost ports back to the host on Windows 11.
 */
async function probeOpenClawGateway(): Promise<{ ok: boolean; version?: string }> {
  const ports = [18789, 18790]  // default + likely fallback
  for (const port of ports) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(1500) as AbortSignal,
      })
      if (res.ok || res.status < 500) {
        // Try to grab a version header if exposed
        const ver = res.headers.get('x-openclaw-version') ?? undefined
        return { ok: true, version: ver }
      }
    } catch { /* keep trying */ }
  }
  return { ok: false }
}

export function createOpenClawDetector(executor: BinaryExecutor): RuntimeDetector {
  return {
    runtimeId: 'openclaw', kind: 'coding_agent', displayName: 'OpenClaw',
    async detect(): Promise<RuntimeCardUpdate> {
      const base = { runtimeId: 'openclaw', kind: 'coding_agent' as const, displayName: 'OpenClaw' }

      // PRIORITY 1: gateway alive on 127.0.0.1:18789 — that's the strongest
      // possible signal that openclaw is usable right now (works whether
      // it's installed natively or inside WSL with port forwarding).
      const gateway = await probeOpenClawGateway()
      if (gateway.ok) {
        return {
          ...base,
          displayName: 'OpenClaw (gateway)',
          status: 'connected',
          version: gateway.version ?? '127.0.0.1:18789',
          endpoint: 'http://127.0.0.1:18789/',
          checkedAt: new Date().toISOString(),
        }
      }

      // PRIORITY 2: native PATH binary
      const result = await executor.probe('openclaw', ['--version'], 5000)
      if (result.found) {
        return { ...base, status: 'installed', version: result.version, checkedAt: new Date().toISOString() }
      }

      // PRIORITY 3: WSL distro contains binary
      let wslHits: import('../probes/wsl-probe.js').WslBinaryHit[] = []
      try {
        wslHits = await probeWslBinary('openclaw')
      } catch { /* WSL not available */ }

      if (wslHits.length > 0) {
        const hit = wslHits[0]
        const distroLabel = `WSL/${hit.distro}`
        return {
          ...base,
          displayName: `OpenClaw (${distroLabel})`,
          status: 'installed',
          version: hit.version ?? distroLabel,
          endpoint: hit.path,
          checkedAt: new Date().toISOString(),
        }
      }

      return { ...base, status: 'not_installed', checkedAt: new Date().toISOString() }
    },
  }
}
