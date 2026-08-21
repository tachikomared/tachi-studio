---
name: react-review
description: Review checklist for React components and hooks — load before reviewing or refactoring React/JSX code so common state, effect, and list-rendering mistakes get caught.
---

# React review checklist

Walk every changed component against this list; call out only real findings.

State & props:
- State that can be derived from props/other state should be computed, not stored.
- No mutation of state or props in place (`arr.push`, `obj.x =`) — always produce new objects.
- Lift state only as high as it must go; a global store is not a default.

Effects:
- Every `useEffect` answers "what external system is this synchronizing with?" — effects that just transform data should be plain renders or `useMemo`.
- Dependency arrays are complete; missing deps hidden by an eslint-disable are a finding.
- Effects that subscribe/listen return a cleanup function.

Rendering:
- List keys are stable identifiers, never the array index when items reorder.
- Expensive children re-render only when their inputs change (`memo`/`useMemo` where measurement justifies it — not sprinkled by default).
- Conditional rendering never changes hook order.

Boundaries:
- User-facing strings go through the project's i18n layer, not hardcoded JSX text.
- Event handlers passed as props are stable when the child depends on identity.
- Errors from async handlers are surfaced to the user, not swallowed.
