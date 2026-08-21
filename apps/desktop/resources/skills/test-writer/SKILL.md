---
name: test-writer
description: How to add unit tests that actually protect behavior — scoping, naming, edge cases, and what NOT to test. Load before writing or extending a test file.
---

# Test authoring guide

Before writing:
- Find the project's existing runner and follow its file layout and naming exactly (look at a neighboring `*.test.*` file first).
- Test the PUBLIC behavior of a unit, not its private helpers — if a helper needs direct tests, that is a hint to extract it.

What every new test file should cover:
- The happy path with realistic (not toy) input.
- Each documented failure mode: bad input, missing file, empty collection, zero/negative numbers.
- Boundaries: exactly-at-limit, one-over-limit, empty string, unicode where strings flow through.
- Idempotence/round-trips when the API implies them (parse↔serialize, save↔load).

Rules:
- One behavior per test; the test name states the expected outcome, not the method name.
- No sleeps and no real network — inject clocks and fetchers; use temp dirs for fs and clean them in `afterEach`.
- Deterministic: a test that can flake is worse than no test.
- Assert on results and observable side effects, not on internal call sequences, unless the call IS the contract.

Do not:
- Snapshot large blobs "for coverage".
- Duplicate the implementation's logic inside the assertion.
- Leave a failing expectation commented out — delete or fix.
