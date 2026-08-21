const SENSITIVE_KEY_PATTERNS = [
  /authorization/i,
  /x-api-key/i,
  /x-auth-token/i,
  /cookie/i,
  /set-cookie/i,
]

// Patterns ordered: Bearer first (keeps "Bearer " prefix), then raw key patterns (full replacement)
const SENSITIVE_VALUE_PATTERNS: Array<{ pattern: RegExp; keepPrefix?: string }> = [
  { pattern: /Bearer\s+\S+/g, keepPrefix: 'Bearer ' },
  { pattern: /bk_[A-Za-z0-9_-]+/g },
  { pattern: /sk-[A-Za-z0-9_-]+/g },
]

export function redactSecrets(input: string): string {
  let result = input
  for (const { pattern, keepPrefix } of SENSITIVE_VALUE_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0
    if (keepPrefix !== undefined) {
      result = result.replace(pattern, `${keepPrefix}[REDACTED]`)
    } else {
      result = result.replace(pattern, '[REDACTED]')
    }
  }
  return result
}

export function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEY_PATTERNS.some(p => p.test(key))) {
      result[key] = '[REDACTED]'
    } else {
      result[key] = value
    }
  }
  return result
}
