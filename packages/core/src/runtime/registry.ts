import { RuntimeDetector } from './types.js'
import { createLMStudioDetector } from './detectors/lmstudio.js'
import { createOllamaDetector } from './detectors/ollama.js'
import { createJanDetector } from './detectors/jan.js'
import { createBankrGatewayDetector } from './detectors/bankr-gateway.js'
import { createBankrBuddyDetector } from './detectors/bankr-buddy.js'

export interface RegistryConfig {
  bankrApiKey?: string
  bankrBuddyPort?: number
  binaryDetectors?: RuntimeDetector[]
}

export function buildRegistry(config: RegistryConfig): RuntimeDetector[] {
  return [
    createLMStudioDetector(),
    createOllamaDetector(),
    createJanDetector(),
    createBankrGatewayDetector(config.bankrApiKey),
    createBankrBuddyDetector(config.bankrBuddyPort),
    ...(config.binaryDetectors ?? []),
  ]
}
