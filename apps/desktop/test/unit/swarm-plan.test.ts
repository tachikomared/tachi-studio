// apps/desktop/test/unit/swarm-plan.test.ts
//
// Audit H1(a) — the pure bridge that turns a gnap task into a harness run plan.
// The end-to-end executor (claim → worktree → harness → completeRun) needs a GUI
// + a live 2-process gnap to verify; this locks the deterministic seam.

import { describe, it, expect } from 'vitest'
import { buildSwarmRunPlan } from '../../electron/services/swarm-plan'

describe('buildSwarmRunPlan', () => {
  it('builds a prompt from title + description and a prefixed run id', () => {
    const plan = buildSwarmRunPlan(
      { id: 't1', title: 'Add dark mode', desc: 'Toggle in settings.' },
      () => 'fixed123',
    )
    expect(plan.taskName).toBe('Add dark mode')
    expect(plan.runId).toBe('run-fixed123')
    expect(plan.prompt).toContain('Add dark mode')
    expect(plan.prompt).toContain('Toggle in settings.')
    expect(plan.prompt).toContain('Commit your work in this worktree')
  })

  it('omits the description block when there is no desc', () => {
    const plan = buildSwarmRunPlan({ id: 't2', title: 'Fix bug' }, () => 'x')
    expect(plan.prompt.startsWith('Fix bug\n\nComplete this task')).toBe(true)
  })

  it('falls back to a Task <id> name when title is blank', () => {
    const plan = buildSwarmRunPlan({ id: 'abc', title: '   ', desc: '' }, () => 'x')
    expect(plan.taskName).toBe('Task abc')
    expect(plan.prompt).toContain('Task abc')
  })

  it('generates distinct run ids by default (real idgen)', () => {
    const a = buildSwarmRunPlan({ id: 't', title: 'A' })
    const b = buildSwarmRunPlan({ id: 't', title: 'A' })
    expect(a.runId).not.toBe(b.runId)
    expect(a.runId.startsWith('run-')).toBe(true)
  })
})
