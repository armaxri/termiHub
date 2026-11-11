/**
 * The File Browser's placeholder separates "no tab open" from "this connection
 * type has no file system" (#5299, audit UX-019 / UI-019).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { setupFileBrowsersRegion } from "@/test/fileBrowsersRegionTestHarness";
import { flushAsync } from "@/test/flushAsync";
import { seedLayoutState } from "@/test/layoutState";
import { FileBrowser } from "./FileBrowser";
import { TooltipProvider } from "@/components/ui";
import type { ConnectionTypeInfo } from "@/services/api";
import type { TerminalTab, LeafPanel } from "@/types/terminal";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(() => Promise.resolve(null)),
  open: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: vi.fn(() => Promise.resolve(vi.fn())),
  }),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/events", () => ({
  onVscodeEditComplete: vi.fn(() => Promise.resolve(vi.fn())),
  onLocalDirChanged: vi.fn(() => Promise.resolve(vi.fn())),
  onTransferProgress: vi.fn(() => Promise.resolve(vi.fn())),
  base64ToBytes: vi.fn(() => new Uint8Array()),
}));

const mockedInvoke = vi.mocked(invoke);

let container: HTMLDivElement;
let root: Root;

setupAgentsRegion();
setupFileBrowsersRegion();

const SERIAL: ConnectionTypeInfo = {
  typeId: "serial",
  displayName: "Serial",
  icon: "serial",
  schema: { groups: [] },
  capabilities: { monitoring: false, fileBrowser: false, resize: false, persistent: false },
} as ConnectionTypeInfo;

/** Make a serial terminal tab active. */
function seedSerialTab() {
  const tab: TerminalTab = {
    id: "serial-tab",
    sessionId: "serial-1",
    title: "Serial /dev/ttyUSB0",
    connectionType: "serial",
    contentType: "terminal",
    config: { type: "serial", config: { port: "/dev/ttyUSB0" } },
    panelId: "panel-1",
    isActive: true,
  };
  const panel: LeafPanel = { type: "leaf", id: tab.panelId, tabs: [tab], activeTabId: tab.id };
  seedLayoutState({ activePanelId: tab.panelId, rootPanel: panel });
}

async function renderBrowser() {
  useAppStore.setState({ sidebarView: "files", connectionTypes: [SERIAL] });
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <FileBrowser />
      </TooltipProvider>
    );
  });
  await flushAsync();
  await flushAsync();
}

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe("FileBrowser — empty states (#5299)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    mockedInvoke.mockImplementation(() => Promise.resolve(undefined));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("tells the user to open a tab when none is open, and offers New Terminal", async () => {
    await renderBrowser();
    const placeholder = q("file-browser-placeholder");
    expect(placeholder?.textContent).toContain("Open a terminal or connection to browse its files");
    expect(placeholder?.textContent).not.toContain("connection type");
    expect(q("file-browser-placeholder-new-terminal")).not.toBeNull();
  });

  it("opens a local terminal from the New Terminal action", async () => {
    const addTab = vi.fn(() => "tab-1");
    useAppStore.setState({ addTab });
    await renderBrowser();
    await act(async () => {
      q("file-browser-placeholder-new-terminal")?.click();
    });
    expect(addTab).toHaveBeenCalledWith("Terminal", "local");
  });

  it("names an unsupported connection type and offers no action", async () => {
    seedSerialTab();
    await renderBrowser();
    const placeholder = q("file-browser-placeholder");
    expect(placeholder?.textContent).toContain("Serial connections have no file system");
    expect(q("file-browser-placeholder-new-terminal")).toBeNull();
  });
});
