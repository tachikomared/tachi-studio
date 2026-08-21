// apps/desktop/test/unit/codexCardWiring.test.ts
//
// SOURCE ASSERTIONS for the halves of the codex vertical that cannot be driven
// in this repo's node-only test setup: the ToolCallBlock router, the progress
// prop threaded from the transcript down into the cards, and the i18n keys the
// review card renders. Same convention as turnResetWiring.test.ts — the pure
// logic is unit-tested for real in codexProgress / pairToolEvents /
// codexReviewCard specs; this file guards the WIRING between them, which is
// otherwise only ever verified by clicking.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const APP  = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(APP, rel), 'utf8')
const AGENT = 'src/pages/agent'

describe('ToolCallBlock: the codex router', () => {
  const src = () => read(`${AGENT}/ToolCallBlock.tsx`)

  it('sends codex_review to its own card and codex_worker to the worker card', () => {
    const s = src()
    expect(s).toContain("import { CodexReviewCard, isCodexReviewTool, parseCodexReviewArgs } from './CodexReviewCard'")
    expect(s).toContain('isCodexReviewTool(props.name) ? parseCodexReviewArgs(props.input) : null')
    expect(s).toContain('<CodexReviewCard')
    expect(s).toContain('<CodexWorkerCard')
  })

  it('keeps BOTH cards behind the error boundary and the parse guard', () => {
    const s = src()
    // Two boundary wrappers — one per card — and the generic block is still the
    // fallback for a shape neither parser recognises.
    expect(s.match(/<CodexCardBoundary fallback=\{generic\}>/g) ?? []).toHaveLength(2)
    expect(s.trimEnd().includes('return generic')).toBe(true)
  })

  it('threads the routed progress lines into both cards', () => {
    const s = src()
    expect(s).toContain('progress?: string[]')
    expect(s.match(/progress=\{props\.progress\}/g) ?? []).toHaveLength(2)
  })
})

describe('AgentPage: the transform moved out, and progress is threaded through', () => {
  const page = () => read(`${AGENT}/AgentPage.tsx`)

  it('imports the pure transform instead of carrying its own copy', () => {
    const s = page()
    expect(s).toContain("import { pairToolEvents, type AgentMessageItem } from './pairToolEvents'")
    expect(s).toContain("export type { ToolBlock } from './pairToolEvents'")
    // The old in-file definition is gone (one call site, no declaration).
    expect(s).not.toContain('function pairToolEvents(')
  })

  it('hands each tool block its progress buffer', () => {
    expect(page()).toContain('progress={block.progress}')
  })

  it('still renders grouped tools through ToolGroupSummary, progress included', () => {
    expect(read(`${AGENT}/ToolGroupSummary.tsx`)).toContain('progress={tool.progress}')
    expect(read(`${AGENT}/ToolGroupSummary.tsx`)).toContain("import type { ToolBlock } from './pairToolEvents'")
  })
})

describe('The cards render the progress strip and end in a terminal state', () => {
  it('the worker card mounts the strip under the shouldShowProgress rule', () => {
    const s = read(`${AGENT}/CodexWorkerCard.tsx`)
    expect(s).toContain('const showProgress = shouldShowProgress({')
    expect(s).toContain('<CodexProgressStrip lines={progress ?? []} running={running} />')
    // hasResultDetail is what retires the strip once the answer lands.
    expect(s).toContain('hasResultDetail: segments.length > 0 || result.steps.length > 0 || !!result.error')
  })

  it('the review card mounts the same shared strip (not a fork)', () => {
    const s = read(`${AGENT}/CodexReviewCard.tsx`)
    expect(s).toContain('<CodexProgressStrip lines={progress ?? []} running={running} />')
    expect(s).toContain("} from './CodexWorkerCard'")
    expect(s).toContain('parseCodexResult')
    expect(s).toContain('segmentCodexOutput')
    expect(s).toContain('extractCodexFiles')
  })

  it('loop.ts still emits the prefix the router keys on', () => {
    // If this line ever changes shape, progress silently stops landing in the
    // card — so the renderer's contract with the emitter is asserted here.
    const loop = read('electron/services/tachi/loop.ts')
    expect(loop).toContain("{ type: 'text', text: `[codex] ${line}\\n` }")
    expect(read(`${AGENT}/codexProgress.ts`)).toContain("export const CODEX_PROGRESS_PREFIX = '[codex] '")
  })

  it('codex_review still ships the args shape the card parses', () => {
    const loop = read('electron/services/tachi/loop.ts')
    expect(loop).toContain("tools['codex_review'] = tool({")
    expect(loop).toContain('summary: z.string()')
    expect(loop).toContain('files: z.array(z.string()).optional()')
    expect(loop).toContain('focus: z.string().optional()')
  })
})

describe('i18n: the review card copy ships in every locale', () => {
  const LANGS = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const
  const REVIEW_KEYS = [
    'review', 'claim', 'focus', 'filesRequested', 'findingsCount',
    'holds', 'holdsTitle', 'reviewed', 'notes', 'runningTitle', 'runningPlaceholder',
  ]

  for (const lang of LANGS) {
    it(`${lang}/agent.json carries codexReview + the progress labels`, () => {
      const ns = JSON.parse(read(`src/i18n/locales/${lang}/agent.json`)) as Record<string, Record<string, string>>
      for (const k of REVIEW_KEYS) {
        expect(ns.codexReview?.[k], `${lang} codexReview.${k}`).toBeTruthy()
      }
      expect(ns.codexCard?.progress, `${lang} codexCard.progress`).toBeTruthy()
      expect(ns.codexCard?.progressEarlier, `${lang} codexCard.progressEarlier`).toContain('{{count}}')
      expect(ns.codexReview.findingsCount).toContain('{{count}}')
    })
  }
})
