// apps/desktop/test/unit/ggufHeader.test.ts
//
// Reading a model's own layer count instead of guessing it.
//
// Two constants used to decide every fit and offload answer this app gives:
// `layers = 32` in catalog/fit.ts and `NOMINAL_LAYERS = 40` in serve-profile.ts,
// whose own comment admitted it did not know. The first real file checked — the
// owner's gemma4 — reports 35, so both were wrong, each in a different
// direction, and nothing had ever compared them to a model.
//
// The parser's whole contract is: prove the hit or return nothing. These tests
// exercise the proving, because a byte-search that guessed would be worse than
// the constants it replaces.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))

import { readGgufHeader } from '../../electron/services/util/gguf-header'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gguf-')) })
afterEach(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* windows lock */ } })

// ── A minimal GGUF builder ───────────────────────────────────────────────────
// Layout: magic, version, tensor count, kv count, then key/value pairs where a
// key is <uint64 length><bytes> and a value is <uint32 type><payload>.

const T_UINT32 = 4
const T_STRING = 8

function kvU32(key: string, value: number): Buffer {
  const k = Buffer.from(key, 'utf8')
  const b = Buffer.alloc(8 + k.length + 4 + 4)
  b.writeBigUInt64LE(BigInt(k.length), 0)
  k.copy(b, 8)
  b.writeUInt32LE(T_UINT32, 8 + k.length)
  b.writeUInt32LE(value, 8 + k.length + 4)
  return b
}

function kvStr(key: string, value: string): Buffer {
  const k = Buffer.from(key, 'utf8')
  const v = Buffer.from(value, 'utf8')
  const b = Buffer.alloc(8 + k.length + 4 + 8 + v.length)
  b.writeBigUInt64LE(BigInt(k.length), 0)
  k.copy(b, 8)
  b.writeUInt32LE(T_STRING, 8 + k.length)
  b.writeBigUInt64LE(BigInt(v.length), 8 + k.length + 4)
  v.copy(b, 8 + k.length + 4 + 8)
  return b
}

function writeGguf(name: string, parts: Buffer[], magic = 'GGUF'): string {
  const head = Buffer.alloc(24)
  head.write(magic, 0, 'ascii')
  head.writeUInt32LE(3, 4)             // version
  head.writeBigUInt64LE(0n, 8)         // tensor count
  head.writeBigUInt64LE(BigInt(parts.length), 16)
  const p = join(dir, name)
  writeFileSync(p, Buffer.concat([head, ...parts]))
  return p
}

describe('it reads what the file states', () => {
  it('pulls the block count, context, heads and architecture', () => {
    const p = writeGguf('ok.gguf', [
      kvStr('general.architecture', 'gemma4'),
      kvU32('gemma4.block_count', 35),
      kvU32('gemma4.context_length', 131072),
      kvU32('gemma4.attention.head_count', 8),
      kvU32('gemma4.attention.head_count_kv', 1),
    ])
    expect(readGgufHeader(p)).toEqual({
      architecture: 'gemma4',
      blockCount: 35,
      contextLength: 131072,
      headCount: 8,
      headCountKv: 1,
    })
  })

  // ── THE DIMS THE KV RESERVATION IS SIZED FROM ──────────────────────────────
  //
  // Measured on the owner's file, 2026-08-03, raw bytes confirmed:
  //
  //   gemma4.embedding_length      1536
  //   gemma4.attention.head_count  8
  //   gemma4.attention.key_length  512
  //   gemma4.attention.value_length 512
  //
  // The usual relation — embedding_length / head_count — gives 192. The file
  // says 512. Sizing the cache by the quotient would have under-reserved by a
  // factor of 2.7 on the very first model checked, which is why `key_length`
  // wins whenever the file states one.
  it('reads the stated key/value dims, which need not be embd / heads', () => {
    const p = writeGguf('dims.gguf', [
      kvStr('general.architecture', 'gemma4'),
      kvU32('gemma4.embedding_length', 1536),
      kvU32('gemma4.attention.head_count', 8),
      kvU32('gemma4.attention.key_length', 512),
      kvU32('gemma4.attention.value_length', 512),
    ])
    const h = readGgufHeader(p)
    expect(h.embeddingLength).toBe(1536)
    expect(h.keyLength).toBe(512)
    expect(h.valueLength).toBe(512)
    // The quotient the fallback would have produced, for the record.
    expect(h.embeddingLength! / h.headCount!).toBe(192)
  })

  it('a model that states no key_length still gives the two facts the quotient needs', () => {
    const p = writeGguf('quot.gguf', [
      kvStr('general.architecture', 'llama'),
      kvU32('llama.embedding_length', 4096),
      kvU32('llama.attention.head_count', 32),
    ])
    const h = readGgufHeader(p)
    expect(h.keyLength).toBeUndefined()
    expect(h.embeddingLength).toBe(4096)
    expect(h.headCount).toBe(32)
  })

  it('works for any architecture prefix — the key is matched by suffix', () => {
    const p = writeGguf('q.gguf', [
      kvStr('general.architecture', 'qwen3moe'),
      kvU32('qwen3moe.block_count', 48),
    ])
    expect(readGgufHeader(p).blockCount).toBe(48)
  })
})

describe('it proves the hit, or reports nothing', () => {
  it('ignores the same text sitting INSIDE a value', () => {
    // The failure mode a naive byte-search has: a vocabulary or a description
    // that happens to contain the key text. A real key carries its own exact
    // length in the eight bytes before it; this one does not.
    const p = writeGguf('trap.gguf', [
      kvStr('general.architecture', 'llama'),
      kvStr('general.description', 'mentions llama.block_count in prose'),
    ])
    expect(readGgufHeader(p).blockCount).toBeUndefined()
  })

  it('refuses a count stored as something that is not a number', () => {
    const p = writeGguf('str.gguf', [kvStr('llama.block_count', '32')])
    expect(readGgufHeader(p).blockCount).toBeUndefined()
  })

  it('refuses an absurd count rather than planning from it', () => {
    const p = writeGguf('huge.gguf', [kvU32('llama.block_count', 4_000_000)])
    expect(readGgufHeader(p).blockCount).toBeUndefined()
  })

  it('a zero block count is not a block count', () => {
    const p = writeGguf('zero.gguf', [kvU32('llama.block_count', 0)])
    expect(readGgufHeader(p).blockCount).toBeUndefined()
  })
})

describe('it never throws, whatever it is pointed at', () => {
  it('a missing file', () => {
    expect(readGgufHeader(join(dir, 'nope.gguf'))).toEqual({})
  })

  it('a file that is not a GGUF', () => {
    const p = join(dir, 'notes.txt')
    writeFileSync(p, 'this is not a model')
    expect(readGgufHeader(p)).toEqual({})
  })

  it('a truncated header', () => {
    const p = join(dir, 'cut.gguf')
    writeFileSync(p, Buffer.from('GGUF'))
    expect(readGgufHeader(p)).toEqual({})
  })

  it('a directory path', () => {
    expect(readGgufHeader(dir)).toEqual({})
  })

  it('a GGUF with no metadata at all — empty, not an error', () => {
    expect(readGgufHeader(writeGguf('bare.gguf', []))).toEqual({})
  })
})
