// apps/desktop/test/unit/tachiKnowledgeLoop.test.ts
//
// The loop WIRING for harness items 7 + 8 — the parts the pure-module tests
// (tachiKnowledge / tachiScopedRules) can't prove:
//
//   * remember_convention writes through the EXISTING permission gate, as a
//     `write` of the project-context file (no private bypass, no new gate name)
//   * a gate denial leaves the file untouched and tells the model so
//     — and a duplicate never even reaches the gate (no write is attempted)
//   * a scoped-rules note rides along on the tool result ONCE, and the flag
//     turns the whole hook off
//
// Same harness as tachi-loop-glue.test.ts: ai/test MockLanguageModelV3 against
// a real temp workspace — no network, no electron.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import type { AgentEvent } from '@tachi/core'
import { runTachiLoop } from '../../electron/services/tachi/loop'
import { LEARNED_HEADING } from '../../electron/services/tachi/knowledge'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'tachi-knowledge-loop-')) })
afterEach(() => { rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

const USAGE = { inputTokens: 5, outputTokens: 5, totalTokens: 10 }

type Step = { tool: string; input: string } | { text: string }

function scriptedModel(steps: Step[]): MockLanguageModelV3 {
  let i = 0
  return new MockLanguageModelV3({
    doStream: async () => {
      const step = steps[Math.min(i, steps.length - 1)]!
      i++
      const chunks: Array<Record<string, unknown>> = [{ type: 'stream-start', warnings: [] }]
      if ('tool' in step) {
        chunks.push({ type: 'tool-call', toolCallId: `call-${i}`, toolName: step.tool, input: step.input })
        chunks.push({ type: 'finish', finishReason: 'tool-calls', usage: USAGE })
      } else {
        chunks.push({ type: 'text-start', id: 'a' })
        chunks.push({ type: 'text-delta', id: 'a', delta: step.text })
        chunks.push({ type: 'text-end', id: 'a' })
        chunks.push({ type: 'finish', finishReason: 'stop', usage: USAGE })
      }
      return { stream: simulateReadableStream({ chunks }) }
    },
  })
}

async function run(
  model: MockLanguageModelV3,
  opts: {
    gate?: (name: string, args: Record<string, unknown>) => Promise<boolean | string>
    scopedRules?: boolean
    task?: string
  } = {},
): Promise<{ events: AgentEvent[]; gateCalls: Array<{ name: string; args: Record<string, unknown> }> }> {
  const events: AgentEvent[] = []
  const gateCalls: Array<{ name: string; args: Record<string, unknown> }> = []
  await runTachiLoop({
    model,
    modelId: 'claude-sonnet-4.6',
    workspaceRoot: ws,
    task: opts.task ?? 'do the thing',
    signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
    gate: async (name, args) => {
      gateCalls.push({ name, args })
      return opts.gate ? opts.gate(name, args) : true
    },
    ...(opts.scopedRules === undefined ? {} : { scopedRules: opts.scopedRules }),
  })
  return { events, gateCalls }
}

const toolDones = (events: AgentEvent[], name: string) =>
  events.filter(e => e.type === 'tool-done' && (e as { name: string }).name === name) as Array<Extract<AgentEvent, { type: 'tool-done' }>>

const NOTE = 'Relative require() inside a function body never resolves in the packaged app.asar.'

describe('remember_convention — gated append-back', () => {
  it('appends to the project-context file THROUGH the write gate', async () => {
    writeFileSync(join(ws, 'AGENTS.md'), '# AGENTS.md\n\nhand-written prose\n')
    const model = scriptedModel([
      { tool: 'remember_convention', input: JSON.stringify({ note: NOTE }) },
      { text: 'noted' },
    ])
    const { events, gateCalls } = await run(model)

    // The gate saw a plain `write` of AGENTS.md — the same call shape any file
    // write makes, so plan mode / roles / trust presets all apply unchanged.
    const write = gateCalls.find(g => g.name === 'write')
    expect(write).toBeDefined()
    expect(write!.args.path).toBe('AGENTS.md')
    expect(String(write!.args.content)).toContain(NOTE)
    expect(gateCalls.some(g => g.name === 'remember_convention')).toBe(false)

    const md = readFileSync(join(ws, 'AGENTS.md'), 'utf8')
    expect(md).toContain('hand-written prose')
    expect(md).toContain(LEARNED_HEADING)
    expect(md).toContain(`- ${NOTE}`)
    expect(toolDones(events, 'remember_convention')[0]!.output).toContain('Recorded in AGENTS.md')
  })

  it('a denied write leaves the file untouched and says so', async () => {
    writeFileSync(join(ws, 'AGENTS.md'), '# AGENTS.md\n')
    const model = scriptedModel([
      { tool: 'remember_convention', input: JSON.stringify({ note: NOTE }) },
      { text: 'ok, moving on' },
    ])
    const { events } = await run(model, { gate: async (name) => name !== 'write' })

    expect(readFileSync(join(ws, 'AGENTS.md'), 'utf8')).toBe('# AGENTS.md\n')
    expect(toolDones(events, 'remember_convention')[0]!.output).toContain('NOT recorded')
  })

  it('a duplicate is a no-op that never attempts a write', async () => {
    writeFileSync(join(ws, 'AGENTS.md'), `# AGENTS.md\n\n${LEARNED_HEADING}\n\n- ${NOTE}\n`)
    const model = scriptedModel([
      { tool: 'remember_convention', input: JSON.stringify({ note: `  ${NOTE.toUpperCase()}  ` }) },
      { text: 'already known' },
    ])
    const { events, gateCalls } = await run(model)

    expect(gateCalls.some(g => g.name === 'write')).toBe(false)
    expect(toolDones(events, 'remember_convention')[0]!.output).toContain('Already recorded')
  })

  it('creates the host file when the workspace has none', async () => {
    const model = scriptedModel([
      { tool: 'remember_convention', input: JSON.stringify({ note: NOTE }) },
      { text: 'noted' },
    ])
    await run(model)
    expect(existsSync(join(ws, 'AGENTS.md'))).toBe(true)
    expect(readFileSync(join(ws, 'AGENTS.md'), 'utf8')).toContain(`- ${NOTE}`)
  })

  it('an over-long note is refused without a write', async () => {
    const model = scriptedModel([
      { tool: 'remember_convention', input: JSON.stringify({ note: 'x'.repeat(500) }) },
      { text: 'fine' },
    ])
    const { events, gateCalls } = await run(model)
    expect(gateCalls.some(g => g.name === 'write')).toBe(false)
    expect(existsSync(join(ws, 'AGENTS.md'))).toBe(false)
    expect(toolDones(events, 'remember_convention')[0]!.output).toContain('NOTHING was written')
  })
})

describe('remember_convention — gave-up classifier credit', () => {
  // Live-found (batch16 verify, M3): a change-shaped run whose only action was
  // a successful remember_convention tripped the auto-continue nudge ("the run
  // made none") and paid an extra LLM pass. The write now counts for the
  // classifier (mutationCount) while staying invisible to the verify policy.
  it('a successful note on a change-shaped task ends done — no nudge, no incomplete', async () => {
    const model = scriptedModel([
      { tool: 'remember_convention', input: JSON.stringify({ note: NOTE }) },
      { text: 'Recorded the convention; the fix itself is already in place.' },
    ])
    const { events } = await run(model, { task: 'Fix the packaging bug in the installer config' })

    expect(readFileSync(join(ws, 'AGENTS.md'), 'utf8')).toContain(`- ${NOTE}`)
    expect(events.some(e => e.type === 'text' && (e as { text?: string }).text?.includes('AUTO-CONTINUE'))).toBe(false)
    const done = events.find(e => e.type === 'done') as { incomplete?: boolean } | undefined
    expect(done).toBeDefined()
    expect(done!.incomplete).toBeUndefined()
  })

  it('a REFUSED note gives no credit — the same run still classifies incomplete', async () => {
    // Duplicate note → no write happens → zero productive acts on a
    // change-shaped task → the nudge machinery must still see a give-up.
    writeFileSync(join(ws, 'AGENTS.md'), `# AGENTS.md\n\n${LEARNED_HEADING}\n\n- ${NOTE}\n`)
    const model = scriptedModel([
      { tool: 'remember_convention', input: JSON.stringify({ note: NOTE }) },
      { text: 'nothing else to do' },
    ])
    const { events } = await run(model, { task: 'Fix the packaging bug in the installer config' })

    const done = events.find(e => e.type === 'done') as { incomplete?: boolean } | undefined
    expect(done?.incomplete).toBe(true)
    expect(events.some(e => e.type === 'text' && (e as { text?: string }).text?.includes('AUTO-CONTINUE'))).toBe(true)
  })
})

describe('scoped rules — the tool-result hook', () => {
  const seedPackage = (): void => {
    mkdirSync(join(ws, 'pkg', 'src'), { recursive: true })
    writeFileSync(join(ws, 'pkg', 'AGENTS.md'), 'PKG RULE: every export needs a doc comment.')
    writeFileSync(join(ws, 'pkg', 'src', 'a.ts'), 'export const a = 1\n')
    writeFileSync(join(ws, 'pkg', 'src', 'b.ts'), 'export const b = 2\n')
  }

  it('rides along on the first result under that directory, then never again', async () => {
    seedPackage()
    const model = scriptedModel([
      { tool: 'read', input: JSON.stringify({ path: 'pkg/src/a.ts' }) },
      { tool: 'read', input: JSON.stringify({ path: 'pkg/src/b.ts' }) },
      { text: 'read both' },
    ])
    const { events } = await run(model)

    const reads = toolDones(events, 'read')
    expect(reads).toHaveLength(2)
    expect(reads[0]!.output).toContain('[scoped rules — pkg/AGENTS.md')
    expect(reads[0]!.output).toContain('PKG RULE')
    expect(reads[0]!.output).toContain('export const a = 1') // the tool's own output is intact
    expect(reads[1]!.output).not.toContain('scoped rules')
  })

  it('is off when scopedRules:false', async () => {
    seedPackage()
    const model = scriptedModel([
      { tool: 'read', input: JSON.stringify({ path: 'pkg/src/a.ts' }) },
      { text: 'read it' },
    ])
    const { events } = await run(model, { scopedRules: false })
    expect(toolDones(events, 'read')[0]!.output).not.toContain('scoped rules')
  })

  it('says nothing for a file with no nested rules above it', async () => {
    writeFileSync(join(ws, 'AGENTS.md'), 'root rules — already in the prompt')
    writeFileSync(join(ws, 'top.ts'), 'export const t = 1\n')
    const model = scriptedModel([
      { tool: 'read', input: JSON.stringify({ path: 'top.ts' }) },
      { text: 'read it' },
    ])
    const { events } = await run(model)
    expect(toolDones(events, 'read')[0]!.output).not.toContain('scoped rules')
  })
})
