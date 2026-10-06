/**
 * The File Browser on a remote-desktop session's file side channel (#4193,
 * concept `vnc-clipboard-file-transfer` phase 3): a VNC tab has no browser
 * until "Browse remote files" opens one; then the sidebar lists the side
 * channel through the session layer (keyed by the graphical session id), shows
 * the route line, and downloads through the Transfers queue to a folder the
 * user picks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { currentFileBrowsersView } from "@/store/fileBrowsersBridge";
import { useRemoteDesktopBrowseStore } from "@/store/remoteDesktopBrowseStore";
import { setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { setupFileBrowsersRegion } from "@/test/fileBrowsersRegionTestHarness";
import { setupVirtualListSizing } from "@/test/virtualListSize";
import { flushAsync } from "@/test/flushAsync";
import { seedLayoutState } from "@/test/layoutState";
import { FileBrowser } from "./FileBrowser";
import { TooltipProvider } from "@/components/ui";
import type { TerminalTab, LeafPanel } from "@/types/terminal";
import type { FileEntry } from "@/types/connection";
import type { FileSideChannel } from "@/types/generated/FileSideChannel";

const saveMock = vi.fn(
  (): Promise<string | null> => Promise.resolve("/local/Downloads/report.pdf")
);
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: () => saveMock(),
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
setupVirtualListSizing();

const SID = "rd-1";
const TUNNEL: FileSideChannel = { kind: "ssh", host: "tiger-box", user: "arne", sameHost: true };

function entry(name: string, isDirectory = false): FileEntry {
  return {
    name,
    path: `/home/arne/Desktop/${name}`,
    isDirectory,
    size: 2048,
    modified: "2026-10-06T00:00:00Z",
    permissions: "rw-r--r--",
    writable: true,
  };
}

/** Make a VNC tab active. */
function seedVncTab() {
  const tab: TerminalTab = {
    id: "vnc-tab",
    sessionId: null,
    title: "VNC tiger-box",
    connectionType: "vnc",
    contentType: "remote-desktop",
    config: { type: "vnc", config: { host: "tiger-box" } },
    panelId: "panel-1",
    isActive: true,
  };
  const panel: LeafPanel = { type: "leaf", id: tab.panelId, tabs: [tab], activeTabId: tab.id };
  seedLayoutState({ activePanelId: tab.panelId, rootPanel: panel });
}

function openSource(channel: FileSideChannel = TUNNEL) {
  act(() =>
    useRemoteDesktopBrowseStore.getState().openSource("vnc-tab", {
      sessionId: SID,
      channel,
      dir: "/home/arne/Desktop",
    })
  );
}

async function renderBrowser() {
  useAppStore.setState({ sidebarView: "files" });
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

describe("FileBrowser — remote-desktop side channel (#4193)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    useRemoteDesktopBrowseStore.setState({ sources: {} });
    mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "session_list_files") {
        const { sessionId } = args as { sessionId: string };
        return sessionId === SID
          ? Promise.resolve([entry("report.pdf"), entry("photos", true)])
          : Promise.reject(new Error(`unexpected session ${sessionId}`));
      }
      if (cmd === "session_supports_transfer_queue") return Promise.resolve(true);
      if (cmd === "session_has_exec_capability") return Promise.reject(new Error("no"));
      if (cmd === "session_download") return Promise.resolve("dl-1");
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("has no file browser on a VNC tab until Browse remote files opens one", async () => {
    seedVncTab();
    await renderBrowser();
    expect(currentFileBrowsersView().mode).toBe("none");
    expect(q("file-browser-placeholder")).not.toBeNull();
    expect(mockedInvoke).not.toHaveBeenCalledWith("session_list_files", expect.anything());
  });

  it("lists the side channel at the requested folder with the route line", async () => {
    seedVncTab();
    await renderBrowser();
    openSource();
    await flushAsync();
    await flushAsync();

    expect(currentFileBrowsersView().mode).toBe("session");
    expect(useAppStore.getState().sessionFileBrowserId).toBe(SID);
    expect(mockedInvoke).toHaveBeenCalledWith("session_list_files", {
      sessionId: SID,
      path: "/home/arne/Desktop",
    });
    expect(container.textContent).toContain("report.pdf");
    const route = q("remote-desktop-browse-route");
    expect(route?.textContent).toContain("arne@tiger-box · SFTP via SSH tunnel");
    expect(route?.textContent).toContain("the desktop host");
  });

  it("warns in the route line when the file host is not the desktop host", async () => {
    seedVncTab();
    await renderBrowser();
    openSource({ kind: "agent", host: "lab-pi", user: "pi", sameHost: false });
    await flushAsync();
    const route = q("remote-desktop-browse-route");
    expect(route?.className).toContain("rd-browse-route--warn");
    expect(route?.textContent).toContain("pi@lab-pi · termiHub agent");
    expect(route?.textContent).toContain("lab-pi is not the desktop host");
  });

  it("downloads through the Transfers queue to the folder the user picks", async () => {
    seedVncTab();
    await renderBrowser();
    openSource();
    await flushAsync();
    await flushAsync();

    const row = container.querySelector('[data-testid="file-row-report.pdf"]') as HTMLElement;
    await act(async () => {
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    await act(async () => {
      (document.querySelector('[data-testid="context-file-download"]') as HTMLElement).click();
    });
    await flushAsync();

    expect(saveMock).toHaveBeenCalled();
    expect(mockedInvoke).toHaveBeenCalledWith("session_download", {
      sessionId: SID,
      remotePath: "/home/arne/Desktop/report.pdf",
      localPath: "/local/Downloads/report.pdf",
    });
  });

  it("drops the browser when the source closes with its session", async () => {
    seedVncTab();
    await renderBrowser();
    openSource();
    await flushAsync();
    expect(currentFileBrowsersView().mode).toBe("session");
    act(() => useRemoteDesktopBrowseStore.getState().closeSource("vnc-tab"));
    await flushAsync();
    expect(currentFileBrowsersView().mode).toBe("none");
  });
});
