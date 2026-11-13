import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { SettingsField } from "@/types/schema";
import { DynamicField } from "./DynamicField";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/services/api", () => ({
  listSerialPorts: vi.fn().mockResolvedValue([]),
}));

let container: HTMLDivElement;
let root: Root;

function render(field: SettingsField, value: unknown) {
  act(() => {
    root.render(<DynamicField field={field} value={value} onChange={vi.fn()} />);
  });
}

function wrapper(key: string): HTMLElement {
  return container.querySelector(`[data-testid="dynamic-field-${key}"]`) as HTMLElement;
}

/** Each hint is a child of its own field wrapper, after the field's control. */
describe("DynamicField hint and layout (#5641)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the description as the field's own hint, directly after the control", () => {
    render(
      {
        key: "host",
        label: "Host",
        fieldType: { type: "text" },
        required: true,
        description: "Hostname or IP address",
      },
      ""
    );
    const field = wrapper("host");
    const kids = Array.from(field.children);
    const control = kids.findIndex((k) => k.querySelector("input") || k.tagName === "INPUT");
    const hint = kids.find((k) => k.classList.contains("settings-form__hint"));
    expect(hint?.textContent).toBe("Hostname or IP address");
    expect(kids.indexOf(hint!)).toBe(control + 1);
  });

  it("lays a boolean out as a toggle row: label and hint left, toggle right", () => {
    render(
      {
        key: "savePassword",
        label: "Save password",
        fieldType: { type: "boolean" },
        required: false,
        description: "Save the password to the credential store for reuse",
      },
      false
    );
    const field = wrapper("savePassword");
    expect(field.className).toContain("settings-form__field--inline");
    const text = field.querySelector(".settings-form__field-text") as HTMLElement;
    expect(text.textContent).toContain("Save password");
    expect(text.querySelector(".settings-form__hint")?.textContent).toBe(
      "Save the password to the credential store for reuse"
    );
    const control = field.querySelector(".settings-form__field-control") as HTMLElement;
    expect(control.querySelector('[role="switch"]')).toBeTruthy();
    expect(control.querySelector(".settings-form__hint")).toBeNull();
  });

  it("keeps the boolean's hint wired to the toggle via aria-describedby", () => {
    render(
      {
        key: "flag",
        label: "Flag",
        fieldType: { type: "boolean" },
        required: false,
        description: "What the flag does",
      },
      false
    );
    const toggle = container.querySelector('[role="switch"]') as HTMLElement;
    const ids = (toggle.getAttribute("aria-describedby") ?? "").split(" ");
    const texts = ids.map((id) => document.getElementById(id)?.textContent);
    expect(texts).toContain("What the flag does");
  });

  it("renders port and number inputs narrow", () => {
    render({ key: "port", label: "Port", fieldType: { type: "port" }, required: true }, 22);
    expect(
      container
        .querySelector('[data-testid="field-port"]')
        ?.classList.contains("settings-form__input--narrow")
    ).toBe(true);
    render({ key: "timeout", label: "Timeout", fieldType: { type: "number" }, required: false }, 5);
    expect(
      container
        .querySelector('[data-testid="field-timeout"]')
        ?.classList.contains("settings-form__input--narrow")
    ).toBe(true);
  });
});
