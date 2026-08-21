// Tests for the shared unattended tool gate (unattended-gate.ts).
//
// Audit 2026-06-12 (dimension 4+6 / HIGH): swarm-executor + approve-plan gated
// ONLY network egress — they skipped checkAutoApproval AND any command safety,
// so an autonomous agent ran arbitrary bash + protected-path writes unattended.
// This gate is what those paths now run (on top of the existing egress check):
//   - bash-shaped  → deny destructive commands (no human to confirm)
//   - everything   → deny anything that would need a human prompt (fail-closed)

import { describe, it, expect } from 'vitest'
import { classifyUnattendedTool } from '../../electron/services/unattended-gate'

const ctx = { workingDir: process.cwd() }

describe('classifyUnattendedTool — bash', () => {
  it('denies a destructive shell command', () => {
    const d = classifyUnattendedTool('bash', { command: 'rm -rf /' }, ctx)
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/delete|destructive|root/i)
  })
  it('allows normal build/test commands', () => {
    expect(classifyUnattendedTool('bash', { command: 'npm test' }, ctx).allowed).toBe(true)
    expect(classifyUnattendedTool('shell', { command: 'git commit -m x' }, ctx).allowed).toBe(true)
  })
})

describe('classifyUnattendedTool — non-bash', () => {
  it('allows read-like tools', () => {
    expect(classifyUnattendedTool('Read', { file_path: 'src/a.ts' }, ctx).allowed).toBe(true)
    expect(classifyUnattendedTool('Grep', { pattern: 'x' }, ctx).allowed).toBe(true)
  })
  it('allows writes inside the workspace', () => {
    expect(classifyUnattendedTool('Write', { file_path: 'src/new.ts' }, ctx).allowed).toBe(true)
  })
  it('denies writes to a protected path (would prompt a human)', () => {
    const d = classifyUnattendedTool('Write', { file_path: '.git/config' }, ctx)
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/approval|protected|human/i)
  })
})
