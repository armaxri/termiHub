/**
 * Surface-specific layout expectations for the rendered visual checks (#4712).
 *
 * Unlike the generic audit in layoutAudit.ts, these encode the layout a surface
 * is designed to have, taken from the guided-manual checks they replaced
 * (#4928): MT-CRED-17 (dialog spacing), MT-UI-54 (Settings row layout),
 * MT-UI-55 (Settings section headers) and MT-UI-53 (sidebar rows, #4954). Each function runs INSIDE the page
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

/** Arguments for {@link rowActionIssues}. */
export interface RowActionArgs {
  /** Selector of the one row under test. */
  row: string;
  /** Selector of its action controls, inside the row. */
  actions: string;
  /** How the row got its state, for the report (`hover` / `focus`). */
  via: string;
}

/**
 * Runs in the browser: while the row is hovered or holds keyboard focus, each
 * of its actions is painted (no transparent ancestor), takes pointer events,
 * lies inside the sidebar and the window, and is the topmost element at its
 * centre, so it is neither clipped nor covered (MT-UI-53, #4954).
 */
export function rowActionIssues({ row, actions, via }: RowActionArgs): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const rowEl = document.querySelector(row);
  const sidebar = document.querySelector("[data-testid=sidebar]");
  if (!rowEl || !sidebar) return [{ kind: "expectation", where: row, detail: "row not found" }];
  const name = (rowEl.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
  const where = `row "${name}" (${via})`;
  const controls = [...rowEl.querySelectorAll<HTMLElement>(actions)];
  if (controls.length === 0) {
    return [{ kind: "expectation", where, detail: `no action matches ${actions}` }];
  }
  const s = sidebar.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  for (const control of controls) {
    const label = control.getAttribute("aria-label") ?? control.textContent?.trim() ?? "?";
    const fail = (detail: string) =>
      issues.push({ kind: "expectation", where, detail: `action "${label}" ${detail}` });
    let opacity = 1;
    for (let n: Element | null = control; n && n !== document.body; n = n.parentElement) {
      opacity *= parseFloat(getComputedStyle(n).opacity);
    }
    if (opacity < 0.99) {
      fail(`is not shown (opacity ${opacity.toFixed(2)})`);
      continue;
    }
    if (getComputedStyle(control).pointerEvents === "none") fail("ignores the pointer");
    const b = control.getBoundingClientRect();
    if (b.width < 2 || b.height < 2) {
      fail(`is squeezed to ${b.width.toFixed(1)}x${b.height.toFixed(1)}px`);
      continue;
    }
    const outside =
      b.left < Math.max(0, s.left) - 1 ||
      b.right > Math.min(vw, s.right) + 1 ||
      b.top < -1 ||
      b.bottom > vh + 1;
    if (outside) {
      fail(
        `spans x ${Math.round(b.left)}..${Math.round(b.right)}, y ${Math.round(b.top)}..` +
          `${Math.round(b.bottom)} outside the sidebar or window`
      );
      continue;
    }
    const hit = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
    if (!hit || !control.contains(hit)) {
      const by = hit ? `${hit.tagName.toLowerCase()}.${String(hit.className).split(" ")[0]}` : "";
      fail(`is covered or clipped at its centre${by ? ` (by ${by})` : ""}`);
    }
  }
  return issues;
}

/** Arguments for {@link cutNames}. */
export interface CutNameArgs {
  /** Selector of every row of one kind. */
  rows: string;
  /** Selector of the row's name, inside the row. */
  name: string;
}

/** One ellipsis-cut row name found by {@link cutNames}. */
export interface CutName {
  /** Index of the row among `rows`. */
  index: number;
  /** The full name text. */
  text: string;
  /** Whether a native `title` on the name or an ancestor up to the row holds it. */
  titled: boolean;
}

/**
 * Runs in the browser: the row names that do not fit their box, and whether a
 * native `title` carries the full text. The spec hovers the untitled ones and
 * expects the `TruncatedText` tooltip to show the full text instead.
 */
export function cutNames({ rows, name }: CutNameArgs): CutName[] {
  const out: CutName[] = [];
  document.querySelectorAll(rows).forEach((rowEl, index) => {
    const nameEl = rowEl.querySelector<HTMLElement>(name);
    if (!nameEl || nameEl.scrollWidth <= nameEl.clientWidth + 1) return;
    const text = (nameEl.textContent ?? "").trim();
    let titled = false;
    for (let n: Element | null = nameEl; n; n = n.parentElement) {
      if ((n.getAttribute("title") ?? "").includes(text)) titled = true;
      if (n === rowEl || titled) break;
    }
    out.push({ index, text, titled });
  });
  return out;
}
