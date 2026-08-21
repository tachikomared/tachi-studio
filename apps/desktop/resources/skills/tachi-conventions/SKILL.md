---
name: tachi-conventions
description: House conventions for working on the Tachi Studio codebase — where things live, how to verify changes, and what never to hand-roll. Load before multi-file edits in this repo.
---

# Tachi Studio conventions

Layout (pnpm monorepo):
- `packages/core` — pure, dependency-light TypeScript (no electron / DOM / network). New logic that CAN live here SHOULD live here, with tests in a sibling `__tests__/` folder.
- `apps/desktop/electron` — main-process services (electron-coupled). The TACHI harness lives in `electron/services/tachi/`.
- `apps/desktop/src` — the React renderer. All user-facing strings go through react-i18next namespaces (8 locales) — never hardcode UI copy.
- `apps/desktop/test/unit` — vitest for desktop pure helpers (electron mocked via `vi.mock('electron', ...)`).

Rules of the road:
- Read a file before editing it; match the surrounding style and comment density.
- No new npm dependencies without an explicit decision — prefer the platform and what's already installed.
- Files are UTF-8; edit with real file tools, never shell regex in-place edits (mojibake risk on Windows).
- Tool failures should return model/user-facing strings, not throw across service boundaries.

Verify:
- Core: `pnpm -F @tachi/core test`
- Desktop units: `npx vitest run <file>` from `apps/desktop`
- Types: `npx tsc --noEmit` in `apps/desktop` (expected baseline may apply — compare before/after).
