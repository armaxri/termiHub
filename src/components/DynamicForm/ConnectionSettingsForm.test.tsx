import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { SettingsSchema } from "@/types/schema";
import { ConnectionSettingsForm } from "./ConnectionSettingsForm";

// Mock Tauri dialog
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));

// Mock KeyPathInput
vi.mock("@/components/Settings/KeyPathInput", () => ({
  KeyPathInput: ({ value }: { value: string }) => (
    <input data-testid="mock-key-path-input" value={value} readOnly />
  ),
}));

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function queryAll(testId: string): NodeListOf<Element> {
  return container.querySelectorAll(`[data-testid="${testId}"]`);
}

function renderForm(
  schema: SettingsSchema,
  settings: Record<string, unknown>,
  onChange: (s: Record<string, unknown>) => void
) {
  act(() => {
    root.render(
      <ConnectionSettingsForm schema={schema} settings={settings} onChange={onChange} />
    );
  });
}

const SSH_SCHEMA: SettingsSchema = {
  groups: [
    {
      key: "connection",
      label: "Connection",
      fields: [
        {
          key: "host",
          label: "Host",
          fieldType: { type: "text" },
          required: true,
          placeholder: "example.com",
        },
        {
          key: "port",
          label: "Port",
          fieldType: { type: "port" },
          required: true,
          default: 22,
        },
      ],
    },
    {
      key: "authentication",
      label: "Authentication",
      fields: [
        {
          key: "authMethod",
          label: "Auth Method",
          fieldType: {
            type: "select",
            options: [
              { value: "key", label: "SSH Key" },
              { value: "password", label: "Password" },
            ],
          },
          required: true,
          default: "key",
        },
        {
          key: "keyPath",
          label: "Key Path",
          fieldType: { type: "filePath", kind: "file" },
          required: false,
          visibleWhen: { field: "authMethod", equals: "key" },
        },
        {
          key: "password",
          label: "Password",
          fieldType: { type: "password" },
          required: false,
          visibleWhen: { field: "authMethod", equals: "password" },
        },
      ],
    },
  ],
};

describe("ConnectionSettingsForm", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders all groups and visible fields", () => {
    renderForm(SSH_SCHEMA, { authMethod: "key", port: 22 }, vi.fn());
    expect(query("connection-settings-form")).toBeTruthy();
    expect(query("form-group-connection")).toBeTruthy();
    expect(query("form-group-authentication")).toBeTruthy();
    expect(query("field-host")).toBeTruthy();
    expect(query("field-port")).toBeTruthy();
    expect(query("field-authMethod")).toBeTruthy();
    // Key path visible when authMethod = "key"
    expect(query("dynamic-field-keyPath")).toBeTruthy();
    // Password NOT visible when authMethod = "key"
    expect(query("dynamic-field-password")).toBeNull();
  });

  it("hides fields when visibility condition is not met", () => {
    renderForm(SSH_SCHEMA, { authMethod: "password", port: 22 }, vi.fn());
    // Password visible when authMethod = "password"
    expect(query("dynamic-field-password")).toBeTruthy();
    // Key path NOT visible when authMethod = "password"
    expect(query("dynamic-field-keyPath")).toBeNull();
  });

  it("hides entire group when all fields are hidden", () => {
    // Create a schema where the only group has all fields conditional
    const schema: SettingsSchema = {
      groups: [
        {
          key: "conditional",
          label: "Conditional",
          fields: [
            {
              key: "extra",
              label: "Extra",
              fieldType: { type: "text" },
              required: false,
              visibleWhen: { field: "mode", equals: "advanced" },
            },
          ],
        },
      ],
    };
    renderForm(schema, { mode: "basic" }, vi.fn());
    expect(query("form-group-conditional")).toBeNull();
  });

  it("calls onChange with updated settings when a field changes", () => {
    const onChange = vi.fn();
    renderForm(SSH_SCHEMA, { authMethod: "key", port: 22, host: "" }, onChange);
    const portInput = query("field-port") as HTMLInputElement;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )?.set;
    act(() => {
      nativeInputValueSetter?.call(portInput, "2222");
      portInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ port: 2222 })
    );
  });

  it("renders empty schema without errors", () => {
    renderForm({ groups: [] }, {}, vi.fn());
    expect(query("connection-settings-form")).toBeTruthy();
    expect(queryAll("[data-testid^='form-group-']").length).toBe(0);
  });
});
