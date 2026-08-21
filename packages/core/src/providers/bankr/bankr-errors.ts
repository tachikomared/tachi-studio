import { FriendlyProviderError } from '../../chat/backend.js'

const ERROR_MAP: Record<number, FriendlyProviderError> = {
  0:   { code: 'UNREACHABLE',       message: 'Bankr Gateway unreachable. Check your connection.' },
  400: { code: 'BAD_REQUEST',       message: 'Request rejected. Check model, message format, or max tokens.' },
  401: { code: 'INVALID_KEY',       message: 'Invalid Bankr API key. Check your key in Settings.' },
  402: { code: 'CREDITS_EXHAUSTED', message: 'Bankr credits exhausted. Top up at bankr.bot.' },
  403: { code: 'ACCESS_DENIED',     message: 'Bankr key does not have access to this model.' },
  404: { code: 'MODEL_NOT_FOUND',   message: 'Model unavailable on this gateway.' },
  408: { code: 'TIMEOUT',           message: 'Request timed out. Try a faster model.' },
  429: { code: 'RATE_LIMITED',      message: 'Rate limited. Slowing down.' },
  499: { code: 'ABORTED',           message: 'Request cancelled.' },
}

export function mapBankrError(status: number): FriendlyProviderError {
  if (ERROR_MAP[status]) return ERROR_MAP[status]
  if (status >= 500) return { code: 'GATEWAY_ERROR', message: 'Gateway error. Bankr may be experiencing issues.' }
  return { code: 'UNKNOWN', message: `Unexpected error (${status}).` }
}

export const MALFORMED_SSE_ERROR: FriendlyProviderError = {
  code: 'MALFORMED_STREAM',
  message: 'Gateway stream ended unexpectedly.',
}

export const NO_MODEL_ERROR: FriendlyProviderError = {
  code: 'NO_MODEL',
  message: 'Choose a model before sending.',
}

export const NO_KEY_ERROR: FriendlyProviderError = {
  code: 'NO_KEY',
  message: 'Configure your Bankr API key in Settings.',
}
