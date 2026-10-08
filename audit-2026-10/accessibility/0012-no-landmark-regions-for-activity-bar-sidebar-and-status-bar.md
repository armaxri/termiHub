---
id: A11Y2-012
title: "No landmark regions for activity bar, sidebar and status bar"
angle: accessibility
severity: low
category: aria
is_workaround: false
subsystem: "src/App.tsx, src/components/ActivityBar, src/components/StatusBar"
evidence:
  - src/App.tsx:323-352
  - src/components/Terminal/TerminalView.tsx:568
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The app shell is built from plain <div>s. Apart from TerminalView's role="region" aria-label="Terminal" and two local <nav>s (settings nav, path bar), there is no <main>, navigation landmark for the activity bar, complementary landmark for the sidebar, or contentinfo/region for the status bar. The first audit recorded this as an observation; it is unchanged.

## Why it matters

WCAG 1.3.1 (A) and 2.4.1 Bypass Blocks (A). Screen-reader users cannot jump between activity bar, sidebar, editor area and status bar with landmark navigation, so reaching the terminal means tabbing through every sidebar control.

## Recommendation

Wrap ActivityBar in <nav aria-label="Activity bar">, Sidebar in <aside aria-label={activeView name}>, TerminalView in <main>, and StatusBar in <footer> or role="contentinfo". Optionally add an F6 region-cycling shortcut, as VS Code does.

## Verification

Confirmed. The app shell has no main, aside, nav or contentinfo landmark (only TerminalView's region plus the settings and path-bar navs). The first audit recorded this as an unresolved observation in audit/accessibility/\_summary.md:67, not as a deliberate decision.
