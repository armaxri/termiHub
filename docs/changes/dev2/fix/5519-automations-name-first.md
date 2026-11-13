### Changed

- Macro and workflow lists now lead with the automation's **name**. The
  step-count badge that sat in front of the name in the Macros and Workflows
  sidebars is gone, and the run-history rows no longer start with a `3/3`
  counter — a run that stopped early notes how far it got (`1/4 steps`) in the
  details line after the name instead. In the command palette, macro and
  workflow entries show just the name (the trailing `macro` / `workflow` tag
  already says what they are); typing "run macro" or "run workflow" still finds
  them. (#5519)
