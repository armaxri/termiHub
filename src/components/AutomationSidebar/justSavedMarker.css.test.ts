/**
 * The just-saved / just-run marker never looks like a selection (live review
 * history-3, store-2, sidebar-2, workflow-3).
 *
 * It tinted the row with the selection fill plus an accent bar, so two rows read
 * as selected at once. It is the accent bar alone now, which fades out.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "AutomationSidebar.css"),
  "utf8"
);

/** The declarations of every rule whose selector list names `.automation-item--just-saved`. */
function justSavedRules(): string[] {
  return [...css.matchAll(/([^{}]*automation-item--just-saved[^{}]*)\{([^}]*)\}/g)].map(
    (m) => m[2]
  );
}

describe("the just-saved marker", () => {
  it("is an accent bar", () => {
    expect(justSavedRules().join("\n")).toMatch(
      /box-shadow:\s*inset 2px 0 0 var\(--accent-color\)/
    );
  });

  it("does not fill the row like a selection", () => {
    for (const body of justSavedRules()) {
      expect(body).not.toMatch(/(^|[\s;])background(-color)?\s*:/);
      expect(body).not.toMatch(/--bg-selected|--sidebar-list-item-surface/);
    }
  });
});
