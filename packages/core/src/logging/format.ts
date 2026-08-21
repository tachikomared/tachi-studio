import { LogEvent, LogLevel, LogCategory } from './types.js'
import { redactSecrets } from './redaction.js'
import { randomUUID } from 'crypto'

export function makeLogEvent(
  level: LogLevel,
  category: LogCategory,
  message: string,
  details?: Record<string, unknown>
): LogEvent {
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    level,
    category,
    message: redactSecrets(message),
    details,
  }
}
