import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Checkbox } from "./Checkbox";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

function checkbox(testid = "cb"): HTMLButtonElement {
  return document.querySelector(`[data-testid="${testid}"]`) as HTMLButtonElement;
}

describe("Checkbox", () => {
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

  it("renders a checkbox with the base class and reflects the checked state", () => {
    render(<Checkbox data-testid="cb" checked onCheckedChange={() => {}} />);
    const cb = checkbox();
    expect(cb).toBeTruthy();
    expect(cb.classList.contains("ui-checkbox")).toBe(true);
    // Radix Checkbox exposes role="checkbox" + aria-checked for accessibility —
    // the semantics a div-with-onClick would not have.
    expect(cb.getAttribute("role")).toBe("checkbox");
    expect(cb.getAttribute("aria-checked")).toBe("true");
  });

  it("reflects the unchecked state", () => {
    render(<Checkbox data-testid="cb" checked={false} onCheckedChange={() => {}} />);
    expect(checkbox().getAttribute("aria-checked")).toBe("false");
  });

  it("exposes the indeterminate state as aria-checked=mixed", () => {
    render(<Checkbox data-testid="cb" checked="indeterminate" onCheckedChange={() => {}} />);
    expect(checkbox().getAttribute("aria-checked")).toBe("mixed");
    expect(checkbox().getAttribute("data-state")).toBe("indeterminate");
  });

  it("renders the indicator when checked and hides it when unchecked", () => {
    render(<Checkbox data-testid="cb" checked onCheckedChange={() => {}} />);
    expect(document.querySelector(".ui-checkbox__indicator")).toBeTruthy();

    render(<Checkbox data-testid="cb" checked={false} onCheckedChange={() => {}} />);
    expect(document.querySelector(".ui-checkbox__indicator")).toBeNull();
  });

  it("renders the indicator in the indeterminate state", () => {
    render(<Checkbox data-testid="cb" checked="indeterminate" onCheckedChange={() => {}} />);
    expect(document.querySelector(".ui-checkbox__indicator")).toBeTruthy();
  });

  it("calls onCheckedChange with the new value when clicked", () => {
    const onCheckedChange = vi.fn();
    render(<Checkbox data-testid="cb" checked={false} onCheckedChange={onCheckedChange} />);
    act(() => checkbox().click());
    expect(onCheckedChange).toHaveBeenCalledTimes(1);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("reports a boolean when toggled out of the indeterminate state", () => {
    const onCheckedChange = vi.fn();
    render(
      <Checkbox data-testid="cb" checked="indeterminate" onCheckedChange={onCheckedChange} />
    );
    act(() => checkbox().click());
    // The consumer's state is boolean; "indeterminate" must never be echoed back.
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("is a natively focusable button, so it is keyboard operable", () => {
    render(<Checkbox data-testid="cb" checked={false} onCheckedChange={() => {}} />);
    const cb = checkbox();
    expect(cb.tagName).toBe("BUTTON");
    // type=button keeps it from submitting a surrounding form.
    expect(cb.getAttribute("type")).toBe("button");
    act(() => cb.focus());
    expect(document.activeElement).toBe(cb);
  });

  it("does not activate on Enter, per the WAI-ARIA checkbox pattern", () => {
    const onCheckedChange = vi.fn();
    render(<Checkbox data-testid="cb" checked={false} onCheckedChange={onCheckedChange} />);
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    act(() => {
      checkbox().dispatchEvent(event);
    });
    // Radix prevents Enter: a checkbox toggles with Space, unlike a button.
    expect(event.defaultPrevented).toBe(true);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it("is labelled by an associated <label htmlFor>", () => {
    render(
      <>
        <label htmlFor="cb-id">Remember choice</label>
        <Checkbox data-testid="cb" id="cb-id" checked={false} onCheckedChange={() => {}} />
      </>
    );
    expect(checkbox().id).toBe("cb-id");
    expect((document.querySelector("label") as HTMLLabelElement).htmlFor).toBe("cb-id");
  });

  it("forwards an aria-label when there is no visible label", () => {
    render(
      <Checkbox data-testid="cb" aria-label="Remember choice" checked onCheckedChange={() => {}} />
    );
    expect(checkbox().getAttribute("aria-label")).toBe("Remember choice");
  });

  it("is disabled and does not fire onCheckedChange when disabled", () => {
    const onCheckedChange = vi.fn();
    render(<Checkbox data-testid="cb" checked={false} disabled onCheckedChange={onCheckedChange} />);
    const cb = checkbox();
    expect(cb.hasAttribute("disabled")).toBe(true);
    act(() => cb.click());
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
