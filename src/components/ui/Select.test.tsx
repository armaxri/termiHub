import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Select } from "./Select";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

const OPTIONS = [
  { value: "ssh", label: "SSH" },
  { value: "serial", label: "Serial" },
  { value: "telnet", label: "Telnet" },
];

describe("Select", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders a trigger with the base class and the selected label", () => {
    render(<Select data-testid="sel" value="serial" onChange={() => {}} options={OPTIONS} />);
    const trigger = document.querySelector('[data-testid="sel"]') as HTMLButtonElement;
    expect(trigger).toBeTruthy();
    expect(trigger.classList.contains("ui-select__trigger")).toBe(true);
    // Radix renders the selected option's label into the trigger value slot.
    expect(trigger.textContent).toContain("Serial");
  });

  it("shows the placeholder when no value is selected", () => {
    render(
      <Select
        data-testid="sel"
        value={undefined}
        onChange={() => {}}
        options={OPTIONS}
        placeholder="Pick one"
      />
    );
    const trigger = document.querySelector('[data-testid="sel"]') as HTMLButtonElement;
    expect(trigger.textContent).toContain("Pick one");
  });

  it("reflects the disabled state on the trigger", () => {
    render(<Select data-testid="sel" value="ssh" onChange={() => {}} options={OPTIONS} disabled />);
    const trigger = document.querySelector('[data-testid="sel"]') as HTMLButtonElement;
    expect(trigger.hasAttribute("disabled")).toBe(true);
  });

  it("opens the listbox and lists all options when the trigger is activated", () => {
    render(<Select data-testid="sel" value="ssh" onChange={() => {}} options={OPTIONS} />);
    const trigger = document.querySelector('[data-testid="sel"]') as HTMLButtonElement;
    // Radix opens on keyboard activation; dispatch the pointer + keyboard path.
    act(() => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    const items = document.querySelectorAll('[role="option"]');
    expect(items.length).toBe(OPTIONS.length);
    const labels = Array.from(items).map((i) => i.textContent);
    expect(labels.join(" ")).toContain("Telnet");
  });
});
