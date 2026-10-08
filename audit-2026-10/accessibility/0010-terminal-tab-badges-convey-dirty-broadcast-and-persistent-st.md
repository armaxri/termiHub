---
id: A11Y2-010
title: "Terminal tab badges convey dirty, broadcast and persistent state with no accessible text"
angle: accessibility
severity: medium
category: screen-reader
is_workaround: false
subsystem: "src/components/Terminal/Tab"
evidence:
  - src/components/Terminal/Tab.tsx:255
  - src/components/Terminal/Tab.tsx:258-266
  - src/components/Terminal/Tab.tsx:306-314
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The A11Y-004 fix gave the tab state dot and the macro badge role=img and an aria-label, but sibling badges in the same tab were missed. The unsaved-changes marker is a bare <span className="tab__dirty-dot"/> with no text at all. The broadcast-target badge is a <span title="Broadcast target"> wrapping a lucide icon with no role or aria-label, so its name is empty. The persistent-session badge has a title, and its content is the glyph '∞', so it is read as 'infinity'.

## Why it matters

WCAG 1.1.1 (A) and 1.4.1 Use of Color (A) for the dirty dot. The broadcast badge carries safety-relevant information: keystrokes typed in this tab are mirrored to other sessions. A screen-reader user cannot learn that a tab is a broadcast target or that an editor tab has unsaved changes before closing it.

## Recommendation

Apply the A11Y-004 pattern: role="img" plus aria-label on each badge ('Unsaved changes', 'Broadcast target: input is sent to all group members', 'Persistent session'), with aria-hidden on the inner icon or glyph. Keep title or swap it for the Tooltip primitive. Add these to the existing Tab a11y test.

## Verification

Confirmed. The dirty dot is an empty span. The broadcast badge has only a title around an unlabeled Radio icon, unlike the macro badge, which has role=img and aria-label. The persistent badge is a bare '∞' with only a title.
