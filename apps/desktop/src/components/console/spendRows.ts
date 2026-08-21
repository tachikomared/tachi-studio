// apps/desktop/src/components/console/spendRows.ts
//
// Which 30-DAY SPEND rows name a gateway you can still spend at, and which name
// something the ledger will keep printing until it ages out of the window.
//
// Pure, and deliberately outside ObservabilityTab.tsx, for the same reason
// civitaiDetail.ts sits beside its panel: the unit suite runs in node with no
// DOM, so a decision that only exists inside a component is a decision no test
// can reach.

/**
 * The harness's own name, written into the ledger's provider column by
 * tachi/loop.ts until `64c837d` (2026-08-01) — and it took TWO commits, which
 * matters because citing only the first would overstate what that one closed.
 * `64c837d` moved the loop's own writes onto the serving gateway and said so;
 * its closing paragraph then recorded, in its own words, "NOTICED, NOT FIXED:
 * fusion.ipc.ts and openclaude-client.ts record the same kind of self-label".
 * Those remaining call sites were closed the next day in `6256c92`.
 *
 * The harness is not a billing entity — it never served a token, the gateway
 * behind it did — so every row carrying this id is spend from before
 * attribution moved to that gateway.
 *
 * The id is CLOSED, and that is the only thing that makes the label below safe
 * to assert rather than guess: every branch of resolveTachiRouting now returns
 * a real gateway id, and a resolver failure aborts the session before any
 * ledger call exists, so no new event can land here. 'openclaude' is
 * deliberately NOT in this set even though it was the same defect class — it is
 * still written today as the fallback for a sidecar run whose spawn predates
 * the id capture (openclaude-client.ts ~line 300), so calling that row history
 * would be a lie the very next run could disprove.
 *
 * Nothing here deletes or rewrites a row. The spend was real and stays in the
 * total; a ledger is not edited after the fact. Only the row's NAME gains an
 * explanation of what it is.
 */
export const LEGACY_HARNESS_LEDGER_ID = 'tachi'

/** True for a ledger provider row that no live code path can add to. */
export function isLegacyHarnessRow(providerId: string): boolean {
  return providerId === LEGACY_HARNESS_LEDGER_ID
}

/**
 * The label for one per-provider spend row.
 *
 * The raw ledger id always comes FIRST and unmodified: the dashboard has to
 * stay greppable against cost-ledger.jsonl, so the tag is an addition and never
 * a substitution — a user reading "$185.75" here must be able to find the same
 * events on disk under the same name.
 *
 * An empty tag yields the bare id rather than a dangling separator: a missing
 * translation must degrade to today's display, not to `tachi · `.
 */
export function spendRowLabel(providerId: string, legacyTag: string): string {
  if (!isLegacyHarnessRow(providerId)) return providerId
  const tag = legacyTag.trim()
  return tag ? `${providerId} · ${tag}` : providerId
}
