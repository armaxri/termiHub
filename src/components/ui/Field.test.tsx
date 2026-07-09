import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Field } from "./Field";
import { Input } from "./Input";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

describe("Field", () => {
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

  it("renders a label wired to the control via htmlFor/id", () => {
    render(
      <Field data-testid="field" label="Host" htmlFor="host">
        <Input id="host" />
      </Field>
    );
    const label = document.querySelector('[data-testid="field"] label') as HTMLLabelElement;
    expect(label).toBeTruthy();
    expect(label.textContent).toContain("Host");
    expect(label.getAttribute("for")).toBe("host");
  });

  it("does not render an error message when error is absent", () => {
    render(
      <Field data-testid="field" label="Host" htmlFor="host">
        <Input id="host" />
      </Field>
    );
    expect(document.querySelector('[data-testid="field-error"]')).toBeNull();
  });

  it("renders an inline error message when error is set", () => {
    render(
      <Field data-testid="field" label="Port" htmlFor="port" error="Must be 1–65535">
        <Input id="port" />
      </Field>
    );
    const msg = document.querySelector('[data-testid="field-error"]');
    expect(msg).toBeTruthy();
    expect(msg!.textContent).toContain("Must be 1–65535");
    // The error message carries an id that ties back to the control via aria-describedby.
    const describedById = msg!.getAttribute("id");
    expect(describedById).toBe("port-error");
  });
});
