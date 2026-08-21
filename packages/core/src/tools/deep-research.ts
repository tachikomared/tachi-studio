// packages/core/src/tools/deep-research.ts
//
// Deep-research loop (STEAL 2026-06-21 #9, odysseus). An iterative
// Think→Search→Extract→Decide→Synthesize loop with an LLM stopping-oracle: the
// model emits SUFFICIENT or NEED_MORE:<gap>, and the gap drives the next search.
// PURE: search / fetch / ask are injected, so the loop, the oracle parsing, and
// the stopping behaviour unit-test with fakes — no network, no model. The
// electron side supplies real Brave search + egress-gated fetch + a model call.

export interface SearchHit { title: string; url: string; description: string }

export interface DeepResearchDeps {
  /** Web search → ranked hits. */
  search: (query: string) => Promise<SearchHit[]>
  /** Fetch a URL → readable text (already extracted/cleaned by the caller). */
  fetch: (url: string) => Promise<string>
  /** One model call: prompt in, text out. */
  ask: (prompt: string) => Promise<string>
}

export interface DeepResearchOptions {
  /** Max search→decide cycles before forcing synthesis (default 4). */
  maxIterations?: number
  /** Hits taken per search (default 3). */
  resultsPerSearch?: number
  /** Pages fetched per iteration (default 2). */
  fetchPerIteration?: number
  /** Chars kept per fetched page (default 2000). */
  excerptChars?: number
}

export interface ResearchFinding { query: string; url: string; title: string; excerpt: string }

export interface DeepResearchResult {
  synthesis: string
  findings: ResearchFinding[]
  iterations: number
  stoppedBecause: 'sufficient' | 'maxIterations'
}

/** Parse the stopping-oracle reply. NEED_MORE wins over SUFFICIENT (incomplete beats done). */
export function parseResearchVerdict(text: string): { done: boolean; gap: string | null } {
  const need = /\bNEED_MORE\b\s*:?\s*(.+)/is.exec(text)
  if (need) {
    const gap = need[1].split('\n')[0].trim()
    return { done: false, gap: gap || null }
  }
  if (/\bSUFFICIENT\b/i.test(text)) return { done: true, gap: null }
  return { done: false, gap: null }
}

function findingsBlock(findings: ResearchFinding[]): string {
  return findings.map((f, i) => `[${i + 1}] ${f.title} — ${f.url}\n${f.excerpt}`).join('\n\n') || '(nothing gathered yet)'
}

function verdictPrompt(question: string, findings: ResearchFinding[]): string {
  return `Research question: ${question}\n\nGathered so far:\n${findingsBlock(findings)}\n\n` +
    `Is this enough to answer the question well? Reply with exactly "SUFFICIENT" if yes, ` +
    `or "NEED_MORE: <the specific missing aspect to search next>" if not.`
}

function synthesisPrompt(question: string, findings: ResearchFinding[]): string {
  return `Research question: ${question}\n\nSources:\n${findingsBlock(findings)}\n\n` +
    `Write a thorough, well-organized answer grounded ONLY in these sources. Cite source numbers [n]. ` +
    `Note explicitly anything the sources do not cover.`
}

/**
 * Run the deep-research loop. Each iteration searches (with the current query),
 * fetches the top pages into findings, then asks the oracle whether to stop;
 * NEED_MORE:<gap> becomes the next query. Always ends with one synthesis call.
 */
export async function runDeepResearch(
  question: string,
  deps: DeepResearchDeps,
  opts: DeepResearchOptions = {},
): Promise<DeepResearchResult> {
  const maxIterations = Math.max(1, opts.maxIterations ?? 4)
  const resultsPerSearch = Math.max(1, opts.resultsPerSearch ?? 3)
  const fetchPerIteration = Math.max(1, opts.fetchPerIteration ?? 2)
  const excerptChars = Math.max(200, opts.excerptChars ?? 2000)

  const findings: ResearchFinding[] = []
  const seen = new Set<string>()
  let query = question
  let iterations = 0
  let stoppedBecause: 'sufficient' | 'maxIterations' = 'maxIterations'

  for (let i = 0; i < maxIterations; i++) {
    iterations = i + 1
    let hits: SearchHit[] = []
    try { hits = (await deps.search(query)).slice(0, resultsPerSearch) } catch { hits = [] }

    let fetched = 0
    for (const h of hits) {
      if (fetched >= fetchPerIteration) break
      if (seen.has(h.url)) continue
      seen.add(h.url)
      let body = ''
      try { body = await deps.fetch(h.url) } catch { continue }
      findings.push({ query, url: h.url, title: h.title, excerpt: body.slice(0, excerptChars) })
      fetched++
    }

    const verdict = parseResearchVerdict(await deps.ask(verdictPrompt(question, findings)))
    if (verdict.done) { stoppedBecause = 'sufficient'; break }
    query = verdict.gap || question
  }

  const synthesis = await deps.ask(synthesisPrompt(question, findings))
  return { synthesis, findings, iterations, stoppedBecause }
}
