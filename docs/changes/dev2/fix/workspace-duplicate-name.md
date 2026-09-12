### Changed

- Saving the current layout as a workspace under a name that already exists now
  prompts to **overwrite** the existing workspace instead of silently creating a
  second one with the identical name. Choosing "Overwrite" updates the existing
  workspace in place (keeping its position in the list), while cancelling leaves
  the Save dialog open so you can pick a different name for a distinct workspace.
  This makes re-saving under the same name a genuine update and removes the
  duplicate-named-workspace footgun (UX-027).
