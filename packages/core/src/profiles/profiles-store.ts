import { type Profile, parseProfile } from './schema.js'
import { DEFAULT_PROFILES } from './types.js'

/** JSON shape persisted by the store. version field enables future migrations. */
export interface ProfilesFileV1 {
  version: 1
  activeId: string | null
  profiles: Profile[]
}

/** Storage adapter — the Electron main will provide one backed by tachi-profiles.json. */
export interface ProfilesStorageAdapter {
  /** Returns raw JSON string or null if absent. */
  read(): string | null
  /** Overwrites the file atomically. */
  write(s: string): void
}

export interface ProfilesStore {
  list(): Profile[]
  get(id: string): Profile | null
  create(input: Omit<Profile, 'id' | 'createdAt' | 'updatedAt'>): Profile
  update(id: string, patch: Partial<Omit<Profile, 'id' | 'createdAt'>>): Profile
  delete(id: string): { deleted: boolean; activeFallback?: string }
  duplicate(id: string): Profile
  /** Returns the currently active profile id, or null when nothing chosen / id stale. */
  getActiveId(): string | null
  /** Marks a profile active, or clears the active selection when id is null. Throws if a non-null id doesn't exist. */
  setActiveId(id: string | null): void
}

function nowIso(): string {
  return new Date().toISOString()
}

function newId(): string {
  return globalThis.crypto.randomUUID()
}

/** Validates a parsed object as ProfilesFileV1 (after version check). */
function isValidFileShape(value: unknown): value is ProfilesFileV1 {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.version !== 1) return false
  if (!Array.isArray(v.profiles)) return false
  if (v.activeId !== null && typeof v.activeId !== 'string') return false
  return true
}

/** Seeds DEFAULT_PROFILES with fresh ids/timestamps. */
function seedDefaults(): ProfilesFileV1 {
  const ts = nowIso()
  const profiles: Profile[] = DEFAULT_PROFILES.map(d =>
    parseProfile({ ...d, id: newId(), createdAt: ts, updatedAt: ts }),
  )
  return { version: 1, activeId: profiles[0].id, profiles }
}

/** Single source of truth for serializing the persisted state. */
function serialize(state: ProfilesFileV1): string {
  return JSON.stringify(state, null, 2)
}

/**
 * Builds a profiles store on top of any storage adapter.
 * On first read of an empty file, seeds the 4 DEFAULT_PROFILES with fresh UUIDs.
 */
export function createProfilesStore(adapter: ProfilesStorageAdapter): ProfilesStore {
  /** Loads the file, seeding+persisting defaults if absent. Throws on corruption. */
  function load(): ProfilesFileV1 {
    const raw = adapter.read()
    if (raw === null || raw === '') {
      const seeded = seedDefaults()
      adapter.write(serialize(seeded))
      return seeded
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('Profiles file is corrupted')
    }
    // Version check BEFORE shape check, so a wrong-version file gets the proper message.
    if (parsed && typeof parsed === 'object' && 'version' in parsed) {
      const v = (parsed as { version: unknown }).version
      if (v !== 1) {
        throw new Error(`Unsupported profiles file version: ${String(v)}`)
      }
    } else {
      throw new Error('Profiles file is corrupted')
    }
    if (!isValidFileShape(parsed)) {
      throw new Error('Profiles file is corrupted')
    }
    // Validate every profile individually so a single corrupt entry triggers the loud error.
    for (const p of parsed.profiles) {
      try {
        parseProfile(p)
      } catch (err) {
        throw new Error(`Profiles file is corrupted: ${err instanceof Error ? err.message : 'unknown'}`)
      }
    }
    return parsed
  }

  function persist(state: ProfilesFileV1): void {
    adapter.write(serialize(state))
  }

  return {
    list(): Profile[] {
      return load().profiles
    },

    get(id: string): Profile | null {
      const state = load()
      return state.profiles.find(p => p.id === id) ?? null
    },

    create(input): Profile {
      const state = load()
      const ts = nowIso()
      const profile = parseProfile({ ...input, id: newId(), createdAt: ts, updatedAt: ts })
      state.profiles.push(profile)
      persist(state)
      return profile
    },

    update(id, patch): Profile {
      const state = load()
      const idx = state.profiles.findIndex(p => p.id === id)
      if (idx === -1) throw new Error(`Profile not found: ${id}`)
      const existing = state.profiles[idx]
      const merged = parseProfile({
        ...existing,
        ...patch,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: nowIso(),
      })
      state.profiles[idx] = merged
      persist(state)
      return merged
    },

    delete(id): { deleted: boolean; activeFallback?: string } {
      const state = load()
      const idx = state.profiles.findIndex(p => p.id === id)
      if (idx === -1) return { deleted: false }
      const wasActive = state.activeId === id
      state.profiles.splice(idx, 1)

      // Empty after delete → re-seed defaults (never empty list).
      if (state.profiles.length === 0) {
        const seeded = seedDefaults()
        state.profiles = seeded.profiles
        const newActive = seeded.profiles[0].id
        state.activeId = newActive
        persist(state)
        return { deleted: true, activeFallback: newActive }
      }

      if (wasActive) {
        const newActive = state.profiles[0].id
        state.activeId = newActive
        persist(state)
        return { deleted: true, activeFallback: newActive }
      }

      persist(state)
      return { deleted: true }
    },

    duplicate(id): Profile {
      const state = load()
      const orig = state.profiles.find(p => p.id === id)
      if (!orig) throw new Error(`Profile not found: ${id}`)
      const ts = nowIso()
      const dup = parseProfile({
        ...orig,
        id: newId(),
        name: `${orig.name} (copy)`,
        createdAt: ts,
        updatedAt: ts,
      })
      state.profiles.push(dup)
      persist(state)
      return dup
    },

    getActiveId(): string | null {
      const state = load()
      if (state.activeId === null) return null
      if (!state.profiles.some(p => p.id === state.activeId)) {
        // Self-heal: persist null so the file doesn't keep a dangling reference.
        state.activeId = null
        persist(state)
        return null
      }
      return state.activeId
    },

    setActiveId(id: string | null): void {
      const state = load()
      if (id === null) {
        state.activeId = null
        persist(state)
        return
      }
      if (!state.profiles.some(p => p.id === id)) {
        throw new Error(`Profile not found: ${id}`)
      }
      state.activeId = id
      persist(state)
    },
  }
}
