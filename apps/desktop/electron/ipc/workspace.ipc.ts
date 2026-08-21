import { ipcMain } from 'electron'
import { z } from 'zod'
import { openWorkspace, currentWorkspace, clearWorkspace } from '../services/workspace-store'
import { initAgentsMd } from '../services/agents-md-init'

export function registerWorkspaceIpc(): void {
  ipcMain.handle('workspace:open', (_e, p: unknown) => {
    const { path } = z.object({ path: z.string().min(1) }).parse(p)
    return openWorkspace(path)
  })

  ipcMain.handle('workspace:current', () => currentWorkspace())

  ipcMain.handle('workspace:clear', () => clearWorkspace())

  // Scaffold a starter AGENTS.md (stack-detected template) in the given path, or
  // the current workspace if none is passed. Never overwrites an existing file.
  ipcMain.handle('workspace:init-agents-md', (_e, p: unknown) => {
    const parsed = z.object({ path: z.string().optional() }).safeParse(p ?? {})
    const explicit = parsed.success ? parsed.data.path : undefined
    const root = explicit ?? currentWorkspace()?.rootPath ?? null
    return initAgentsMd(root)
  })
}
