// apps/desktop/electron/services/util/gguf-header.ts
//
// READ THE MODEL'S OWN NUMBERS INSTEAD OF GUESSING THEM.
//
// Two constants decide every "will it fit" and "how many layers" answer this
// app gives, and both are invented:
//
//   packages/core/src/catalog/fit.ts:16-20   layers = 32   ("Default 32")
//   packages/core/src/tachi/serve-profile.ts NOMINAL_LAYERS = 40, whose own
//                                            comment admits "we don't know the
//                                            exact layer count here"
//
// A GGUF file states its layer count in its header. Nothing was reading it, so
// a 3B model with 26 blocks and a 70B with 80 were both planned as if they had
// 32 (or 40, depending which code path asked), and a user-installed HF download
// had nothing but a file size to go on.
//
// ── WHY A KEY SEARCH AND NOT A FULL PARSE ───────────────────────────────────
// GGUF is: magic, version, tensor count, KV count, then the KV pairs. Walking
// the pairs in order is the "correct" way and it is the wrong way here: the
// tokenizer arrays (vocab, merges, token types) sit among them and run to tens
// of megabytes, so an in-order walk either reads the whole lot or stops before
// reaching a key that happens to sit after them.
//
// So this searches a BOUNDED window for the key bytes and then proves the hit
// by reading backwards: a GGUF key is stored as a uint64 length followed by the
// bytes, so a genuine key has its own exact length in the eight bytes before
// it. A coincidental occurrence of the same text inside a vocabulary blob will
// not. After that the value type tag must be one we expect and the number must
// be in a sane range. Any doubt at any step returns undefined, and undefined
// means the callers keep the behaviour they have today — this can improve a
// plan, never break one.

import { openSync, readSync, closeSync } from 'fs'

/** How much of the file to look at. Large enough that the architecture block
 *  is comfortably inside it on every model we have seen, small enough that the
 *  read is imperceptible next to loading the model itself. */
const WINDOW_BYTES = 1024 * 1024

const MAGIC = 0x46554747 // 'GGUF' little-endian

/** GGUF metadata value types we accept for a count. */
const T_UINT32 = 4
const T_INT32  = 5
const T_UINT64 = 10
const T_INT64  = 11

export interface GgufHeaderFacts {
  /** Transformer blocks — the real `--n-gpu-layers` denominator. */
  blockCount?: number
  /** Training context length the file declares. */
  contextLength?: number
  /** Attention heads, and the KV heads that size the cache. */
  headCount?: number
  headCountKv?: number
  /** Model width. With headCount it gives the per-head dimension. */
  embeddingLength?: number
  /**
   * Per-head KEY and VALUE dimensions, when the file states them outright.
   *
   * Most files do not, and `embedding_length / head_count` is the standard
   * fallback — but it is only a fallback. DeepSeek's MLA and a few others carry
   * key and value dims that differ from each other AND from that quotient, so a
   * cache sized by the quotient alone would be wrong for exactly the models
   * whose caches are unusual. When the file says, we believe the file.
   */
  keyLength?: number
  valueLength?: number
  /** Architecture string (`llama`, `qwen3`, `gemma3`…), when readable. */
  architecture?: string
}

/**
 * Find `needle` in `buf`, then prove it is a GGUF KEY rather than a byte
 * sequence that happens to appear inside a value: the eight bytes before a key
 * hold its length as a little-endian uint64, and for a real key that number
 * equals the key's own length.
 *
 * Returns the offset just past the key (where the value type tag begins), or
 * -1. Keys are matched on their SUFFIX (`.block_count`) because the prefix is
 * the architecture name and differs per model family.
 */
function findKeyEnd(buf: Buffer, suffix: string): number {
  const needle = Buffer.from(suffix, 'utf8')
  let from = 0
  for (;;) {
    const at = buf.indexOf(needle, from)
    if (at < 0) return -1
    from = at + 1
    const keyEnd = at + needle.length
    // Walk backwards over the architecture prefix to every plausible key start,
    // and accept the one whose declared length matches exactly.
    for (let start = at; start >= 8 && at - start <= 64; start--) {
      const declared = buf.readBigUInt64LE(start - 8)
      if (declared === BigInt(keyEnd - start)) return keyEnd
      // A key cannot contain a NUL; stop walking back through one.
      if (start > 0 && buf[start - 1] === 0x00 && at - start > 0) break
    }
  }
}

/** Read a count at `off`, where `off` points at the value TYPE tag. */
function readCount(buf: Buffer, off: number): number | undefined {
  if (off < 0 || off + 4 > buf.length) return undefined
  const type = buf.readUInt32LE(off)
  const v = off + 4
  let n: number
  switch (type) {
    case T_UINT32: if (v + 4 > buf.length) return undefined; n = buf.readUInt32LE(v); break
    case T_INT32:  if (v + 4 > buf.length) return undefined; n = buf.readInt32LE(v);  break
    case T_UINT64: if (v + 8 > buf.length) return undefined; n = Number(buf.readBigUInt64LE(v)); break
    case T_INT64:  if (v + 8 > buf.length) return undefined; n = Number(buf.readBigInt64LE(v));  break
    default: return undefined   // a count stored as a string/array/bool is not a count we understand
  }
  // Range check: these are architecture counts, not file offsets. A number
  // outside this is a misread, and a misread must not become a plan.
  if (!Number.isFinite(n) || n <= 0 || n > 100_000_000) return undefined
  return n
}

/** Read a string value at `off` (pointing at the type tag), bounded. */
function readString(buf: Buffer, off: number): string | undefined {
  if (off < 0 || off + 4 > buf.length) return undefined
  if (buf.readUInt32LE(off) !== 8 /* STRING */) return undefined
  const lenAt = off + 4
  if (lenAt + 8 > buf.length) return undefined
  const len = Number(buf.readBigUInt64LE(lenAt))
  if (!Number.isFinite(len) || len <= 0 || len > 256) return undefined
  const start = lenAt + 8
  if (start + len > buf.length) return undefined
  return buf.toString('utf8', start, start + len)
}

/**
 * The facts a GGUF file states about itself, or an empty object.
 *
 * NEVER THROWS. A missing file, a truncated download, a format we do not
 * recognise and a key we cannot prove all produce the same thing: nothing. The
 * callers treat absence as "carry on as before", so this is a pure improvement
 * or a no-op, never a new failure mode.
 */
export function readGgufHeader(path: string): GgufHeaderFacts {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.allocUnsafe(WINDOW_BYTES)
    const read = readSync(fd, buf, 0, WINDOW_BYTES, 0)
    if (read < 24) return {}
    const win = buf.subarray(0, read)
    if (win.readUInt32LE(0) !== MAGIC) return {}

    const out: GgufHeaderFacts = {}
    const num = (suffix: string): number | undefined => {
      const end = findKeyEnd(win, suffix)
      return end < 0 ? undefined : readCount(win, end)
    }

    const blockCount = num('.block_count')
    // A transformer with more than a thousand blocks does not exist today; a
    // number that large is a misread that survived the earlier checks.
    if (blockCount !== undefined && blockCount <= 1000) out.blockCount = blockCount

    const ctx = num('.context_length')
    if (ctx !== undefined && ctx >= 512) out.contextLength = ctx

    const heads = num('.attention.head_count')
    if (heads !== undefined && heads <= 1024) out.headCount = heads

    const kvHeads = num('.attention.head_count_kv')
    if (kvHeads !== undefined && kvHeads <= 1024) out.headCountKv = kvHeads

    // Bounded well above any shipped model (Llama-405B is 16384) and well below
    // anything that would signal a misread.
    const embd = num('.embedding_length')
    if (embd !== undefined && embd <= 65_536) out.embeddingLength = embd

    const kLen = num('.attention.key_length')
    if (kLen !== undefined && kLen <= 4096) out.keyLength = kLen

    const vLen = num('.attention.value_length')
    if (vLen !== undefined && vLen <= 4096) out.valueLength = vLen

    const archEnd = findKeyEnd(win, 'general.architecture')
    if (archEnd >= 0) {
      const arch = readString(win, archEnd)
      if (arch && /^[a-z0-9_.\-]{2,64}$/i.test(arch)) out.architecture = arch
    }
    return out
  } catch {
    return {}
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* already gone */ } }
  }
}
