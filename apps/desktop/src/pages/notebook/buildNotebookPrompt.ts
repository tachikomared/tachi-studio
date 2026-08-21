// apps/desktop/src/pages/notebook/buildNotebookPrompt.ts
//
// Notebook surface v1 (STEAL 2026-06-21 #7, open-notebook). CAG, not vector RAG:
// the user's text sources are stuffed directly into one grounded prompt and sent
// through the existing chat (which already has long-context + prompt caching).
// Pure + dependency-free so the assembly is unit-tested on its own.

export interface NotebookSource {
  title: string
  text: string
}

/**
 * Assemble a single grounded prompt from the user's sources + their question.
 * Empty/whitespace-only sources are dropped. The instruction forces the model to
 * answer ONLY from the sources (and to say when they don't cover the question),
 * which is the whole point of a notebook over a free chat.
 */
export function buildNotebookPrompt(sources: NotebookSource[], question: string): string {
  const usable = sources.filter((s) => s.text.trim().length > 0)
  const blocks = usable.map(
    (s, i) => `=== SOURCE ${i + 1}: ${s.title.trim() || `Untitled ${i + 1}`} ===\n${s.text.trim()}`,
  )
  const header =
    'You are answering using ONLY the sources below. Do not use outside knowledge. ' +
    'If the answer is not in the sources, say so plainly. Cite the source title(s) you used.'
  const body = blocks.length > 0 ? blocks.join('\n\n') : '(no sources were provided)'
  return `${header}\n\n${body}\n\nQUESTION: ${question.trim()}`
}
