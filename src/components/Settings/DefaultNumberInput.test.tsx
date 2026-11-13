import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { DefaultNumberInput, formatSettingNumber } from "./DefaultNumberInput";

let container: HTMLDivElement;
let root: Root;

function render(value: number | undefined, onChange = vi.fn(), step?: number) {
  act(() => {
    root.render(
      <DefaultNumberInput
        value={value}
        defaultValue={1}
        step={step}
        onChange={onChange}
        data-testid="n"
      />
    );
  });
  return onChange;
}

function input(): HTMLInputElement {
  return container.querySelector('[data-testid="n-input"]') as HTMLInputElement;
}

function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("formatSettingNumber (#5632)", () => {
  it("pads to the step's decimals", () => {
    expect(formatSettingNumber(1, 0.1)).toBe("1.0");
    expect(formatSettingNumber(1.2, 0.1)).toBe("1.2");
  });

  it("never rounds away the value's own decimals", () => {
    expect(formatSettingNumber(1.25, 0.1)).toBe("1.25");
  });

  it("prints integers plainly without a fractional step", () => {
    expect(formatSettingNumber(10000)).toBe("10000");
    expect(formatSettingNumber(14, 1)).toBe("14");
  });
});

describe("DefaultNumberInput (#5632)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the default as the input's value, not as a placeholder", () => {
    render(undefined, vi.fn(), 0.1);
    expect(input().value).toBe("1.0");
    expect(input().placeholder).toBe("");
  });

  it("keeps a cleared field empty while it is being edited", () => {
    const onChange = render(1.5, vi.fn(), 0.1);
    act(() => input().focus());
    type("");
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    render(undefined, onChange, 0.1);
    expect(input().value).toBe("");
  });

  it("shows the effective value again once the field loses focus", () => {
    const onChange = render(1.5, vi.fn(), 0.1);
    act(() => input().focus());
    type("");
    render(undefined, onChange, 0.1);
    act(() => input().blur());
    expect(input().value).toBe("1.0");
  });

  it("stores unset when the default value is typed", () => {
    const onChange = render(1.5);
    type("1");
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("emits the parsed number for any other value", () => {
    const onChange = render(undefined);
    type("1.3");
    expect(onChange).toHaveBeenLastCalledWith(1.3);
  });
});
