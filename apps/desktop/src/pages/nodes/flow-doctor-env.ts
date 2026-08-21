// apps/desktop/src/pages/nodes/flow-doctor-env.ts
//
// NODES-RESEARCH #4 — the IMPURE half of the self-healing template check. This
// gathers the plain-data snapshot that the PURE analyzer (flow-doctor.ts) reads.
//
// Every window.tachi.* read is individually try/caught: a missing API or a
// rejected call leaves its env field UNDEFINED, which makes the analyzer skip
// the dependent check (fail-open — never invent a broken-flow warning because a
// probe failed). We also only reach for what the flow actually references (no
// llama.cpp status read unless a llama.cpp node exists, etc.), so a plain
// cloud-only flow does zero local-engine I/O.

import { listProviders } from '@tachi/core/src/providers/registry'
import { canonicalProviderId } from './providerCompat'
import type { FlowDoctorEnv } from './flow-doctor'
import type { TachiNode } from './types'

type Tachi = any
function tachi(): Tachi | undefined {
  return (typeof window !== 'undefined' ? (window as any).tachi : undefined)
}

/** Run a probe, swallowing ANY failure (missing API, reject, throw) → undefined. */
async function safe<T>(fn: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

function nodeProviderIds(nodes: readonly TachiNode[], type: 'provider'): string[] {
  const out: string[] = []
  for (const n of nodes) {
    if (n?.type !== type) continue
    const raw = (n.data as { providerId?: unknown }).providerId
    if (typeof raw === 'string' && raw) out.push(canonicalProviderId(raw))
  }
  return out
}

/**
 * Build the env snapshot for the CURRENT flow. Selective + resilient: each
 * section is guarded and only runs when the flow references that concern.
 */
export async function gatherFlowEnv(nodes: readonly TachiNode[]): Promise<FlowDoctorEnv> {
  const api = tachi()
  if (!api) return {} // no bridge (tests / early boot) → analyzer fully fail-open

  const env: FlowDoctorEnv = {}

  // ── Provider keys + connection state ────────────────────────────────────────
  const storedKeys = await safe<string[]>(() => api.settings?.listKeys())
  if (Array.isArray(storedKeys)) {
    env.storedKeys = storedKeys
    // Ready = keyless OR key present — mirrors ProviderPicker.isReady.
    env.connectedProviders = listProviders()
      .filter(p => !p.keychainId || storedKeys.includes(p.keychainId))
      .map(p => p.id)
  }

  // ── Local engine (llama.cpp) model state — only if a llama.cpp node exists ──
  const providerIds = nodeProviderIds(nodes, 'provider')
  if (providerIds.includes('llama-cpp')) {
    const status = await safe<{ state?: string; modelId?: string; downloadedModels?: string[] }>(
      () => api.llamaCpp?.status(),
    )
    if (status && typeof status === 'object') {
      const installed = Array.isArray(status.downloadedModels) ? status.downloadedModels : []
      const loaded = status.state === 'running' && typeof status.modelId === 'string' && status.modelId
        ? [status.modelId]
        : []
      env.localModels = { installed, loaded }
    }
  }

  // ── Codex installed? — only if a codex agent node exists ────────────────────
  const hasCodexAgent = nodes.some(
    n => n?.type === 'agent' && (n.data as { harnessId?: unknown }).harnessId === 'codex',
  )
  if (hasCodexAgent) {
    const status = await safe<{ installed?: boolean }>(() => api.codex?.status())
    if (status && typeof status.installed === 'boolean') env.codexInstalled = status.installed
  }

  // ── RIFE sidecar installed? — only if an interpolate node exists ────────────
  // The status call is cheap (it stats a directory), but a cloud-only flow has
  // no business asking, and rife:status is absent in older builds — hence the
  // same guard-then-probe shape as codex above, leaving the field undefined
  // (→ check skipped) whenever the answer is not a real boolean.
  if (nodes.some(n => n?.type === 'rife')) {
    const status = await safe<{ installed?: boolean }>(() => api.rife?.status())
    if (status && typeof status.installed === 'boolean') env.rifeInstalled = status.installed
  }

  // ── Folder existence — only for folder nodes with a concrete path ───────────
  const folderPaths = Array.from(new Set(
    nodes
      .filter(n => n?.type === 'folder')
      .map(n => (n.data as { path?: unknown }).path)
      .filter((p): p is string => typeof p === 'string' && p.trim() !== ''),
  ))
  if (folderPaths.length > 0) {
    const res = await safe<{ existing?: Record<string, boolean> }>(
      () => api.nodes?.pathsExist(folderPaths),
    )
    if (res && res.existing && typeof res.existing === 'object') env.existingFolders = res.existing
  }

  // ── Available skills (installed SKILL.md + roles) — only if a skill node ─────
  const hasSkillNode = nodes.some(n => n?.type === 'skill')
  if (hasSkillNode) {
    const available = new Set<string>()
    const skills = await safe<{ skills?: Array<{ name?: string }> }>(() => api.skills?.list())
    if (skills && Array.isArray(skills.skills)) {
      for (const s of skills.skills) if (typeof s?.name === 'string') available.add(s.name)
    }
    const roles = await safe<Array<{ id?: string }>>(() => api.roles?.list())
    if (Array.isArray(roles)) {
      for (const r of roles) if (typeof r?.id === 'string') available.add(r.id)
    }
    // Only assert availableSkills when at least ONE source answered — otherwise
    // leave it undefined so the analyzer fail-opens the skill check.
    if (skills !== undefined || roles !== undefined) env.availableSkills = Array.from(available)
  }

  return env
}
