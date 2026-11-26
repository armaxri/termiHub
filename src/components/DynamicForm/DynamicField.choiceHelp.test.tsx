/** A bare-word select from a backend schema says what its choice means (#6036). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { withTooltip } from "@/test/tooltip";
import type { SettingsField } from "@/types/schema";
import { DynamicField } from "./DynamicField";

let container: HTMLDivElement;
let root: Root;
const byTestId = (id: string) =>
  container.ownerDocument.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const PARITY: SettingsField = {
  key: "parity",
  label: "Parity",
  fieldType: {
    type: "select",
    options: [
      { value: "none", label: "None" },
      { value: "odd", label: "Odd" },
      { value: "even", label: "Even" },
      { value: "mark", label: "Mark" },
    ],
  },
  required: true,
};

function render(field: SettingsField, value: string) {
  act(() =>
    root.render(withTooltip(<DynamicField field={field} value={value} onChange={vi.fn()} />))
  );
}

/** The text a screen reader gets as the element's description. */
function description(el: HTMLElement): string {
  return (el.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((ref) => document.getElementById(ref)?.textContent)
    .join(" ");
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("a schema choice with plain words", () => {
  it("says what the chosen value means under the select", () => {
    render(PARITY, "even");
    expect(byTestId("field-parity-choice")?.textContent).toBe(
      "Must match the device. Even: one extra bit per character makes the count of 1s even."
    );
    render(PARITY, "none");
    expect(byTestId("field-parity-choice")?.textContent).toBe(
      "Must match the device; most devices use None."
    );
  });

  it("describes the select by the summary and the three lines", () => {
    render(PARITY, "odd");
    const said = description(byTestId("field-parity")!);
    expect(said).toContain("Odd: one extra bit per character makes the count of 1s odd.");
    expect(said).toContain("such as 7O1.");
  });

  it("shows the three lines in place under the line from its help button", async () => {
    render(PARITY, "odd");
    const button = byTestId("field-parity-choice-about")!;
    expect(button.getAttribute("aria-label")).toBe("About Odd");
    expect(byTestId("field-parity-choice-help")).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    act(() => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const tip = byTestId("field-parity-choice-help")!.textContent;
    expect(tip).toContain("characters arrive garbled or not at all.");
    expect(tip).toContain("such as 7O1.");
  });

  it("a value it has no words for keeps the bare select", () => {
    render(PARITY, "mark");
    expect(byTestId("field-parity-choice")).toBeNull();
    expect(byTestId("field-parity-choice-about")).toBeNull();
  });

  it("other selects are unchanged", () => {
    render({ ...PARITY, key: "authMethod", label: "Auth" }, "none");
    expect(byTestId("field-authMethod-choice")).toBeNull();
  });
});
