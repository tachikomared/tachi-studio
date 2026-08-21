// apps/desktop/test/unit/roleBoundary.test.ts
import { describe, it, expect } from 'vitest'
import { checkRoleBoundary } from '../../electron/services/role-registry'

type RoleLike = Parameters<typeof checkRoleBoundary>[0]
const mkRole = (o: {
  label?: string; allowedTools?: string[]; denyWritePaths?: string[]; denyToolPatterns?: string[]
}): RoleLike => ({
  id: 'x', label: o.label ?? 'X', description: '',
  triggers: { keywords: [], paths: [] }, examples: [],
  boundaries: { denyWritePaths: o.denyWritePaths ?? [], denyToolPatterns: o.denyToolPatterns ?? [] },
  allowedTools: o.allowedTools ?? [],
}) as unknown as RoleLike

describe('checkRoleBoundary — allowed-tools allowlist', () => {
  const security = mkRole({ label: 'Security Engineer', allowedTools: ['Read', 'Glob', 'Grep', 'WebFetch'] })
  it('allows tools in the allowlist, denies the rest', () => {
    expect(checkRoleBoundary(security, 'Read').allowed).toBe(true)
    expect(checkRoleBoundary(security, 'WebFetch').allowed).toBe(true)
    const d = checkRoleBoundary(security, 'Write')
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/permits only/)
  })
  it('fail-open: empty allowlist + empty boundaries = everything allowed', () => {
    const open = mkRole({})
    expect(checkRoleBoundary(open, 'Bash', { command: 'rm -rf /' }).allowed).toBe(true)
    expect(checkRoleBoundary(open, 'Write', { path: 'package.json' }).allowed).toBe(true)
  })
})

describe('checkRoleBoundary — deny-tool-patterns (Tool:regex)', () => {
  const role = mkRole({ allowedTools: ['Bash', 'Read'], denyToolPatterns: ['Bash:rm.*', 'Bash:dd.*'] })
  it('denies a matching command, allows a safe one', () => {
    expect(checkRoleBoundary(role, 'Bash', { command: 'ls -la' }).allowed).toBe(true)
    expect(checkRoleBoundary(role, 'Bash', { command: 'rm -rf x' }).allowed).toBe(false)
    expect(checkRoleBoundary(role, 'Bash', { command: 'dd if=/dev/zero' }).allowed).toBe(false)
  })
  it('the pattern is scoped to its tool (Read is unaffected)', () => {
    expect(checkRoleBoundary(role, 'Read').allowed).toBe(true)
  })
})

describe('checkRoleBoundary — deny-write-paths (write tools only)', () => {
  const fe = mkRole({
    label: 'Frontend',
    allowedTools: ['Read', 'Write', 'Edit'],
    denyWritePaths: ['**/node_modules/**', 'package.json', '.env*'],
  })
  it('allows a normal source write', () => {
    expect(checkRoleBoundary(fe, 'Write', { file_path: 'src/App.tsx' }).allowed).toBe(true)
  })
  it('denies protected paths (full glob + basename)', () => {
    expect(checkRoleBoundary(fe, 'Write', { file_path: 'package.json' }).allowed).toBe(false)
    expect(checkRoleBoundary(fe, 'Write', { path: 'node_modules/x/y.js' }).allowed).toBe(false)
    expect(checkRoleBoundary(fe, 'Edit', { path: 'config/.env.local' }).allowed).toBe(false) // basename .env.local
  })
  it('does not apply path rules to non-write tools', () => {
    expect(checkRoleBoundary(fe, 'Read', { file_path: 'package.json' }).allowed).toBe(true)
  })
})
