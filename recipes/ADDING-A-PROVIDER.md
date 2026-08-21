# Adding a provider — the real checklist

The registry claims "one entry appears everywhere". That is true for the
PICKERS, but SEVEN surfaces keep their own provider logic and silently
ignore a new provider until touched. imgnAI took 4 fix rounds because each
gap only showed up at runtime. Next provider: walk this list top to bottom.

## 1. Registry (the advertised step)
- `packages/core/src/providers/registry.ts` — ProviderId union + descriptor
  (baseUrl WITHOUT trailing slash, keychainId, capabilities, hint).
- `packages/core/src/providers/__tests__/registry.test.ts` — count + order.
- Capability entries in `packages/core/src/tachi/models.ts` for its model ids
  (longest-substring: prefixed entries beat short generic ones).

## 2. Chat — apps/desktop/electron/services/chat-service.ts
PER-PROVIDER BRANCHES, not registry-driven. No branch = message sent into the
void with NO error. Clone the venice branch (lean: key check → messages →
fetch baseUrl/chat/completions stream → streamOpenAiCompatDeltas). Also add
the provider to PROVIDER_MAX_TOKENS_CHAT (D4 context tracker).

## 3. Key reporting — apps/desktop/electron/ipc/settings.ipc.ts
list-keys derives provider ids from the registry SINCE imgnai (was hardcoded;
"✓ Key stored" never showed). Nothing to do unless you add a NON-provider key
→ NON_PROVIDER_KEY_IDS.

## 4. Settings card — apps/desktop/src/pages/settings/SettingsPage.tsx
One card component per provider (copy VeniceCard) + mount in the Connections
section + settings.json i18n ×8.

## 5. Health/models probe — apps/desktop/electron/services/model-discovery.ts
PROBES table. Missing entry = Providers page says "unreachable" and the
generic model list is empty even when the API is fine.

## 6. Nodes canvas (agent-kit) — FOUR hops
- `electron/services/agentkit-adapters.ts` — make<X>Adapter + AgentKitProviderId
  union + makeAdapterFor case.
- `electron/services/graph-to-agentkit.ts` — mapProviderId case + CompileOpts
  key field + adapter-opts switch case + explicit-model list (named catalogs
  reject 'auto').
- `electron/ipc/graph.ipc.ts` — retrieveKey at BOTH call sites + opts pass.
- `src/pages/nodes/providerCompat.ts` GRAPH_PROVIDER_IDS (+ its unit test).

## 7. Design tab — src/pages/design/DesignPage.tsx
DESIGN_PROVIDER_IDS literal (the generator itself is registry-generic via
resolveEndpoint — only the dropdown list is hardcoded).

## 8. CODE tab (agent harness) — the deepest chain
- `src/store/agent.store.ts` AgentProvider union
- `src/pages/agent/AgentPage.tsx` ProviderPicker options (+ fusionEligible
  lists ONLY if fusion-capable)
- `src/types/electron.d.ts` + `electron/preload.ts` startSession unions
- `electron/ipc/agent.ipc.ts` zod enum + kind mapping
- `electron/ipc/agent-runtime.ipc.ts` + `electron/store/agent-runtime.store.ts`
- `electron/services/sidecar-manager.ts` (openclaude env builders)
- `electron/services/tachi/provider.ts` (TACHI harness)
- agent.json i18n ×8 (provider.<x>Hint)

## 9. Egress policy — electron/services/egress-policy.ts
Cloud providers must be in the cloud list or PRIVATE MODE won't block them.

## 10. Media (only if the provider does image/video/tts)
Mirror the imgnai-media pattern: service (submit+poll in MAIN, download
expiring assets immediately) + zod IPC router + preload + electron.d.ts +
MediaPage provider row + media.json i18n.

## Keyless upstreams — the Kilo pattern (2026-08-01, revised same day)

**Read the ending first: Kilo Gateway is no longer a provider.** It shipped as
the first `auth:'none'` cloud provider in the morning and was removed the same
day by owner decision — it is now an upstream INSIDE the FreeLLM local router
(`freellmapi-local`), reached through the relay's vendored provider pool, not
through a picker row. The pattern below is still the right pattern; what
changed is WHERE it applies. Ask this question first:

> Does this keyless endpoint give the user a reason to CHOOSE it over the free
> router — a capability the router cannot reach, or a different trust boundary?

If not, it belongs behind `freellmapi-local` as another upstream, not in front
of the user as another decision. Adding a row to a picker is the expensive
option: ten surfaces, eight locales, and one more thing to explain.

### Adding a keyless upstream to the relay (the default path)
The relay is vendored from a pinned upstream commit plus TachiDesk patches in
`scripts/patches/`, applied IN ORDER by `scripts/download-sidecars.mjs` at
package time and by `freellmapi-installer.ts` at runtime (the patches ship as
an `extraResources` entry so both paths build the SAME relay — they drifted
before, and the runtime path silently produced a weaker free route).

- Add the platform to the relay's `Platform` union, provider registration,
  keys-route allowlist and a `migrateModelsV<N>` catalog block. See
  `freellmapi-kilo-zen-freeroute.patch` for the shape.
- The router only considers a platform with **at least one key row**, so a
  keyless upstream still needs a placeholder key seeded from
  `sidecar-manager.ts`'s `anon` list. That list is also the cheapest failover
  control there is: the key check happens BEFORE any socket is opened, so an
  upstream absent from it costs exactly zero per send.
- If the gateway rejects a present-but-bogus bearer while serving anonymous
  traffic fine (OpenCode Zen does), set `omitAuth` on the provider so the
  placeholder never reaches the wire. Empty-string bearer is NOT the same as
  no header.
- **Order deliberately.** New catalog rows land at `MAX(priority)+n` — dead
  last — which buries a good upstream. Give the best few an explicit negative
  lead priority and leave the rest at the tail. Keep the lead band SMALL: the
  router's penalty caps at `MAX_PENALTY`, so a lead row can sink but never fall
  past the keyed providers, making each lead row a round-trip the user pays for
  if that upstream dies. Put a different vendor in the last lead slot so a
  single gateway's outage fails over across vendors.
- **Probe before and after, with a nonce in every prompt.** A cached 200 is not
  a live answer. Record the status codes in the patch header; an upstream that
  4xxs is worse than an absent one because it burns a failover attempt.

### If it really must be its own provider
The ten surfaces above all apply, plus these decisions — each was pinned in
shipped code, and the tests that survived the Kilo removal still enforce them:

- Registry row: `auth:'none'` and NO keychainId. keychainId doubles as the
  picker's requiresKey gate, so omitting it is what removes the key prompt.
  `billing:'free'` is load-bearing, not decorative: the cost ledger derives its
  known-$0 set from it and the AUTO ladder's free rung derives membership from
  it. Flip it and both react without edits.
- Settings card with NO key input — prose only: what it is, the no-key line,
  the training notice. Nothing to paste.
- NO validator when the upstream cannot distinguish keys. Kilo 200s ANY
  Authorization value including garbage (measured 2026-08-01), so a key can't
  be validated — the probe stays `authKind:'none'`, answering "reachable?" and
  nothing else. A probe-derived ✓ would be the Bankr-health bug again: a green
  tick from an endpoint that never checked the credential is a lie the user
  will trust. Corollary: send NO Authorization header at all.
- Dated whitelists, never suffix rules. The free set is exact-id membership
  verified against the provider's own catalog on a stated date (same discipline
  as pricing.ts VERIFIED_FREE_MODELS). `:free` is a NAME: OpenGateway bills
  tencent/hy3 while still publishing the tencent/hy3:free alias. Filter the
  live catalog to the whitelist so a paid row can never reach a keyless picker.
  (Kilo's whitelist has already rotted once — `openrouter/free` left the live
  catalog within the day. A second copy of a provider's catalog is a liability;
  inside the relay there is exactly one.)
- Free is a price, not a place. Keyless ≠ local: the provider goes in the
  egress-policy.ts cloud list (#9) so PRIVATE MODE blocks it, and `billing`
  stays a separate registry fact from `egress` — a surface that wants "$0, and
  the prompt still left this machine" asks BOTH (run-cost.ts).

### The disclosure rule (the one that outlived the provider)
Kilo's catalog reports `mayTrainOnYourPrompts` on every free row. When Kilo was
a picker row, the disclosure lived on its card and its hint. When it moved
behind the router, the disclosure had to move WITH THE TRAFFIC — onto
`freellmapi-local`'s registry hint, the Free Providers card, and the
`freellmapi` i18n namespace's `disclosure` block in 8 locales — because a user
who picks "the free router" can now be served by Kilo without ever seeing a
Kilo surface.

**The rule: a disclosure belongs on the surface where the user makes the
choice, not on the component that happens to make the request.** Moving an
upstream without moving its disclosure makes the app quieter about the same
risk. Pinned by `providerKeyProbe.test.ts` ("the free route discloses that some
upstreams may train on prompts") and by the `trainsOnPrompts` flag on
`freellmapi-providers.ts` rows.

## Verify (all on the INSTALLED build)
Chat reply live · "✓ Key stored" · health/models · nodes palette + a dropped
provider node · design dropdown · CODE picker + one harness start (missing-key
error text) · media generate (or its honest key hint) · private mode blocks it.
