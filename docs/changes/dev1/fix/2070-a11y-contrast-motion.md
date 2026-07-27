### Fixed

- Accessibility: several theme text colors now meet the WCAG 2.2 AA minimum
  contrast ratio (4.5:1) for normal text. The muted text color (`--text-muted`)
  was too faint in both built-in themes and the light theme's warning color was
  too light for text use; they were adjusted so they pass AA against both the
  primary and sidebar backgrounds (dark `--text-muted` `#7d7d7d` → `#909090`,
  light `--text-muted` `#858a90` → `#686d74`, light `--color-warning` `#b08800`
  → `#856900`) (#2070).
- Accessibility: added a global `prefers-reduced-motion: reduce` backstop so
  that when the operating system requests reduced motion, animations and
  transitions that were not individually guarded are neutralized instead of
  played (#2070).
