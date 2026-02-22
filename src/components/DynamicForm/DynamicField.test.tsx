import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { SettingsField } from "@/types/schema";
import { DynamicField } from "./DynamicField";

// Mock Tauri dialog
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));

// Mock KeyPathInput to avoid heavy dependencies in unit tests
vi.mock("@/components/Settings/KeyPathInput", () => ({
  KeyPathInput: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
  }) => (
    <input
      data-testid="mock-key-path-input"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  ),
}));

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function renderField(field: SettingsField, value: unknown, onChange: (k: string, v: unknown) => void) {
  act(() => {
    root.render(<DynamicField field={field} value={value} onChange={onChange} />);
  });
}

function textField(key: string, opts: Partial<SettingsField> = {}): SettingsField {
  return {
    key,
    label: key.charAt(0).toUpperCase() + key.slice(1),
    fieldType: { type: "text" },
    required: false,
    ...opts,
  };
}

function passwordField(key: string, opts: Partial<SettingsField> = {}): SettingsField {
  return {
    key,
    label: key.charAt(0).toUpperCase() + key.slice(1),
    fieldType: { type: "password" },
    required: false,
    ...opts,
  };
}

describe("DynamicField", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  describe("text field", () => {
    it("renders text input with value", () => {
      renderField(textField("host"), "example.com", vi.fn());
      const input = query("field-host") as HTMLInputElement;
      expect(input).toBeTruthy();
      expect(input.value).toBe("example.com");
      expect(input.type).toBe("text");
    });

    it("calls onChange on input change", () => {
      const onChange = vi.fn();
      renderField(textField("host"), "", onChange);
      const input = query("field-host") as HTMLInputElement;
      // Use React-compatible native input simulation
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      act(() => {
        nativeInputValueSetter?.call(input, "new");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(onChange).toHaveBeenCalledWith("host", "new");
    });

    it("renders placeholder", () => {
      renderField(textField("host", { placeholder: "example.com" }), "", vi.fn());
      const input = query("field-host") as HTMLInputElement;
      expect(input.placeholder).toBe("example.com");
    });

    it("renders description as hint", () => {
      renderField(textField("host", { description: "Server address" }), "", vi.fn());
      expect(container.textContent).toContain("Server address");
    });
  });

  describe("password field", () => {
    it("renders password input", () => {
      renderField(passwordField("password"), "secret", vi.fn());
      const input = query("field-password") as HTMLInputElement;
      expect(input).toBeTruthy();
      expect(input.type).toBe("password");
      expect(input.value).toBe("secret");
    });
  });

  describe("number field", () => {
    it("renders number input with min/max", () => {
      const field: SettingsField = {
        key: "timeout",
        label: "Timeout",
        fieldType: { type: "number", min: 0, max: 300 },
        required: false,
      };
      renderField(field, 30, vi.fn());
      const input = query("field-timeout") as HTMLInputElement;
      expect(input.type).toBe("number");
      expect(input.min).toBe("0");
      expect(input.max).toBe("300");
      expect(input.valueAsNumber).toBe(30);
    });
  });

  describe("boolean field", () => {
    it("renders checkbox with checked state", () => {
      const field: SettingsField = {
        key: "removeOnExit",
        label: "Remove on Exit",
        fieldType: { type: "boolean" },
        required: false,
      };
      renderField(field, true, vi.fn());
      const input = query("field-removeOnExit") as HTMLInputElement;
      expect(input).toBeTruthy();
      expect(input.type).toBe("checkbox");
      expect(input.checked).toBe(true);
    });

    it("renders label text", () => {
      const field: SettingsField = {
        key: "removeOnExit",
        label: "Remove on Exit",
        fieldType: { type: "boolean" },
        required: false,
      };
      renderField(field, false, vi.fn());
      expect(container.textContent).toContain("Remove on Exit");
    });
  });

  describe("select field", () => {
    it("renders select with options", () => {
      const field: SettingsField = {
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
      };
      renderField(field, "key", vi.fn());
      const select = query("field-authMethod") as HTMLSelectElement;
      expect(select.value).toBe("key");
      expect(select.options.length).toBe(2);
      expect(select.options[0].text).toBe("SSH Key");
      expect(select.options[1].text).toBe("Password");
    });
  });

  describe("port field", () => {
    it("renders port input with 1-65535 bounds", () => {
      const field: SettingsField = {
        key: "port",
        label: "Port",
        fieldType: { type: "port" },
        required: true,
      };
      renderField(field, 22, vi.fn());
      const input = query("field-port") as HTMLInputElement;
      expect(input.type).toBe("number");
      expect(input.min).toBe("1");
      expect(input.max).toBe("65535");
      expect(input.valueAsNumber).toBe(22);
    });
  });

  describe("filePath field", () => {
    it("renders text input with browse button for directory", () => {
      const field: SettingsField = {
        key: "startingDirectory",
        label: "Starting Directory",
        fieldType: { type: "filePath", kind: "directory" },
        required: false,
      };
      renderField(field, "/home/user", vi.fn());
      const input = query("field-startingDirectory") as HTMLInputElement;
      expect(input.value).toBe("/home/user");
      expect(query("field-startingDirectory-browse")).toBeTruthy();
    });

    it("renders KeyPathInput for keyPath fields", () => {
      const field: SettingsField = {
        key: "keyPath",
        label: "Key Path",
        fieldType: { type: "filePath", kind: "file" },
        required: false,
      };
      renderField(field, "~/.ssh/id_rsa", vi.fn());
      const mockInput = query("mock-key-path-input") as HTMLInputElement;
      expect(mockInput).toBeTruthy();
      expect(mockInput.value).toBe("~/.ssh/id_rsa");
    });
  });

  describe("keyValueList field", () => {
    const kvField: SettingsField = {
      key: "envVars",
      label: "Environment Variables",
      fieldType: { type: "keyValueList" },
      required: false,
    };

    it("renders empty list with add button", () => {
      renderField(kvField, [], vi.fn());
      expect(query("field-envVars-add")).toBeTruthy();
    });

    it("renders existing key-value pairs", () => {
      const items = [{ key: "FOO", value: "bar" }];
      renderField(kvField, items, vi.fn());
      expect((query("field-envVars-key-0") as HTMLInputElement).value).toBe("FOO");
      expect((query("field-envVars-value-0") as HTMLInputElement).value).toBe("bar");
    });

    it("adds new item on click", () => {
      const onChange = vi.fn();
      renderField(kvField, [], onChange);
      act(() => {
        (query("field-envVars-add") as HTMLElement).click();
      });
      expect(onChange).toHaveBeenCalledWith("envVars", [{ key: "", value: "" }]);
    });

    it("removes item on click", () => {
      const onChange = vi.fn();
      const items = [
        { key: "A", value: "1" },
        { key: "B", value: "2" },
      ];
      renderField(kvField, items, onChange);
      act(() => {
        (query("field-envVars-remove-0") as HTMLElement).click();
      });
      expect(onChange).toHaveBeenCalledWith("envVars", [{ key: "B", value: "2" }]);
    });
  });

  describe("objectList field", () => {
    const volumeField: SettingsField = {
      key: "volumes",
      label: "Volumes",
      fieldType: {
        type: "objectList",
        fields: [
          {
            key: "hostPath",
            label: "Host Path",
            fieldType: { type: "filePath", kind: "directory" },
            required: true,
          },
          {
            key: "containerPath",
            label: "Container Path",
            fieldType: { type: "text" },
            required: true,
          },
          {
            key: "readOnly",
            label: "RO",
            fieldType: { type: "boolean" },
            required: false,
            default: false,
          },
        ],
      },
      required: false,
    };

    it("renders empty list with add button", () => {
      renderField(volumeField, [], vi.fn());
      expect(query("field-volumes-add")).toBeTruthy();
    });

    it("renders existing items", () => {
      const items = [{ hostPath: "/data", containerPath: "/mnt", readOnly: true }];
      renderField(volumeField, items, vi.fn());
      expect((query("field-volumes-hostPath-0") as HTMLInputElement).value).toBe("/data");
      expect((query("field-volumes-containerPath-0") as HTMLInputElement).value).toBe("/mnt");
      expect((query("field-volumes-readOnly-0") as HTMLInputElement).checked).toBe(true);
    });

    it("adds new item with defaults", () => {
      const onChange = vi.fn();
      renderField(volumeField, [], onChange);
      act(() => {
        (query("field-volumes-add") as HTMLElement).click();
      });
      expect(onChange).toHaveBeenCalledWith("volumes", [
        { hostPath: "", containerPath: "", readOnly: false },
      ]);
    });

    it("removes item on click", () => {
      const onChange = vi.fn();
      const items = [
        { hostPath: "/a", containerPath: "/b", readOnly: false },
        { hostPath: "/c", containerPath: "/d", readOnly: true },
      ];
      renderField(volumeField, items, onChange);
      act(() => {
        (query("field-volumes-remove-0") as HTMLElement).click();
      });
      expect(onChange).toHaveBeenCalledWith("volumes", [
        { hostPath: "/c", containerPath: "/d", readOnly: true },
      ]);
    });
  });
});
