/**
 * The terminal's right-click surface (#4915): the context menu (Copy Selection /
 * Paste / Copy All …) by default, Quick Copy/Paste only when opted in. Shared by
 * the in-panel terminal and the zoom overlay, which previously had no terminal
 * menu at all — only the title's tab menu offered a copy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

const registry = {
  getTerminalSelection: vi.fn<(tabId: string) => string | undefined>(() => undefined),
  clearTerminalSelection: vi.fn(),
  copySelectionToClipboard: vi.fn(),
  copyTerminalToClipboard: vi.fn(),
  pasteToTerminal: vi.fn(() => Promise.resolve()),
  saveTerminalToFile: vi.fn(),
  clearTerminal: vi.fn(),
  isMouseReportingActive: vi.fn(() => false),
};

vi.mock("@/components/Terminal/TerminalRegistry", () => ({
  useTerminalRegistry: () => registry,
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn(() => Promise.resolve()),
}));

let settings: { rightClickBehavior?: "contextMenu" | "quickAction" } = {};
vi.mock("@/store/useProjectedSettings", () => ({
  useProjectedSettings: () => settings,
}));

let windows = false;
vi.mock("@/utils/platform", () => ({
  isWindows: () => windows,
}));

import { TerminalContextMenu, useTerminalQuickActionMode } from "./TerminalContextMenu";

let container: HTMLDivElement;
let root: Root;

const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

function rightClick(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 10,
        clientY: 10,
      })
    );
  });
}

function Harness({ tabId = "t1" }: { tabId?: string }) {
  const quickAction = useTerminalQuickActionMode();
  return (
    <TerminalContextMenu
      tabId={tabId}
      quickAction={quickAction}
      triggerTestId={`trigger-${tabId}`}
      className="terminal-context-trigger"
      horizontalScrolling={false}
      onToggleHorizontalScrolling={vi.fn()}
      onRename={vi.fn()}
      onSetColor={vi.fn()}
    >
      <div data-testid="term">terminal</div>
    </TerminalContextMenu>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  settings = {};
  windows = false;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("TerminalContextMenu", () => {
  it("opens the context menu by default on macOS/Linux instead of pasting", () => {
    act(() => root.render(<Harness />));
    rightClick(q("term")!);

    expect(q("terminal-context-paste")).not.toBeNull();
    expect(q("terminal-context-copy-all")).not.toBeNull();
    expect(registry.pasteToTerminal).not.toHaveBeenCalled();
  });

  it("names the items as documented and offers Copy Selection only with a selection", () => {
    registry.getTerminalSelection.mockReturnValue("picked");
    act(() => root.render(<Harness />));
    rightClick(q("term")!);

    expect(q("terminal-context-copy-selection")!.textContent).toContain("Copy Selection");
    expect(q("terminal-context-paste")!.textContent).toContain("Paste");
    expect(q("terminal-context-copy-all")!.textContent).toContain("Copy All");
  });

  it("runs Quick Copy/Paste only when the setting opts in", () => {
    settings = { rightClickBehavior: "quickAction" };
    act(() => root.render(<Harness />));
    rightClick(q("term")!);

    expect(q("terminal-context-paste")).toBeNull();
    expect(registry.pasteToTerminal).toHaveBeenCalledWith("t1");
  });

  it("keeps Quick Copy/Paste as the platform default on Windows", () => {
    windows = true;
    act(() => root.render(<Harness />));
    rightClick(q("term")!);

    expect(q("terminal-context-paste")).toBeNull();
    expect(registry.pasteToTerminal).toHaveBeenCalledWith("t1");
  });

  it("honours an explicit Context Menu choice on Windows", () => {
    windows = true;
    settings = { rightClickBehavior: "contextMenu" };
    act(() => root.render(<Harness />));
    rightClick(q("term")!);

    expect(q("terminal-context-paste")).not.toBeNull();
    expect(registry.pasteToTerminal).not.toHaveBeenCalled();
  });
});
