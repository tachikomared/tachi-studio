// apps/desktop/test/unit/sidecarSpend.test.ts
//
// Sidecar spend accounting — closes the security-audit gap "sidecar spend
// unrecorded". The OpenClaude (HTTP/NDJSON) sidecar records ONE usage event per
// completed query into the cost ledger, with the token totals the SDK's
// terminal `result` message reports. The character estimate (@tachi/core's
// estimateTokens) survives only as the fallback for a gateway that reports
// nothing. The Goose half of this suite went away with the Goose harness.
//
// STILL OPEN: the PROVIDER on that record is the harness's own name. See
// costLedger.test.ts ("COSTS THE CAP AN INVENTED $5") for what that costs and
// why the fix does not live in this file.
//
// These tests exercise the estimate+record path directly via the exported
// recorders, mocking getCostLedger so the assertion is on what record() is
// called with — never touching electron or the real on-disk ledger.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the electron-coupled ledger module BEFORE importing the clients, so the
// clients' `import { getCostLedger } from './cost-ledger'` resolves to the mock
// (and the real module's lazy `require('electron')` is never hit).
const record = vi.fn()
vi.mock('../../electron/services/cost-ledger', () => ({
  getCostLedger: () => ({ record }),
}))

import { recordSpend, parseReportedUsage, stripHostPreamble } from '../../electron/services/openclaude-client'
import { estimateTokens, classifyTask, PROVIDER_LIST } from '@tachi/core'

beforeEach(() => { record.mockReset() })

describe('OpenClaude recordSpend', () => {
  it('records one event with plausible (>0) estimated token counts when nothing was reported', () => {
    const prompt = 'Summarize the architecture of this repository in detail.'
    const response = 'The repository is a pnpm monorepo with a desktop Electron app and a core package. '.repeat(5)

    recordSpend('bankr-gateway', 'claude-sonnet-4.6', prompt, response)

    expect(record).toHaveBeenCalledTimes(1)
    const [provider, model, promptTokens, completionTokens] = record.mock.calls[0]!
    expect(provider).toBe('bankr-gateway')
    expect(model).toBe('claude-sonnet-4.6')
    expect(promptTokens).toBeGreaterThan(0)
    expect(completionTokens).toBeGreaterThan(0)
    // Longer response than prompt ⇒ more completion tokens than prompt tokens.
    expect(completionTokens).toBeGreaterThan(promptTokens)
    // Estimates match the core estimator exactly (deterministic heuristic).
    expect(promptTokens).toBe(estimateTokens(prompt))
    expect(completionTokens).toBe(estimateTokens(response))
  })

  it('falls back to a best-effort model label when the model id is unknown', () => {
    recordSpend('openclaude', 'openclaude', 'hello there', 'general kenobi')
    expect(record).toHaveBeenCalledTimes(1)
    expect(record.mock.calls[0]![1]).toBe('openclaude')
  })

  it('never throws when the ledger record() fails (resilient by design)', () => {
    record.mockImplementationOnce(() => { throw new Error('ledger boom') })
    expect(() => recordSpend('openclaude', 'm', 'p', 'r')).not.toThrow()
  })

  // ── Reported counts beat the estimate ─────────────────────────────────────
  //
  // The estimate was a guess made from character length in a place where the
  // real number is on the wire. It is spend the 30-day cap is governed by, so
  // the reported total wins whenever there is one.
  it('prefers the reported totals over the character estimate', () => {
    const prompt = 'x'.repeat(10_000)   // an estimate nowhere near 120
    recordSpend('bankr-gateway', 'claude-sonnet-4.6', prompt, 'short', {
      promptTokens: 120, completionTokens: 34,
    })
    const [, , promptTokens, completionTokens] = record.mock.calls[0]!
    expect(promptTokens).toBe(120)
    expect(completionTokens).toBe(34)
    expect(promptTokens).not.toBe(estimateTokens(prompt))
  })

  it('passes the reported cache hits through so the ledger can discount them', () => {
    recordSpend('bankr-gateway', 'claude-sonnet-4.6', 'p', 'r', {
      promptTokens: 1000, completionTokens: 10, cachedTokens: 900,
    })
    // record(provider, model, prompt, completion, taskType, cachedTokens)
    expect(record.mock.calls[0]![5]).toBe(900)
  })

  // recordSpend itself is provider-agnostic and ALREADY correct: it records
  // whatever identity the caller resolved. The open gap is the caller — the
  // /query path can only name the harness, because the gateway is chosen in
  // sidecar-manager at spawn time. This pins the shape the fix needs: hand it a
  // registry id and the ledger can see a free run as free.
  it('records whatever provider the caller resolved, registry ids included', () => {
    recordSpend('freellmapi-local', 'auto', 'p', 'r', { promptTokens: 4_000_000, completionTokens: 2_000_000 })
    const provider = record.mock.calls[0]![0]
    expect(provider).toBe('freellmapi-local')
    expect(PROVIDER_LIST.map(p => p.id)).toContain(provider)
  })
})

// ── The task-type dimension ─────────────────────────────────────────────────
//
// The ledger's "by task type" view answers "what am I spending tokens ON". The
// chat path fills it (chat-service: classifyTask(messageText(message)) → the 5th
// argument of record); this call site passed a hardcoded `undefined`, and the
// ledger buckets a taskType-less event under 'other' — so every OpenClaude
// sidecar run in that view was 'other', and the harness was invisible in the
// one dimension the view exists for.
describe('OpenClaude recordSpend — task category', () => {
  it('classifies the task and records it in the 5th argument', () => {
    recordSpend('opengateway', 'glm-4.7', 'Fix the crash in the NDJSON parser', 'done')
    // record(provider, model, prompt, completion, taskType, cachedTokens)
    expect(record.mock.calls[0]![4]).toBe('debugging')
  })

  it('agrees with the chat path, which is the point of sharing the classifier', () => {
    const task = 'Write a test for the streaming client'
    recordSpend('opengateway', 'glm-4.7', task, 'ok')
    expect(record.mock.calls[0]![4]).toBe(classifyTask(task))
  })

  // THE PART THAT IS NOT COSMETIC. agent.ipc.ts hands this client
  // `effectiveTask`, not the user's message: on the first turn of a session it
  // prepends up to 6000 characters of recalled prior-session notes, plus
  // <reflexion> / <role> blocks and a slash-command instruction. classifyTask
  // scans only the first 2000 characters, so classifying the raw string tags the
  // run by the RECALLED NOTES — a category derived from text the user never
  // wrote, which is worse than the 'other' it replaces because it looks earned.
  it('classifies the user\'s words, not the workspace memory prepended to them', () => {
    const notes = 'Prior session note: the vitest suite covers the parser.\n'.repeat(60)
    expect(notes.length).toBeGreaterThan(2000)  // …so it fills the whole scan window
    const effectiveTask =
      `<workspace-memory>\nNotes from your PRIOR sessions in this workspace.\n\n${notes}\n</workspace-memory>\n\n` +
      'Add an export button to the toolbar'

    // The defect, stated as a fact about the input rather than an opinion.
    expect(classifyTask(effectiveTask)).toBe('testing')

    recordSpend('opengateway', 'glm-4.7', effectiveTask, 'ok')
    expect(record.mock.calls[0]![4]).toBe('feature')
  })

  it('still bills the FULL text — stripping is for the category, never the count', () => {
    const effectiveTask = `<role>\nYou are acting as the "Reviewer" role: review code.\n</role>\n\n${'x'.repeat(4000)}`
    recordSpend('opengateway', 'glm-4.7', effectiveTask, 'ok')
    // The preamble is real input, really sent, really paid for.
    expect(record.mock.calls[0]![2]).toBe(estimateTokens(effectiveTask))
  })
})

describe('stripHostPreamble', () => {
  // The shapes are agent.ipc.ts's, copied from the composition sites
  // (<workspace-memory> / <reflexion> / <role> / buildSlashCommandInstruction).
  it('removes each wrapper the host prepends, and the stack of all of them', () => {
    expect(stripHostPreamble('<workspace-memory>\nnotes\n</workspace-memory>\n\nthe task')).toBe('the task')
    expect(stripHostPreamble('<reflexion>\nlessons\n</reflexion>\n\nthe task')).toBe('the task')
    expect(stripHostPreamble('<role>\nYou are acting as the "Reviewer" role.\n</role>\n\nthe task')).toBe('the task')
    expect(stripHostPreamble(
      '[SLASH COMMAND: /plan]\nThe user invoked /plan. Your first response MUST be a plan block.\n\n' +
      '<role>\nrole text\n</role>\n\n' +
      '<reflexion>\nlessons\n</reflexion>\n\n' +
      '<workspace-memory>\nnotes\n</workspace-memory>\n\n' +
      'the task',
    )).toBe('the task')
  })

  it('leaves an ordinary task exactly as it was', () => {
    // No wrapper recognised ⇒ no guessing. Angle brackets in a real task (a
    // pasted diff, an HTML question) must not be mistaken for a host block.
    const plain = 'Rename <Button> to <ActionButton> across the renderer'
    expect(stripHostPreamble(plain)).toBe(plain)
    expect(stripHostPreamble('')).toBe('')
  })

  it('strips only the LEADING wrappers — a tag inside the task is the task', () => {
    const t = 'Explain what <workspace-memory> is for</workspace-memory>'
    expect(stripHostPreamble(t)).toBe(t)
  })
})

// ── The SDK's usage object → the ledger's contract ──────────────────────────
//
// `input_tokens` in the SDK's Anthropic-shaped usage is the FRESH slice only
// (buildAnthropicUsageFromRawUsage subtracts cache reads); the ledger wants
// TOTAL input with cachedTokens as a SUBSET of it. Getting this backwards
// under-counts input by the whole cached slice.
describe('parseReportedUsage', () => {
  it('sums fresh + cache-creation + cache-read into promptTokens, and reports the read slice', () => {
    expect(parseReportedUsage({
      input_tokens: 100,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 900,
      output_tokens: 42,
    })).toEqual({ promptTokens: 1050, completionTokens: 42, cachedTokens: 900 })
  })

  it('omits cachedTokens entirely when the provider reported no cache hits', () => {
    expect(parseReportedUsage({ input_tokens: 10, output_tokens: 5 }))
      .toEqual({ promptTokens: 10, completionTokens: 5 })
  })

  it('returns undefined for missing / empty / all-zero usage so the estimate is used instead', () => {
    expect(parseReportedUsage(undefined)).toBeUndefined()
    expect(parseReportedUsage({})).toBeUndefined()
    expect(parseReportedUsage({ input_tokens: 0, output_tokens: 0 })).toBeUndefined()
  })

  it('ignores negative / non-finite junk rather than propagating it into spend', () => {
    expect(parseReportedUsage({ input_tokens: -5, output_tokens: 7 }))
      .toEqual({ promptTokens: 0, completionTokens: 7 })
    expect(parseReportedUsage({ input_tokens: Number.NaN, output_tokens: Number.POSITIVE_INFINITY }))
      .toBeUndefined()
  })
})
