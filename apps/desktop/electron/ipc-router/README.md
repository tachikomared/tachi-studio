# IPC Router — typed tRPC-style Electron IPC

Sprint C1 infrastructure. Wraps `ipcMain.handle` with Zod-validated, envelope-typed routes. Zero wire-protocol change — channel names are identical to the old hand-written handlers.

## How it works

```
defineRouter('shell', { openExternal: route({ input, output, handle }) })
        │
        ▼
registerRouter(shellRouter)    ← main process: ipcMain.handle('shell:open-external', ...)
        │
        ▼
preloadBridge<typeof shellRouter>('shell', ['openExternal'])  ← preload: ipcRenderer.invoke(...)
        │
        ▼
window.tachi.shell.openExternal(...)   ← renderer: typed, envelope-unwrapped
```

### Channel name derivation

Route keys are camelCase; channels are `<namespace>:<kebab-key>`:
- `shell` + `openExternal` → `shell:open-external`
- `bankr` + `listModels`   → `bankr:list-models`
- `playbook` + `list`      → `playbook:list`

This preserves exact wire compatibility with the old `ipcMain.handle('shell:open-external', ...)` registrations.

### Result envelope

Every router-registered handler wraps its return in:

```ts
{ ok: true, data: T }          // success
{ ok: false, error: { code, message } }  // handler threw or Zod parse failed
```

`preloadBridge` unwraps this: on `ok: true` it returns `data`; on `ok: false` it throws `new Error(message)` with `.code` set.

---

## Migration recipe — one IPC file in 5 minutes

Follow these steps to migrate any existing `registerXxxIpc()` to the router:

1. **Read the existing file** (`electron/ipc/xxx.ipc.ts`). Note every `ipcMain.handle('xxx:yyy', ...)` call and its payload shape.

2. **Replace the file body** with a `defineRouter` call:

   ```ts
   import { z } from 'zod'
   import { defineRouter, route } from '../ipc-router/router'

   export const xxxRouter = defineRouter('xxx', {
     yyy: route({
       input:  z.object({ /* the payload fields */ }),
       output: z.object({ /* the return type */ }),
       handle: async (input) => { /* move the handler body here */ },
     }),
   })

   /** @deprecated Use registerRouter(xxxRouter) instead. */
   export function registerXxxIpc(): void { /* no-op shim */ }
   ```

3. **Update `electron/main.ts`**:
   - Add `import { xxxRouter } from './ipc/xxx.ipc'` and `import { registerRouter } from './ipc-router/router'` (if not already present).
   - Add `registerRouter(xxxRouter)` BEFORE the `registerXxxIpc()` shim call.

4. **Update `electron/preload.ts`** — two sub-cases:

   a. **Renderer passes objects already** (e.g. `bankr.listModels({ force })`): use `preloadBridge` directly:
      ```ts
      import { preloadBridge } from './ipc-router/preload-bridge'
      import type { xxxRouter } from './ipc/xxx.ipc'
      const xxxBridge = preloadBridge<typeof xxxRouter>('xxx', ['yyy'])
      // In contextBridge: xxx: xxxBridge
      ```

   b. **Renderer passes primitive args** (e.g. `shell.openExternal(url)`): keep a manual wrapper in the preload stanza:
      ```ts
      const xxxBridge = preloadBridge<typeof xxxRouter>('xxx', ['yyy'])
      // In contextBridge:
      xxx: {
        yyy: (primitiveArg: string) => xxxBridge.yyy({ field: primitiveArg }),
      }
      ```

5. **Update `src/types/electron.d.ts`**:

   a. If you used `preloadBridge` directly (case 4a), add a typed stanza using `inferRouterAPI`:
      ```ts
      import type { xxxRouter } from '../../electron/ipc/xxx.ipc'
      import type { inferRouterAPI } from '../../electron/ipc-router/types'
      // In TachiAPI:
      xxx: inferRouterAPI<typeof xxxRouter>
      ```

   b. If you kept a manual wrapper (case 4b), keep the manual type stanza in `TachiAPI` matching the renderer call signature.

6. **Run typecheck**: `pnpm --filter tachi-studio-desktop exec tsc --noEmit | grep -v "TS17004\|TS6142"`. Should add zero new errors.

7. **Verify**: confirm the renderer call (e.g. `window.tachi.shell.openExternal(url)`) is unchanged in the component files.

---

## Already migrated namespaces (Sprint C1)

| Namespace | Router export | Route keys | Notes |
|---|---|---|---|
| `shell` | `shellRouter` | `openExternal` | Manual preload wrapper (string→object) |
| `bankr` | `bankrRouter` | `listModels` | Bridge used directly |
| `playbook` | `playbookRouter` | `list`, `load`, `delete` | Manual preload wrappers (string→object) |

## Not yet migrated (~17 namespaces)

All other namespaces in `electron/ipc/*.ts` continue to use `ipcMain.handle` directly. They are untouched and work identically to before. Migrate them incrementally following the recipe above.

## Event-streaming (push channels)

Push channels like `agent:event`, `terminal:data` are NOT handled by the router — they use `webContents.send()` in the main process and `ipcRenderer.on()` in the preload. The router only covers request/response patterns (`ipcMain.handle` + `ipcRenderer.invoke`). Event subscriptions remain as hand-written `on<EventName>(cb)` stanzas in the preload. Future C2 work may address these.
