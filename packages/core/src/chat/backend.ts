import type { RagCitation } from '../rag/citations.js'

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface FriendlyProviderError {
  code: string
  message: string
}

/** One panel member's answer as delivered to the renderer (Fusion compare mode). */
export interface ChatPanelMember {
  model: string
  text: string
  ok: boolean
  /** Wall time for this member's full answer, ms. */
  ms: number
  /** Completion tokens when the backend reported usage. */
  tokens?: number
  /**
   * Time-to-first-token, ms — measured from the leg's request start to its
   * first streamed delta. Absent when the stream produced no delta (so the
   * UI shows "—" instead of a fake number).
   */
  ttftMs?: number
  error?: string
}

export type ChatChunk =
  | { type: 'start'; messageId: string; model?: string }
  | { type: 'delta'; messageId: string; text: string }
  | { type: 'usage'; messageId: string; usage: TokenUsage }
  /** Fusion compare mode: every panel answer side-by-side (no judge stage). */
  | { type: 'panel'; messageId: string; members: ChatPanelMember[] }
  /**
   * RAG SOURCE CITATIONS (T20): provenance for the reply that is about to
   * stream — emitted by the main process right after the attached-folder
   * retrieval, i.e. BEFORE any provider branch has minted a message id.
   * `messageId` is therefore normally EMPTY and `conversationId` is the
   * authoritative target: the store buffers the citations and stamps them onto
   * the assistant message created by the next `start` in that conversation.
   * (`messageId` is still present — un-narrowed consumers read `chunk.messageId`
   * across the whole union — and is honoured when a producer does know it.)
   */
  | { type: 'citations'; messageId: string; conversationId: string; citations: RagCitation[] }
  /**
   * CONNECTION RESILIENCE — discard everything streamed into this message so
   * far. Emitted right before a reconnect re-requests the answer: the provider
   * restarts generation from scratch, so the partial text must go or the reply
   * renders twice. (The renderer clears both the committed content and the
   * coalescing delta buffer.)
   */
  | { type: 'reset'; messageId: string }
  /**
   * A retryable transport failure killed the stream and we are reconnecting.
   * `attempt` is 1-based, `delayMs` is the wait before the next request.
   * Purely transient UI — cleared by `reconnect-resolved`, `error` or `done`.
   */
  | { type: 'reconnect'; messageId: string; attempt: number; maxAttempts: number; delayMs: number; reason: string }
  /** The reconnected request is streaming again — clear the retry strip. */
  | { type: 'reconnect-resolved'; messageId: string }
  | { type: 'error'; messageId: string; error: FriendlyProviderError }
  | { type: 'done'; messageId: string }

export interface ModelInfo {
  id: string
  displayName?: string
  tier?: 'fast' | 'balanced' | 'powerful' | 'coding' | 'reasoning'
  isDefault?: boolean
  isRecommended?: boolean
}

export type HealthStatus =
  | { status: 'healthy' }
  | { status: 'reachable_auth_invalid' }
  | { status: 'unreachable' }
  | { status: 'degraded'; message: string }

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'file'; data: string; mimeType: string; filename: string }

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | ChatContentPart[]
}

export interface ChatRequest {
  messages: ChatMessage[]
  model: string
  stream?: boolean
  maxTokens?: number
  tools?: unknown[]
  tool_choice?: string | Record<string, unknown>
}

export interface ChatBackend {
  id: string
  displayName: string
  sendMessage(request: ChatRequest, apiKey: string): AsyncIterable<ChatChunk>
  listModels?(apiKey: string): Promise<ModelInfo[]>
  healthCheck?(apiKey: string): Promise<HealthStatus>
}
