---
name: docker-helper
description: Writing and reviewing Dockerfiles and compose files — layer ordering, image size, build cache, and container hygiene. Load before touching Docker assets.
---

# Docker build & compose helper

Dockerfile checklist:
- Order layers by change frequency: base → system packages → dependency manifests + install → source copy → build. Copying source before installing deps kills the cache.
- Use a specific base tag (`node:22-slim`), never `latest`.
- Multi-stage: build tools stay in the builder stage; the final image carries runtime artifacts only.
- One `.dockerignore` exists and excludes VCS dirs, local env files, build output, and dependency folders.
- The container runs as a non-root user unless there is a stated reason.
- Secrets are never baked in via `ENV`/`ARG` that survive into the image — pass them at runtime.
- `CMD` is exec-form (`["node","server.js"]`) so signals reach the process and shutdown is clean.

Compose checklist:
- Services declare `depends_on` with healthchecks when startup order matters — "it usually boots first" is not ordering.
- Volumes: named volumes for data that must survive, bind mounts only for dev workflows.
- Ports bound to localhost in dev unless external exposure is intended.

Debugging quick moves:
- Build failing at a step → rerun with the target stage and inspect: `docker build --target <stage>`.
- Big image → check layer sizes with the image history before reaching for tools.
