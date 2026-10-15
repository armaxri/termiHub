// jest-axe loads axe-core, which registers itself as `window.axe` under jsdom.
// axe-core is only a transitive dependency (via jest-axe), so it is reached
// through that global rather than imported by name.
import "jest-axe";

/**
 * Role and accessible-name queries for component tests, computed by axe-core's
 * own ARIA engine (the same one `checkA11y` audits with). The repo has no
 * testing-library, so this is the "getByRole(role, { name })" of the suite:
 * it resolves implicit roles (`<nav>` → navigation, `<footer>` → contentinfo),
 * `aria-labelledby`, `<label for>`, and role="img" labels exactly like a
 * screen reader would, instead of asserting on raw attributes.
 */
export interface RoleMatch {
  element: Element;
  role: string | null;
  name: string;
}

/** The slice of axe-core's runtime API used here (its typings omit `commons`). */
interface AxeEngine {
  setup: (node: Element) => unknown;
  teardown: () => void;
  utils: { getNodeFromTree: (el: Element) => unknown };
  commons: {
    aria: { getRole: (vNode: unknown) => string | null };
    text: { accessibleTextVirtual: (vNode: unknown) => string };
  };
}

/** Every element under `root` with its computed role and accessible name. */
export function rolesIn(root: Element | Document = document.body): RoleMatch[] {
  const rootEl = root instanceof Document ? root.documentElement : root;
  const engine = (window as unknown as { axe: AxeEngine }).axe;
  engine.setup(rootEl);
  try {
    return Array.from(rootEl.querySelectorAll("*")).map((element) => {
      const vNode = engine.utils.getNodeFromTree(element);
      return {
        element,
        role: vNode ? engine.commons.aria.getRole(vNode) : null,
        name: vNode ? engine.commons.text.accessibleTextVirtual(vNode).trim() : "",
      };
    });
  } finally {
    engine.teardown();
  }
}

/** All elements with `role` (optionally with an exact or matching accessible name). */
export function queryAllByRole(
  role: string,
  name?: string | RegExp,
  root: Element | Document = document.body
): Element[] {
  return rolesIn(root)
    .filter((m) => m.role === role)
    .filter((m) =>
      name === undefined ? true : typeof name === "string" ? m.name === name : name.test(m.name)
    )
    .map((m) => m.element);
}

/** The single element with `role` and `name`; throws when there is not exactly one. */
export function getByRole(
  role: string,
  name?: string | RegExp,
  root: Element | Document = document.body
): Element {
  const found = queryAllByRole(role, name, root);
  if (found.length !== 1) {
    const seen = rolesIn(root)
      .filter((m) => m.role === role)
      .map((m) => JSON.stringify(m.name));
    throw new Error(
      `expected exactly one ${role} named ${String(name)}, found ${found.length} (have: ${seen.join(", ") || "none"})`
    );
  }
  return found[0];
}

/** The accessible name of `element`. */
export function accessibleName(element: Element): string {
  const root = element.ownerDocument.body;
  const match = rolesIn(root).find((m) => m.element === element);
  return match?.name ?? "";
}
