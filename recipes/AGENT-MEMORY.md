# Recipe: agent context files (scoped rules + learned notes)

Two conventions govern what an agent knows about this repo. Both live in the
repo (so the knowledge travels with a clone), both use the same filename, and
both are wired in `apps/desktop/electron/services/tachi/`.

## 1. Scoped rules — nested `AGENTS.md`

A subdirectory's `AGENTS.md` is the guidance for files under that
subdirectory. The root file is injected into the system prompt once per
session; nested ones are injected LAZILY:

- when a tool (`read`/`write`/`edit`/`grep`/`blast_radius`) touches a path,
  the nearest ancestor `AGENTS.md` **below the root** is appended to that tool
  result as a `[scoped rules — <rel> · applies to files under <dir>/]` block;
- once per rules file per session (never re-shown), ≤2000 chars per file and
  ≤6000 chars per session total — over budget, a file is skipped, not trimmed
  into nonsense;
- the root `AGENTS.md` is excluded (already in the prompt).

Where to put a rule: the narrowest directory it is true for. A rule about
i18n key parity belongs in `apps/desktop/AGENTS.md`, not the root file — the
root file is paid for on every call of every session.

Code: `scoped-rules.ts` (`findNearestScopedRules`, `ScopedRulesSession`),
hooked at the tool-result boundary in `loop.ts`. Off switch:
`TACHI_SCOPED_RULES=0`, or `scopedRules: false` on the session options.

## 2. Learned notes — `remember_convention`

`## Learned notes (TACHI)` in the root agent-context file is the harness's
durable memory. The `remember_convention(note)` tool appends one line there,
and the next session reads it back as ordinary project context (the same file
the injection wire already loads — `AGENTS.md`, else `TACHI.md`, else
`CLAUDE.md`; that order is `PROJECT_CONTEXT_FILES`, shared by the reader and
the writer so they cannot drift).

Write a note only when ALL of these hold:

- you VERIFIED it this run (a tool result proved it, not a guess);
- it is specific to THIS project (not general programming knowledge);
- it is durable (still true next month, not "the build is currently broken");
- it isn't already written down where the next agent would look;
- it is one sentence — if it needs a paragraph, write a doc and record a
  one-line pointer to it.

Limits, and what happens at the edge (nothing is ever silently discarded):

| Limit | Value | On overflow |
| --- | --- | --- |
| note length | 400 chars | rejected, nothing written |
| notes per section | 40 | rejected — prune/merge existing notes first |
| section size | 6000 chars | rejected, nothing written |
| duplicate / near-duplicate | — | no-op, tells you the existing note |

It is a normal file write: the same permission prompt, plan-mode block, role
boundary and sandbox as `write`. It is deliberately NOT counted as a workspace
mutation, so recording a note never drags a read-only run through the verify
policy.

Code: `knowledge.ts` (pure append/dedup/cap logic + host resolution), tool
registered in `loop.ts`. Tests: `apps/desktop/test/unit/tachiKnowledge.test.ts`
and `tachiScopedRules.test.ts`.
