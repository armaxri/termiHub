import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { FileBrowser } from "./FileBrowser";
import type { TerminalTab, LeafPanel } from "@/types/terminal";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/events", () => ({
  onVscodeEditComplete: vi.fn(() => Promise.resolve(vi.fn())),
}));

vi.mock("@/services/api", () => ({
  getHomeDir: vi.fn(() => Promise.resolve("C:\\Users\\test")),
  ConnectionTypeInfo: {},
}));

let container: HTMLDivElement;
let root: Root;

/** Create a minimal TerminalTab for testing. */
function makeTab(overrides: Partial<TerminalTab>): TerminalTab {
  return {
    id: "tab-1",
    sessionId: "sess-1",
    title: "Test Tab",
    connectionType: "local",
    contentType: "terminal",
    config: { type: "local", config: {} },
    panelId: "panel-1",
    isActive: true,
    ...overrides,
  };
}

/** Set up the store so `getActiveTab` returns the given tab. */
function setActiveTab(tab: TerminalTab) {
  const panel: LeafPanel = {
    type: "leaf",
    id: tab.panelId,
    tabs: [tab],
    activeTabId: tab.id,
  };
  useAppStore.setState({
    activePanelId: tab.panelId,
    rootPanel: panel,
  });
}

describe("FileBrowser – useFileBrowserSync", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("sets fileBrowserMode to 'local' for a WSL tab", () => {
    const wslTab = makeTab({
      connectionType: "wsl",
      config: { type: "wsl", config: { distribution: "Ubuntu" } },
    });
    setActiveTab(wslTab);

    act(() => {
      root.render(<FileBrowser />);
    });

    expect(useAppStore.getState().fileBrowserMode).toBe("local");
  });

  it("sets fileBrowserMode to 'local' for a local tab with WSL shell type", () => {
    const localWslTab = makeTab({
      connectionType: "local",
      config: { type: "local", config: { shell: "wsl:Ubuntu" } },
    });
    setActiveTab(localWslTab);

    act(() => {
      root.render(<FileBrowser />);
    });

    expect(useAppStore.getState().fileBrowserMode).toBe("local");
  });

  it("sets fileBrowserMode to 'local' for a plain local tab", () => {
    const localTab = makeTab({
      connectionType: "local",
      config: { type: "local", config: { shell: "powershell" } },
    });
    setActiveTab(localTab);

    act(() => {
      root.render(<FileBrowser />);
    });

    expect(useAppStore.getState().fileBrowserMode).toBe("local");
  });

  it("does not set fileBrowserMode to 'sftp' for a WSL tab", () => {
    // Simulate a WSL connection type that the backend reports supports file browsing.
    // Even if connectionTypes claims file_browser=true, the WSL tab should
    // be caught by the `=== "wsl"` check first and use local mode.
    const wslTab = makeTab({
      connectionType: "wsl",
      config: { type: "wsl", config: { distribution: "Debian" } },
    });
    setActiveTab(wslTab);
    useAppStore.setState({
      connectionTypes: [
        {
          typeId: "wsl",
          displayName: "WSL",
          icon: "penguin",
          schema: { groups: [] },
          capabilities: {
            monitoring: false,
            fileBrowser: true, // backend still claims true
            resize: true,
            persistent: true,
          },
        },
      ],
    });

    act(() => {
      root.render(<FileBrowser />);
    });

    // Should still be local, not sftp
    expect(useAppStore.getState().fileBrowserMode).toBe("local");
  });
});
