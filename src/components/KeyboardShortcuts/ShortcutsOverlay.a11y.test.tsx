/**
 * Accessibility (a11y) regression test for the {@link ShortcutsOverlay} — a real,
 * store-backed dialog composed from the shared `ui/` primitives (audit finding
 * TFE-012). It renders a keyboard cheat-sheet table inside a Modal; auditing it
 * guards the dialog name, the search field's accessible name, and the table
 * structure against regression. See `src/test/axe.ts` for the shared helper.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { checkA11y } from "@/test/axe";
import { ShortcutsOverlay } from "./ShortcutsOverlay";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ShortcutsOverlay — accessibility (TFE-012)", () => {
  it("has no a11y violations when open", async () => {
    act(() => root.render(<ShortcutsOverlay open onOpenChange={() => {}} />));
    expect(await checkA11y()).toHaveNoViolations();
  });
});
