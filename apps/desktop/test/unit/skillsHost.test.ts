// apps/desktop/test/unit/skillsHost.test.ts
//
// SKILL.md skills host — discovery precedence across layers (bundled → user →
// project, later wins), the 50-skill cap, viewSkill's frontmatter stripping,
// subfile containment (traversal rejection), and the exact anti-hallucination
// message for an unknown skill. electron is mocked; the filesystem is real
// (mkdtemp) because path resolution/containment IS the logic under test.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Mutable holder so each test's temp dirs reach the hoisted electron mock.
const holder = vi.hoisted(() => ({ userData: '', appPath: '' }))
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return holder.userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => holder.appPath,
  },
}))

import { discoverSkills, viewSkill } from '../../electron/services/tachi/skills-host'

let base: string
let workspaceRoot: string
const savedResourcesPath = (process as { resourcesPath?: string }).resourcesPath

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'skills-host-'))
  workspaceRoot = join(base, 'workspace')
  holder.userData = join(base, 'userData')
  holder.appPath = join(base, 'appPath')
  mkdirSync(workspaceRoot, { recursive: true })
  // Point the "packaged" bundled layer at a temp dir too.
  ;(process as { resourcesPath?: string }).resourcesPath = join(base, 'appResources')
})
afterEach(() => {
  ;(process as { resourcesPath?: string }).resourcesPath = savedResourcesPath
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

/** Create <root>/<folder>/SKILL.md (plus optional extra files). */
function writeSkill(root: string, folder: string, frontmatter: string, body = 'Do the thing.', extras: Record<string, string> = {}): void {
  const dir = join(root, folder)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}\n`, 'utf8')
  for (const [rel, content] of Object.entries(extras)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), content, 'utf8')
  }
}

describe('discoverSkills', () => {
  it('returns [] when no layer has a skills dir (and never throws)', () => {
    expect(discoverSkills(workspaceRoot)).toEqual([])
    expect(discoverSkills(join(base, 'does-not-exist'))).toEqual([])
  })

  it('discovers project skills from both <root>/.tachi/skills and <root>/skills', () => {
    writeSkill(join(workspaceRoot, '.tachi', 'skills'), 'hidden-one', 'name: hidden-one\ndescription: from .tachi')
    writeSkill(join(workspaceRoot, 'skills'), 'plain-one', 'name: plain-one\ndescription: from skills/')
    const names = discoverSkills(workspaceRoot).map(s => s.name).sort()
    expect(names).toEqual(['hidden-one', 'plain-one'])
    expect(discoverSkills(workspaceRoot).every(s => s.layer === 'project')).toBe(true)
  })

  it('later layers win on a name collision: project > user > bundled', () => {
    writeSkill(join(base, 'appResources', 'skills'), 'dupe', 'name: dupe\ndescription: bundled copy')
    writeSkill(join(holder.userData, 'skills'), 'dupe', 'name: dupe\ndescription: user copy')
    writeSkill(join(workspaceRoot, '.tachi', 'skills'), 'dupe', 'name: dupe\ndescription: project copy')
    const skills = discoverSkills(workspaceRoot)
    expect(skills).toHaveLength(1)
    expect(skills[0].description).toBe('project copy')
    expect(skills[0].layer).toBe('project')
  })

  it('user (userData) layer overrides bundled', () => {
    writeSkill(join(base, 'appResources', 'skills'), 'dupe', 'name: dupe\ndescription: bundled copy')
    writeSkill(join(holder.userData, 'skills'), 'dupe', 'name: dupe\ndescription: user copy')
    const skills = discoverSkills(workspaceRoot)
    expect(skills).toHaveLength(1)
    expect(skills[0].description).toBe('user copy')
  })

  it('also finds bundled skills via the dev fallback <appPath>/resources/skills', () => {
    delete (process as { resourcesPath?: string }).resourcesPath
    writeSkill(join(holder.appPath, 'resources', 'skills'), 'dev-bundled', 'name: dev-bundled\ndescription: dev copy')
    const skills = discoverSkills(workspaceRoot)
    expect(skills.map(s => s.name)).toEqual(['dev-bundled'])
    expect(skills[0].layer).toBe('bundled')
  })

  it('skips folders without a SKILL.md and falls back to the folder name when frontmatter has no valid name', () => {
    mkdirSync(join(workspaceRoot, 'skills', 'not-a-skill'), { recursive: true })
    writeSkill(join(workspaceRoot, 'skills'), 'folder-named', 'description: no name key here')
    writeSkill(join(workspaceRoot, 'skills'), 'Bad Folder!', 'description: invalid folder + no fm name')
    const names = discoverSkills(workspaceRoot).map(s => s.name)
    expect(names).toEqual(['folder-named'])
  })

  it('caps discovery at 50 skills', () => {
    for (let i = 0; i < 55; i++) {
      writeSkill(join(workspaceRoot, 'skills'), `skill-${String(i).padStart(2, '0')}`, `name: skill-${String(i).padStart(2, '0')}`)
    }
    expect(discoverSkills(workspaceRoot)).toHaveLength(50)
  })
})

describe('viewSkill', () => {
  it('returns the SKILL.md body with the frontmatter stripped', () => {
    writeSkill(join(workspaceRoot, 'skills'), 'reader', 'name: reader\ndescription: d', '# Reader\n\nStep 1.')
    const out = viewSkill(workspaceRoot, 'reader')
    expect(out).toContain('# Reader')
    expect(out).toContain('Step 1.')
    expect(out).not.toContain('---')
    expect(out).not.toContain('description: d')
  })

  it('matches the name case-insensitively (identifiers are lowercase)', () => {
    writeSkill(join(workspaceRoot, 'skills'), 'reader', 'name: reader')
    expect(viewSkill(workspaceRoot, 'READER')).toContain('Do the thing.')
  })

  it('serves a relative subfile inside the skill folder', () => {
    writeSkill(join(workspaceRoot, 'skills'), 'refs', 'name: refs', 'body', {
      [join('references', 'usage.md')]: 'deep reference content',
    })
    expect(viewSkill(workspaceRoot, 'refs', 'references/usage.md')).toBe('deep reference content')
  })

  it('rejects .. traversal outside the skill folder', () => {
    writeSkill(join(workspaceRoot, 'skills'), 'jail', 'name: jail')
    writeFileSync(join(workspaceRoot, 'secret.txt'), 'top secret', 'utf8')
    const out = viewSkill(workspaceRoot, 'jail', '../../secret.txt')
    expect(out).toContain('Rejected')
    expect(out).not.toContain('top secret')
  })

  it('rejects an absolute filePath', () => {
    writeSkill(join(workspaceRoot, 'skills'), 'jail', 'name: jail')
    writeFileSync(join(workspaceRoot, 'secret.txt'), 'top secret', 'utf8')
    const out = viewSkill(workspaceRoot, 'jail', join(workspaceRoot, 'secret.txt'))
    expect(out).toContain('Rejected')
    expect(out).not.toContain('top secret')
  })

  it('reports a missing subfile without throwing', () => {
    writeSkill(join(workspaceRoot, 'skills'), 'refs', 'name: refs')
    expect(viewSkill(workspaceRoot, 'refs', 'references/nope.md')).toContain('no file at "references/nope.md"')
  })

  it('returns the exact anti-hallucination message for an unknown skill', () => {
    expect(viewSkill(workspaceRoot, 'ghost')).toBe(
      'No skill named "ghost" is installed. Do NOT search the filesystem for it — pick one from <available_skills> or proceed without a skill.',
    )
  })

  it('caps a huge SKILL.md body at 20k chars', () => {
    writeSkill(join(workspaceRoot, 'skills'), 'big', 'name: big', 'x'.repeat(30_000))
    const out = viewSkill(workspaceRoot, 'big')
    expect(out.length).toBeLessThan(21_000)
    expect(out).toContain('[... truncated at 20000 chars ...]')
  })
})
