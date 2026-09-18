import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { SettingsField } from "./SettingsField";

let container: HTMLDivElement;
let root: Root;

function render(node: React.ReactElement) {
  act(() => {
    root.render(node);
  });
}

describe("SettingsField", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders the field scaffold with label, control, and hint", () => {
    render(
      <SettingsField label="My Label" hint="My hint text">
        <input type="text" data-testid="my-control" />
      </SettingsField>
    );

    const field = container.querySelector(".settings-form__field");
    expect(field).not.toBeNull();

    const label = field?.querySelector(".settings-form__label");
    expect(label?.textContent).toBe("My Label");

    const control = field?.querySelector('[data-testid="my-control"]');
    expect(control).not.toBeNull();

    const hint = field?.querySelector(".settings-form__hint");
    expect(hint?.textContent).toBe("My hint text");
  });

  it("derives the control's aria-label from the label", () => {
    render(
      <SettingsField label="Cursor Blink">
        <input type="text" data-testid="my-control" />
      </SettingsField>
    );

    const control = container.querySelector('[data-testid="my-control"]');
    expect(control?.getAttribute("aria-label")).toBe("Cursor Blink");
  });

  it("preserves an explicit aria-label already set on the control", () => {
    render(
      <SettingsField label="Field Label">
        <input type="text" aria-label="Explicit Label" data-testid="my-control" />
      </SettingsField>
    );

    const control = container.querySelector('[data-testid="my-control"]');
    expect(control?.getAttribute("aria-label")).toBe("Explicit Label");
  });

  it("preserves the child's own props and data-testid", () => {
    render(
      <SettingsField label="Field Label">
        <input type="number" placeholder="42" data-testid="my-control" />
      </SettingsField>
    );

    const control = container.querySelector<HTMLInputElement>('[data-testid="my-control"]');
    expect(control?.getAttribute("type")).toBe("number");
    expect(control?.getAttribute("placeholder")).toBe("42");
  });

  it("omits the hint element when no hint is provided", () => {
    render(
      <SettingsField label="No Hint">
        <input type="text" data-testid="my-control" />
      </SettingsField>
    );

    expect(container.querySelector(".settings-form__hint")).toBeNull();
  });

  it("applies the warning hint variant", () => {
    render(
      <SettingsField label="Warned" hint="Careful" hintVariant="warning">
        <input type="text" data-testid="my-control" />
      </SettingsField>
    );

    const hint = container.querySelector(".settings-form__hint");
    expect(hint?.classList.contains("settings-form__hint--warning")).toBe(true);
  });

  it("uses the default hint variant when unspecified", () => {
    render(
      <SettingsField label="Plain" hint="Plain hint">
        <input type="text" data-testid="my-control" />
      </SettingsField>
    );

    const hint = container.querySelector(".settings-form__hint");
    expect(hint?.classList.contains("settings-form__hint--warning")).toBe(false);
  });

  it("omits the error message when no error is provided", () => {
    render(
      <SettingsField label="No Error">
        <input type="text" data-testid="my-control" />
      </SettingsField>
    );

    expect(container.querySelector('[data-testid="settings-field-error"]')).toBeNull();
    const control = container.querySelector('[data-testid="my-control"]');
    expect(control?.getAttribute("aria-invalid")).toBeNull();
    expect(control?.getAttribute("aria-describedby")).toBeNull();
  });

  it("renders an inline error message mirroring the Field primitive when error is set", () => {
    render(
      <SettingsField label="Port" error="Must be 1–65535">
        <input type="text" data-testid="my-control" />
      </SettingsField>
    );

    const msg = container.querySelector('[data-testid="settings-field-error"]');
    expect(msg).not.toBeNull();
    expect(msg?.classList.contains("ui-field__msg")).toBe(true);
    expect(msg?.getAttribute("role")).toBe("alert");
    expect(msg?.textContent).toContain("Must be 1–65535");
    expect(msg?.querySelector(".ui-field__msg-icon")).not.toBeNull();
  });

  it("links the error to the control via aria-describedby and marks it invalid", () => {
    render(
      <SettingsField label="Port" error="Bad value">
        <input type="text" data-testid="my-control" />
      </SettingsField>
    );

    const control = container.querySelector('[data-testid="my-control"]');
    expect(control?.getAttribute("aria-invalid")).toBe("true");
    const describedBy = control?.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const msg = describedBy ? document.getElementById(describedBy) : null;
    expect(msg?.textContent).toContain("Bad value");
  });

  it("merges an existing aria-describedby on the control with the error id", () => {
    render(
      <SettingsField label="Port" error="Bad">
        <input type="text" aria-describedby="port-hint" data-testid="my-control" />
      </SettingsField>
    );

    const control = container.querySelector('[data-testid="my-control"]');
    const ids = (control?.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids).toContain("port-hint");
    // The generated error id is also present alongside the pre-existing one.
    expect(ids.length).toBeGreaterThan(1);
  });
});
