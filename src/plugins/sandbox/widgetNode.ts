/**
 * Materialise a sandbox {@link WidgetNode} descriptor into real DOM on the main
 * thread — part of the plugin sandbox work (#2136).
 *
 * Status-bar widget `render()` runs inside the sandbox worker, which has no DOM,
 * so it returns a declarative {@link WidgetNode} rather than a live element. The
 * host rebuilds the DOM here. Because the descriptor crosses a trust boundary
 * (it originates in plugin code), materialisation is **strictly allowlisted**:
 *
 * - only safe, non-interactive element tags are created;
 * - text is set with `textContent` — never `innerHTML`, so no markup a plugin
 *   emits is ever parsed as HTML;
 * - only a small set of attributes is applied, and event handlers (`on*`) and
 *   URL-bearing attributes are refused, so a descriptor cannot smuggle
 *   executable content or navigation into the host page.
 *
 * A node that violates the allowlist is coerced to a safe `<span>` rather than
 * throwing, so one malformed field never blanks the whole widget.
 */

import type { WidgetNode } from "./protocol";

/** Element tags a widget descriptor may create. Inert, non-interactive only. */
const ALLOWED_TAGS = new Set([
  "span",
  "div",
  "b",
  "i",
  "em",
  "strong",
  "code",
  "small",
  "sub",
  "sup",
  "s",
  "u",
]);

/** Attributes a widget descriptor may set. No `on*`, no `href`/`src`/`style`. */
const ALLOWED_ATTRS = new Set(["class", "title", "role", "aria-label"]);

/** Guard against pathological/hostile trees blowing the stack or the DOM. */
const MAX_DEPTH = 16;
const MAX_CHILDREN = 64;

/** Whether `name` is a safe, applyable attribute (allowlist + `data-*`). */
function isAllowedAttr(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith("on")) return false;
  return ALLOWED_ATTRS.has(lower) || lower.startsWith("data-");
}

/**
 * Build a live `HTMLElement` from a widget descriptor. Unknown tags become a
 * `<span>`; disallowed attributes are dropped; text is applied via
 * `textContent`. Depth and child count are capped.
 */
export function buildWidgetDom(node: WidgetNode, doc: Document = document, depth = 0): HTMLElement {
  const tag =
    typeof node?.tag === "string" && ALLOWED_TAGS.has(node.tag.toLowerCase())
      ? node.tag.toLowerCase()
      : "span";
  const el = doc.createElement(tag);

  if (node?.attrs && typeof node.attrs === "object") {
    for (const [name, value] of Object.entries(node.attrs)) {
      if (typeof value === "string" && isAllowedAttr(name)) {
        el.setAttribute(name, value);
      }
    }
  }

  if (typeof node?.text === "string") {
    el.textContent = node.text;
  }

  if (Array.isArray(node?.children) && depth < MAX_DEPTH) {
    for (const child of node.children.slice(0, MAX_CHILDREN)) {
      if (child && typeof child === "object") {
        el.appendChild(buildWidgetDom(child, doc, depth + 1));
      }
    }
  }

  return el;
}
