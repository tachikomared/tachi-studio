# Documentation

| Page | What it covers |
|---|---|
| [architecture.md](architecture.md) | How the app is put together: processes, the IPC contract, where state lives |
| [privacy-and-security.md](privacy-and-security.md) | Private mode, secrets, the network boundary, download verification |
| [providers-and-models.md](providers-and-models.md) | Cloud providers, the free router, automatic model choice, local engines |
| [agents-and-automation.md](agents-and-automation.md) | Coding agents, permissions, node flows, the scheduler, MCP |

Extending the app:

- [../recipes/ADDING-A-THEME.md](../recipes/ADDING-A-THEME.md) — add a theme, including one that redraws the window frame
- [../recipes/AGENT-MEMORY.md](../recipes/AGENT-MEMORY.md) — how the agent remembers things between runs
- [../AGENTS.md](../AGENTS.md) — the conventions this codebase is written to. The in-app agent reads this file when it works on Tachi Studio itself.

Screenshots used throughout the documentation live in [media/](media/).

## A note on `notes/…` references in the source

Some comments cite a research file under `notes/` — a measured provider sweep, a
protocol investigation, a design spec. Those are the maintainer's working notes:
they are the evidence behind a decision, they are not published, and the comment
names them so the reasoning has an owner rather than appearing out of nowhere.
Nothing in the build reads them. If a claim in a comment matters to you and the
note is not here, open an issue and ask — the measurement can be repeated.
