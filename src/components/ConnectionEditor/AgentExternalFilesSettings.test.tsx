import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ExternalAgentFile } from "@/types/terminal";
import { AgentExternalFilesSettings } from "./AgentExternalFilesSettings";

let container: HTMLDivElement;
let root: Root;

function render(files: ExternalAgentFile[], onChange: (files: ExternalAgentFile[]) => void) {
  act(() => {
    root.render(<AgentExternalFilesSettings files={files} onChange={onChange} />);
  });
}

function query(testId: string): Element | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

describe("AgentExternalFilesSettings", () => {
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

  it("renders a row per configured file", () => {
    render([{ path: "/etc/team.json", enabled: true }], vi.fn());
    expect(query("agent-external-file-row")).not.toBeNull();
    expect(container.textContent).toContain("/etc/team.json");
  });

  it("renders the enable toggle as the shared Toggle primitive", () => {
    render([{ path: "/etc/team.json", enabled: true }], vi.fn());
    const toggle = query("agent-external-file-toggle") as HTMLElement;
    expect(toggle.getAttribute("role")).toBe("switch");
    expect(toggle.classList.contains("ui-toggle")).toBe(true);
  });

  it("renders the remove button as a shared ghost Button primitive (not the bespoke shell)", () => {
    render([{ path: "/etc/team.json", enabled: true }], vi.fn());
    const btn = query("agent-external-file-remove") as HTMLButtonElement;
    expect(btn.classList.contains("ui-btn")).toBe(true);
    expect(btn.classList.contains("ui-btn--ghost")).toBe(true);
    expect(btn.classList.contains("settings-panel__file-remove")).toBe(false);
  });

  it("toggles a file's enabled state via onChange", () => {
    const onChange = vi.fn();
    render([{ path: "/etc/team.json", enabled: true }], onChange);
    act(() => {
      (query("agent-external-file-toggle") as HTMLElement).click();
    });
    expect(onChange).toHaveBeenCalledWith([{ path: "/etc/team.json", enabled: false }]);
  });

  it("removes a file via onChange", () => {
    const onChange = vi.fn();
    render(
      [
        { path: "/etc/team.json", enabled: true },
        { path: "/etc/other.json", enabled: false },
      ],
      onChange
    );
    act(() => {
      (query("agent-external-file-remove") as HTMLButtonElement).click();
    });
    expect(onChange).toHaveBeenCalledWith([{ path: "/etc/other.json", enabled: false }]);
  });

  it("adds a new file path via onChange", () => {
    const onChange = vi.fn();
    render([], onChange);
    const input = query("agent-external-file-input") as HTMLInputElement;
    act(() => {
      // Use the native value setter so React's value tracker sees the change
      // and fires the controlled onChange handler.
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      nativeSetter?.call(input, "/home/user/team.json");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      (query("agent-external-file-add") as HTMLButtonElement).click();
    });
    expect(onChange).toHaveBeenCalledWith([{ path: "/home/user/team.json", enabled: true }]);
  });
});
