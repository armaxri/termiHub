---
id: FEC-012
title: TerminalSlot RAF-path adoption returns cleanup that never parks the xterm element back
angle: frontend-components
severity: medium
category: bug
is_workaround: false
subsystem: src/components/SplitView
evidence:
  - src/components/SplitView/SplitView.tsx:1022
status: fixed
resolution: "#2808 — SplitView RAF-branch cleanup now parks xterm el back (shared teardown)"
---

## What
`TerminalSlot` adopts the imperative xterm DOM element into its slot. When the
element is not yet registered on first render, adoption is retried inside a RAF,
but the cleanup returned on that branch only cancels the RAF — it never parks the
element back:
```ts
if (!tryAdopt()) {
  const rafId = requestAnimationFrame(() => tryAdopt());
  return () => cancelAnimationFrame(rafId);        // no park-back
}
return () => {
  const termEl = getElement(tabId);
  if (termEl && termEl.parentNode === slotEl) parkingEl?.appendChild(termEl);  // park-back
};
```

## Why it matters
If the slot unmounts after a RAF-path adoption (tab moved/closed in the same
frame window), the xterm element stays parented to the now-detached `slotEl`
instead of the parking node. It usually self-heals because the registry still
hands the element to the next slot's `tryAdopt`, but on a *final* unmount the
element is orphaned inside a detached node — a DOM/xterm-instance leak, and the
kind of adoption edge that has repeatedly caused the parking/reattach bugs this
file documents (2-col reflow, blank panes).

## Evidence
`src/components/SplitView/SplitView.tsx:1022-1034`.

## Recommendation
Have both cleanup branches share one teardown that cancels the pending RAF *and*
parks the element back if it is still parented to `slotEl`.
