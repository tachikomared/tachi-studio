# Contributing to Tachi Studio

Thanks for your interest! This is a pre-1.0, local-first desktop AI app
(Electron + React + a pure `@tachi/core` package). Issues and PRs are welcome.

## Dev setup

Requires **Node 22+** and **pnpm 9+** (Windows, macOS, or Linux).

```bash
pnpm install
pnpm prepare:sidecars   # REQUIRED once — builds the pinned FreeLLM router sidecar
pnpm dev                # launch the app (electron-vite dev)
```

`prepare:sidecars` is not automatic — `pnpm dev` won't fully work until you've run
it once. No API key is needed to start: the keyless free providers route out of the box.

> Windows: the terminal uses `node-pty` (winpty); the first `pnpm install` builds
> native addons, so have the VS Build Tools installed.

## The loop

| Command | What it does |
|---|---|
| `pnpm dev` | Run the app |
| `pnpm build` | Build main + preload + renderer (electron-vite) |
| `pnpm typecheck` | Full-project `tsc --noEmit` — **must be 0** |
| `pnpm test` | Unit suites (`@tachi/core` + desktop, vitest) |
| `pnpm lint` | ESLint (flat config) |
| `pnpm -F tachi-studio-desktop e2e` | Playwright `_electron` driver — launches the real window |

Before opening a PR: **`pnpm typecheck` must be clean, `pnpm test` green, and the app
must still build.** CI (`.github/workflows/ci.yml`) runs typecheck → both test suites →
build on every push/PR.

## Where things live

```
apps/desktop/electron/   main process — ipc/ (typed surfaces), services/, mcp/
apps/desktop/src/        renderer — pages/, store/ (Zustand), i18n/
packages/core/           @tachi/core — pure, testable logic (no Electron/DOM imports)
docs/                    architecture and subsystem docs (start: architecture.md)
recipes/                 how to add a theme, a provider, agent memory
scripts/                 build helpers (download-sidecars.mjs)
```

**`packages/core` must stay pure** — no `electron`, `fs`, or DOM imports — so it unit-tests
in plain Node and can be reused headless. Put I/O and Electron glue in `apps/desktop`.

## Conventions

- **TypeScript, strict.** No `any` escape hatches in new code; keep `tsc` at 0 errors.
- **IPC is a 3-layer contract** — renderer (`window.tachi.*`) → preload bridge →
  `ipcMain` handler. Validate every handler's input (Zod). See
  [`docs/architecture.md`](docs/architecture.md).
- **Security is not optional.** Network-touching agent tools must route through the
  SSRF guard + egress policy and respect Private Mode (fail-closed). File-writing IPC
  must stay confined to the open workspace. Never log or return secrets to the renderer.
  See [`SECURITY.md`](SECURITY.md).
- **Match the surrounding code** — comment density, naming, and file headers. Most files
  open with a short comment explaining the "why".
- **Tests for logic.** Put testable logic in `@tachi/core` with a vitest spec; reserve
  the Playwright `_electron` driver for end-to-end UI checks.
- **i18n.** User-facing strings go through `react-i18next` (the app ships multiple locales).

## Commit & PR style

- Conventional-commit prefixes (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`) with a
  scope where it helps (`fix(design): …`).
- Keep PRs focused. Describe what changed, why, and how you verified it (ideally by
  *running the app*, not just by passing CI).

## Reporting bugs / requesting features

Open an issue with repro steps, your OS, and what you expected. For anything
security-sensitive, follow [`SECURITY.md`](SECURITY.md) instead of filing a public issue.
