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

  it("renders an optional hint below the control", () => {
    render(
      <Field data-testid="field" label="Host" htmlFor="host" hint="Reachable hostname">
        <Input id="host" />
      </Field>
    );
    const hint = document.querySelector('[data-testid="field"] .ui-field__hint');
    expect(hint?.textContent).toBe("Reachable hostname");
    expect(hint?.classList.contains("ui-field__hint--warning")).toBe(false);
  });

  it("applies the warning hint variant", () => {
    render(
      <Field data-testid="field" label="Host" htmlFor="host" hint="Careful" hintVariant="warning">
        <Input id="host" />
      </Field>
    );
    const hint = document.querySelector('[data-testid="field"] .ui-field__hint');
    expect(hint?.classList.contains("ui-field__hint--warning")).toBe(true);
  });

  it("omits the hint element when no hint is provided", () => {
    render(
      <Field data-testid="field" label="Host" htmlFor="host">
        <Input id="host" />
      </Field>
    );
    expect(document.querySelector('[data-testid="field"] .ui-field__hint')).toBeNull();
  });

  it("renders the settings variant scaffold and error test hook", () => {
    render(
      <Field data-testid="field" variant="settings" label="Cursor Blink" error="Nope">
        <Input data-testid="settings-control" />
      </Field>
    );
    expect(document.querySelector(".settings-form__field")).toBeTruthy();
    expect(document.querySelector(".settings-form__label")?.textContent).toBe("Cursor Blink");
    expect(document.querySelector('[data-testid="settings-field-error"]')).toBeTruthy();
  });

  it("renders a span label and derives aria-label when htmlFor is omitted", () => {
    render(
      <Field data-testid="field" label="Cursor Blink">
        <input type="text" data-testid="no-id-control" />
      </Field>
    );
    expect(document.querySelector('[data-testid="field"] label')).toBeNull();
    const spanLabel = document.querySelector('[data-testid="field"] span');
    expect(spanLabel?.textContent).toBe("Cursor Blink");
    const control = document.querySelector('[data-testid="no-id-control"]');
    expect(control?.getAttribute("aria-label")).toBe("Cursor Blink");
  });

  it("preserves an explicit aria-label on the control when htmlFor is omitted", () => {
    render(
      <Field data-testid="field" label="Field Label">
        <input type="text" aria-label="Explicit Label" data-testid="no-id-control" />
      </Field>
    );
    const control = document.querySelector('[data-testid="no-id-control"]');
    expect(control?.getAttribute("aria-label")).toBe("Explicit Label");
  });

  it("renders a decorative required asterisk inside the label", () => {
    render(
      <Field data-testid="field" variant="settings" label="Host" htmlFor="host" required>
        <Input id="host" />
      </Field>
    );
    const label = document.querySelector('[data-testid="field"] label') as HTMLLabelElement;
    const marker = label.querySelector(".settings-form__required");
    expect(marker).toBeTruthy();
    expect(marker?.getAttribute("aria-hidden")).toBe("true");
    expect(label.textContent).toContain("*");
  });

  it("omits the required marker by default", () => {
    render(
      <Field data-testid="field" label="Host" htmlFor="host">
        <Input id="host" />
      </Field>
    );
    expect(document.querySelector(".ui-field__required")).toBeNull();
  });

  it("renders a label accessory beside (not inside) the label in a label row", () => {
    render(
      <Field
        data-testid="field"
        variant="settings"
        label="Host"
        htmlFor="host"
        labelAccessory={<button type="button" data-testid="help" />}
      >
        <Input id="host" />
      </Field>
    );
    const row = document.querySelector(".settings-form__label-row");
    expect(row).toBeTruthy();
    const help = document.querySelector('[data-testid="help"]');
    expect(row?.contains(help)).toBe(true);
    expect(help?.closest("label")).toBeNull();
    expect(row?.querySelector("label")?.textContent).toBe("Host");
  });

  it("does not render a label row when there is no accessory", () => {
    render(
      <Field data-testid="field" variant="settings" label="Host" htmlFor="host">
        <Input id="host" />
      </Field>
    );
    expect(document.querySelector(".settings-form__label-row")).toBeNull();
  });

  it("renders the checkbox layout as a wrapping label with the control first", () => {
    render(
      <Field
        data-testid="field"
        variant="settings"
        layout="checkbox"
        label="Enable it"
        labelIcon={<svg data-testid="icon" />}
        labelClassName="extra-label"
      >
        <input type="checkbox" aria-label="Enable it" data-testid="cb" />
      </Field>
    );
    const wrapper = document.querySelector('[data-testid="field"]') as HTMLElement;
    expect(wrapper.tagName).toBe("LABEL");
    expect(wrapper.className).toContain("settings-form__field--checkbox");
    const first = wrapper.firstElementChild;
    expect(first?.getAttribute("data-testid")).toBe("cb");
    const text = wrapper.querySelector(".settings-form__label") as HTMLElement;
    expect(text.tagName).toBe("SPAN");
    expect(text.className).toContain("extra-label");
    expect(text.querySelector('[data-testid="icon"]')).toBeTruthy();
    expect(text.textContent).toBe("Enable it");
  });

  it("can place the hint directly after the label", () => {
    render(
      <Field data-testid="field" label="Rules" hint="About rules" hintPosition="afterLabel">
        <>
          <div data-testid="list" />
        </>
      </Field>
    );
    const wrapper = document.querySelector('[data-testid="field"]') as HTMLElement;
    const children = Array.from(wrapper.children);
    const hintIdx = children.findIndex((c) => c.className.includes("ui-field__hint"));
    const listIdx = children.findIndex((c) => c.getAttribute("data-testid") === "list");
    expect(hintIdx).toBeGreaterThan(-1);
    expect(hintIdx).toBeLessThan(listIdx);
  });

  it("honours a custom error id and error test id", () => {
    render(
      <Field
        label="Name"
        htmlFor="name"
        error="Required"
        errorId="custom-err"
        errorTestId="name-err"
      >
        <Input id="name" data-testid="name-input" />
      </Field>
    );
    const msg = document.querySelector('[data-testid="name-err"]');
    expect(msg?.id).toBe("custom-err");
    const input = document.querySelector('[data-testid="name-input"]');
    expect(input?.getAttribute("aria-describedby")).toBe("custom-err");
  });

  it("leaves fragment children untouched (composite controls wire their own a11y)", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <Field data-testid="field" label="Composite" error="Bad">
        <>
          <input type="text" data-testid="part" />
        </>
      </Field>
    );
    expect(errorSpy).not.toHaveBeenCalled();
    const part = document.querySelector('[data-testid="part"]');
    expect(part?.getAttribute("aria-label")).toBeNull();
    expect(document.querySelector('[data-testid="field-error"]')).toBeTruthy();
    errorSpy.mockRestore();
  });
});
