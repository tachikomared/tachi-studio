// apps/desktop/test/unit/artifactsStore.test.ts
//
// Store-level coverage for the chat artifacts store
// (src/store/artifacts.store.ts) — the versioning behavior wired through the
// real zustand actions, plus persist rehydration of a PRE-versioning record
// (no versions/updatedAt fields) to prove the additive schema needs no
// storage-name bump.
//
// Recipe follows chatStore.test.ts: install a localStorage shim + a window.tachi
// stub whose safeStorage reports "unavailable" BEFORE importing the store, so
// encryptedStorage falls back to plain localStorage and persist writes resolve
// quietly in the node env.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const memStore = new Map<string, string>()
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
  setItem: (k: string, v: string) => void memStore.set(k, v),
  removeItem: (k: string) => void memStore.delete(k),
  clear: () => memStore.clear(),
}
;(globalThis as Record<string, unknown>).window = {
  tachi: { safeStorage: { isAvailable: async () => ({ available: false }) } },
}

const { useArtifactsStore } = await import('../../src/store/artifacts.store')

const CONV = 'conv-1'

function candidate(over: Partial<{ messageId: string; title: string; kind: 'code' | 'html' | 'svg' | 'mermaid'; language?: string; content: string }> = {}) {
  return {
    messageId: 'm1',
    title: 'demo page',
    kind: 'html' as const,
    language: 'html',
    content: '<p>v1</p>',
    ...over,
  }
}

function list() {
  return useArtifactsStore.getState().getForConversation(CONV)
}

beforeEach(() => {
  memStore.clear()
  useArtifactsStore.setState({ artifacts: {}, activeArtifactId: null })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('addArtifact version-merge semantics', () => {
  it('appends a brand-new artifact and activates it', () => {
    const id = useArtifactsStore.getState().addArtifact(CONV, candidate())
    expect(list()).toHaveLength(1)
    expect(list()[0].id).toBe(id)
    expect(list()[0].versions).toBeUndefined()
    expect(useArtifactsStore.getState().activeArtifactId).toBe(id)
  })

  it('same title+kind with DIFFERENT content reuses the tab and stashes a version', () => {
    const st = useArtifactsStore.getState()
    const id1 = st.addArtifact(CONV, candidate())
    const id2 = st.addArtifact(CONV, candidate({ messageId: 'm2', content: '<p>v2</p>' }))

    expect(id2).toBe(id1) // no duplicate tab
    expect(list()).toHaveLength(1)
    const a = list()[0]
    expect(a.content).toBe('<p>v2</p>')
    expect(a.messageId).toBe('m2')
    expect(a.versions?.map(v => v.content)).toEqual(['<p>v1</p>'])
    expect(a.updatedAt).toBeTruthy()
    expect(useArtifactsStore.getState().activeArtifactId).toBe(id1)
  })

  it('same title+kind with IDENTICAL content is a no-op (keeps the dedupe)', () => {
    const st = useArtifactsStore.getState()
    const id1 = st.addArtifact(CONV, candidate())
    const id2 = st.addArtifact(CONV, candidate({ messageId: 'm9' }))
    expect(id2).toBe(id1)
    expect(list()).toHaveLength(1)
    expect(list()[0].versions).toBeUndefined()
    expect(list()[0].messageId).toBe('m1') // untouched
  })

  it('same title but different kind appends a separate artifact', () => {
    const st = useArtifactsStore.getState()
    st.addArtifact(CONV, candidate())
    st.addArtifact(CONV, candidate({ kind: 'svg', content: '<svg/>' }))
    expect(list()).toHaveLength(2)
  })

  it('reload replay of older messages is fully idempotent (no rollback, no junk versions)', () => {
    const st = useArtifactsStore.getState()
    st.addArtifact(CONV, candidate()) // m1 → v1
    st.addArtifact(CONV, candidate({ messageId: 'm2', content: '<p>v2</p>' })) // regen

    // App reload: MessageBubble re-extracts BOTH finished messages in order.
    st.addArtifact(CONV, candidate()) // m1/v1 replay — must not roll back
    st.addArtifact(CONV, candidate({ messageId: 'm2', content: '<p>v2</p>' })) // m2/v2 replay

    expect(list()).toHaveLength(1)
    const a = list()[0]
    expect(a.content).toBe('<p>v2</p>')
    expect(a.messageId).toBe('m2')
    expect(a.versions?.map(v => v.content)).toEqual(['<p>v1</p>']) // exactly one stash
  })
})

describe('updateArtifact manual-edit versioning (60s gate)', () => {
  it('stashes on first edit, edits in place inside 60s, stashes again after', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-19T12:00:00.000Z'))
    const st = useArtifactsStore.getState()
    const id = st.addArtifact(CONV, candidate())

    st.updateArtifact(CONV, id, '<p>edit1</p>')
    expect(list()[0].versions?.map(v => v.content)).toEqual(['<p>v1</p>'])

    vi.setSystemTime(new Date('2026-07-19T12:00:30.000Z')) // +30s → in-place
    st.updateArtifact(CONV, id, '<p>edit2</p>')
    expect(list()[0].content).toBe('<p>edit2</p>')
    expect(list()[0].versions).toHaveLength(1)

    vi.setSystemTime(new Date('2026-07-19T12:01:31.000Z')) // >60s after stash
    st.updateArtifact(CONV, id, '<p>edit3</p>')
    expect(list()[0].versions?.map(v => v.content)).toEqual(['<p>v1</p>', '<p>edit2</p>'])
    expect(list()[0].content).toBe('<p>edit3</p>')
  })
})

describe('restoreVersion', () => {
  it('makes an old version current and pushes the present content to history', () => {
    const st = useArtifactsStore.getState()
    const id = st.addArtifact(CONV, candidate())
    st.addArtifact(CONV, candidate({ messageId: 'm2', content: '<p>v2</p>' }))

    st.restoreVersion(CONV, id, 0)
    const a = list()[0]
    expect(a.content).toBe('<p>v1</p>')
    expect(a.versions?.map(v => v.content)).toEqual(['<p>v1</p>', '<p>v2</p>'])
  })
})

describe('persist rehydration of pre-versioning records', () => {
  it('rehydrates a record without versions/updatedAt and versions it on next regen', async () => {
    // Old-shape blob exactly as the pre-versioning build persisted it.
    const legacy = {
      state: {
        artifacts: {
          [CONV]: [{
            id: 'legacy-1',
            messageId: 'm-old',
            title: 'demo page',
            kind: 'html',
            language: 'html',
            content: '<p>legacy</p>',
            createdAt: '2026-01-01T00:00:00.000Z',
          }],
        },
        activeArtifactId: 'legacy-1',
      },
      version: 0,
    }
    memStore.set('tachi-artifacts-v1', JSON.stringify(legacy))

    await useArtifactsStore.persist.rehydrate()

    const a = list()[0]
    expect(a).toBeTruthy()
    expect(a.content).toBe('<p>legacy</p>')
    expect(a.versions).toBeUndefined() // additive field absent — still parses

    // A regeneration merges into the legacy record and creates versions[].
    const id = useArtifactsStore.getState().addArtifact(CONV, candidate({ messageId: 'm-new', content: '<p>regen</p>' }))
    expect(id).toBe('legacy-1')
    expect(list()).toHaveLength(1)
    expect(list()[0].versions?.map(v => v.content)).toEqual(['<p>legacy</p>'])
  })
})
