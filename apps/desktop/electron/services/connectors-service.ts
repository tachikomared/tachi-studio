// apps/desktop/electron/services/connectors-service.ts
//
// Registry of external service connectors.  Each connector exposes its auth
// status so the Settings → Connectors page can render it without knowing the
// connector's internals.
//
// Adding a new connector:
//   1. Implement a `getStatus()` + optional `disconnect()` in a separate module.
//   2. Register it in CONNECTOR_REGISTRY below with a stable id.
//   3. The IPC layer (connectors.ipc.ts) picks it up automatically.

import { retrieveKey, deleteKey } from './keychain'

export interface ConnectorStatus {
  id: string
  name: string
  description: string
  authStatus: 'connected' | 'disconnected' | 'error'
  connectedAs?: string
}

// ── GitHub connector ──────────────────────────────────────────────────────────

async function getGitHubStatus(): Promise<ConnectorStatus> {
  const base: Pick<ConnectorStatus, 'id' | 'name' | 'description'> = {
    id:          'github',
    name:        'GitHub',
    description: 'Browse repos, issues, and files. Required for the Aeon tab and /gh chat tools.',
  }

  const token = retrieveKey('github')
  if (!token) {
    return { ...base, authStatus: 'disconnected' }
  }

  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization:          `Bearer ${token}`,
        Accept:                 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    if (!res.ok) {
      return { ...base, authStatus: 'error', connectedAs: undefined }
    }
    const data = await res.json() as { login: string }
    return { ...base, authStatus: 'connected', connectedAs: `@${data.login}` }
  } catch {
    return { ...base, authStatus: 'error' }
  }
}

// ── Registry ──────────────────────────────────────────────────────────────────

interface ConnectorEntry {
  getStatus: () => Promise<ConnectorStatus>
  disconnect?: () => void
}

const CONNECTOR_REGISTRY: ConnectorEntry[] = [
  {
    getStatus: getGitHubStatus,
    disconnect: () => deleteKey('github'),
  },
]

export async function listConnectors(): Promise<ConnectorStatus[]> {
  return Promise.all(CONNECTOR_REGISTRY.map(c => c.getStatus()))
}

export async function getConnectorStatus(id: string): Promise<ConnectorStatus | null> {
  const entry = CONNECTOR_REGISTRY.find(c => {
    // We need the id — resolve status just to check, but we want a cheaper check.
    // Instead, rely on the entry index matching the known ids.
    // A cleaner approach: store id on the entry too.
    return true  // placeholder — real filtering below
  })
  // Simpler: just call listConnectors and filter
  const all = await listConnectors()
  return all.find(c => c.id === id) ?? null
}

export function disconnectConnector(id: string): boolean {
  const entry = CONNECTOR_REGISTRY.find(async c => {
    const s = await c.getStatus()
    return s.id === id
  })
  // Map by id directly — maintain a parallel id→entry map for O(1) lookup
  const idMap: Record<string, ConnectorEntry | undefined> = {
    github: CONNECTOR_REGISTRY[0],
  }
  const found = idMap[id]
  if (!found?.disconnect) return false
  found.disconnect()
  return true
}
