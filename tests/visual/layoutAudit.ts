/**
 * Baseline-free layout assertions for the rendered visual checks (#4712).
 *
 * {@link auditLayout} runs INSIDE the page (`page.evaluate(auditLayout, args)`),
 * so it must stay self-contained: no imports, no references to module scope.
 * It measures the live DOM of one surface and reports every:
 *
 * - `overflow`        — an element that sticks out of the surface horizontally;
 * - `clipped-control` — an interactive control cut off by an ancestor that
 *                        clips (`overflow: hidden|clip`) or by the window edge,
 *                        or squeezed to nothing;
 * - `truncated-text`  — ellipsis-truncated text left with less than ~4
 *                        characters of room (a name shown as `te…`);
 * - `text-overlap`    — a line of text overlapping an interactive control's box
 *                        (including its focus ring) or another element's text;
 * - `unstyled-class`  — a class a `ui/` primitive emits, which some stylesheet in
 *                        the repo styles, but which no LOADED stylesheet defines
 *                        (the CSS lives in a chunk that has not been loaded).
 */

/** One layout problem found on a surface. */
export interface LayoutIssue {
  kind:
    | "overflow"
    | "clipped-control"
    | "truncated-text"
    | "text-overlap"
    | "unstyled-class"
    // Raised by the spec, not by auditLayout:
    | "expectation"
    | "console-error";
  /** Short human description of the offending element. */
  where: string;
  /** What is wrong, with the measured numbers. */
  detail: string;
}

/** Arguments for {@link auditLayout}. */
export interface AuditArgs {
  /** CSS selector of the surface root to audit. */
  root: string;
  /** `ui/` primitive classes that a repo stylesheet defines (see uiClasses.ts). */
  styledClasses: string[];
}

/** Runs in the browser: audit one surface and return its layout issues. */
export function auditLayout({ root, styledClasses }: AuditArgs): LayoutIssue[] {
  const TOL = 1;
  const issues: LayoutIssue[] = [];
  const rootEl = document.querySelector<HTMLElement>(root);
  if (!rootEl) {
    return [{ kind: "overflow", where: root, detail: "surface root not found" }];
  }

  const CONTROL_SELECTOR = [
    "button",
    "a[href]",
    "input:not([type=hidden])",
    "select",
    "textarea",
    "[role=button]",
    "[role=switch]",
    "[role=checkbox]",
    "[role=radio]",
    "[role=tab]",
    "[role=combobox]",
    "[role=slider]",
    "[role=menuitem]",
  ].join(",");

  const describe = (el: Element): string => {
    const testId = el.getAttribute("data-testid");
    const label =
      el.getAttribute("aria-label") ??
      el.getAttribute("title") ??
      (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
    const id = testId ? `[data-testid=${testId}]` : `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`;
    return label ? `${id} "${label}"` : id;
  };

  const isRendered = (el: Element): boolean =>
    el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });

  /** Screen-reader-only / visually hidden helpers are meant to be invisible. */
  const isVisuallyHiddenOnPurpose = (el: Element): boolean => {
    for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
      if (n.getAttribute("aria-hidden") === "true") return true;
      const cs = getComputedStyle(n);
      if (cs.clip !== "auto" && cs.clip !== "" && cs.position === "absolute") return true;
      if (cs.clipPath.startsWith("inset(50%")) return true;
    }
    return false;
  };

  const r = (el: Element): DOMRect => el.getBoundingClientRect();

  /** The axes an ancestor clips its descendants on (scrollers are reachable). */
  const clipAxes = (el: Element): { x: boolean; y: boolean } => {
    const cs = getComputedStyle(el);
    const clips = (v: string) => v === "hidden" || v === "clip";
    return { x: clips(cs.overflowX), y: clips(cs.overflowY) };
  };

  /** Ancestors whose overflow can actually clip `el` (respects positioning). */
  const clippingAncestors = (el: Element): Element[] => {
    const out: Element[] = [];
    let pos = getComputedStyle(el).position;
    if (pos === "fixed") return out;
    let needPositioned = pos === "absolute";
    for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const positioned = cs.position !== "static" || cs.transform !== "none";
      if (needPositioned && !positioned) continue;
      needPositioned = false;
      out.push(n);
      pos = cs.position;
      if (pos === "fixed") break;
      if (pos === "absolute") needPositioned = true;
    }
    return out;
  };

  /** Whether `el` sits inside a horizontal scroller below `stop` (legit overflow). */
  const inHorizontalScroller = (el: Element, stop: Element): boolean => {
    for (let n = el.parentElement; n && n !== stop; n = n.parentElement) {
      const ox = getComputedStyle(n).overflowX;
      if (ox === "auto" || ox === "scroll") return true;
    }
    return false;
  };

  const rootRect = r(rootEl);
  const vw = document.documentElement.clientWidth;
  const all = Array.from(rootEl.querySelectorAll<HTMLElement>("*")).filter(isRendered);

  // ── overflow: nothing sticks out of the surface horizontally ──
  for (const el of all) {
    if (getComputedStyle(el).position === "fixed" || isVisuallyHiddenOnPurpose(el)) continue;
    const b = r(el);
    if (b.width === 0 && b.height === 0) continue;
    if (b.right <= rootRect.right + TOL && b.left >= rootRect.left - TOL) continue;
    if (inHorizontalScroller(el, rootEl)) continue;
    // Report only the outermost offender, not every descendant that rides along.
    const parent = el.parentElement;
    if (parent && parent !== rootEl) {
      const pb = r(parent);
      if (pb.right > rootRect.right + TOL || pb.left < rootRect.left - TOL) continue;
    }
    issues.push({
      kind: "overflow",
      where: describe(el),
      detail: `spans x ${Math.round(b.left)}..${Math.round(b.right)}, surface is ${Math.round(rootRect.left)}..${Math.round(rootRect.right)}`,
    });
  }

  // ── clipped-control: every control is fully visible ──
  const controls = all.filter((el) => el.matches(CONTROL_SELECTOR) && !isVisuallyHiddenOnPurpose(el));
  for (const el of controls) {
    const b = r(el);
    if (b.width < 2 || b.height < 2) {
      issues.push({
        kind: "clipped-control",
        where: describe(el),
        detail: `squeezed to ${b.width.toFixed(1)}x${b.height.toFixed(1)}px`,
      });
      continue;
    }
    let reason = "";
    if (b.left < -TOL || b.right > vw + TOL) {
      reason = `off-screen: x ${Math.round(b.left)}..${Math.round(b.right)}, window width ${vw}`;
    }
    // Inside a scroller the control is reachable by scrolling on that axis, so
    // clips further out no longer apply to that axis.
    let scrollX = false;
    let scrollY = false;
    for (const a of reason ? [] : clippingAncestors(el)) {
      const axes = clipAxes(a);
      const cs = getComputedStyle(a);
      const ab = r(a);
      const cutX = !scrollX && axes.x && (b.left < ab.left - TOL || b.right > ab.right + TOL);
      const cutY = !scrollY && axes.y && (b.top < ab.top - TOL || b.bottom > ab.bottom + TOL);
      scrollX ||= cs.overflowX === "auto" || cs.overflowX === "scroll";
      scrollY ||= cs.overflowY === "auto" || cs.overflowY === "scroll";
      if (cutX || cutY) {
        const visible = Math.max(0, Math.min(b.right, ab.right) - Math.max(b.left, ab.left));
        reason = `cut off by ${describe(a)}: ${cutX ? `${Math.round(visible)} of ${Math.round(b.width)}px wide visible` : "vertically"}`;
        break;
      }
    }
    if (reason) issues.push({ kind: "clipped-control", where: describe(el), detail: reason });
  }

  // ── truncated-text: ellipsis must leave a readable stub ──
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.textOverflow !== "ellipsis" || el.scrollWidth <= el.clientWidth + TOL) continue;
    const em = parseFloat(cs.fontSize) || 13;
    if (el.clientWidth < 4 * em * 0.6) {
      issues.push({
        kind: "truncated-text",
        where: describe(el),
        detail: `only ${el.clientWidth}px of ${el.scrollWidth}px text shown (~${Math.max(0, Math.round(el.clientWidth / (em * 0.6)))} chars)`,
      });
    }
  }

  // ── text-overlap: no text line overlaps a control (incl. focus ring) or other text ──
  const inflate = (el: Element): DOMRect => {
    const b = r(el);
    const cs = getComputedStyle(el);
    let grow = 0;
    if (cs.outlineStyle !== "none") grow = parseFloat(cs.outlineWidth) + parseFloat(cs.outlineOffset);
    for (const m of cs.boxShadow.matchAll(/(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px(?![^,]*inset)/g)) {
      grow = Math.max(grow, parseFloat(m[4]));
    }
    return grow > 0 ? new DOMRect(b.x - grow, b.y - grow, b.width + 2 * grow, b.height + 2 * grow) : b;
  };
  /** Not painted at rest: some ancestor is fully transparent (hover-revealed). */
  const transparent = (el: Element): boolean => {
    for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
      if (parseFloat(getComputedStyle(n).opacity) === 0) return true;
    }
    return false;
  };
  /** The part of `rect` its ancestors let through (scrollers clip too), or null. */
  const visiblePart = (el: Element, rect: DOMRect): DOMRect | null => {
    let { left, top, right, bottom } = rect;
    for (const a of clippingAncestors(el)) {
      const cs = getComputedStyle(a);
      const ab = r(a);
      if (cs.overflowX !== "visible") {
        left = Math.max(left, ab.left);
        right = Math.min(right, ab.right);
      }
      if (cs.overflowY !== "visible") {
        top = Math.max(top, ab.top);
        bottom = Math.min(bottom, ab.bottom);
      }
      if (right - left <= TOL || bottom - top <= TOL) return null;
    }
    return new DOMRect(left, top, right - left, bottom - top);
  };
  const overlaps = (a: DOMRect, c: DOMRect, min: number): boolean =>
    Math.min(a.right, c.right) - Math.max(a.left, c.left) > min &&
    Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top) > min;

  interface TextLine {
    owner: Element;
    rect: DOMRect;
    text: string;
  }
  const lines: TextLine[] = [];
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? "").trim();
    const owner = node.parentElement;
    if (!text || !owner || !isRendered(owner) || isVisuallyHiddenOnPurpose(owner)) continue;
    if (transparent(owner)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const raw of Array.from(range.getClientRects())) {
      const rect = visiblePart(owner, raw);
      if (rect) lines.push({ owner, rect, text: text.slice(0, 30) });
    }
  }
  const controlBoxes = controls.flatMap((el) => {
    const rect = transparent(el) ? null : visiblePart(el, inflate(el));
    return rect ? [{ el, rect }] : [];
  });
  const reported = new Set<string>();
  for (const line of lines) {
    for (const c of controlBoxes) {
      if (c.el.contains(line.owner) || line.owner.contains(c.el)) continue;
      // A control's own <label> legitimately wraps or sits on it.
      if (line.owner.closest("label")?.contains(c.el)) continue;
      if (!overlaps(line.rect, c.rect, TOL)) continue;
      const key = `${describe(line.owner)}|${describe(c.el)}`;
      if (reported.has(key)) continue;
      reported.add(key);
      issues.push({
        kind: "text-overlap",
        where: describe(line.owner),
        detail: `text "${line.text}" overlaps ${describe(c.el)}${c.el === document.activeElement ? " (focus ring)" : ""}`,
      });
    }
  }
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i];
      const b = lines[j];
      if (a.owner === b.owner || a.owner.contains(b.owner) || b.owner.contains(a.owner)) continue;
      if (!overlaps(a.rect, b.rect, 2)) continue;
      const key = `${describe(a.owner)}|${describe(b.owner)}`;
      if (reported.has(key)) continue;
      reported.add(key);
      issues.push({
        kind: "text-overlap",
        where: describe(a.owner),
        detail: `text "${a.text}" overlaps text "${b.text}" of ${describe(b.owner)}`,
      });
    }
  }

  // ── unstyled-class: every ui/ primitive class on screen has its CSS loaded ──
  const selectorText: string[] = [];
  const collect = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) selectorText.push(rule.selectorText);
      if ("cssRules" in rule && (rule as CSSGroupingRule).cssRules) {
        collect((rule as CSSGroupingRule).cssRules);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      collect(sheet.cssRules);
    } catch {
      // Cross-origin sheet: not ours, nothing to check.
    }
  }
  const loaded = selectorText.join("\n");
  const styled = new Set(styledClasses);
  const seen = new Set<string>();
  for (const el of [rootEl, ...all]) {
    for (const cls of Array.from(el.classList)) {
      if (!styled.has(cls) || seen.has(cls)) continue;
      seen.add(cls);
      const escaped = cls.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
      if (!new RegExp(`\\.${escaped}(?![\\w-])`).test(loaded)) {
        issues.push({
          kind: "unstyled-class",
          where: describe(el),
          detail: `.${cls} is styled in the repo but no loaded stylesheet defines it`,
        });
      }
    }
  }

  return issues;
}
