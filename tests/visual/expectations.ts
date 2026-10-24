/**
 * Surface-specific layout expectations for the rendered visual checks (#4712).
 *
 * Unlike the generic audit in layoutAudit.ts, these encode the layout a surface
 * is designed to have, taken from the guided-manual checks they replaced
 * (#4928): MT-CRED-17 (dialog spacing), MT-UI-54 (Settings row layout) and
 * MT-UI-55 (Settings section headers). Each function runs INSIDE the page
 * (`page.evaluate(fn, args)`), so it must stay self-contained: no imports, no
 * references to module scope. Each returns `expectation` issues.
 */

import type { LayoutIssue } from "./layoutAudit";

/** Arguments for {@link stackedGapIssues}. */
export interface StackArgs {
  /** `data-testid`s of blocks that must stack top to bottom; missing ones are skipped. */
  testIds: string[];
  /** Minimum vertical gap in px between consecutive blocks. */
  minGap: number;
}

/**
 * Runs in the browser: every listed block sits below the previous one with at
 * least `minGap` px between them (MT-CRED-17: description, field, error and
 * reset link are separate lines with a clear gap).
 */
export function stackedGapIssues({ testIds, minGap }: StackArgs): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const present = testIds
    .map((id) => ({ id, el: document.querySelector(`[data-testid="${id}"]`) }))
    .filter((b): b is { id: string; el: Element } => b.el !== null);
  for (let i = 1; i < present.length; i++) {
    const above = present[i - 1];
    const below = present[i];
    const gap = below.el.getBoundingClientRect().top - above.el.getBoundingClientRect().bottom;
    if (gap < minGap) {
      issues.push({
        kind: "expectation",
        where: `${above.id} → ${below.id}`,
        detail: `vertical gap ${gap.toFixed(1)}px, expected at least ${minGap}px`,
      });
    }
  }
  return issues;
}

/**
 * Runs in the browser: the Settings rows under `root` follow their layout
 * (MT-UI-54). An inline row (toggle, single button) has its label and hint on
 * the left and the control right-aligned beside them; a stacked row has its
 * label, then the control, then the hint; the SSH key path "…" button joins
 * its input.
 */
export function settingsFieldIssues(root: string): LayoutIssue[] {
  const TOL = 1;
  const issues: LayoutIssue[] = [];
  const rootEl = document.querySelector(root);
  if (!rootEl) return [{ kind: "expectation", where: root, detail: "surface root not found" }];
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const labelOf = (field: Element): string =>
    (field.querySelector(".settings-form__label")?.textContent ?? "").trim().slice(0, 40);

  for (const field of rootEl.querySelectorAll(".settings-form__field--inline")) {
    if (!visible(field)) continue;
    const text = field.querySelector(":scope > .settings-form__field-text");
    const control = field.querySelector(":scope > .settings-form__field-control");
    if (!text || !control || !visible(control)) continue;
    const f = field.getBoundingClientRect();
    const t = text.getBoundingClientRect();
    const c = control.getBoundingClientRect();
    if (c.left < t.right - TOL) {
      issues.push({
        kind: "expectation",
        where: `inline row "${labelOf(field)}"`,
        detail: `control starts at ${c.left.toFixed(0)}px, left of the text end ${t.right.toFixed(0)}px`,
      });
    }
    if (f.right - c.right > 2 + TOL) {
      issues.push({
        kind: "expectation",
        where: `inline row "${labelOf(field)}"`,
        detail: `control ends ${(f.right - c.right).toFixed(0)}px before the row's right edge`,
      });
    }
  }

  for (const field of rootEl.querySelectorAll(".settings-form__field")) {
    if (!visible(field)) continue;
    if (field.matches(".settings-form__field--inline, .settings-form__field--checkbox")) continue;
    // Ignore zero-ish helpers (live regions, popover anchors) between the blocks.
    const children = [...field.children].filter(
      (el) => visible(el) && el.getBoundingClientRect().height >= 4
    );
    const labelIdx = children.findIndex((el) =>
      el.matches(".settings-form__label, .settings-form__label-row")
    );
    const hintIdx = children.findIndex((el) => el.matches(".settings-form__hint"));
    if (labelIdx !== 0 || hintIdx < 2) continue;
    const label = children[labelIdx].getBoundingClientRect();
    const hint = children[hintIdx].getBoundingClientRect();
    for (const control of children.slice(labelIdx + 1, hintIdx)) {
      const c = control.getBoundingClientRect();
      if (c.top < label.bottom - TOL || c.bottom > hint.top + TOL) {
        issues.push({
          kind: "expectation",
          where: `stacked row "${labelOf(field)}"`,
          detail:
            `control spans ${c.top.toFixed(0)}–${c.bottom.toFixed(0)}px, expected between ` +
            `the label (ends ${label.bottom.toFixed(0)}px) and the hint (starts ${hint.top.toFixed(0)}px)`,
        });
      }
    }
  }

  for (const wrapper of rootEl.querySelectorAll(".key-path-input")) {
    const input = wrapper.querySelector(".key-path-input__field");
    const browse = wrapper.querySelector(".key-path-input__browse");
    if (!input || !browse || !visible(input) || !visible(browse)) continue;
    const i = input.getBoundingClientRect();
    const b = browse.getBoundingClientRect();
    const gap = b.left - i.right;
    const centerDelta = Math.abs((b.top + b.bottom) / 2 - (i.top + i.bottom) / 2);
    if (Math.abs(gap) > 1 + TOL || centerDelta > 2) {
      issues.push({
        kind: "expectation",
        where: "key path input",
        detail: `the "…" button is ${gap.toFixed(1)}px from its input and ${centerDelta.toFixed(1)}px off its centre line`,
      });
    }
  }
  return issues;
}

/**
 * Runs in the browser: every Settings section header under `root` keeps its
 * title and buttons on one row (MT-UI-55, checked at the widest window; at the
 * minimum window the generic audit checks the wrapped buttons stay usable).
 */
export function oneRowHeaderIssues(root: string): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const rootEl = document.querySelector(root);
  if (!rootEl) return [{ kind: "expectation", where: root, detail: "surface root not found" }];
  for (const header of rootEl.querySelectorAll(".settings-panel__section-header")) {
    const items = [...header.children].filter((el) => el.getBoundingClientRect().height > 0);
    if (items.length < 2) continue;
    const tops = items.map((el) => el.getBoundingClientRect());
    const firstBottom = tops[0].bottom;
    if (tops.some((r) => r.top >= firstBottom - 1)) {
      const title = (items[0].textContent ?? "").trim().slice(0, 40);
      issues.push({
        kind: "expectation",
        where: `section header "${title}"`,
        detail: "title and buttons wrap onto separate rows at the widest window",
      });
    }
  }
  return issues;
}
