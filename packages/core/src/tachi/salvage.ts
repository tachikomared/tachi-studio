// packages/core/src/tachi/salvage.ts
//
// Tool-call SALVAGE parser. Many gateway/OSS models (DeepSeek, qwen-coder on
// vLLM, Groq-Llama, …) refuse to emit native `tool_calls` and instead print the
// call as TEXT in the assistant message. When the provider's native tool_calls
// array comes back empty, the loop hands the raw assistant text here to recover
// any calls the model meant to make.
//
// It recognises four textual encodings (each tagged on SalvagedCall.via):
//   - 'xml-function'  <function=NAME>{…json…}</function>, the <function="NAME">
//                     quoted-attr variant, and <function_call name="NAME">…</function_call>
//   - 'xml-tool_call' <tool_call>{"name":…,"arguments":…}</tool_call>
//                     (arguments may be a JSON object OR a JSON-encoded string)
//   - 'json-block'    a fenced ```json … ``` block holding {name|tool, arguments|args}
//   - 'bare-json'     a top-level {name|tool, arguments|args} object that IS the
//                     whole trimmed text (or a single clearly-delimited line)
//
// Design priorities, in order:
//   1. False-positive resistance. The overwhelmingly common case is ordinary
//      prose with no call in it — that must return [] cheaply. We never treat a
//      JSON blob as a call unless it carries a name/tool key AND (for bare-json)
//      stands alone, so prose that merely *mentions* "function" or shows example
//      JSON data does not trip the parser.
//   2. Robust arg normalisation. arguments/args may be an object or a
//      JSON-encoded string; we always return a parsed object. Malformed arg JSON
//      makes us SKIP that one call rather than throw.
//   3. Document order. Multiple calls (even across encodings) come back in the
//      order they appear in the text.
//
// Pure TypeScript: no electron / node / network. Plain regex + JSON.parse.

import type { SalvagedCall } from './contract.js'

/** Internal: a recovered call plus where it started in the source text (for ordering). */
interface Located {
  index: number
  call: SalvagedCall
}

/**
 * Recover tool calls encoded as text in an assistant message. Returns [] when
 * nothing tool-shaped is present (the common path). Never throws on malformed
 * input — a call whose args can't be parsed into an object is silently skipped.
 */
export function salvageToolCalls(assistantText: string): SalvagedCall[] {
  if (typeof assistantText !== 'string' || assistantText.trim() === '') return []

  const located: Located[] = []
  scanXmlFunction(assistantText, located)
  scanXmlToolCall(assistantText, located)
  scanJsonBlock(assistantText, located)

  // bare-json is the loosest matcher and the easiest to over-fire, so only try
  // it when NO delimited encoding was found in the text. The delimited scans
  // above already consume the obvious cases (and a <tool_call> body would
  // otherwise also look like bare-json), so gating on `located.length` both
  // prevents double-counting and keeps prose safe.
  if (located.length === 0) {
    scanBareJson(assistantText, located)
  }

  located.sort((a, b) => a.index - b.index)
  return located.map(l => l.call)
}

// ── Helpers ──────────────────────────────────────────────────────────────────────

/** True only for a plain (non-array, non-null) object. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** JSON.parse that returns undefined instead of throwing. */
function tryParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

/**
 * Normalise an arguments value into a parsed object, or undefined if it can't be.
 * Accepts: an object (returned as-is), a JSON-encoded string (parsed once more,
 * must yield an object), or undefined/null (treated as empty args `{}`).
 * Arrays and scalars are rejected (return undefined) — args must be an object.
 */
function normaliseArgs(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return {}
  if (isPlainObject(raw)) return raw
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed === '') return {}
    const parsed = tryParse(trimmed)
    return isPlainObject(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * Build a SalvagedCall from a name + a raw args value, or undefined if the args
 * can't be normalised to an object (caller then skips this match).
 */
function buildCall(name: string, rawArgs: unknown, via: SalvagedCall['via']): SalvagedCall | undefined {
  const args = normaliseArgs(rawArgs)
  if (args === undefined) return undefined
  return { name, args, via }
}

/**
 * Pull the `name`/`tool` and `arguments`/`args` fields out of an already-parsed
 * call object and build a SalvagedCall. Returns undefined when there's no usable
 * name key or the args don't normalise — this is also the gate that keeps plain
 * JSON *data* (no name/tool key) from being read as a call.
 */
function callFromObject(obj: Record<string, unknown>, via: SalvagedCall['via']): SalvagedCall | undefined {
  const nameVal = obj.name ?? obj.tool
  if (typeof nameVal !== 'string' || nameVal.trim() === '') return undefined
  const rawArgs = 'arguments' in obj ? obj.arguments : 'args' in obj ? obj.args : undefined
  return buildCall(nameVal, rawArgs, via)
}

// ── Encoding scanners ──────────────────────────────────────────────────────────────

/**
 * <function=NAME>{…}</function>, <function="NAME">{…}</function>, and
 * <function_call name="NAME">{…}</function_call>. The body between the tags is
 * the args JSON itself (no name field inside).
 */
function scanXmlFunction(text: string, out: Located[]): void {
  // <function=NAME> or <function="NAME"> / <function='NAME'> … </function>
  const re1 = /<function\s*=\s*["']?([\w.-]+)["']?\s*>([\s\S]*?)<\/function>/g
  for (let m = re1.exec(text); m !== null; m = re1.exec(text)) {
    const name = m[1]
    const body = m[2].trim()
    const parsed = body === '' ? {} : tryParse(body)
    if (!isPlainObject(parsed)) continue
    const call = buildCall(name, parsed, 'xml-function')
    if (call) out.push({ index: m.index, call })
  }

  // <function_call name="NAME"> … </function_call>
  const re2 = /<function_call\s+name\s*=\s*["']([\w.-]+)["']\s*>([\s\S]*?)<\/function_call>/g
  for (let m = re2.exec(text); m !== null; m = re2.exec(text)) {
    const name = m[1]
    const body = m[2].trim()
    const parsed = body === '' ? {} : tryParse(body)
    if (!isPlainObject(parsed)) continue
    const call = buildCall(name, parsed, 'xml-function')
    if (call) out.push({ index: m.index, call })
  }
}

/**
 * <tool_call>{"name":…,"arguments":…}</tool_call>. The body is a JSON object
 * that itself carries the name + arguments (arguments may be a nested JSON
 * string, handled by normaliseArgs).
 */
function scanXmlToolCall(text: string, out: Located[]): void {
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const parsed = tryParse(m[1].trim())
    if (!isPlainObject(parsed)) continue
    const call = callFromObject(parsed, 'xml-tool_call')
    if (call) out.push({ index: m.index, call })
  }
}

/**
 * Fenced ```json … ``` blocks. Only those whose content parses to a call object
 * (has a name/tool key) count; a fence holding plain data or a bare array is
 * ignored so we don't false-positive on example JSON in an answer.
 */
function scanJsonBlock(text: string, out: Located[]): void {
  // ```json (optionally with trailing space) … ``` — case-insensitive lang tag.
  const re = /```[ \t]*json[ \t]*\r?\n([\s\S]*?)```/gi
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const parsed = tryParse(m[1].trim())
    if (!isPlainObject(parsed)) continue
    const call = callFromObject(parsed, 'json-block')
    if (call) out.push({ index: m.index, call })
  }
}

/**
 * A top-level {name|tool, arguments|args} object that stands alone. CONSERVATIVE
 * by design: we accept it only when the whole trimmed text is that object, or
 * when it is a single line by itself (trimmed line === the object). This keeps
 * prose that happens to contain an inline `{"name": …}` fragment from being
 * misread as a call. Only reached when no delimited encoding matched.
 */
function scanBareJson(text: string, out: Located[]): void {
  const trimmed = text.trim()

  // Case A: the entire message is the JSON object.
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const parsed = tryParse(trimmed)
    if (isPlainObject(parsed)) {
      const call = callFromObject(parsed, 'bare-json')
      if (call) {
        out.push({ index: text.indexOf(trimmed), call })
        return
      }
    }
    // Whole-text object that isn't a call (or bad JSON) -> nothing to salvage.
    // Fall through is pointless here since the text is a single blob.
    return
  }

  // Case B: a clearly-delimited standalone line that is exactly the object.
  for (const line of lineSpans(text)) {
    const t = line.text.trim()
    if (!t.startsWith('{') || !t.endsWith('}')) continue
    const parsed = tryParse(t)
    if (!isPlainObject(parsed)) continue
    const call = callFromObject(parsed, 'bare-json')
    if (call) out.push({ index: line.index, call })
  }
}

/** Split text into lines, keeping each line's start offset in the source. */
function lineSpans(text: string): Array<{ text: string; index: number }> {
  const spans: Array<{ text: string; index: number }> = []
  let start = 0
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      let end = i
      if (end > start && text[end - 1] === '\r') end -= 1
      spans.push({ text: text.slice(start, end), index: start })
      start = i + 1
    }
  }
  return spans
}
