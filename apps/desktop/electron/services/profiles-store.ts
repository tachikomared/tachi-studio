import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createProfilesStore, type ProfilesStore } from '@tachi/core'

let cached: ProfilesStore | null = null

/**
 * Lazy singleton wrapping the pure core profiles store with a file adapter
 * backed by `<userData>/tachi-profiles.json`. First read seeds DEFAULT_PROFILES.
 */
export function getProfilesStore(): ProfilesStore {
  if (cached) return cached
  const file = join(app.getPath('userData'), 'tachi-profiles.json')
  cached = createProfilesStore({
    read(): string | null {
      if (!existsSync(file)) return null
      return readFileSync(file, 'utf8')
    },
    write(s: string): void {
      mkdirSync(app.getPath('userData'), { recursive: true })
      writeFileSync(file, s, 'utf8')
    },
  })
  return cached
}
