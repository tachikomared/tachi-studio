// apps/desktop/electron/mcp/sanitize.ts
//
// Sanitizers for UNTRUSTED strings the MCP server derives from the filesystem
// or git and returns to external agents (STEAL 2026-06-12 cluster B;
// code-review-graph graph.py _sanitize_name). A filename or commit subject is
// chosen by whoever wrote it — control characters let it forge extra result
// rows, ANSI-style terminal escapes, or invisible text in an agent's context.
//
// NOT applied to fs_read content: that tool is verbatim by contract (agents
// diff/hash the exact bytes).

/** Remove C0 control chars (0x00–0x1F, incl. \n \t \r) and DEL (0x7F). */
export function stripControl(raw: string): string {
  let out = ''
  for (const ch of raw) {
    const c = ch.codePointAt(0) as number
    if ((c >= 0x00 && c <= 0x1f) || c === 0x7f) continue
    out += ch
  }
  return out
}

/** stripControl + cap at maxLen code points (default 256), '…' marks the cut. */
export function sanitizeName(raw: string, maxLen = 256): string {
  const s = stripControl(raw)
  const chars = Array.from(s)
  return chars.length > maxLen ? chars.slice(0, maxLen - 1).join('') + '…' : s
}
