export type RuntimeStatus =
  | 'unknown'
  | 'not_installed'
  | 'installed'
  | 'not_running'
  | 'running'
  | 'healthy'
  | 'needs_login'
  | 'unreachable'
  | 'error'
  | 'connected'

export type RuntimeKind =
  | 'cloud_gateway'
  | 'local_model_server'
  | 'coding_agent'
  | 'companion'
  | 'custom_api'

export interface RuntimeCardUpdate {
  runtimeId: string
  kind: RuntimeKind
  status: RuntimeStatus
  version?: string
  displayName?: string
  endpoint?: string
  providerId?: string
  error?: string
  checkedAt: string  // ISO 8601
}

export interface RuntimeDetector {
  runtimeId: string
  kind: RuntimeKind
  displayName: string
  detect(): Promise<RuntimeCardUpdate>
}

// Whitelist shape — validated in Electron main before any spawn
export interface AllowedCommand {
  allowedArgv: (string | RegExp)[][]
  timeoutMs: number
  deepAllowedArgv?: (string | RegExp)[][]
  deepTimeoutMs?: number
}
