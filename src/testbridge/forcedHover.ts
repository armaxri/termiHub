/**
 * Render an element as hovered without moving the OS pointer (#5538).
 *
 * A synthetic `mouseover`/`pointerover` never sets `:hover` — only the real
 * pointer does — so a grade that needs the hovered look (the product run's
 * hovered-selected row contrast and its screenshot) either drives the real
 * pointer (`termihub_harness.os_input`, gated: it moves the user's mouse) or
 * uses this: every stylesheet rule whose selector contains `:hover` is cloned
 * into one bridge-owned `<style>` with `:hover` replaced by the
 * {@link FORCED_HOVER_ATTR} attribute, and that attribute is set on the element
 * and its ancestors (`:hover` matches the whole ancestor chain). The browser
 * then paints and computes exactly the hover rules the app ships — transitions
 * included — so `getComputedStyle` and a screenshot both show the hovered state.
 *
 * Only ever runs in a test-bridge build. Cross-origin sheets (unreadable
 * `cssRules`) are skipped.
 */

/** The attribute that stands in for `:hover` while a hover is forced. */
export const FORCED_HOVER_ATTR = "data-testbridge-hover";
/** `id` of the bridge-owned `<style>` that holds the cloned rules. */
export const FORCED_HOVER_STYLE_ID = "testbridge-forced-hover";

const HOVER_RE = /:hover(?![\w-])/g;

/** `selector` with every `:hover` pseudo-class replaced by the attribute. */
export function forcedHoverSelector(selector: string): string {
  return selector.replace(HOVER_RE, `[${FORCED_HOVER_ATTR}]`);
}

function readRules(sheet: CSSStyleSheet): CSSRuleList | null {
  try {
    return sheet.cssRules;
  } catch {
    return null; // cross-origin
  }
}

/** The hover rules of `rules`, rewritten; group rules (`@media`) keep their condition. */
function cloneHoverRules(rules: CSSRuleList): string[] {
  const out: string[] = [];
  for (const rule of Array.from(rules)) {
    const style = rule as CSSStyleRule;
    if (typeof style.selectorText === "string") {
      if (HOVER_RE.test(style.selectorText)) {
        out.push(`${forcedHoverSelector(style.selectorText)} { ${style.style.cssText} }`);
      }
      HOVER_RE.lastIndex = 0;
      continue;
    }
    const group = rule as CSSGroupingRule & { conditionText?: string; media?: MediaList };
    if (group.cssRules) {
      const inner = cloneHoverRules(group.cssRules);
      if (inner.length === 0) continue;
      const condition = group.conditionText ?? group.media?.mediaText;
      const keyword =
        typeof CSSMediaRule !== "undefined" && rule instanceof CSSMediaRule
          ? "@media"
          : typeof CSSSupportsRule !== "undefined" && rule instanceof CSSSupportsRule
            ? "@supports"
            : null;
      out.push(
        keyword && condition ? `${keyword} ${condition} { ${inner.join("\n")} }` : inner.join("\n")
      );
    }
  }
  return out;
}

/** Remove a forced hover (attribute and cloned rules) from `doc`. */
export function clearForcedHover(doc: Document): void {
  for (const node of Array.from(doc.querySelectorAll(`[${FORCED_HOVER_ATTR}]`))) {
    node.removeAttribute(FORCED_HOVER_ATTR);
  }
  doc.getElementById(FORCED_HOVER_STYLE_ID)?.remove();
}

/**
 * Force `element` (and its ancestors) into the hovered state; returns how many
 * `:hover` rules now apply through the attribute. Replaces any earlier forced hover.
 */
export function forceHover(element: Element): number {
  const doc = element.ownerDocument;
  clearForcedHover(doc);
  const rules: string[] = [];
  for (const sheet of Array.from(doc.styleSheets)) {
    const list = readRules(sheet as CSSStyleSheet);
    if (list) rules.push(...cloneHoverRules(list));
  }
  const style = doc.createElement("style");
  style.id = FORCED_HOVER_STYLE_ID;
  style.textContent = rules.join("\n");
  doc.head.append(style);
  for (let node: Element | null = element; node; node = node.parentElement) {
    node.setAttribute(FORCED_HOVER_ATTR, "");
  }
  return rules.length;
}
