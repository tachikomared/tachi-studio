// packages/core/src/tachi/__tests__/skills.test.ts
import { describe, it, expect } from 'vitest'
import {
  parseSkillFrontmatter,
  stripSkillFrontmatter,
  buildAvailableSkillsBlock,
  isValidSkillName,
  type SkillMeta,
} from '../skills.js'

const md = (fm: string, body = 'Body.'): string => `---\n${fm}\n---\n${body}\n`

describe('parseSkillFrontmatter', () => {
  it('parses simple name + description', () => {
    const r = parseSkillFrontmatter(md('name: my-skill\ndescription: Does a thing.'))
    expect(r).toEqual({ name: 'my-skill', description: 'Does a thing.' })
  })

  it('returns null when there are no frontmatter fences', () => {
    expect(parseSkillFrontmatter('# Just markdown\n\nname: nope')).toBeNull()
  })

  it('returns null when the opening fence is not the first non-empty line', () => {
    expect(parseSkillFrontmatter('intro text\n---\nname: x\n---\n')).toBeNull()
  })

  it('returns null for an unterminated frontmatter block', () => {
    expect(parseSkillFrontmatter('---\nname: my-skill\nno closing fence')).toBeNull()
  })

  it('tolerates blank lines before the opening fence and CRLF endings', () => {
    const r = parseSkillFrontmatter('\r\n---\r\nname: crlf-skill\r\ndescription: Windows.\r\n---\r\nbody')
    expect(r).toEqual({ name: 'crlf-skill', description: 'Windows.' })
  })

  it('strips matching single and double quotes around values', () => {
    expect(parseSkillFrontmatter(md('name: "quoted"\ndescription: \'single quoted\''))).toEqual({
      name: 'quoted',
      description: 'single quoted',
    })
  })

  it('lowercases the name before validating', () => {
    expect(parseSkillFrontmatter(md('name: My-Skill'))?.name).toBe('my-skill')
  })

  it('drops an invalid name (spaces, leading dash, over-long) but keeps the description', () => {
    expect(parseSkillFrontmatter(md('name: has spaces\ndescription: d'))).toEqual({ description: 'd' })
    expect(parseSkillFrontmatter(md('name: -leading-dash'))).toEqual({})
    expect(parseSkillFrontmatter(md(`name: ${'a'.repeat(65)}`))).toEqual({})
  })

  it('accepts a 64-char name (boundary)', () => {
    const name = 'a'.repeat(64)
    expect(parseSkillFrontmatter(md(`name: ${name}`))?.name).toBe(name)
  })

  it('ignores unknown keys, nested lines, and non key:value lines', () => {
    const r = parseSkillFrontmatter(md('name: ok\nversion: 2\nmeta:\n  nested: true\nnot a pair'))
    expect(r).toEqual({ name: 'ok' })
  })

  it('handles a description containing colons', () => {
    expect(parseSkillFrontmatter(md('name: c\ndescription: use when: always, why: because'))?.description)
      .toBe('use when: always, why: because')
  })

  it('treats an empty frontmatter block as parsed-but-empty (not null)', () => {
    expect(parseSkillFrontmatter('---\n---\nbody')).toEqual({})
  })
})

describe('stripSkillFrontmatter', () => {
  it('removes the frontmatter block, returning only the body', () => {
    expect(stripSkillFrontmatter(md('name: x\ndescription: y', '# Title\n\nDo the thing.'))).toBe('# Title\n\nDo the thing.\n')
  })

  it('returns text without frontmatter unchanged', () => {
    expect(stripSkillFrontmatter('# No fences here')).toBe('# No fences here')
  })
})

describe('isValidSkillName', () => {
  it('accepts lowercase alphanumerics with dashes, case-insensitively', () => {
    expect(isValidSkillName('tachi-conventions')).toBe(true)
    expect(isValidSkillName('Tachi-Conventions')).toBe(true)  // validated after lowercasing
    expect(isValidSkillName('a')).toBe(true)
  })
  it('rejects spaces, leading dashes, and empty strings', () => {
    expect(isValidSkillName('has space')).toBe(false)
    expect(isValidSkillName('-x')).toBe(false)
    expect(isValidSkillName('')).toBe(false)
  })
})

describe('buildAvailableSkillsBlock', () => {
  const skill = (name: string, description = `${name} description`, layer: SkillMeta['layer'] = 'project'): SkillMeta =>
    ({ name, description, layer, dir: `/skills/${name}` })

  it('returns "" for an empty list', () => {
    expect(buildAvailableSkillsBlock([], 2000)).toBe('')
  })

  it('renders the full block (header + one line per skill) when within budget', () => {
    const block = buildAvailableSkillsBlock([skill('alpha'), skill('beta', 'Second skill.', 'bundled')], 2000)
    expect(block.startsWith('<available_skills>\n')).toBe(true)
    expect(block.endsWith('\n</available_skills>')).toBe(true)
    expect(block).toContain('These are skill names for the skill_view tool — they are NOT callable tools themselves.')
    expect(block).toContain('alpha — alpha description (project)')
    expect(block).toContain('beta — Second skill. (bundled)')
  })

  it('omits the dash separator for a skill with an empty description', () => {
    const block = buildAvailableSkillsBlock([skill('bare', '')], 2000)
    expect(block).toContain('bare (project)')
    expect(block).not.toContain('bare — ')
  })

  it('drops descriptions (name-only compact mode) when the full block is over budget', () => {
    const skills = [skill('alpha', 'x'.repeat(300)), skill('beta', 'y'.repeat(300))]
    const fullLen = buildAvailableSkillsBlock(skills, 100_000).length
    const block = buildAvailableSkillsBlock(skills, fullLen - 1)
    expect(block).toContain('alpha')
    expect(block).toContain('beta')
    expect(block).not.toContain('xxx')
    expect(block.length).toBeLessThanOrEqual(fullLen - 1)
  })

  it('truncates the list (keeping the header + >= 1 entry) when compact mode is still over budget', () => {
    const skills = Array.from({ length: 40 }, (_, i) => skill(`skill-${String(i).padStart(2, '0')}`))
    const block = buildAvailableSkillsBlock(skills, 200)
    expect(block).toContain('These are skill names for the skill_view tool')
    expect(block).toContain('skill-00')
    expect(block).toMatch(/\[\.\.\. \d+ more skill\(s\) omitted for budget \.\.\.\]/)
    expect(block.length).toBeLessThanOrEqual(200)
  })

  it('keeps at least one entry even when the budget is impossibly small', () => {
    const block = buildAvailableSkillsBlock([skill('alpha'), skill('beta')], 1)
    expect(block).toContain('<available_skills>')
    expect(block).toContain('alpha')
  })
})
