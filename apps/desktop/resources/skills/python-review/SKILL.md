---
name: python-review
description: Review checklist for Python changes — typing, packaging, error handling, and the traps that pass locally but break in CI. Load before reviewing or writing Python.
---

# Python review checklist

Structure & typing:
- Public functions carry type hints; `Any` that spreads through a call chain is a finding.
- Mutable default arguments (`def f(x=[])`) are always a bug — default to `None` and create inside.
- Dataclasses (or pydantic where already used) over ad-hoc dicts crossing function boundaries.

Errors:
- `except Exception:`-and-continue hides real failures — catch the narrow exception you can actually handle.
- Resources (files, sockets, subprocesses) are opened in `with` blocks.
- User-facing errors get messages with the failing value/path in them, not just the type name.

Correctness traps:
- Paths built with `pathlib`, not string concatenation — and never assume the CWD.
- Timezone-naive `datetime.now()` in anything persisted or compared is a finding.
- Iterating while mutating the same collection; shadowing builtins (`list`, `id`, `type`).
- Subprocess calls use argument lists, not `shell=True` with interpolated strings.

Project hygiene:
- New dependencies land in the project manifest (pyproject/requirements) with a bound, not just in the local venv.
- Follow the repo's existing formatter/linter config; do not introduce a second style.
- Tests accompany behavior changes and run with the project's configured runner.
