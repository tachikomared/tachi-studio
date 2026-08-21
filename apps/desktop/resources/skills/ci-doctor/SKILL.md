---
name: ci-doctor
description: Diagnose and harden CI pipelines (GitHub Actions and friends) — load when a workflow fails, is slow, or needs review for safety and cache correctness.
---

# CI pipeline doctor

Failure triage, in order:
1. Read the FIRST failing step's log, not the last — later failures usually cascade.
2. Reproduce locally with the exact command the workflow runs (not the near-equivalent you normally type).
3. Check what changed: the diff, the runner image, and any unpinned action/tool version that could have moved underneath.

Review checklist for workflow files:
- Actions are pinned (tag at minimum; commit SHA for anything with secrets access).
- `permissions:` is declared and minimal — default token write access is a finding.
- Secrets never appear in `run:` echo/debug lines and are not passed to forks' PR runs.
- Caches key on the lockfile hash, and a cache miss still builds correctly.
- Jobs that can run in parallel do; long serial chains get split.
- Timeouts are set — a hung job should fail in minutes, not hours.
- Matrix entries that always fail together are one entry, not noise.

Speed levers worth checking before exotic ones:
- Dependency cache actually hitting (look at the restore log line).
- Shallow clone (`fetch-depth: 1`) unless history is needed.
- Skipping doc-only changes via path filters.
