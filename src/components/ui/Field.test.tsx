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

  it("links the error to the wrapped control via aria-describedby and marks it invalid", () => {
    render(
      <Field data-testid="field" label="Port" htmlFor="port" error="Must be 1–65535">
        <Input id="port" data-testid="port-input" />
      </Field>
    );
    const input = document.querySelector('[data-testid="port-input"]') as HTMLInputElement;
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBe("port-error");
    // The referenced node is the visible error message.
    const msg = document.getElementById(describedBy!);
    expect(msg?.textContent).toContain("Must be 1–65535");
  });

  it("leaves aria-describedby/aria-invalid off the control when there is no error", () => {
    render(
      <Field data-testid="field" label="Host" htmlFor="host">
        <Input id="host" data-testid="host-input" />
      </Field>
    );
    const input = document.querySelector('[data-testid="host-input"]') as HTMLInputElement;
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(input.getAttribute("aria-describedby")).toBeNull();
  });

  it("merges an existing aria-describedby on the child with the error id", () => {
    render(
      <Field data-testid="field" label="Port" htmlFor="port" error="bad">
        <Input id="port" data-testid="port-input" aria-describedby="port-hint" />
      </Field>
    );
    const input = document.querySelector('[data-testid="port-input"]') as HTMLInputElement;
    const ids = (input.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids).toContain("port-hint");
    expect(ids).toContain("port-error");
  });
});
