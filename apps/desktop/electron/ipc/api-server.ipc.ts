// apps/desktop/electron/ipc/api-server.ipc.ts
//
// IPC for the local OpenAI-compatible API server (openai-api-server.ts) —
// the loopback endpoint Tachi Studio EXPOSES so external tools can talk to
// FreeLLM + llama.cpp. Mirrors registerInProcessMcpIpc's shape.
//
// Channels:
//   api-server:status        — { running, enabled, baseUrl, port } (key NOT here)
//   api-server:reveal-token  — returns the API key (explicit reveal only)
//   api-server:rotate-token  — stop, regenerate key, restart. Returns new status.
//   api-server:set-enabled   — toggle the server on/off (persisted). Default: on.
//   api-server:copy-snippet  — ready-to-paste client config (curl + python).

import { ipcMain } from 'electron'
import { z } from 'zod'
import type { ApiServerHandle } from '../services/openai-api-server'

export function registerApiServerIpc(
  getHandle: () => ApiServerHandle | null,
  setEnabled: (v: boolean) => Promise<void>,
  rotateToken: () => Promise<void>,
  isEnabled: () => boolean,
): void {
  const status = () => {
    const h = getHandle()
    return {
      running: !!h,
      enabled: isEnabled(),
      baseUrl: h?.baseUrl ?? null,
      port: h?.port ?? null,
    }
  }

  ipcMain.handle('api-server:status', () => status())

  // The key is only ever returned through this explicit "reveal" channel —
  // never included in status payloads, never broadcast.
  ipcMain.handle('api-server:reveal-token', () => {
    const h = getHandle()
    return h ? h.token : null
  })

  ipcMain.handle('api-server:rotate-token', async () => {
    await rotateToken()
    return status()
  })

  ipcMain.handle('api-server:set-enabled', async (_event, payload: unknown) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(payload)
    await setEnabled(enabled)
    return status()
  })

  ipcMain.handle('api-server:copy-snippet', () => {
    const h = getHandle()
    if (!h) return null
    return {
      baseUrl: h.baseUrl,
      curl: [
        `curl ${h.baseUrl}/chat/completions \\`,
        `  -H "Authorization: Bearer ${h.token}" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{"model": "auto", "messages": [{"role": "user", "content": "hello"}]}'`,
      ].join('\n'),
      python: [
        'from openai import OpenAI',
        `client = OpenAI(base_url="${h.baseUrl}", api_key="${h.token}")`,
        'r = client.chat.completions.create(model="auto", messages=[{"role": "user", "content": "hello"}])',
        'print(r.choices[0].message.content)',
      ].join('\n'),
    }
  })
}
