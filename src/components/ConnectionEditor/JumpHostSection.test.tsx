import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { JumpHostConfig } from "@/types/connection";
import { JumpHostSection } from "./JumpHostSection";

// Mock the heavy KeyPathInput (pulls in SSH key validation / fs APIs).
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
      data-testid="jump-host-key-path"
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
  targetHost = "target.internal"
) {
  act(() => {
    root.render(<JumpHostSection value={value} targetHost={targetHost} onChange={onChange} />);
  });
}

/** Set a value on a React-controlled <input>/<select> and fire the native event. */
function setValue(el: HTMLInputElement | HTMLSelectElement, value: string, event = "input") {
  const proto =
    el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event(event, { bubbles: true }));
  });
}

const HOP: JumpHostConfig = {
  host: "bastion.example.com",
  port: 2222,
  username: "admin",
  authMethod: "key",
  keyPath: "~/.ssh/bastion",
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
    expect(query("jump-host-host")).toBeNull();
  });

  it("enabling emits a default single inline hop", () => {
    const onChange = vi.fn();
    render(undefined, onChange);
    const checkbox = query("jump-host-enabled") as HTMLInputElement;
    act(() => {
      checkbox.click();
    });
    expect(onChange).toHaveBeenCalledWith([
      { host: "", port: 22, username: "", authMethod: "key" },
    ]);
  });

  it("renders the inline fields populated from the hop", () => {
    render([HOP], vi.fn());
    expect((query("jump-host-host") as HTMLInputElement).value).toBe("bastion.example.com");
    expect((query("jump-host-port") as HTMLInputElement).value).toBe("2222");
    expect((query("jump-host-username") as HTMLInputElement).value).toBe("admin");
    expect((query("jump-host-auth-method") as HTMLSelectElement).value).toBe("key");
    expect(query("jump-host-key-path")).toBeTruthy();
    expect(query("jump-host-password")).toBeNull();
  });

  it("editing the host merges into the existing hop", () => {
    const onChange = vi.fn();
    render([HOP], onChange);
    setValue(query("jump-host-host") as HTMLInputElement, "edge.example.com");
    expect(onChange).toHaveBeenCalledWith([{ ...HOP, host: "edge.example.com" }]);
  });

  it("shows the password field for password auth and hides the key path", () => {
    render([{ ...HOP, authMethod: "password" }], vi.fn());
    expect(query("jump-host-password")).toBeTruthy();
    expect(query("jump-host-key-path")).toBeNull();
  });

  it("agent auth hides both key path and password", () => {
    render([{ ...HOP, authMethod: "agent" }], vi.fn());
    expect(query("jump-host-key-path")).toBeNull();
    expect(query("jump-host-password")).toBeNull();
  });

  it("switching auth method merges into the hop", () => {
    const onChange = vi.fn();
    render([HOP], onChange);
    setValue(query("jump-host-auth-method") as HTMLSelectElement, "password", "change");
    expect(onChange).toHaveBeenCalledWith([{ ...HOP, authMethod: "password" }]);
  });

  it("disabling clears the jump-host config", () => {
    const onChange = vi.fn();
    render([HOP], onChange);
    const checkbox = query("jump-host-enabled") as HTMLInputElement;
    act(() => {
      checkbox.click();
    });
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("shows the connection path with the target host", () => {
    render([HOP], vi.fn(), "app-server.internal");
    const path = query("jump-host-path");
    expect(path?.textContent).toContain("bastion.example.com");
    expect(path?.textContent).toContain("app-server.internal");
  });
});
