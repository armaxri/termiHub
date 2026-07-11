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
});
