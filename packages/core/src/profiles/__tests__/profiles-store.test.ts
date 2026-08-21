import { describe, it, expect, vi } from 'vitest'
import { createProfilesStore, type ProfilesStorageAdapter } from '../profiles-store.js'
import { DEFAULT_PROFILES } from '../types.js'

function memoryAdapter(initial: string | null = null) {
  let data: string | null = initial
  const adapter: ProfilesStorageAdapter = {
    read(): string | null { return data },
    write(s: string): void { data = s },
  }
  return {
    adapter,
    snapshot(): string | null { return data },
  }
}

describe('createProfilesStore', () => {
  it('seeds 4 defaults on first list() with empty storage and writes them back', () => {
    const mem = memoryAdapter(null)
    const store = createProfilesStore(mem.adapter)
    const list = store.list()
    expect(list).toHaveLength(4)
    // names match the DEFAULT_PROFILES
    expect(list.map(p => p.name).sort()).toEqual(
      DEFAULT_PROFILES.map(p => p.name).sort()
    )
    // ids look like uuids (non-empty strings)
    for (const p of list) {
      expect(p.id).toBeTruthy()
      expect(p.createdAt).toBeTruthy()
      expect(p.updatedAt).toBeTruthy()
    }
    // file persisted
    expect(mem.snapshot()).not.toBeNull()
    const parsed = JSON.parse(mem.snapshot() as string)
    expect(parsed.version).toBe(1)
    expect(parsed.profiles).toHaveLength(4)
  })

  it('does not re-seed on subsequent calls (ids stay the same)', () => {
    const mem = memoryAdapter(null)
    const store = createProfilesStore(mem.adapter)
    const first = store.list()
    const second = store.list()
    expect(second.map(p => p.id)).toEqual(first.map(p => p.id))
  })

  it('create() returns a profile with fresh id and timestamps and persists it', () => {
    const mem = memoryAdapter(null)
    const store = createProfilesStore(mem.adapter)
    store.list() // seed
    const before = store.list().length
    const created = store.create({
      name: 'X', systemPrompt: 'y', providerId: 'p', model: 'm', tags: [],
    })
    expect(created.id).toBeTruthy()
    expect(created.createdAt).toBeTruthy()
    expect(created.updatedAt).toBeTruthy()
    expect(created.name).toBe('X')
    const after = store.list()
    expect(after).toHaveLength(before + 1)
    expect(after.some(p => p.id === created.id)).toBe(true)
  })

  it('update() mutates fields and bumps updatedAt but not createdAt', async () => {
    const mem = memoryAdapter(null)
    const store = createProfilesStore(mem.adapter)
    const created = store.create({
      name: 'Old', systemPrompt: 's', providerId: 'p', model: 'm', tags: [],
    })
    // Wait a tick so updatedAt is observably different
    await new Promise(r => setTimeout(r, 10))
    const updated = store.update(created.id, { name: 'NEW' })
    expect(updated.name).toBe('NEW')
    expect(updated.createdAt).toBe(created.createdAt)
    expect(updated.updatedAt).not.toBe(created.updatedAt)
  })

  it('update() throws with id in message when profile missing', () => {
    const mem = memoryAdapter(null)
    const store = createProfilesStore(mem.adapter)
    expect(() => store.update('does-not-exist', { name: 'x' })).toThrow(/does-not-exist/)
  })

  it('delete() returns { deleted: true } and removes the profile', () => {
    const mem = memoryAdapter(null)
    const store = createProfilesStore(mem.adapter)
    const created = store.create({
      name: 'GoneSoon', systemPrompt: 's', providerId: 'p', model: 'm', tags: [],
    })
    const result = store.delete(created.id)
    expect(result.deleted).toBe(true)
    expect(store.get(created.id)).toBeNull()
  })

  it('delete() of missing id returns { deleted: false }', () => {
    const mem = memoryAdapter(null)
    const store = createProfilesStore(mem.adapter)
    store.list()
    expect(store.delete('nope')).toEqual({ deleted: false })
  })

  it('delete(active) returns activeFallback to first remaining and updates active', () => {
    const mem = memoryAdapter(null)
    const store = createProfilesStore(mem.adapter)
    const list = store.list()
    expect(list).toHaveLength(4)
    store.setActiveId(list[0].id)
    const result = store.delete(list[0].id)
    expect(result.deleted).toBe(true)
    expect(result.activeFallback).toBe(list[1].id)
    expect(store.getActiveId()).toBe(list[1].id)
  })

  it('delete of the last profile re-seeds defaults and activeFallback is first default', () => {
    const mem = memoryAdapter(null)
    const store = createProfilesStore(mem.adapter)
    // delete all 4 defaults until empty
    const initial = store.list()
    store.setActiveId(initial[0].id)
    // Delete the first 3 normally
    for (let i = 0; i < 3; i++) {
      store.delete(store.list()[0].id)
    }
    expect(store.list()).toHaveLength(1)
    const last = store.list()[0]
    const result = store.delete(last.id)
    expect(result.deleted).toBe(true)
    expect(result.activeFallback).toBeTruthy()
    const seeded = store.list()
    expect(seeded).toHaveLength(4)
    expect(result.activeFallback).toBe(seeded[0].id)
    expect(store.getActiveId()).toBe(seeded[0].id)
  })

  it('duplicate() creates a profile named "<original> (copy)" with fresh id, other fields equal', () => {
    const mem = memoryAdapter(null)
    const store = createProfilesStore(mem.adapter)
    const orig = store.create({
      name: 'Original', systemPrompt: 's', providerId: 'p', model: 'm', tags: ['t1'],
      emoji: '🔥', temperature: 0.5,
    })
    const dup = store.duplicate(orig.id)
    expect(dup.id).not.toBe(orig.id)
    expect(dup.name).toBe('Original (copy)')
    expect(dup.systemPrompt).toBe(orig.systemPrompt)
    expect(dup.providerId).toBe(orig.providerId)
    expect(dup.model).toBe(orig.model)
    expect(dup.tags).toEqual(orig.tags)
    expect(dup.emoji).toBe(orig.emoji)
    expect(dup.temperature).toBe(orig.temperature)
  })

  it('setActiveId() throws if id does not exist', () => {
    const mem = memoryAdapter(null)
    const store = createProfilesStore(mem.adapter)
    store.list()
    expect(() => store.setActiveId('nonsense')).toThrow()
  })

  it('throws "Profiles file is corrupted" on bad JSON', () => {
    const mem = memoryAdapter('{not valid json')
    const store = createProfilesStore(mem.adapter)
    expect(() => store.list()).toThrow(/Profiles file is corrupted/)
  })

  it('throws "Profiles file is corrupted" on wrong shape', () => {
    const mem = memoryAdapter(JSON.stringify({ version: 1, profiles: 'not-an-array' }))
    const store = createProfilesStore(mem.adapter)
    expect(() => store.list()).toThrow(/Profiles file is corrupted/)
  })

  it('throws on unsupported version', () => {
    const mem = memoryAdapter(JSON.stringify({ version: 99, activeId: null, profiles: [] }))
    const store = createProfilesStore(mem.adapter)
    expect(() => store.list()).toThrow(/Unsupported profiles file version: 99/)
  })

  it('getActiveId returns null when activeId points to a deleted profile', () => {
    const mem = memoryAdapter(null)
    const store = createProfilesStore(mem.adapter)
    const created = store.create({
      name: 'Z', systemPrompt: 's', providerId: 'p', model: 'm', tags: [],
    })
    store.setActiveId(created.id)
    expect(store.getActiveId()).toBe(created.id)
    // Tamper: write file with activeId pointing to a missing profile
    const file = JSON.parse(mem.snapshot() as string)
    file.activeId = 'missing-id'
    mem.adapter.write(JSON.stringify(file))
    expect(store.getActiveId()).toBeNull()
  })

  it('setActiveId(null) clears the active selection', () => {
    const mem = memoryAdapter(null)
    const store = createProfilesStore(mem.adapter)
    const list = store.list()
    store.setActiveId(list[0].id)
    expect(store.getActiveId()).toBe(list[0].id)
    store.setActiveId(null)
    expect(store.getActiveId()).toBeNull()
    // Persisted to file
    const file = JSON.parse(mem.snapshot() as string)
    expect(file.activeId).toBeNull()
  })

  it('getActiveId self-heals by persisting null when activeId is stale', () => {
    const mem = memoryAdapter(null)
    const store = createProfilesStore(mem.adapter)
    store.list() // seed
    // Tamper: write a stale activeId directly
    const file = JSON.parse(mem.snapshot() as string)
    file.activeId = 'definitely-not-real'
    mem.adapter.write(JSON.stringify(file))
    expect(store.getActiveId()).toBeNull()
    // File should now have activeId: null persisted
    const after = JSON.parse(mem.snapshot() as string)
    expect(after.activeId).toBeNull()
  })

  it('update with empty patch still bumps updatedAt but leaves other fields', () => {
    vi.useFakeTimers()
    try {
      const mem = memoryAdapter(null)
      const store = createProfilesStore(mem.adapter)
      const created = store.create({
        name: 'Unchanged', systemPrompt: 's', providerId: 'p', model: 'm', tags: ['a'],
      })
      vi.advanceTimersByTime(1)
      const updated = store.update(created.id, {})
      expect(updated.updatedAt).not.toBe(created.updatedAt)
      expect(updated.name).toBe(created.name)
      expect(updated.systemPrompt).toBe(created.systemPrompt)
      expect(updated.providerId).toBe(created.providerId)
      expect(updated.model).toBe(created.model)
      expect(updated.tags).toEqual(created.tags)
      expect(updated.createdAt).toBe(created.createdAt)
    } finally {
      vi.useRealTimers()
    }
  })

  it('duplicate naming chains: repeated copies append " (copy)" each time', () => {
    const mem = memoryAdapter(null)
    const store = createProfilesStore(mem.adapter)
    const orig = store.create({
      name: 'Base', systemPrompt: 's', providerId: 'p', model: 'm', tags: [],
    })
    const dup1 = store.duplicate(orig.id)
    const dup2 = store.duplicate(orig.id)
    expect(dup1.name).toBe('Base (copy)')
    expect(dup2.name).toBe('Base (copy)')
    const dup3 = store.duplicate(dup1.id)
    expect(dup3.name).toBe('Base (copy) (copy)')
  })
})
