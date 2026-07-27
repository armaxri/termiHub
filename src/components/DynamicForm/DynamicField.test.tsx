import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { listSerialPorts } from "@/services/api";
import { createRoot, Root } from "react-dom/client";
import type { SettingsField } from "@/types/schema";
import { DynamicField } from "./DynamicField";

// Mock Tauri dialog
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));

// Mock serial port listing
vi.mock("@/services/api", () => ({
  listSerialPorts: vi.fn().mockResolvedValue(["/dev/ttyUSB0", "/dev/ttyS0"]),
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

function renderField(
  field: SettingsField,
  value: unknown,
  onChange: (v: unknown) => void,
  opts: { availablePorts?: string[]; error?: string } = {}
) {
  act(() => {
    root.render(
      <DynamicField
        field={field}
        value={value}
        onChange={onChange}
        availablePorts={opts.availablePorts}
        error={opts.error}
      />
    );
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
      expect(onChange).toHaveBeenCalledWith("new");
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

  /** Set an input's value the React-controlled way (native setter + input event). */
  function setNumber(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  describe("number field", () => {
    const numberField: SettingsField = {
      key: "timeout",
      label: "Timeout",
      fieldType: { type: "number", min: 0, max: 300 },
      required: false,
    };

    it("renders number input with min/max", () => {
      renderField(numberField, 30, vi.fn());
      const input = query("field-timeout") as HTMLInputElement;
      expect(input.type).toBe("number");
      expect(input.min).toBe("0");
      expect(input.max).toBe("300");
      expect(input.valueAsNumber).toBe(30);
    });

    it("renders a blank box when the value is undefined (#1444)", () => {
      renderField(numberField, undefined, vi.fn());
      expect((query("field-timeout") as HTMLInputElement).value).toBe("");
    });

    it("emits a parsed number when a value is typed (#1444)", () => {
      const onChange = vi.fn();
      renderField(numberField, 30, onChange);
      setNumber(query("field-timeout") as HTMLInputElement, "120");
      expect(onChange).toHaveBeenCalledWith(120);
    });

    it("clears to undefined (not 0) when the input is emptied (#1444)", () => {
      const onChange = vi.fn();
      renderField(numberField, 30, onChange);
      setNumber(query("field-timeout") as HTMLInputElement, "");
      expect(onChange).toHaveBeenCalledWith(undefined);
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
      const toggle = query("field-removeOnExit") as HTMLButtonElement;
      expect(toggle).toBeTruthy();
      expect(toggle.getAttribute("role")).toBe("switch");
      expect(toggle.getAttribute("aria-checked")).toBe("true");
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

    it("falls back to schema default when value is undefined", () => {
      const field: SettingsField = {
        key: "shellIntegration",
        label: "Shell Integration",
        fieldType: { type: "boolean" },
        required: false,
        default: true,
      };
      renderField(field, undefined, vi.fn());
      const toggle = query("field-shellIntegration") as HTMLButtonElement;
      expect(toggle.getAttribute("aria-checked")).toBe("true");
    });

    it("falls back to false when value is undefined and no schema default", () => {
      const field: SettingsField = {
        key: "flag",
        label: "Flag",
        fieldType: { type: "boolean" },
        required: false,
      };
      renderField(field, undefined, vi.fn());
      const toggle = query("field-flag") as HTMLButtonElement;
      expect(toggle.getAttribute("aria-checked")).toBe("false");
    });

    describe("help dialog (#2071 — shared Modal)", () => {
      const helpField: SettingsField = {
        key: "shellIntegration",
        label: "Shell Integration",
        fieldType: { type: "boolean" },
        required: false,
        helpText: "First paragraph.\n\nSecond paragraph.",
      };

      it("shows no help button when the field has no helpText", () => {
        renderField({ ...helpField, helpText: undefined }, false, vi.fn());
        expect(query("field-shellIntegration-help")).toBeNull();
      });

      it("opens an accessible modal dialog with the field label as its name", () => {
        renderField(helpField, false, vi.fn());
        act(() => {
          (query("field-shellIntegration-help") as HTMLElement).click();
        });
        // Radix Dialog portals to document.body, so query the whole document.
        const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
        expect(dialog).toBeTruthy();
        // The dialog is labelled by its title (Radix wires aria-labelledby).
        expect(dialog.textContent).toContain("Shell Integration");
        expect(dialog.textContent).toContain("First paragraph.");
        expect(dialog.textContent).toContain("Second paragraph.");
        // The shared Modal provides a real close affordance (focus trap/ESC come
        // from Radix and are covered by the Modal primitive's own tests).
        expect(document.querySelector('[data-testid="modal-close"]')).toBeTruthy();
      });

      it("closes the modal when the close button is clicked", () => {
        renderField(helpField, false, vi.fn());
        act(() => {
          (query("field-shellIntegration-help") as HTMLElement).click();
        });
        expect(document.querySelector('[role="dialog"]')).toBeTruthy();
        act(() => {
          (document.querySelector('[data-testid="modal-close"]') as HTMLElement).click();
        });
        expect(document.querySelector('[role="dialog"]')).toBeNull();
      });
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
      // The Select primitive (Radix skin) exposes its value via `data-value` on
      // the trigger button and shows the selected option's label as its text.
      const trigger = query("field-authMethod") as HTMLButtonElement;
      expect(trigger.getAttribute("data-value")).toBe("key");
      expect(trigger.textContent).toContain("SSH Key");
      expect(trigger.hasAttribute("disabled")).toBe(false);
    });

    it("disables select when only one option exists", () => {
      const field: SettingsField = {
        key: "runtime",
        label: "Runtime",
        fieldType: {
          type: "select",
          options: [{ value: "docker", label: "Docker" }],
        },
        required: true,
      };
      renderField(field, "docker", vi.fn());
      const trigger = query("field-runtime") as HTMLButtonElement;
      expect(trigger.hasAttribute("disabled")).toBe(true);
      expect(trigger.getAttribute("data-value")).toBe("docker");
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

    it("clears to undefined (not 0) when the input is emptied (#1444)", () => {
      const field: SettingsField = {
        key: "port",
        label: "Port",
        fieldType: { type: "port" },
        required: true,
      };
      const onChange = vi.fn();
      renderField(field, 22, onChange);
      setNumber(query("field-port") as HTMLInputElement, "");
      expect(onChange).toHaveBeenCalledWith(undefined);
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
      expect(onChange).toHaveBeenCalledWith([{ key: "", value: "" }]);
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
      expect(onChange).toHaveBeenCalledWith([{ key: "B", value: "2" }]);
    });
  });

  describe("serialPort field", () => {
    const serialPortField: SettingsField = {
      key: "port",
      label: "Port",
      fieldType: { type: "serialPort" },
      required: true,
    };

    /** Set an input's value the React-controlled way (native setter + input event). */
    function typeInto(input: HTMLInputElement, value: string) {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      act(() => {
        setter?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }

    /** The datalist the port input is wired to via its `list` attribute. */
    function datalistFor(input: HTMLInputElement): HTMLDataListElement {
      const listId = input.getAttribute("list");
      expect(listId).toBeTruthy();
      return container.querySelector(`#${listId}`) as HTMLDataListElement;
    }

    it("renders an editable text input (not a select)", async () => {
      await act(async () => {
        renderField(serialPortField, "/dev/ttyUSB0", vi.fn());
      });
      const input = query("field-port") as HTMLInputElement;
      expect(input.tagName).toBe("INPUT");
      expect(input.value).toBe("/dev/ttyUSB0");
    });

    it("offers detected ports as datalist suggestions", async () => {
      await act(async () => {
        renderField(serialPortField, "", vi.fn());
      });
      const datalist = datalistFor(query("field-port") as HTMLInputElement);
      const optionValues = Array.from(datalist.options).map((o) => o.value);
      expect(optionValues).toContain("/dev/ttyUSB0");
      expect(optionValues).toContain("/dev/ttyS0");
    });

    it("accepts a typed device path that is not a detected port", async () => {
      const onChange = vi.fn();
      await act(async () => {
        renderField(serialPortField, "", onChange);
      });
      typeInto(query("field-port") as HTMLInputElement, "/tmp/termihub-serial-a");
      expect(onChange).toHaveBeenCalledWith("/tmp/termihub-serial-a");
    });

    it("clears to undefined when the input is emptied", async () => {
      const onChange = vi.fn();
      await act(async () => {
        renderField(serialPortField, "/dev/ttyUSB0", onChange);
      });
      typeInto(query("field-port") as HTMLInputElement, "");
      expect(onChange).toHaveBeenCalledWith(undefined);
    });

    it("shows a not-connected hint when the value is not a detected port", async () => {
      await act(async () => {
        renderField(serialPortField, "/dev/ttyUSB1", vi.fn());
      });
      const hint = query("field-port-disconnected");
      expect(hint).toBeTruthy();
      expect(hint?.textContent).toContain("not connected");
    });

    it("does not show the hint when the value is a detected port", async () => {
      await act(async () => {
        renderField(serialPortField, "/dev/ttyUSB0", vi.fn());
      });
      expect(query("field-port-disconnected")).toBeNull();
    });

    it("does not show the hint when the value is empty", async () => {
      await act(async () => {
        renderField(serialPortField, "", vi.fn());
      });
      expect(query("field-port-disconnected")).toBeNull();
    });

    it("calls listSerialPorts on mount", async () => {
      await act(async () => {
        renderField(serialPortField, "", vi.fn());
      });
      expect(listSerialPorts).toHaveBeenCalled();
    });

    it("uses provided availablePorts instead of calling listSerialPorts", async () => {
      const callCountBefore = (listSerialPorts as ReturnType<typeof vi.fn>).mock.calls.length;
      await act(async () => {
        renderField(serialPortField, "/dev/ttyAMA0", vi.fn(), {
          availablePorts: ["/dev/ttyAMA0", "/dev/ttyAMA1"],
        });
      });
      expect((listSerialPorts as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callCountBefore);
      const datalist = datalistFor(query("field-port") as HTMLInputElement);
      const optionValues = Array.from(datalist.options).map((o) => o.value);
      expect(optionValues).toContain("/dev/ttyAMA0");
      expect(optionValues).toContain("/dev/ttyAMA1");
      expect(optionValues).not.toContain("/dev/ttyUSB0");
    });

    it("shows the not-connected hint from availablePorts when value is not in the supplied list", async () => {
      await act(async () => {
        renderField(serialPortField, "/dev/ttyAMA2", vi.fn(), {
          availablePorts: ["/dev/ttyAMA0"],
        });
      });
      const hint = query("field-port-disconnected");
      expect(hint).toBeTruthy();
      expect(hint?.textContent).toContain("not connected");
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
      // The per-row boolean is a Toggle (Radix Switch) — read `aria-checked`.
      expect(query("field-volumes-readOnly-0")?.getAttribute("aria-checked")).toBe("true");
    });

    it("adds new item with defaults", () => {
      const onChange = vi.fn();
      renderField(volumeField, [], onChange);
      act(() => {
        (query("field-volumes-add") as HTMLElement).click();
      });
      expect(onChange).toHaveBeenCalledWith([{ hostPath: "", containerPath: "", readOnly: false }]);
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
      expect(onChange).toHaveBeenCalledWith([
        { hostPath: "/c", containerPath: "/d", readOnly: true },
      ]);
    });
  });

  describe("error prop", () => {
    it("displays inline error message when error is provided", () => {
      renderField(textField("host"), "", vi.fn(), { error: "Host is required" });
      expect(container.textContent).toContain("Host is required");
      expect(query("field-host-error")).toBeTruthy();
    });

    it("does not render error element when error is undefined", () => {
      renderField(textField("host"), "example.com", vi.fn());
      expect(query("field-host-error")).toBeNull();
    });
  });

  describe("required-field markers", () => {
    it("renders a required marker and aria-required for a required field", () => {
      renderField(textField("host", { required: true }), "", vi.fn());
      const input = query("field-host") as HTMLInputElement;
      expect(input.getAttribute("aria-required")).toBe("true");
      expect(container.querySelector(".settings-form__required")).toBeTruthy();
    });

    it("omits the marker and aria-required for an optional field", () => {
      renderField(textField("host", { required: false }), "", vi.fn());
      const input = query("field-host") as HTMLInputElement;
      expect(input.getAttribute("aria-required")).toBeNull();
      expect(container.querySelector(".settings-form__required")).toBeNull();
    });
  });
});
