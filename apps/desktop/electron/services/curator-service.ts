// apps/desktop/electron/services/curator-service.ts
//
// One-shot LLM call that compresses a JSONL run-trace into a playbook.md.
//
// Priority:
//   1. Bankr gateway (claude-sonnet-4.6) if a bankr-gateway key exists
//   2. Local Ollama at http://localhost:11434 with model aya-expanse:8b
//   3. Return null (caller logs + skips silently)

import { retrieveKey } from './keychain'
import type { Block } from './playbook-service'

const BANKR_BASE_URL  = 'https://llm.bankr.bot/v1'
const BANKR_MODEL     = 'claude-sonnet-4.6'
const OLLAMA_BASE_URL = 'http://localhost:11434'
const OLLAMA_MODEL    = 'aya-expanse:8b'
const MAX_TOKENS      = 600   // slight headroom above 500

const SYSTEM_PROMPT = `You compress agent run traces into concise playbooks. Given the JSONL trace below, output a markdown playbook with these sections: ## Goal, ## Approach, ## Gotchas, ## What Worked. Max 500 tokens, no preamble, plain markdown.`

// ─── Bankr (OpenAI-compatible) ────────────────────────────────────────────────

async function curateViaBankr(jsonl: string): Promise<string | null> {
  const key = retrieveKey('bankr-gateway')
  if (!key) return null

  const res = await fetch(`${BANKR_BASE_URL}/chat/completions`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model:      BANKR_MODEL,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: jsonl },
      ],
    }),
    signal: AbortSignal.timeout(60_000) as AbortSignal,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Bankr curator HTTP ${res.status}: ${text.slice(0, 200)}`)
  }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>
  }
  return data.choices?.[0]?.message?.content ?? null
}

// ─── Ollama ───────────────────────────────────────────────────────────────────

async function isOllamaRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(2_000) as AbortSignal,
    })
    return res.ok
  } catch {
    return false
  }
}

async function curateViaOllama(jsonl: string): Promise<string | null> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:  OLLAMA_MODEL,
      stream: false,
      options: { num_predict: MAX_TOKENS },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: jsonl },
      ],
    }),
    signal: AbortSignal.timeout(120_000) as AbortSignal,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Ollama curator HTTP ${res.status}: ${text.slice(0, 200)}`)
  }

  const data = await res.json() as {
    message?: { content?: string }
  }
  return data.message?.content ?? null
}

// ─── Markdown → Block[] converter ─────────────────────────────────────────────

/**
 * Convert a markdown string (from the curator LLM) into a structured Block[].
 * Handles ## headings, # headings, ``` code fences, - bullet lines, and plain text.
 * Falls back to a single `text` block on unexpected input.
 *
 * Exported so playbook-service can use it for emitSummary.
 */
export function markdownToBlocks(markdown: string): Block[] {
  try {
    const lines = markdown.split('\n')
    const blocks: Block[] = []
    let inCodeFence = false
    let codeLang: string | undefined
    let codeLines: string[] = []

    for (const raw of lines) {
      const line = raw.trimEnd()

      // Code fence open/close
      if (line.startsWith('```')) {
        if (!inCodeFence) {
          inCodeFence = true
          codeLang = line.slice(3).trim() || undefined
          codeLines = []
        } else {
          blocks.push({ type: 'code', lang: codeLang, text: codeLines.join('\n') })
          inCodeFence = false
          codeLines = []
          codeLang = undefined
        }
        continue
      }
      if (inCodeFence) {
        codeLines.push(raw)
        continue
      }

      // Heading level 1
      if (/^# /.test(line)) {
        blocks.push({ type: 'heading', level: 1, text: line.slice(2).trim() })
        continue
      }
      // Heading level 2
      if (/^## /.test(line)) {
        blocks.push({ type: 'heading', level: 2, text: line.slice(3).trim() })
        continue
      }
      // Bullet (- or *)
      if (/^[-*] /.test(line)) {
        blocks.push({ type: 'bullet', text: line.slice(2).trim() })
        continue
      }
      // Blank line — skip
      if (!line.trim()) continue
      // Plain text
      blocks.push({ type: 'text', text: line.trim() })
    }

    // Unclosed code fence — flush as code block
    if (inCodeFence && codeLines.length > 0) {
      blocks.push({ type: 'code', lang: codeLang, text: codeLines.join('\n') })
    }

    // Always ensure at least one block
    if (blocks.length === 0) {
      blocks.push({ type: 'text', text: markdown.trim() })
    }

    return blocks
  } catch {
    return [{ type: 'text', text: markdown }]
  }
}

/**
 * No-LLM FALLBACK playbook: build a minimal markdown summary straight from the
 * JSONL run trace, used when no curator LLM is available (curate() -> null) so
 * cross-session memory still works (loadPlaybook reads this back next session).
 * Pure: parses turns, extracts the goal (first user turn), tools used (counted),
 * and a few decision-ish assistant lines. Returns '' when there's nothing useful.
 */
export function fallbackPlaybook(jsonl: string): string {
  const turns = jsonl.split('\n').flatMap(line => {
    const t = line.trim()
    if (!t) return []
    try { return [JSON.parse(t) as { role?: string; content?: string; name?: string }] }
    catch { return [] }
  })
  if (turns.length === 0) return ''

  const firstUser = turns.find(t => t.role === 'user')
  const goal = (firstUser?.content ?? '').trim().replace(/\s+/g, ' ').slice(0, 300)

  const toolCounts = new Map<string, number>()
  for (const t of turns) {
    if (t.role === 'tool-call' && t.name) toolCounts.set(t.name, (toolCounts.get(t.name) ?? 0) + 1)
  }

  const decisionRe = /\b(decided|chose|choosing|will use|going with|switched to)\b/i
  const decisions = turns
    .filter(t => t.role === 'assistant' && typeof t.content === 'string' && decisionRe.test(t.content))
    .map(t => (t.content ?? '').trim().replace(/\s+/g, ' ').slice(0, 160))
    .filter(Boolean)
    .slice(0, 4)

  const lines: string[] = []
  if (goal) lines.push('## Goal', goal, '')
  if (toolCounts.size > 0) {
    lines.push('## Tools used')
    for (const [name, n] of [...toolCounts.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${name}${n > 1 ? ` (x${n})` : ''}`)
    }
    lines.push('')
  }
  if (decisions.length > 0) {
    lines.push('## Notes')
    for (const d of decisions) lines.push(`- ${d}`)
    lines.push('')
  }
  // Only meaningful with at least a goal or some tool activity.
  return (goal || toolCounts.size > 0) ? lines.join('\n').trim() : ''
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compress a JSONL run trace into a playbook markdown string.
 * Returns null if no LLM backend is available (non-fatal).
 */
export async function curate(jsonl: string): Promise<string | null> {
  // 1. Try Bankr
  try {
    const bankrKey = retrieveKey('bankr-gateway')
    if (bankrKey) {
      const result = await curateViaBankr(jsonl)
      if (result) return result
    }
  } catch (err) {
    console.warn('[curator] Bankr failed, falling back to Ollama:', err)
  }

  // 2. Try Ollama
  try {
    if (await isOllamaRunning()) {
      const result = await curateViaOllama(jsonl)
      if (result) return result
    }
  } catch (err) {
    console.warn('[curator] Ollama failed:', err)
  }

  // 3. No backend available
  console.warn('[curator] no LLM backend available for curation (Bankr key absent, Ollama not running)')
  return null
}
