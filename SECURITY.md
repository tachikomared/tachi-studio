# Security Policy

Tachi Studio runs AI agents that can touch your filesystem, the network, and
(optionally) a crypto wallet. Security is treated as a first-class concern.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately via **GitHub Security Advisories** ("Report a vulnerability" on the
repository's *Security* tab). Include repro steps, affected version/commit, your OS, and
the impact you observed. We aim to acknowledge reports promptly and will coordinate a fix
and disclosure timeline with you.

This is a pre-1.0 project — only the latest `main` is supported. Please verify against it
before reporting.

## What's in scope

- Sandbox / IPC escapes (renderer reaching the filesystem, secrets, or wallet outside the
  intended surface).
- Agent tools acting outside their boundary (writing/deleting outside the open workspace;
  network egress that bypasses the SSRF guard / Private Mode).
- Secret exposure (API keys, wallet keys) via logs, disk, IPC, or model context.
- Prompt-injection that escalates into a real action (money movement, destructive command,
  unattended execution) without the intended gate.

## Out of scope

- Issues that require the user to install a malicious model/sidecar or paste a malicious
  command themselves.
- Findings only reachable with developer tools / an unpacked dev build.
- The inherent risk of running an LLM agent you've explicitly granted permissions to.

## Security posture (how the app defends itself)

- **Sandboxed renderer** — `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`,
  a strict production Content-Security-Policy, and an `openExternal` host allowlist.
- **Validated IPC** — handlers validate input (Zod); the renderer is told only *whether* a
  key exists, never its value.
- **Network egress is gated** — agent web tools (`browse`, `deep_research`, `http_fetch`)
  run through an SSRF guard (DNS-resolves and rejects private/link-local/metadata ranges,
  with a rebind/TOCTOU re-check) and an egress policy **before** any request. **Private Mode
  is fail-closed** — network tools are denied, not risked. Untrusted page content is wrapped
  so it can't act as an instruction.
- **Filesystem confinement** — agent write/delete IPC is confined to the workspace folder
  you opened; it cannot modify files outside it.
- **Secrets at rest** — API/wallet keys are stored with the OS keychain (`safeStorage`),
  never written to disk in plaintext; the agent's shell runs with a scrubbed environment.
- **Wallet** — keys never cross IPC; real transactions require an explicit confirm; money-
  moving tools default to dry-run.
- **Supply chain** — bundled binaries and downloaded models are SHA-256-verified against
  authoritative publisher digests; packaged builds fail closed on any unpinned artifact.
- **Catastrophic-command deny** — agent shell tools hard-deny destructive commands
  (`rm -rf /`, disk wipes, fork bombs) before spawning. This is defense-in-depth, **not** an
  OS sandbox — only grant agent permissions to code/folders you trust.

The user-facing version of all of this — what private mode actually switches off,
where secrets live, what is verified before it runs — is in
[`docs/privacy-and-security.md`](docs/privacy-and-security.md).

## Using it safely

- Keep **Private Mode** on unless you intend to allow network egress.
- Only point the coding agent at folders you're comfortable letting it modify.
- Review actions the agent asks to take — approval prompts exist for a reason.
