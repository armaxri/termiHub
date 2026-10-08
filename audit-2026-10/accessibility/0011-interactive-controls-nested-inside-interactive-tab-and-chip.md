---
id: A11Y2-011
title: "Interactive controls nested inside interactive tab and chip elements"
angle: accessibility
severity: low
category: aria
is_workaround: false
subsystem: "src/components/Terminal"
evidence:
  - src/components/Terminal/TabGroupChips.tsx:136-160
  - src/components/Terminal/Tab.tsx:285-298
  - src/components/Terminal/Tab.tsx:324-336
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The tab-group chip is a <button> that contains a <span role="button" aria-label="Close …"> with only onClick: it is not focusable and has no key handler, and nested buttons are invalid. The terminal tab (role="tab") contains focusable <button>s (Close, controlled-by-window), whose labels are folded into the tab's own accessible name. The close label is the generic 'Close', not 'Close <title>'.

## Why it matters

WCAG 4.1.2 (A); this is the axe 'nested-interactive' rule. Screen readers flatten or skip the inner control, so the tab-group close cannot be reached by keyboard except through the context menu (Shift+F10). The tab name becomes '<title> Close', and several 'Close' buttons cannot be told apart.

## Recommendation

Move the close controls out of the button/tab element into a sibling wrapper (a role="presentation" container holding tab + close button), or drop the inner control and expose close via Delete/Backspace on the focused tab or chip plus the context menu. Name close buttons `Close ${title}`.

## Verification

Confirmed. TabGroupChips nests a span role=button with only onClick (not focusable) inside a <button>. The role=tab div in Tab.tsx contains focusable buttons, including one generically named 'Close'.
