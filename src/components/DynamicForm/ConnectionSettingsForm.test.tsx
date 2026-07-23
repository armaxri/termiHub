import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { SettingsSchema } from "@/types/schema";
import { ConnectionSettingsForm } from "./ConnectionSettingsForm";
import { dispatchCommand, type BridgeDeps } from "@/testbridge/dispatcher";

// Mock Tauri dialog
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));

// Mock serial port listing
vi.mock("@/services/api", () => ({
  listSerialPorts: vi.fn().mockResolvedValue([]),
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
    root.render(<ConnectionSettingsForm schema={schema} settings={settings} onChange={onChange} />);
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

  // Regression for #1820: when the connection type changes, the previous type's
  // value for a field whose name is shared between schemas (both the local shell
  // and SSH have a `shell` field) must not leak into the new type. Without the
  // fix, react-hook-form's per-name value cache re-populated the SSH Advanced →
  // Shell field with the local default shell (`powershell` on Windows), which
  // the user could not clear.
  it("clears a shared-name field when switching to a schema that omits its default (#1820)", () => {
    // A local-shell-like schema whose `shell` field is pre-filled.
    const LOCAL_SCHEMA: SettingsSchema = {
      groups: [
        {
          key: "shell",
          label: "Shell",
          fields: [
            {
              key: "shell",
              label: "Shell",
              fieldType: {
                type: "select",
                options: [
                  { value: "powershell", label: "PowerShell" },
                  { value: "cmd", label: "cmd" },
                ],
              },
              required: false,
              default: "powershell",
            },
          ],
        },
      ],
    };
    // An SSH-like schema whose Advanced `shell` field is a free-text field with
    // no default (matches the real core SSH schema).
    const SSH_WITH_SHELL: SettingsSchema = {
      groups: [
        {
          key: "connection",
          label: "Connection",
          fields: [{ key: "host", label: "Host", fieldType: { type: "text" }, required: true }],
        },
        {
          key: "advanced",
          label: "Advanced",
          fields: [
            {
              key: "shell",
              label: "Shell",
              fieldType: { type: "text" },
              required: false,
              placeholder: "/bin/bash",
            },
          ],
        },
      ],
    };

    const onChange = vi.fn();
    renderForm(LOCAL_SCHEMA, { shell: "powershell" }, onChange);
    // Switch to the SSH schema with settings that carry no `shell` value.
    renderForm(SSH_WITH_SHELL, {}, onChange);

    const shellInput = query("field-shell") as HTMLInputElement | null;
    expect(shellInput).toBeTruthy();
    expect(shellInput!.value).toBe("");
  });

  it("hides fields when visibility condition is not met", () => {
    renderForm(SSH_SCHEMA, { authMethod: "password", port: 22 }, vi.fn());
    // Password visible when authMethod = "password"
    expect(query("dynamic-field-password")).toBeTruthy();
    // Key path NOT visible when authMethod = "password"
    expect(query("dynamic-field-keyPath")).toBeNull();
  });

  it("updates conditional fields when the test bridge selects an option", async () => {
    // Regression: the auth-method dropdown is a react-hook-form Controller, whose
    // watched value drives `visibleWhen`. A bridge `select` must actually update
    // that value so dependent fields (keyPath) appear — i.e. it must drive the
    // migrated Radix Select the way a real user does. The live harness wraps
    // `select` in a retry (`wait`), so mirror that here; in a WebView one call
    // suffices, but Radix binds its portalled option handlers a tick after open.
    renderForm(SSH_SCHEMA, { authMethod: "password", port: 22 }, vi.fn());
    expect(query("dynamic-field-keyPath")).toBeNull();

    const deps: BridgeDeps = {
      root: container,
      readTerminal: () => undefined,
      scrollTerminal: () => false,
      getTerminalViewport: () => undefined,
      getActiveTabId: () => undefined,
      getState: () => ({}),
      sendTerminalInput: async () => false,
      resizeWindow: async () => {},
      screenshot: async () => "data:image/png;base64,AAAA",
      emitEvent: async () => {},
    };
    for (let i = 0; i < 3 && query("dynamic-field-keyPath") === null; i++) {
      await act(async () => {
        await dispatchCommand({ action: "select", testId: "field-authMethod", value: "key" }, deps);
      });
    }

    expect(query("dynamic-field-keyPath")).toBeTruthy();
    expect(query("dynamic-field-password")).toBeNull();
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
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ port: 2222 }));
  });

  describe("host:port auto-extract on blur (PR #195 / #895)", () => {
    const setHostValue = (hostInput: HTMLInputElement, value: string) => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      nativeInputValueSetter?.call(hostInput, value);
      hostInput.dispatchEvent(new Event("input", { bubbles: true }));
    };

    it("splits an IPv4 host:port into host and port when the host field blurs", async () => {
      const onChange = vi.fn();
      await act(async () => {
        renderForm(SSH_SCHEMA, { authMethod: "key", port: 22, host: "" }, onChange);
      });
      const hostInput = query("field-host") as HTMLInputElement;
      await act(async () => {
        setHostValue(hostInput, "192.168.0.2:2222");
      });
      await act(async () => {
        hostInput.dispatchEvent(new Event("focusout", { bubbles: true }));
      });

      const portInput = query("field-port") as HTMLInputElement;
      expect(hostInput.value).toBe("192.168.0.2");
      expect(portInput.value).toBe("2222");
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ host: "192.168.0.2", port: 2222 })
      );
    });

    it("splits a bracketed IPv6 host:port into host and port on blur", async () => {
      const onChange = vi.fn();
      await act(async () => {
        renderForm(SSH_SCHEMA, { authMethod: "key", port: 22, host: "" }, onChange);
      });
      const hostInput = query("field-host") as HTMLInputElement;
      await act(async () => {
        setHostValue(hostInput, "[::1]:2022");
      });
      await act(async () => {
        hostInput.dispatchEvent(new Event("focusout", { bubbles: true }));
      });

      const portInput = query("field-port") as HTMLInputElement;
      expect(hostInput.value).toBe("::1");
      expect(portInput.value).toBe("2022");
    });

    it("leaves a bare hostname unchanged and keeps the existing port on blur", async () => {
      await act(async () => {
        renderForm(SSH_SCHEMA, { authMethod: "key", port: 22, host: "" }, vi.fn());
      });
      const hostInput = query("field-host") as HTMLInputElement;
      await act(async () => {
        setHostValue(hostInput, "example.com");
      });
      await act(async () => {
        hostInput.dispatchEvent(new Event("focusout", { bubbles: true }));
      });

      const portInput = query("field-port") as HTMLInputElement;
      expect(hostInput.value).toBe("example.com");
      expect(portInput.value).toBe("22");
    });

    it("leaves a bare IPv6 address intact on blur (no spurious split)", async () => {
      await act(async () => {
        renderForm(SSH_SCHEMA, { authMethod: "key", port: 22, host: "" }, vi.fn());
      });
      const hostInput = query("field-host") as HTMLInputElement;
      await act(async () => {
        setHostValue(hostInput, "::1");
      });
      await act(async () => {
        hostInput.dispatchEvent(new Event("focusout", { bubbles: true }));
      });

      const portInput = query("field-port") as HTMLInputElement;
      expect(hostInput.value).toBe("::1");
      expect(portInput.value).toBe("22");
    });

    it("does not split when the schema has no port field", async () => {
      // A schema with a host field but no sibling port must leave host untouched.
      const schema: SettingsSchema = {
        groups: [
          {
            key: "connection",
            label: "Connection",
            fields: [{ key: "host", label: "Host", fieldType: { type: "text" }, required: true }],
          },
        ],
      };
      await act(async () => {
        renderForm(schema, { host: "" }, vi.fn());
      });
      const hostInput = query("field-host") as HTMLInputElement;
      await act(async () => {
        setHostValue(hostInput, "192.168.0.2:2222");
      });
      await act(async () => {
        hostInput.dispatchEvent(new Event("focusout", { bubbles: true }));
      });

      expect(hostInput.value).toBe("192.168.0.2:2222");
    });
  });

  it("renders empty schema without errors", () => {
    renderForm({ groups: [] }, {}, vi.fn());
    expect(query("connection-settings-form")).toBeTruthy();
    expect(queryAll("[data-testid^='form-group-']").length).toBe(0);
  });

  it("shows credential saved hint for empty password fields when enabled", () => {
    const schema: SettingsSchema = {
      groups: [
        {
          key: "auth",
          label: "Auth",
          fields: [
            {
              key: "password",
              label: "Password",
              fieldType: { type: "password" },
              required: false,
            },
          ],
        },
      ],
    };
    act(() => {
      root.render(
        <ConnectionSettingsForm
          schema={schema}
          settings={{}}
          onChange={vi.fn()}
          credentialSavedHint={true}
        />
      );
    });
    expect(query("field-password-credential-saved")).toBeTruthy();
  });

  it("shows validation error for invalid port", async () => {
    await act(async () => {
      renderForm(SSH_SCHEMA, { authMethod: "key", port: 22, host: "h" }, vi.fn());
    });
    const portInput = query("field-port") as HTMLInputElement;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )?.set;
    await act(async () => {
      nativeInputValueSetter?.call(portInput, "0");
      portInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(query("field-port-error")).toBeTruthy();
  });

  it("clears validation error when field becomes valid", async () => {
    await act(async () => {
      renderForm(SSH_SCHEMA, { authMethod: "key", port: 22, host: "" }, vi.fn());
    });
    const hostInput = query("field-host") as HTMLInputElement;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )?.set;

    // Trigger error
    await act(async () => {
      nativeInputValueSetter?.call(hostInput, "");
      hostInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // Fix the value
    await act(async () => {
      nativeInputValueSetter?.call(hostInput, "fixed-host");
      hostInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(query("field-host-error")).toBeNull();
  });
});
