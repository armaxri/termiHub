---
id: CORE-038
title: panel_tree can panic on an empty Split node
angle: backend-core-rust
severity: medium
category: bug
is_workaround: false
subsystem: core/layout
evidence:
  - core/src/layout/panel_tree.rs
status: open
---

## What
The panel-tree algebra can panic when a `Split` node has no children (an empty
`Split`), e.g. indexing/`first`/ratio math that assumes at least one child
(reported by the plugin/files/layout audit).

## Why it matters
Layout state is persisted and restored (workspace save/restore) and mutated by
split/close operations; a state that reaches an empty `Split` — via a close
sequence or a restored/hand-edited workspace file — panics the thread performing
layout, taking down the UI's layout handling. On a safety-critical release a
panic on restored state is a crash-on-open risk.

## Evidence
`core/src/layout/panel_tree.rs` (Split-child access without an emptiness guard).
The proptest suite (`panel_tree/tests.rs`) exercises tree ops but the empty-Split
invariant is where the panic hides.

## Recommendation
Make the type enforce the invariant (a `Split` always has ≥2 children — e.g. a
non-empty children representation) or guard every child access and collapse an
empty/single-child `Split` into its parent/child. Add a proptest/regression case
that closes panels down to empty and asserts no panic.
