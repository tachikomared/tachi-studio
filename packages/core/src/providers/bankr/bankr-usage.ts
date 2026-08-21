import { BankrUsageResponse } from './types.js'

export async function fetchBankrUsage(
  apiKey: string,
  days = 30,
  fetchFn: typeof fetch = fetch
): Promise<BankrUsageResponse | null> {
  try {
    const res = await fetchFn(`https://llm.bankr.bot/v1/usage?days=${days}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    return await res.json() as BankrUsageResponse
  } catch {
    return null
  }
}
