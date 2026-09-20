### Added

- Workflows can now branch with a **conditional step** (PROD-0044, slice 1). A
  conditional evaluates a structured comparison — a left operand, an operator
  (`equals`, `not equals`, `greater than`, `less than`, `greater or equal`,
  `less or equal`, `contains`), and a right operand — and runs its **Then**
  steps when the condition holds or its optional **Else** steps otherwise. Both
  operands may reference workflow parameters as `${name}`, resolved at run time
  just like a command's text. A false condition with no Else branch is a no-op
  and never fails the run. The workflow editor gains a condition builder and
  Then/Else sub-step lists; existing workflows are unaffected and load
  unchanged.
