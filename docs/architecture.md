# Architecture

Tachi Studio is an Electron application: a Node.js **main process** that owns the
machine, and a sandboxed **renderer** that owns the pixels. Everything that can
touch a file, a socket, a keychain or a child process lives in main. The window
can only ask.

```
apps/desktop/electron/     main process
  ipc/                     79 modules — the only doors into main
  services/                187 modules — the things behind those doors
  mcp/                     the MCP server this app exposes to other tools
apps/desktop/src/          renderer (React 19)
  pages/                   22 page groups — one per tab and its panels
  store/                   31 Zustand stores
  i18n/                    21 namespaces × 8 locales
packages/core/             @tachi/core — shared logic with no Electron in it
scripts/                   sidecar preparation, licence notice generation
```

## The three layers

Every feature that crosses the process boundary is three files, and they have to
agree:

1. **`preload`** exposes a named channel on `window.tachi`. Nothing else is
   reachable from the renderer — `nodeIntegration` is off, `contextIsolation` is
   on, and the renderer runs in Chromium's sandbox.
2. **`electron/ipc/<area>.ipc.ts`** registers the handler. Arguments are parsed
   with a Zod schema before anything else happens, so a malformed call fails at
   the door with a typed error instead of halfway through a service.
3. **`electron/services/<thing>.ts`** does the work. Services do not know about
   IPC; they take arguments and return values, which is why most of them are
   unit-testable without Electron running.

If you add a capability and only wire two of the three, the app will typecheck
and then do nothing at runtime — that failure has happened here often enough that
it is written into [AGENTS.md](../AGENTS.md) as a convention.

## Where state lives

| State | Where | Notes |
|---|---|---|
| Chats, folders, flows, prompts | JSON + SQLite under the user data directory | Full-text search uses SQLite FTS5 |
| Settings | `tachi-settings.json` in the user data directory | Plain JSON on purpose — you can read it |
| API keys and wallet keys | OS keychain, via Electron `safeStorage` | Never sent to the renderer |
| Models and engines | A storage root you choose | Can be a different drive; the app moves them for you |
| Generated media | Under the same storage root | Kept as normal files with metadata |

In **portable mode** — an empty folder named `tachi-data` next to the executable —
all of the above moves inside the application folder. That redirection happens in
the first lines of the main process, before any module has had a chance to read a
path, which is the only place it can be done correctly.

## Renderer state

31 Zustand stores, one per subject (chat, agents, nodes, media, settings…). The
rule they follow: a store holds what the UI needs to draw, and asks main for
anything authoritative. Two consequences worth knowing when you read the code —
persisted store shapes are versioned and migrated on load, and any store that
writes to disk throttles and latches its failures rather than throwing into a
render.

## packages/core

`@tachi/core` is the part with no Electron import: model capabilities and context
windows, prompt classification for automatic model choice, the memory/recall
packer, wallet math, and the parsers. It is a separate package so that logic can
be tested as plain TypeScript and reused by the sidecars and the harness — and so
that a mistake there shows up as a failing unit test rather than a broken window.

## Testing

Roughly 9 800 unit tests across the two packages (389 desktop test files plus the
core suite). They run in a couple of minutes and are expected to be green before
anything is committed; the ones that matter most are the "wiring" tests, which
assert that the three layers above still line up.

Continuous integration runs typecheck → both suites → a build on every push.
