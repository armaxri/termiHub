import { describe, it, expect } from "vitest";
import { TabContentType, TerminalTab } from "@/types/terminal";
import { ShortcutScope } from "@/types/keybindings";
import {
  activeContextFromTab,
  isEventFromTextInput,
  isScopeCompatible,
  ActiveContext,
} from "./activeContext";

/** Build a minimal TerminalTab with the given content type for context tests. */
function makeTab(contentType: TabContentType): TerminalTab {
  return {
    id: "t1",
    sessionId: null,
    title: "tab",
    connectionType: "local",
    contentType,
    config: { type: "local", config: {} },
    panelId: "p1",
    isActive: true,
  };
}

describe("activeContextFromTab", () => {
  it("returns 'other' when no tab is active", () => {
    expect(activeContextFromTab(undefined)).toBe("other");
  });

  it("maps a terminal tab to 'terminal'", () => {
    expect(activeContextFromTab(makeTab("terminal"))).toBe("terminal");
  });

  it("maps a Monaco editor tab to 'editor'", () => {
    expect(activeContextFromTab(makeTab("editor"))).toBe("editor");
  });

  it.each<TabContentType>([
    "connection-editor",
    "tunnel-editor",
    "workspace-editor",
    "settings",
    "network-diagnostic",
  ])("maps input-bearing tab '%s' to 'form'", (contentType) => {
    expect(activeContextFromTab(makeTab(contentType))).toBe("form");
  });

  it.each<TabContentType>(["log-viewer", "agent-error"])(
    "maps read-only tab '%s' to 'other'",
    (contentType) => {
      expect(activeContextFromTab(makeTab(contentType))).toBe("other");
    }
  );
});

describe("isEventFromTextInput", () => {
  it("returns true for an <input> target", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    const e = new KeyboardEvent("keydown", { key: "f" });
    Object.defineProperty(e, "target", { value: input });
    expect(isEventFromTextInput(e)).toBe(true);
    input.remove();
  });

  it("returns true for a target inside a .monaco-editor", () => {
    const wrapper = document.createElement("div");
    wrapper.className = "monaco-editor";
    const inner = document.createElement("div");
    wrapper.appendChild(inner);
    document.body.appendChild(wrapper);
    const e = new KeyboardEvent("keydown", { key: "f" });
    Object.defineProperty(e, "target", { value: inner });
    expect(isEventFromTextInput(e)).toBe(true);
    wrapper.remove();
  });

  it("returns false for a plain <div> target", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const e = new KeyboardEvent("keydown", { key: "f" });
    Object.defineProperty(e, "target", { value: div });
    expect(isEventFromTextInput(e)).toBe(false);
    div.remove();
  });
});

describe("isScopeCompatible", () => {
  const CONTEXTS: ActiveContext[] = ["terminal", "editor", "form", "other"];

  it("global scope is compatible with every context", () => {
    for (const ctx of CONTEXTS) {
      expect(isScopeCompatible("global", ctx, false)).toBe(true);
    }
  });

  it("terminal scope is compatible only with the terminal context", () => {
    expect(isScopeCompatible("terminal", "terminal", false)).toBe(true);
    expect(isScopeCompatible("terminal", "editor", false)).toBe(false);
    expect(isScopeCompatible("terminal", "form", false)).toBe(false);
    expect(isScopeCompatible("terminal", "other", false)).toBe(false);
  });

  it("terminal scope bails when focus is inside a text input even on a terminal tab", () => {
    expect(isScopeCompatible("terminal", "terminal", true)).toBe(false);
  });

  it("editor-delegated scope bails in editor and form contexts", () => {
    expect(isScopeCompatible("editor-delegated", "editor", false)).toBe(false);
    expect(isScopeCompatible("editor-delegated", "form", false)).toBe(false);
  });

  it("editor-delegated scope fires in terminal and other contexts", () => {
    expect(isScopeCompatible("editor-delegated", "terminal", false)).toBe(true);
    expect(isScopeCompatible("editor-delegated", "other", false)).toBe(true);
  });

  it("editor-delegated scope bails whenever focus is inside a text input", () => {
    const scope: ShortcutScope = "editor-delegated";
    expect(isScopeCompatible(scope, "other", true)).toBe(false);
    expect(isScopeCompatible(scope, "terminal", true)).toBe(false);
  });
});
