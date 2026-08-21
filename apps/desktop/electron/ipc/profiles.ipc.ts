import { ipcMain } from 'electron'
import { z } from 'zod'
import { getProfilesStore } from '../services/profiles-store'

/**
 * ProfileInput — what callers send for create/update. No id, no timestamps;
 * the store assigns those. Mirrors ProfileSchema in @tachi/core (the store
 * itself re-validates via parseProfile so this layer just guards the IPC).
 */
const ProfileInputSchema = z.object({
  name:         z.string().min(1).max(80),
  emoji:        z.string().max(8).optional(),
  systemPrompt: z.string().max(20_000),
  providerId:   z.string().min(1),
  model:        z.string().min(1),
  temperature:  z.number().min(0).max(2).optional(),
  maxTokens:    z.number().int().positive().optional(),
  tags:         z.array(z.string().min(1)).max(32),
  permissions:  z.object({
    mode:          z.enum(['full', 'read-only']),
    toolAllowList: z.array(z.string()).optional(),
    toolDenyList:  z.array(z.string()).optional(),
  }).optional(),
})

const IdPayload = z.object({ id: z.string().min(1) })

export function registerProfilesIpc(): void {
  ipcMain.handle('profiles:list', () => getProfilesStore().list())

  ipcMain.handle('profiles:get', (_e, p: unknown) => {
    const { id } = IdPayload.parse(p)
    return getProfilesStore().get(id)
  })

  ipcMain.handle('profiles:create', (_e, p: unknown) => {
    const input = ProfileInputSchema.parse(p)
    return getProfilesStore().create(input)
  })

  ipcMain.handle('profiles:update', (_e, p: unknown) => {
    const v = z.object({
      id:    z.string().min(1),
      patch: ProfileInputSchema.partial(),
    }).parse(p)
    return getProfilesStore().update(v.id, v.patch)
  })

  ipcMain.handle('profiles:delete', (_e, p: unknown) => {
    const { id } = IdPayload.parse(p)
    return getProfilesStore().delete(id)
  })

  ipcMain.handle('profiles:duplicate', (_e, p: unknown) => {
    const { id } = IdPayload.parse(p)
    return getProfilesStore().duplicate(id)
  })

  ipcMain.handle('profiles:get-active', () => getProfilesStore().getActiveId())

  ipcMain.handle('profiles:set-active', (_e, p: unknown) => {
    const v = z.object({ id: z.string().min(1).nullable() }).parse(p)
    getProfilesStore().setActiveId(v.id)
  })
}
