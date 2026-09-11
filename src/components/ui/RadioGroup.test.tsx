import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { RadioGroup, RadioGroupItem } from "./RadioGroup";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

function byTestId(testid: string): HTMLElement {
  return document.querySelector(`[data-testid="${testid}"]`) as HTMLElement;
}

const OPTIONS = [
  { value: "a", label: "Option A", "data-testid": "opt-a" },
  { value: "b", label: "Option B", "data-testid": "opt-b" },
  { value: "c", label: "Option C", "data-testid": "opt-c" },
];

describe("RadioGroup", () => {
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

  it("renders a role=radiogroup with the base class and an accessible name", () => {
    render(
      <RadioGroup
        value="a"
        onValueChange={() => {}}
        options={OPTIONS}
        aria-label="Pick one"
        data-testid="rg"
      />
    );
    const group = byTestId("rg");
    expect(group).toBeTruthy();
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(group.classList.contains("ui-radio-group")).toBe(true);
    expect(group.getAttribute("aria-label")).toBe("Pick one");
  });

  it("renders each option as a radio with aria-checked reflecting the selection", () => {
    render(
      <RadioGroup value="b" onValueChange={() => {}} options={OPTIONS} aria-label="Pick one" />
    );
    expect(byTestId("opt-a").getAttribute("role")).toBe("radio");
    expect(byTestId("opt-a").getAttribute("aria-checked")).toBe("false");
    expect(byTestId("opt-b").getAttribute("aria-checked")).toBe("true");
    expect(byTestId("opt-c").getAttribute("aria-checked")).toBe("false");
  });

  it("calls onValueChange with the clicked option's value", () => {
    const onValueChange = vi.fn();
    render(
      <RadioGroup value="a" onValueChange={onValueChange} options={OPTIONS} aria-label="Pick one" />
    );
    act(() => byTestId("opt-c").click());
    expect(onValueChange).toHaveBeenCalledWith("c");
  });

  it("wires roving tabindex on every radio so the group is a single Tab stop", () => {
    render(
      <RadioGroup value="b" onValueChange={() => {}} options={OPTIONS} aria-label="Pick one" />
    );
    // Radix roving-focus makes the group one Tab stop: each radio is managed with
    // a roving tabindex (0 for the active stop, -1 for the rest) rather than every
    // radio being independently tabbable. Arrow keys — not Tab — then move within.
    for (const o of OPTIONS) {
      const ti = byTestId(o["data-testid"]).getAttribute("tabindex");
      expect(ti, `${o.value} should carry a roving tabindex`).not.toBeNull();
      expect(["0", "-1"]).toContain(ti);
    }
  });

  it("radios are focusable type=button controls (keyboard operable)", () => {
    render(
      <RadioGroup value="a" onValueChange={() => {}} options={OPTIONS} aria-label="Pick one" />
    );
    const first = byTestId("opt-a");
    // type=button keeps a radio from submitting a surrounding form; being a real
    // focusable button is what lets Radix's roving Arrow-key navigation drive it.
    expect(first.tagName).toBe("BUTTON");
    expect(first.getAttribute("type")).toBe("button");
    act(() => first.focus());
    expect(document.activeElement).toBe(first);
  });

  it("associates the visible text label with its radio (clicking the label selects)", () => {
    const onValueChange = vi.fn();
    render(
      <RadioGroup value="a" onValueChange={onValueChange} options={OPTIONS} aria-label="Pick one" />
    );
    // The <span> text sits in a wrapping <label>; clicking it toggles the radio.
    const label = byTestId("opt-b").closest("label") as HTMLLabelElement;
    act(() => label.click());
    expect(onValueChange).toHaveBeenCalledWith("b");
  });

  it("disables an individual option and does not select it", () => {
    const onValueChange = vi.fn();
    render(
      <RadioGroup
        value="a"
        onValueChange={onValueChange}
        options={[OPTIONS[0], { ...OPTIONS[1], disabled: true }, OPTIONS[2]]}
        aria-label="Pick one"
      />
    );
    const b = byTestId("opt-b");
    expect(b.hasAttribute("disabled")).toBe(true);
    act(() => b.click());
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("disables the whole group when disabled", () => {
    const onValueChange = vi.fn();
    render(
      <RadioGroup
        value="a"
        onValueChange={onValueChange}
        options={OPTIONS}
        disabled
        aria-label="Pick one"
      />
    );
    expect(byTestId("opt-a").hasAttribute("disabled")).toBe(true);
    expect(byTestId("opt-c").hasAttribute("disabled")).toBe(true);
    act(() => byTestId("opt-c").click());
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("reflects horizontal orientation on the root for keyboard/layout", () => {
    render(
      <RadioGroup
        value="a"
        onValueChange={() => {}}
        options={OPTIONS}
        orientation="horizontal"
        aria-label="Pick one"
        data-testid="rg"
      />
    );
    expect(byTestId("rg").getAttribute("data-orientation")).toBe("horizontal");
  });

  it("supports the children escape hatch with RadioGroupItem for bespoke layouts", () => {
    const onValueChange = vi.fn();
    render(
      <RadioGroup value="x" onValueChange={onValueChange} aria-label="Pick one" data-testid="rg">
        <label className="card">
          <RadioGroupItem value="x" data-testid="card-x" aria-label="X" />
          <span>Card X</span>
        </label>
        <label className="card">
          <RadioGroupItem value="y" data-testid="card-y" aria-label="Y" />
          <span>Card Y</span>
        </label>
      </RadioGroup>
    );
    expect(byTestId("rg").getAttribute("role")).toBe("radiogroup");
    expect(byTestId("card-x").getAttribute("aria-checked")).toBe("true");
    act(() => byTestId("card-y").click());
    expect(onValueChange).toHaveBeenCalledWith("y");
  });

  it("appends a custom className to the root", () => {
    render(
      <RadioGroup
        value="a"
        onValueChange={() => {}}
        options={OPTIONS}
        className="my-group"
        aria-label="Pick one"
        data-testid="rg"
      />
    );
    const group = byTestId("rg");
    expect(group.classList.contains("ui-radio-group")).toBe(true);
    expect(group.classList.contains("my-group")).toBe(true);
  });
});
