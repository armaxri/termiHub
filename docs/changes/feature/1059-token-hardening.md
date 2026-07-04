## Fixed

- **Light theme:** primary-button, badge, and overlay text no longer renders as hardcoded white on light surfaces — it now uses a theme-aware `--text-on-accent` token.

## Changed

- Unified all modal/dialog overlay scrims and their blur onto shared `--overlay-bg` / `--overlay-blur` tokens for a consistent look across the app.
- Tab group chips now use the app's standard auto-hide scrollbar instead of suppressing it, completing the scrollbar unification.
