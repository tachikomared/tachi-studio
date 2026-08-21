import { app } from 'electron'
import { join, isAbsolute, sep } from 'path'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { type Workspace, parseAgentsMd, AGENTS_MD_MAX_BYTES } from '@tachi/core'

/** Path is computed lazily so tests that don't initialise electron's app don't crash on import. */
const WS_FILE = (): string => join(app.getPath('userData'), 'workspaces.json')

interface PersistedShape {
  version: 1
  rootPath: string | null
}

function readPersisted(): PersistedShape {
  const path = WS_FILE()
  if (!existsSync(path)) return { version: 1, rootPath: null }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PersistedShape>
    if (parsed.version !== 1) return { version: 1, rootPath: null }
    return { version: 1, rootPath: typeof parsed.rootPath === 'string' ? parsed.rootPath : null }
  } catch {
    return { version: 1, rootPath: null }
  }
}

function writePersisted(data: PersistedShape): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(WS_FILE(), JSON.stringify(data, null, 2), 'utf8')
}

/** Builds a Workspace by re-reading AGENTS.md from disk so edits are picked up. */
function buildWorkspace(rootPath: string): Workspace {
  const agentsPath = join(rootPath, 'AGENTS.md')
  if (!existsSync(agentsPath)) return { rootPath }
  const st = statSync(agentsPath)
  if (!st.isFile() || st.size > AGENTS_MD_MAX_BYTES) return { rootPath }
  const raw = readFileSync(agentsPath, 'utf8')
  const parsed = parseAgentsMd(agentsPath, raw)
  return { rootPath, agentsMd: parsed }
}

/**
 * Opens a workspace at an absolute directory path. Persists the choice and
 * returns a freshly-parsed Workspace. Throws on relative paths, traversal
 * fragments, non-existent paths, or non-directories.
 */
export function openWorkspace(rootPath: string): Workspace {
  if (!isAbsolute(rootPath)) throw new Error('Workspace path must be absolute')
  if (rootPath.includes('..' + sep) || rootPath.endsWith(sep + '..')) {
    throw new Error('Workspace path traversal rejected')
  }
  if (!existsSync(rootPath)) throw new Error('Workspace path does not exist')
  if (!statSync(rootPath).isDirectory()) throw new Error('Workspace path is not a directory')
  // Short-circuit: only write if the persisted path actually changes. Validation
  // above still runs every call so we don't trust a stale cache.
  const persisted = readPersisted()
  if (persisted.rootPath !== rootPath) {
    writePersisted({ version: 1, rootPath })
  }
  return buildWorkspace(rootPath)
}

/**
 * Returns the currently open Workspace (re-reading AGENTS.md from disk) or null.
 * Self-heals by clearing the persisted path if it's gone stale (deleted/moved).
 */
export function currentWorkspace(): Workspace | null {
  const { rootPath } = readPersisted()
  if (!rootPath) return null
  if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
    writePersisted({ version: 1, rootPath: null })
    return null
  }
  return buildWorkspace(rootPath)
}

export function clearWorkspace(): void {
  writePersisted({ version: 1, rootPath: null })
}
