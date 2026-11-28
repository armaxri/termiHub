/**
 * The Customize Layout preview's pane labels stay legible (#6166).
 *
 * Its panes were faded with element `opacity` (0.6, 0.25, 0.2), which fades the
 * label inside them too, and the label had its own 0.7 on top: "SIDEBAR" ended at
 * about 0.18 of its colour. The panes are faint through their background colour
 * instead, and the label draws at full strength.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "LayoutPreview.css"),
  "utf8"
);

/** The declarations of the rule for exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`no rule for ${selector}`);
  return match[1];
}

describe("the layout preview's labels (#6166)", () => {
  it.each([
    ".layout-preview__activity-bar",
    ".layout-preview__activity-bar--top",
    ".layout-preview__sidebar",
    ".layout-preview__status-bar",
    ".layout-preview__label",
  ])("%s is not faded with opacity, which would fade the label", (selector) => {
    expect(rule(selector)).not.toMatch(/(^|[\s;])opacity\s*:/);
  });

  it("draws the label in a readable text colour", () => {
    expect(rule(".layout-preview__label")).toMatch(/color:\s*var\(--text-(primary|secondary)\)/);
  });
});
