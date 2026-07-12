import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { JumpHostConfig } from "@/types/connection";
import { JumpHostSection } from "./JumpHostSection";

// Mock the heavy KeyPathInput (pulls in SSH key validation / fs APIs). Honor the
// passed testIdPrefix so per-hop key-path fields stay addressable.
vi.mock("@/components/Settings/KeyPathInput", () => ({
  KeyPathInput: ({
    value,
    onChange,
    placeholder,
    testIdPrefix,
  }: {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    testIdPrefix?: string;
  }) => (
    <input
      data-testid={testIdPrefix}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  ),
}));

vi.mock("@/components/PasswordInput/PasswordInput", () => ({
  PasswordInput: ({
    value,
    onChange,
    placeholder,
    "data-testid": testId,
  }: {
    value: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    placeholder?: string;
    "data-testid"?: string;
  }) => (
    <input
      type="password"
      data-testid={testId}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
    />
  ),
}));

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function render(
  value: JumpHostConfig[] | undefined,
  onChange: (hops: JumpHostConfig[] | undefined) => void,
  opts: {
    targetHost?: string;
    errors?: string[];
    warnings?: string[];
    savedConnections?: { id: string; label: string }[];
  } = {}
) {
  act(() => {
    root.render(
      <JumpHostSection
        value={value}
        targetHost={opts.targetHost ?? "target.internal"}
        onChange={onChange}
        savedConnections={opts.savedConnections}
        errors={opts.errors}
        warnings={opts.warnings}
      />
    );
  });
}

/** Set a value on a React-controlled <input> and fire the native input event. */
function setValue(el: HTMLInputElement, value: string, event = "input") {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event(event, { bubbles: true }));
  });
}

/**
 * Select an option in a shared {@link Select} (Radix) primitive addressed by
 * its trigger test id. Opens via the keyboard path (mirrors ui/Select.test.tsx,
 * which avoids the pointer-capture jsdom gap), then clicks the option whose text
 * matches `label`.
 */
function selectOption(triggerTestId: string, label: string) {
  const trigger = query(triggerTestId) as HTMLButtonElement;
  act(() => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  const option = Array.from(document.querySelectorAll('[role="option"]')).find((o) =>
    o.textContent?.includes(label)
  ) as HTMLElement | undefined;
  act(() => {
    option?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const HOP: JumpHostConfig = {
  host: "bastion.example.com",
  port: 2222,
  username: "admin",
  authMethod: "key",
  keyPath: "~/.ssh/bastion",
};

const HOP2: JumpHostConfig = {
  host: "internal-bastion",
  port: 22,
  username: "ops",
  authMethod: "agent",
};

describe("JumpHostSection", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("is disabled with no inline fields when value is empty", () => {
    render(undefined, vi.fn());
    const checkbox = query("jump-host-enabled") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(query("jump-host-host-0")).toBeNull();
  });

  it("enabling emits a default single inline hop", () => {
    const onChange = vi.fn();
    render(undefined, onChange);
    act(() => {
      (query("jump-host-enabled") as HTMLInputElement).click();
    });
    expect(onChange).toHaveBeenCalledWith([
      { host: "", port: 22, username: "", authMethod: "key" },
    ]);
  });

  it("renders the inline fields populated from the hop (single hop, no card)", () => {
    render([HOP], vi.fn());
    expect((query("jump-host-host-0") as HTMLInputElement).value).toBe("bastion.example.com");
    expect((query("jump-host-port-0") as HTMLInputElement).value).toBe("2222");
    expect((query("jump-host-username-0") as HTMLInputElement).value).toBe("admin");
    expect(query("jump-host-auth-method-0")?.getAttribute("data-value")).toBe("key");
    expect(query("jump-host-key-path-0")).toBeTruthy();
    expect(query("jump-host-password-0")).toBeNull();
    // A single hop is not wrapped in a numbered card.
    expect(query("jump-host-card-0")).toBeNull();
  });

  it("editing the host merges into the existing hop", () => {
    const onChange = vi.fn();
    render([HOP], onChange);
    setValue(query("jump-host-host-0") as HTMLInputElement, "edge.example.com");
    expect(onChange).toHaveBeenCalledWith([{ ...HOP, host: "edge.example.com" }]);
  });

  it("editing the port merges the parsed number into the hop (#1444)", () => {
    const onChange = vi.fn();
    render([HOP], onChange);
    setValue(query("jump-host-port-0") as HTMLInputElement, "2200");
    expect(onChange).toHaveBeenCalledWith([{ ...HOP, port: 2200 }]);
  });

  it("clearing the port keeps it blank instead of coercing to a default (#1444)", () => {
    const onChange = vi.fn();
    render([HOP], onChange);
    setValue(query("jump-host-port-0") as HTMLInputElement, "");
    expect(onChange).toHaveBeenCalledWith([{ ...HOP, port: "" }]);
  });

  it("shows the password field for password auth and hides the key path", () => {
    render([{ ...HOP, authMethod: "password" }], vi.fn());
    expect(query("jump-host-password-0")).toBeTruthy();
    expect(query("jump-host-key-path-0")).toBeNull();
  });

  it("agent auth hides both key path and password", () => {
    render([{ ...HOP, authMethod: "agent" }], vi.fn());
    expect(query("jump-host-key-path-0")).toBeNull();
    expect(query("jump-host-password-0")).toBeNull();
  });

  it("switching auth method merges into the hop", () => {
    const onChange = vi.fn();
    render([HOP], onChange);
    selectOption("jump-host-auth-method-0", "Password");
    expect(onChange).toHaveBeenCalledWith([{ ...HOP, authMethod: "password" }]);
  });

  it("renders the per-hop connect timeout populated from the hop", () => {
    render([{ ...HOP, connectTimeoutSecs: 45 }], vi.fn());
    expect((query("jump-host-connect-timeout-0") as HTMLInputElement).value).toBe("45");
  });

  it("shows an empty connect timeout when unset", () => {
    render([HOP], vi.fn());
    expect((query("jump-host-connect-timeout-0") as HTMLInputElement).value).toBe("");
  });

  it("editing the connect timeout merges a number into the hop", () => {
    const onChange = vi.fn();
    render([HOP], onChange);
    setValue(query("jump-host-connect-timeout-0") as HTMLInputElement, "60");
    expect(onChange).toHaveBeenCalledWith([{ ...HOP, connectTimeoutSecs: 60 }]);
  });

  it("clearing the connect timeout resets it to undefined (default)", () => {
    const onChange = vi.fn();
    render([{ ...HOP, connectTimeoutSecs: 45 }], onChange);
    setValue(query("jump-host-connect-timeout-0") as HTMLInputElement, "");
    expect(onChange).toHaveBeenCalledWith([{ ...HOP, connectTimeoutSecs: undefined }]);
  });

  it("disabling clears the jump-host config", () => {
    const onChange = vi.fn();
    render([HOP], onChange);
    act(() => {
      (query("jump-host-enabled") as HTMLInputElement).click();
    });
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("shows the connection path with the target host", () => {
    render([HOP], vi.fn(), { targetHost: "app-server.internal" });
    const path = query("jump-host-path");
    expect(path?.textContent).toContain("bastion.example.com");
    expect(path?.textContent).toContain("app-server.internal");
  });

  // ── Multi-hop ──────────────────────────────────────────────────────

  it("appends a default hop when 'Add another hop' is clicked", () => {
    const onChange = vi.fn();
    render([HOP], onChange);
    act(() => {
      (query("jump-host-add-hop") as HTMLButtonElement).click();
    });
    expect(onChange).toHaveBeenCalledWith([
      HOP,
      { host: "", port: 22, username: "", authMethod: "key" },
    ]);
  });

  it("renders numbered, removable cards for multiple hops", () => {
    render([HOP, HOP2], vi.fn());
    expect(query("jump-host-card-0")).toBeTruthy();
    expect(query("jump-host-card-1")).toBeTruthy();
    expect((query("jump-host-host-1") as HTMLInputElement).value).toBe("internal-bastion");
    expect(query("jump-host-card-0")?.textContent).toContain("outermost");
    expect(query("jump-host-card-1")?.textContent).toContain("innermost");
  });

  it("removing a hop drops it from the chain", () => {
    const onChange = vi.fn();
    render([HOP, HOP2], onChange);
    act(() => {
      (query("jump-host-remove-1") as HTMLButtonElement).click();
    });
    expect(onChange).toHaveBeenCalledWith([HOP]);
  });

  it("editing a second hop merges into the right entry", () => {
    const onChange = vi.fn();
    render([HOP, HOP2], onChange);
    setValue(query("jump-host-username-1") as HTMLInputElement, "deployer");
    expect(onChange).toHaveBeenCalledWith([HOP, { ...HOP2, username: "deployer" }]);
  });

  it("shows the full chain in the connection path", () => {
    render([HOP, HOP2], vi.fn(), { targetHost: "db-server" });
    const path = query("jump-host-path")?.textContent ?? "";
    expect(path).toContain("bastion.example.com");
    expect(path).toContain("internal-bastion");
    expect(path).toContain("db-server");
  });

  // ── Validation display ─────────────────────────────────────────────

  it("renders blocking errors when provided", () => {
    render([{ ...HOP, host: "" }], vi.fn(), { errors: ["Jump host: host is required."] });
    const errors = query("jump-host-errors");
    expect(errors).toBeTruthy();
    expect(errors?.textContent).toContain("host is required");
  });

  it("renders advisory warnings when provided", () => {
    render([HOP], vi.fn(), {
      warnings: ["Chain has 6 hops. Deep chains may add connection latency."],
    });
    expect(query("jump-host-warning")?.textContent).toContain("Deep chains");
    // A warning is not an error block.
    expect(query("jump-host-errors")).toBeNull();
  });

  // ── Source toggle: saved-connection reference vs inline (#940) ──────

  const OPTIONS = [
    { id: "Work/edge", label: "Work / edge" },
    { id: "Work/bastion", label: "Work / bastion" },
  ];

  it("defaults a fresh hop to inline mode with the inline fields shown", () => {
    render([HOP], vi.fn(), { savedConnections: OPTIONS });
    expect(
      (query("jump-host-source-inline-0") as HTMLButtonElement).getAttribute("aria-checked")
    ).toBe("true");
    expect(query("jump-host-host-0")).toBeTruthy();
    expect(query("jump-host-connection-0")).toBeNull();
  });

  it("switching to saved mode selects the first connection and clears inline host/username", () => {
    const onChange = vi.fn();
    render([HOP], onChange, { savedConnections: OPTIONS });
    act(() => {
      (query("jump-host-source-saved-0") as HTMLButtonElement).click();
    });
    expect(onChange).toHaveBeenCalledWith([
      { ...HOP, connectionId: "Work/edge", host: "", username: "" },
    ]);
  });

  it("disables the saved option when there are no SSH connections to reference", () => {
    render([HOP], vi.fn(), { savedConnections: [] });
    expect((query("jump-host-source-saved-0") as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders the dropdown (not inline fields) for a saved-connection hop", () => {
    render([{ ...HOP, connectionId: "Work/bastion" }], vi.fn(), { savedConnections: OPTIONS });
    const select = query("jump-host-connection-0");
    expect(select).toBeTruthy();
    expect(select?.getAttribute("data-value")).toBe("Work/bastion");
    expect(query("jump-host-host-0")).toBeNull();
  });

  it("picking a different connection updates connectionId", () => {
    const onChange = vi.fn();
    render([{ ...HOP, connectionId: "Work/bastion" }], onChange, { savedConnections: OPTIONS });
    selectOption("jump-host-connection-0", "Work / edge");
    expect(onChange).toHaveBeenCalledWith([{ ...HOP, connectionId: "Work/edge" }]);
  });

  it("switching back to inline clears the connectionId", () => {
    const onChange = vi.fn();
    render([{ ...HOP, connectionId: "Work/bastion" }], onChange, { savedConnections: OPTIONS });
    act(() => {
      (query("jump-host-source-inline-0") as HTMLButtonElement).click();
    });
    expect(onChange).toHaveBeenCalledWith([{ ...HOP, connectionId: undefined }]);
  });

  it("shows a 'not found' option for a reference whose connection is gone", () => {
    render([{ ...HOP, connectionId: "deleted-id" }], vi.fn(), { savedConnections: OPTIONS });
    // The Select trigger renders the selected item's label, which for a missing
    // reference is the synthesized "<id> (not found)" entry.
    const select = query("jump-host-connection-0");
    expect(select?.textContent).toContain("not found");
  });
});
