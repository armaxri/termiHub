# Changes

## Changed

- The workflow editor no longer scrolls twice: the step list flows in the dialog
  instead of its own scroll box. Each step of an opened workflow shows as one
  summary line (its command, delay or pattern) and expands to edit; **Expand
  all** opens every step. Triggers now sit above the steps, so they are visible
  without scrolling, and their chips show a check mark when on. Name,
  Description and Tags are evenly spaced, the per-step failure options share one
  row, and the dialog fits an 800x600 window (#5637).
