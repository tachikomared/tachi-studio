// apps/desktop/test/unit/extractPlanJson.test.ts
//
// Pure string parser: pulls a <tachi-plan type="..."> JSON </tachi-plan> block
// out of agent text and parses it into a SlashCommandResult. No DOM / electron
// imports, so node vitest env is fine.
import { describe, it, expect } from 'vitest'

import { extractPlanJson } from '../../src/lib/extract-plan-json'
import type {
  TroubleshootPlan,
  RefactorPlan,
  ReviewReport,
  PlanArtifact,
} from '../../src/types/slash-commands'

// ── Deterministic fixtures (minimal-but-valid per command type) ───────────────

const troubleshoot: TroubleshootPlan = {
  command: 'troubleshoot',
  rootCause: { summary: 'null deref', confidence: 80, evidence: ['log line'] },
  solutions: [{ title: 'guard', steps: ['add ?.'], risk: 'low', reversible: true }],
  risks: [],
  metadata: { sessionId: 's1', workspaceDir: '/w', ts: 1 },
}

const refactor: RefactorPlan = {
  command: 'refactor',
  target: 'src/foo.ts',
  changes: [
    { kind: 'rename', description: 'rename x->y', filePaths: ['/w/src/foo.ts'], impact: 'low', reversible: true },
  ],
  estimatedDiff: { added: 3, removed: 1 },
  metadata: { sessionId: 's1', workspaceDir: '/w', ts: 1 },
}

const review: ReviewReport = {
  command: 'review',
  scope: 'src/',
  findings: [
    { severity: 'warning', file: 'a.ts', rule: 'missing-await', description: 'await me' },
  ],
  summary: { errorCount: 0, warningCount: 1, infoCount: 0 },
  metadata: { sessionId: 's1', workspaceDir: '/w', ts: 1 },
}

const plan: PlanArtifact = {
  command: 'plan',
  goal: 'ship it',
  phases: [
    {
      id: 'phase-1',
      name: 'setup',
      status: 'pending',
      dependsOn: [],
      tasks: [{ id: 'task-1', description: 'do', status: 'pending', toolHints: ['Read'] }],
    },
  ],
  risks: [],
  criticalPath: ['phase-1'],
  metadata: { sessionId: 's1', workspaceDir: '/w', ts: 1 },
}

const wrap = (type: string, json: unknown) =>
  `<tachi-plan type="${type}">${JSON.stringify(json)}</tachi-plan>`

describe('extractPlanJson — well-formed block per command type', () => {
  it('parses a troubleshoot block', () => {
    expect(extractPlanJson(wrap('troubleshoot', troubleshoot))).toEqual(troubleshoot)
  })

  it('parses a refactor block', () => {
    expect(extractPlanJson(wrap('refactor', refactor))).toEqual(refactor)
  })

  it('parses a review block', () => {
    expect(extractPlanJson(wrap('review', review))).toEqual(review)
  })

  it('parses a plan block', () => {
    expect(extractPlanJson(wrap('plan', plan))).toEqual(plan)
  })
})

describe('extractPlanJson — surrounding prose tolerance', () => {
  it('ignores leading prose before the tag', () => {
    const text = `Here is my analysis:\n\n${wrap('plan', plan)}`
    expect(extractPlanJson(text)).toEqual(plan)
  })

  it('ignores trailing prose after the closing tag', () => {
    const text = `${wrap('plan', plan)}\n\nLet me know if you approve.`
    expect(extractPlanJson(text)).toEqual(plan)
  })

  it('ignores prose on both sides', () => {
    const text = `intro\n${wrap('review', review)}\noutro`
    expect(extractPlanJson(text)).toEqual(review)
  })
})

describe('extractPlanJson — tag-syntax permissiveness', () => {
  it('matches case-insensitively (<TACHI-PLAN>)', () => {
    const text = `<TACHI-PLAN type="plan">${JSON.stringify(plan)}</tachi-plan>`
    expect(extractPlanJson(text)).toEqual(plan)
  })

  it('tolerates whitespace around the attribute and = sign', () => {
    const text = `<tachi-plan   type = "plan" >${JSON.stringify(plan)}</tachi-plan>`
    expect(extractPlanJson(text)).toEqual(plan)
  })

  it("accepts single-quoted type values (type='plan')", () => {
    const text = `<tachi-plan type='plan'>${JSON.stringify(plan)}</tachi-plan>`
    expect(extractPlanJson(text)).toEqual(plan)
  })

  it('tolerates a leading BOM / whitespace inside the inner JSON', () => {
    const text = `<tachi-plan type="plan">﻿  \n${JSON.stringify(plan)}\n  </tachi-plan>`
    expect(extractPlanJson(text)).toEqual(plan)
  })

  it('matches JSON spanning multiple lines (dotall)', () => {
    const pretty = JSON.stringify(plan, null, 2)
    const text = `<tachi-plan type="plan">\n${pretty}\n</tachi-plan>`
    expect(extractPlanJson(text)).toEqual(plan)
  })
})

describe('extractPlanJson — no usable block', () => {
  it('returns null when there is no tag at all', () => {
    expect(extractPlanJson('just some plain agent prose, no tags here')).toBeNull()
  })

  it('returns null on an empty string', () => {
    expect(extractPlanJson('')).toBeNull()
  })

  it('returns null when the type attribute is not one of the four commands', () => {
    const text = `<tachi-plan type="explain">${JSON.stringify(plan)}</tachi-plan>`
    expect(extractPlanJson(text)).toBeNull()
  })

  it('returns null when the type attribute is missing entirely', () => {
    const text = `<tachi-plan>${JSON.stringify(plan)}</tachi-plan>`
    expect(extractPlanJson(text)).toBeNull()
  })

  it('returns null when the closing tag is absent', () => {
    const text = `<tachi-plan type="plan">${JSON.stringify(plan)}`
    expect(extractPlanJson(text)).toBeNull()
  })
})

describe('extractPlanJson — malformed / mismatched JSON', () => {
  it('returns null when inner content is not valid JSON', () => {
    expect(extractPlanJson('<tachi-plan type="plan">{not json}</tachi-plan>')).toBeNull()
  })

  it('returns null when inner content is empty', () => {
    expect(extractPlanJson('<tachi-plan type="plan"></tachi-plan>')).toBeNull()
  })

  it('returns null when JSON parses to a non-object (array)', () => {
    expect(extractPlanJson('<tachi-plan type="plan">[1,2,3]</tachi-plan>')).toBeNull()
  })

  it('returns null when JSON parses to a primitive (string)', () => {
    expect(extractPlanJson('<tachi-plan type="plan">"hello"</tachi-plan>')).toBeNull()
  })

  it('returns null when JSON parses to literal null', () => {
    expect(extractPlanJson('<tachi-plan type="plan">null</tachi-plan>')).toBeNull()
  })

  it('returns null when the object has no command field', () => {
    expect(extractPlanJson('<tachi-plan type="plan">{"goal":"x"}</tachi-plan>')).toBeNull()
  })

  it('returns null when command is present but not a string', () => {
    expect(extractPlanJson('<tachi-plan type="plan">{"command":42}</tachi-plan>')).toBeNull()
  })

  it('returns null when the command field mismatches the type attribute', () => {
    // tag says review, body says refactor → reject
    const text = `<tachi-plan type="review">${JSON.stringify(refactor)}</tachi-plan>`
    expect(extractPlanJson(text)).toBeNull()
  })
})

describe('extractPlanJson — multiple blocks', () => {
  it('returns the FIRST block when several are present (non-greedy first-wins)', () => {
    const text = `${wrap('plan', plan)}\n${wrap('review', review)}`
    expect(extractPlanJson(text)).toEqual(plan)
  })

  it('a malformed first block is NOT skipped — first match wins even if it fails to parse', () => {
    // The regex matches the first <tachi-plan> block; that block is malformed,
    // so the whole call returns null rather than falling through to the valid one.
    const text = `<tachi-plan type="plan">{bad}</tachi-plan>\n${wrap('review', review)}`
    expect(extractPlanJson(text)).toBeNull()
  })
})
