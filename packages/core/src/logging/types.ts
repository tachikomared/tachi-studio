export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogCategory =
  | 'app'
  | 'chat'
  | 'provider'
  | 'runtime'
  | 'terminal'
  | 'agent-command'
  | 'settings'
  | 'updater'
  | 'security'

export interface LogEvent {
  id: string
  ts: string  // ISO 8601
  level: LogLevel
  category: LogCategory
  message: string
  details?: Record<string, unknown>
}
