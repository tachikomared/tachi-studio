// apps/desktop/electron/services/memory-facts-store.ts
//
// Persistence for the structured memory fact store (USER-PAINS T16) — the PURE
// half: no electron, no settings-store, nothing that touches app.getPath at
// module load. vitest imports THIS file and drives the class against a temp
// file; the Electron-coupled singleton lives in memory-facts-service.ts.
//
// Facts live in userData/memory-facts.json as a flat array:
//   [{ id, text, source: 'user'|'auto', createdAt, enabled }]
//
// MIGRATION (v1, once, non-destructive): the FIRST time this file is needed and
// does not exist, the legacy free-form `userMemory` blob from tachi-settings.json
// is split line-by-line into facts (source='user'). The original blob is NOT
// deleted — it stays in settings as the backup key. Migration is idempotent:
// once the facts file exists we never re-migrate, so a user-deleted migrated
// fact is not resurrected.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from 'fs'
import { dirname } from 'path'
import {
  migrateBlobToFacts,
  joinEnabledFacts,
  type MemoryFact,
} from '@tachi/core'

export type { MemoryFact } from '@tachi/core'

// ── Validation helper ─────────────────────────────────────────────────────────

/** Narrow an unknown parsed row to a MemoryFact, or null if malformed. */
function asFact(v: unknown): MemoryFact | null {
  if (v === null || typeof v !== 'object') return null
  const o = v as Partial<MemoryFact>
  if (typeof o.id !== 'string' || typeof o.text !== 'string') return null
  return {
    id: o.id,
    text: o.text,
    source: o.source === 'auto' ? 'auto' : 'user',
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : new Date(0).toISOString(),
    enabled: o.enabled !== false, // default-enabled unless explicitly false
  }
}

function defaultIdGen(): string {
  return `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`
}

// ── Store ─────────────────────────────────────────────────────────────────────

export class MemoryFactsStore {
  constructor(
    private filePath: string,
    /** Provider for the legacy blob, read once on first migration. */
    private getBlob: () => string = () => '',
    private now: () => string = () => new Date().toISOString(),
    private idGen: () => string = defaultIdGen,
  ) {}

  /**
   * Migrate the legacy blob into facts exactly once. Guarded by file existence,
   * so it runs on the first access and never again — even an empty blob writes
   * an empty array file, which permanently marks migration done.
   */
  private ensureMigrated(): void {
    if (existsSync(this.filePath)) return
    const facts = migrateBlobToFacts(this.getBlob(), { now: this.now, idGen: this.idGen })
    this.writeAll(facts)
  }

  private readAll(): MemoryFact[] {
    this.ensureMigrated()
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown
      if (!Array.isArray(raw)) return []
      return raw.map(asFact).filter((f): f is MemoryFact => f !== null)
    } catch {
      return []
    }
  }

  private writeAll(facts: MemoryFact[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = this.filePath + '.tmp'
    writeFileSync(tmp, JSON.stringify(facts, null, 2), 'utf8')
    renameSync(tmp, this.filePath)
  }

  /** All facts, in stored order. */
  list(): MemoryFact[] {
    return this.readAll()
  }

  /** Append a new (enabled) fact. Empty/blank text is rejected (returns null). */
  add(text: string, source: 'user' | 'auto' = 'user'): MemoryFact | null {
    const clean = (text ?? '').trim()
    if (!clean) return null
    const facts = this.readAll()
    const fact: MemoryFact = {
      id: this.idGen(),
      text: clean,
      source,
      createdAt: this.now(),
      enabled: true,
    }
    facts.push(fact)
    this.writeAll(facts)
    return fact
  }

  /** Replace a fact's text. Returns the updated fact, or null if id/text invalid. */
  edit(id: string, text: string): MemoryFact | null {
    const clean = (text ?? '').trim()
    if (!clean) return null
    const facts = this.readAll()
    const idx = facts.findIndex(f => f.id === id)
    if (idx < 0) return null
    facts[idx] = { ...facts[idx]!, text: clean }
    this.writeAll(facts)
    return facts[idx]!
  }

  /** Remove a fact. Returns true when a row was removed. */
  delete(id: string): boolean {
    const facts = this.readAll()
    const next = facts.filter(f => f.id !== id)
    if (next.length === facts.length) return false
    this.writeAll(next)
    return true
  }

  /** Enable / disable a fact (soft toggle — injection skips disabled facts). */
  toggle(id: string, enabled: boolean): MemoryFact | null {
    const facts = this.readAll()
    const idx = facts.findIndex(f => f.id === id)
    if (idx < 0) return null
    facts[idx] = { ...facts[idx]!, enabled }
    this.writeAll(facts)
    return facts[idx]!
  }

  /** The exact text injected into chat (enabled facts, joined by newline). */
  injection(): string {
    return joinEnabledFacts(this.readAll())
  }
}

// ── Fail-soft injection seam ──────────────────────────────────────────────────

/**
 * The ONLY way chat-service is allowed to read injected memory.
 *
 * Memory injection is an ENHANCEMENT, never a precondition for sending. It sits
 * before every provider branch in sendChatMessage(), so anything that throws
 * here kills the entire send — which is exactly what happened in every packaged
 * build (P0 2026-07-25): the store's lazy relative require of settings-store did
 * not resolve inside app.asar, the IPC layer swallowed the rejection, and chat
 * was silently dead. A failure now degrades to "no injected memory" plus one
 * console.error, and the send continues.
 *
 * Returns the trimmed injection text, or '' on any failure.
 */
export function safeInjection(getStore: () => { injection(): string }): string {
  try {
    return getStore().injection().trim()
  } catch (err) {
    console.error('[memory-facts] injection failed — sending without user memory:', err)
    return ''
  }
}
