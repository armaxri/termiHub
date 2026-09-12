import { axe } from "jest-axe";

/**
 * Shared accessibility (a11y) regression helper — the seed of an automated
 * accessibility net (audit finding TFE-012). Renders-then-audits a component
 * with `axe-core` and asserts zero violations via the `jest-axe`
 * `toHaveNoViolations` matcher (registered globally in `src/test/setup.ts`).
 *
 * ## Adding an a11y test for a component
 *
 * ```tsx
 * import { checkA11y } from "@/test/axe";
 *
 * it("has no a11y violations", async () => {
 *   act(() => root.render(<MyComponent aria-label="…" />));
 *   expect(await checkA11y()).toHaveNoViolations();
 * });
 * ```
 *
 * Pass a specific `node` to scope the audit; the default (`document.body`) also
 * catches Radix content that portals out of the render container (Modal, Select,
 * dialogs). Real violations must be **fixed**, never suppressed — if a component
 * has a violation too large to fix in-scope, leave it out of the seed and file a
 * `Ready2Implement` follow-up rather than shipping a red or papered-over suite.
 *
 * ## Why some rules are disabled here
 *
 * axe's page-scope rules assume a full document. When a single component is
 * rendered in isolation under jsdom it is (correctly) not wrapped in a `<main>`
 * landmark and has no `<h1>`, so `region`, `landmark-one-main`, and
 * `page-has-heading-one` fire on every component — noise, not a component
 * defect. They are disabled for isolated-component audits; page-level layout is
 * covered elsewhere. Every other rule (roles, names, `aria-*`, labels, invalid
 * attributes, …) stays on. `color-contrast` needs layout/canvas that jsdom does
 * not provide, so axe reports it as *incomplete* (never a false *violation*).
 */
const ISOLATED_COMPONENT_RULES = {
  region: { enabled: false },
  "landmark-one-main": { enabled: false },
  "page-has-heading-one": { enabled: false },
} as const;

/** Extra options for {@link checkA11y}; `rules` merge over the isolated-component defaults. */
type AxeOptions = NonNullable<Parameters<typeof axe>[1]>;

/**
 * Run axe on `node` (default `document.body`) with the isolated-component rule
 * set. Returns the axe results — assert on them with
 * `expect(await checkA11y()).toHaveNoViolations()`.
 */
export function checkA11y(
  node: Element | Document = document.body,
  options: AxeOptions = {}
): ReturnType<typeof axe> {
  return axe(node as Element, {
    ...options,
    rules: { ...ISOLATED_COMPONENT_RULES, ...(options.rules ?? {}) },
  });
}
