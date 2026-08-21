# Privacy and security

The short version: your keys are in the operating system's keychain, your data is
in files you can open, and the network boundary is enforced where the network
calls actually happen — in the main process — not by a checkbox that the UI
politely respects.

## Private mode

One switch in **Settings → Advanced**. With it on:

- every cloud provider disappears from the pickers **and** is refused at the
  egress policy, so a stale reference cannot sneak a request out;
- web search is disabled;
- MCP servers are restricted to a built-in safe list of local-only ones;
- the tab that runs GitHub Actions is hidden, because it is by definition remote.

The panel lists exactly what it has hidden and disabled, so the mode does not
require trust. Local models are unaffected: the whole point is that the app keeps
working with the network gone.

There is a second, narrower switch — **scrub secrets before cloud send** — that
replaces API keys, tokens, emails, cards and other personal data with stable
placeholders in anything about to leave for a cloud provider. It is off by
default, because a silent rewrite of your own message is a surprising default.

## Secrets

API keys and wallet private keys are encrypted with Electron's `safeStorage`,
which uses the OS keychain (DPAPI on Windows, Keychain on macOS, libsecret on
Linux). They are read in the main process at the moment of use. They are never
passed across IPC, never written to the settings file, and never included in an
exported backup — the export says so on the button.

## The renderer is not trusted

- `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`.
- A strict Content-Security-Policy in production builds.
- Every IPC argument is validated with a Zod schema before a service sees it.
- `openExternal` runs against a host allowlist, so a link in a model's answer
  cannot open an arbitrary protocol handler.
- Requests to user-supplied URLs go through an SSRF guard that rejects private
  address ranges.

## Agents are gated, not trusted

An agent that can edit files and run commands is the most dangerous thing in the
app, and it is treated that way:

- each tool is approved separately, and approvals queue rather than being lost if
  you are looking at another tab;
- file access is bounded by an explicit path root;
- shell commands run with a scrubbed environment, a deny-list, and process-tree
  termination on cancel;
- network access follows the same egress policy as everything else;
- spending is capped: there is a cost ledger and a budget check before a run
  starts, including for the sidecar processes.

This is a defence-in-depth story, not a sandbox. A coding agent you point at your
own repository can change that repository — that is what you asked it to do.

## Downloads are verified

Model weights and engine binaries are checked against the publisher's own SHA256
digest — HuggingFace LFS object IDs and GitHub release digests, resolved ahead of
time and pinned in the repository. A packaged build **fails closed**: it refuses
to run an artifact whose hash was not pinned at build time. A partially
downloaded file is never destroyed by a server answering differently than it did
before.

## What leaves your machine

The dashboard lists every outbound request the main process makes, with URL,
timing and outcome. It is a debugging aid rather than a complete ledger — calls
made inside sidecar processes and on-chain wallet RPC are not in that list, and
the panel says so.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
