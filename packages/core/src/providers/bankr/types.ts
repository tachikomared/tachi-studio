export interface BankrUsageResponse {
  totalTokens: number
  totalRequests: number
  estimatedCostUsd: number
  byModel: Array<{ model: string; tokens: number; costUsd: number }>
}
