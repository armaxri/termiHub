/**
 * A dialog opened over another hides the lower one's footer (#6183, editor-7).
 *
 * The schedule editor opens over the automation editor at the same width, so
 * both footers (Cancel / Save …) showed at once. A Modal that another open Modal
 * covers carries `data-covered`; ui.css hides its footer on that mark, for every
 * stacked pair.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Modal } from "./Modal";
import { Button } from "./Button";

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
  document.body.innerHTML = "";
});

function dialogs(child: boolean) {
  return (
    <Modal
      open
      onOpenChange={() => {}}
      title="Parent"
      data-testid="parent"
      footer={<Button data-testid="parent-save">Save</Button>}
    >
      <p>body</p>
      <Modal
        open={child}
        onOpenChange={() => {}}
        title="Child"
        data-testid="child"
        footer={<Button data-testid="child-save">Save</Button>}
      >
        <p>child</p>
      </Modal>
    </Modal>
  );
}

const covered = (testId: string) =>
  document.querySelector(`[data-testid="${testId}"]`)?.hasAttribute("data-covered") ?? false;

describe("stacked dialogs (#6183, editor-7)", () => {
  it("marks the lower dialog as covered while one is open over it", () => {
    act(() => root.render(dialogs(false)));
    expect(covered("parent")).toBe(false);
    act(() => root.render(dialogs(true)));
    expect(covered("parent")).toBe(true);
    expect(covered("child")).toBe(false);
    // Closing the upper one uncovers the lower one.
    act(() => root.render(dialogs(false)));
    expect(covered("parent")).toBe(false);
  });

  it("hides a covered dialog's footer in ui.css", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ui.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\s+/g, " ");
    expect(css).toMatch(
      /\.ui-modal\[data-covered\] \.ui-modal__foot\s*\{[^}]*visibility:\s*hidden/
    );
  });
});
