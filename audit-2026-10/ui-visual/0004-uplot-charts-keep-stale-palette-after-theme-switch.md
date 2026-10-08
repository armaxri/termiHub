---
id: UI2-004
title: "uPlot charts (latency chart, metric sparklines) resolve theme colors once and keep the old palette after a theme switch"
angle: ui-visual
severity: low
category: ui
is_workaround: true
subsystem: "src/components/charts, NetworkTools, StatusBar"
evidence:
  - src/components/NetworkTools/LatencyChart.tsx:83
  - src/components/NetworkTools/LatencyChart.tsx:87
  - src/components/NetworkTools/LatencyChart.tsx:136
  - src/components/StatusBar/MetricSparkline.tsx:49
  - src/components/StatusBar/MetricSparkline.tsx:72
  - src/components/charts/uplot.ts:88
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

Both charts read --accent-color, --text-secondary, --border-primary and --color-error from getComputedStyle inside makeOptions, which only runs when the chart is (re)created. recreateDeps are [intervalMs, height] and [min, max, height, width], and nothing subscribes to onThemeChange or the theme setting. Switching between dark and light, or to a Solarized/custom theme, while a latency chart or monitoring sparkline is mounted leaves the canvas with the old axis, grid and line colors; for example, dark-theme grid lines (#2a2f40) on a light background. The fallbacks are also the old VS Code palette (#3794ff/#969696/#3c3c3c/#f44747), the stale-fallback pattern UI-011 removed from CSS.

## Why it matters

These are the only theme-unaware surfaces left after UI-001..012. It is visible right after a live theme switch, and sparklines are long-lived (status bar, monitoring panel). Remounting the panel works around it.

## Evidence

- src/components/NetworkTools/LatencyChart.tsx:83
- src/components/NetworkTools/LatencyChart.tsx:87
- src/components/NetworkTools/LatencyChart.tsx:136
- src/components/StatusBar/MetricSparkline.tsx:49
- src/components/StatusBar/MetricSparkline.tsx:72
- src/components/charts/uplot.ts:88

## Recommendation

Add a theme revision to recreateDeps in useUplot, for example a small useThemeRevision() hook that increments on onThemeChange and on settings.theme changes, so the canvas re-reads tokens. Replace the hex fallbacks with the variables.css dark values, or drop them; cssVar always resolves under the engine.

## Verification

Confirmed. makeOptions reads the CSS vars only inside useUplot's layout effect, and recreateDeps are [intervalMs, height] and [min, max, height, width]. Neither chart nor uplot.ts subscribes to onThemeChange or the theme setting, so a live theme switch keeps the old canvas colors until remount. The fallbacks are the old VS Code hex values.
