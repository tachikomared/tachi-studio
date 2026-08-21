// apps/desktop/test/unit/artifactVersioning.test.ts
//
// Pure version-merge logic for chat artifacts
// (src/store/artifact-versioning.ts):
//   decideMerge     — append / noop / newVersion decisions (regen semantics)
//   applyManualEdit — 60s-gated version stashing for hand-edits
//   applyRestore    — an old version becomes current; history stays complete
//
// The module only type-imports the store, so no zustand/persist shims needed.
// Records WITHOUT a versions field stand in for pre-versioning persisted data —
// every function must treat them as valid (rehydration compatibility).
import { describe, it, expect } from 'vitest'
import {
  decideMerge,
  applyManualEdit,
  applyRestore,
  MANUAL_VERSION_GAP_MS,
} from '../../src/store/artifact-versioning'
import type { Artifact } from '../../src/store/artifacts.store'

const T0 = '2026-07-19T12:00:00.000Z'

function art(over: Partial<Artifact> = {}): Artifact {
  return {
    id: 'a1',
    messageId: 'm1',
    title: 'demo page',
    kind: 'html',
    language: 'html',
    content: '<p>v1</p>',
    createdAt: T0,
    ...over,
  }
}

function iso(baseMs: number, plusMs: number): string {
  return new Date(baseMs + plusMs).toISOString()
}

const BASE = Date.parse(T0)

describe('decideMerge', () => {
  it('appends when no artifact matches title+kind', () => {
    expect(decideMerge([], { messageId: 'm2', title: 'demo page', kind: 'html', content: '<p>x</p>' }, T0))
      .toEqual({ action: 'append' })
    expect(decideMerge([art()], { messageId: 'm2', title: 'other', kind: 'html', content: '<p>x</p>' }, T0))
      .toEqual({ action: 'append' })
  })

  it('appends when the title matches but the kind differs', () => {
    const d = decideMerge([art()], { messageId: 'm2', title: 'demo page', kind: 'svg', content: '<svg/>' }, T0)
    expect(d).toEqual({ action: 'append' })
  })

  it('no-ops on identical content (same title+kind)', () => {
    const d = decideMerge([art()], { messageId: 'm2', title: 'demo page', kind: 'html', content: '<p>v1</p>' }, T0)
    expect(d).toEqual({ action: 'noop', id: 'a1' })
  })

  it('stashes the current content as a version on same title+kind, different content', () => {
    const now = iso(BASE, 1000)
    const d = decideMerge([art()], { messageId: 'm2', title: 'demo page', kind: 'html', content: '<p>v2</p>' }, now)
    expect(d.action).toBe('newVersion')
    if (d.action !== 'newVersion') return
    expect(d.id).toBe('a1')
    expect(d.artifact.content).toBe('<p>v2</p>')
    expect(d.artifact.messageId).toBe('m2') // reflects the newest generating message
    expect(d.artifact.updatedAt).toBe(now)
    expect(d.artifact.versions).toEqual([{ content: '<p>v1</p>', createdAt: now, messageId: 'm1' }])
  })

  it('replay guard: a candidate matching a stashed (content, messageId) pair is a no-op', () => {
    // Regenerate v1 (from m1) into v2 (from m2)…
    const d = decideMerge([art()], { messageId: 'm2', title: 'demo page', kind: 'html', content: '<p>v2</p>' }, iso(BASE, 1000))
    if (d.action !== 'newVersion') throw new Error('expected newVersion')
    // …then an app reload re-extracts m1's old content. Must NOT roll back.
    const replay = decideMerge([d.artifact], { messageId: 'm1', title: 'demo page', kind: 'html', content: '<p>v1</p>' }, iso(BASE, 2000))
    expect(replay).toEqual({ action: 'noop', id: 'a1' })
    // But the SAME old content from a NEW message is a genuine regeneration.
    const genuine = decideMerge([d.artifact], { messageId: 'm3', title: 'demo page', kind: 'html', content: '<p>v1</p>' }, iso(BASE, 3000))
    expect(genuine.action).toBe('newVersion')
  })

  it('works on a pre-versioning record (no versions field) and accumulates oldest→newest', () => {
    const legacy = art() // no versions key at all
    expect('versions' in legacy).toBe(false)

    const d1 = decideMerge([legacy], { messageId: 'm2', title: 'demo page', kind: 'html', content: '<p>v2</p>' }, iso(BASE, 1000))
    if (d1.action !== 'newVersion') throw new Error('expected newVersion')
    const d2 = decideMerge([d1.artifact], { messageId: 'm3', title: 'demo page', kind: 'html', content: '<p>v3</p>' }, iso(BASE, 2000))
    if (d2.action !== 'newVersion') throw new Error('expected newVersion')

    expect(d2.artifact.versions?.map(v => v.content)).toEqual(['<p>v1</p>', '<p>v2</p>'])
    expect(d2.artifact.content).toBe('<p>v3</p>')
  })
})

describe('applyManualEdit', () => {
  it('returns the artifact unchanged on identical content', () => {
    const a = art()
    expect(applyManualEdit(a, '<p>v1</p>', iso(BASE, 1000))).toBe(a)
  })

  it('stashes the previous content on the first edit (empty versions)', () => {
    const now = iso(BASE, 1000)
    const out = applyManualEdit(art(), '<p>edited</p>', now)
    expect(out.content).toBe('<p>edited</p>')
    expect(out.updatedAt).toBe(now)
    expect(out.versions).toEqual([{ content: '<p>v1</p>', createdAt: now, messageId: 'm1' }])
  })

  it('does NOT stash when the last version is under 60s old (typing burst)', () => {
    const first = applyManualEdit(art(), '<p>edit1</p>', iso(BASE, 0))
    const second = applyManualEdit(first, '<p>edit2</p>', iso(BASE, 5_000))
    expect(second.content).toBe('<p>edit2</p>')
    expect(second.versions).toHaveLength(1) // still only the original stash
    expect(second.versions?.[0].content).toBe('<p>v1</p>')
  })

  it('stashes again once the last version is older than 60s', () => {
    const first = applyManualEdit(art(), '<p>edit1</p>', iso(BASE, 0))
    const later = applyManualEdit(first, '<p>edit2</p>', iso(BASE, MANUAL_VERSION_GAP_MS + 1))
    expect(later.versions).toHaveLength(2)
    expect(later.versions?.map(v => v.content)).toEqual(['<p>v1</p>', '<p>edit1</p>'])
  })
})

describe('applyRestore', () => {
  it('makes the selected version current and pushes the present content to history', () => {
    const a = art({ versions: [{ content: '<p>v1-old</p>', createdAt: T0 }], content: '<p>v2</p>' })
    const now = iso(BASE, 9000)
    const out = applyRestore(a, 0, now)
    expect(out.content).toBe('<p>v1-old</p>')
    expect(out.updatedAt).toBe(now)
    expect(out.versions?.map(v => v.content)).toEqual(['<p>v1-old</p>', '<p>v2</p>'])
  })

  it('is a no-op for an out-of-range index or when the version equals current', () => {
    const a = art({ versions: [{ content: '<p>v1</p>', createdAt: T0 }] })
    expect(applyRestore(a, 5, iso(BASE, 1))).toBe(a)
    expect(applyRestore(a, 0, iso(BASE, 1))).toBe(a) // versions[0] === current content
  })

  it('is a no-op on a record with no versions at all', () => {
    const a = art()
    expect(applyRestore(a, 0, iso(BASE, 1))).toBe(a)
  })
})
