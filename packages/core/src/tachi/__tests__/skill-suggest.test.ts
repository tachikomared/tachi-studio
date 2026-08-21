// packages/core/src/tachi/__tests__/skill-suggest.test.ts
import { describe, it, expect } from 'vitest'
import { suggestSkills, type WorkspaceMarkers } from '../skill-suggest.js'

const markers = (m: Partial<WorkspaceMarkers>): WorkspaceMarkers => ({
  files: [], deps: [], languages: [], ...m,
})

const ids = (m: WorkspaceMarkers): string[] => suggestSkills(m).map(s => s.skillId)

describe('suggestSkills', () => {
  it('returns [] for empty markers', () => {
    expect(suggestSkills(markers({}))).toEqual([])
  })

  it('tolerates garbage input without throwing', () => {
    // Sloppy callers (or an IPC boundary) may hand us junk — treat as empty.
    expect(suggestSkills({ files: undefined, deps: null, languages: 42 } as unknown as WorkspaceMarkers)).toEqual([])
    expect(suggestSkills(undefined as unknown as WorkspaceMarkers)).toEqual([])
  })

  it('detects React from package.json deps', () => {
    const out = suggestSkills(markers({ deps: ['react', 'react-dom'] }))
    expect(out.map(s => s.skillId)).toContain('react-review')
    const react = out.find(s => s.skillId === 'react-review')!
    expect(react.layer).toBe('suggested')
    expect(react.title.length).toBeGreaterThan(0)
    expect(react.reason.length).toBeGreaterThan(0)
  })

  it('detects React from tsx files even without deps', () => {
    expect(ids(markers({ languages: ['tsx'] }))).toContain('react-review')
  })

  it('detects Python from pyproject.toml and from the py extension', () => {
    expect(ids(markers({ files: ['pyproject.toml'] }))).toContain('python-review')
    expect(ids(markers({ languages: ['py'] }))).toContain('python-review')
    expect(ids(markers({ files: ['requirements-dev.txt'] }))).toContain('python-review')
  })

  it('detects Docker from a Dockerfile (case-insensitive) and compose files', () => {
    expect(ids(markers({ files: ['Dockerfile'] }))).toContain('docker-helper')
    expect(ids(markers({ files: ['deploy/compose.yaml'] }))).toContain('docker-helper')
    expect(ids(markers({ files: ['docker-compose.yml'] }))).toContain('docker-helper')
  })

  it('detects CI from .github/workflows paths', () => {
    expect(ids(markers({ files: ['.github/workflows'] }))).toContain('ci-doctor')
    expect(ids(markers({ files: ['.github/workflows/ci.yml'] }))).toContain('ci-doctor')
    // .github alone is not a CI signal
    expect(ids(markers({ files: ['.github'] }))).not.toContain('ci-doctor')
  })

  it('normalizes Windows-style backslash paths', () => {
    expect(ids(markers({ files: ['prisma\\schema.prisma'] }))).toContain('db-migrations')
    expect(ids(markers({ files: ['.github\\workflows\\ci.yml'] }))).toContain('ci-doctor')
  })

  it('detects Rust / Go from manifest or extension', () => {
    expect(ids(markers({ files: ['Cargo.toml'] }))).toContain('rust-review')
    expect(ids(markers({ languages: ['rs'] }))).toContain('rust-review')
    expect(ids(markers({ files: ['go.mod'] }))).toContain('go-review')
  })

  it('detects Next.js from the dep or a next.config file', () => {
    expect(ids(markers({ deps: ['next'] }))).toContain('nextjs-helper')
    expect(ids(markers({ files: ['next.config.mjs'] }))).toContain('nextjs-helper')
  })

  it('detects test runners from deps and config files', () => {
    expect(ids(markers({ deps: ['vitest'] }))).toContain('test-writer')
    expect(ids(markers({ files: ['playwright.config.ts'] }))).toContain('test-writer')
  })

  it('emits at most one suggestion per skill even when several signals hit', () => {
    const out = suggestSkills(markers({
      deps: ['react', 'preact'],
      files: ['src/App.tsx'],
      languages: ['tsx', 'jsx'],
    }))
    expect(out.filter(s => s.skillId === 'react-review')).toHaveLength(1)
  })

  it('fires multiple independent rules for a mixed workspace', () => {
    const out = ids(markers({
      deps: ['react', 'vitest', 'electron'],
      files: ['Dockerfile', '.github/workflows/ci.yml', 'pnpm-workspace.yaml'],
    }))
    for (const id of ['react-review', 'test-writer', 'electron-review', 'docker-helper', 'ci-doctor', 'monorepo-navigator']) {
      expect(out).toContain(id)
    }
  })

  it('matches deps and extensions case-insensitively, tolerating a leading dot', () => {
    expect(ids(markers({ deps: ['React'] }))).toContain('react-review')
    expect(ids(markers({ languages: ['.PY'] }))).toContain('python-review')
  })

  it('does not fire unrelated rules on a plain node project', () => {
    const out = ids(markers({ files: ['package.json', 'index.js'], deps: ['express'], languages: ['js'] }))
    expect(out).not.toContain('python-review')
    expect(out).not.toContain('rust-review')
    expect(out).not.toContain('docker-helper')
  })
})
