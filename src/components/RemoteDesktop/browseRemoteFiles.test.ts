import { describe, it, expect, vi, beforeEach } from "vitest";
import { useAppStore } from "@/store/appStore";
import { useRemoteDesktopBrowseStore } from "@/store/remoteDesktopBrowseStore";
import type { FileSideChannel } from "@/types/generated/FileSideChannel";

const hoisted = vi.hoisted(() => ({
  open: vi.fn(),
  close: vi.fn(),
  list: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/services/api", () => ({
  remoteDesktopOpenFileBrowser: hoisted.open,
  remoteDesktopCloseFileBrowser: hoisted.close,
  sessionListFiles: hoisted.list,
}));
vi.mock("@/components/ui", () => ({ toast: { error: hoisted.error } }));

import {
  closeRemoteDesktopBrowser,
  listRemoteFolders,
  openRemoteDesktopBrowser,
  reattachRemoteDesktopBrowser,
} from "./browseRemoteFiles";

const AGENT: FileSideChannel = { kind: "agent", host: "lab-pi", user: "pi", sameHost: true };

describe("browseRemoteFiles (#4193)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState(useAppStore.getInitialState());
    useRemoteDesktopBrowseStore.setState({ sources: {} });
    hoisted.open.mockImplementation((_id: string, dir?: string) =>
      Promise.resolve({ channel: AGENT, startDir: dir ?? "/home/pi/Desktop" })
    );
    hoisted.close.mockResolvedValue(undefined);
  });

  it("opens the side channel as the tab's browser source and shows the Files sidebar", async () => {
    useAppStore.setState({ sidebarView: "connections" });
    expect(await openRemoteDesktopBrowser("tab-1", "rd-1", "/home/pi/in")).toBe(true);
    expect(hoisted.open).toHaveBeenCalledWith("rd-1", "/home/pi/in");
    expect(useRemoteDesktopBrowseStore.getState().sources["tab-1"]).toEqual({
      sessionId: "rd-1",
      channel: AGENT,
      dir: "/home/pi/in",
      openCount: 1,
    });
    expect(useAppStore.getState().sidebarView).toBe("files");

    // Opening again (Reveal) re-navigates and keeps the sidebar open.
    await openRemoteDesktopBrowser("tab-1", "rd-1", "/home/pi/in");
    expect(useRemoteDesktopBrowseStore.getState().sources["tab-1"].openCount).toBe(2);
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
  });

  it("toasts a refusal and opens nothing", async () => {
    hoisted.open.mockRejectedValue("File transfer is not available in a view-only session");
    expect(await openRemoteDesktopBrowser("tab-1", "rd-1")).toBe(false);
    expect(hoisted.error).toHaveBeenCalledWith(
      "Cannot browse remote files: File transfer is not available in a view-only session",
      expect.anything()
    );
    expect(useRemoteDesktopBrowseStore.getState().sources["tab-1"]).toBeUndefined();
  });

  it("re-attaches without moving the folder, and closes with the backend", async () => {
    await openRemoteDesktopBrowser("tab-1", "rd-1", "/home/pi/in");
    hoisted.open.mockResolvedValue({ channel: { ...AGENT, user: "root" }, startDir: "/x" });
    await reattachRemoteDesktopBrowser("tab-1");
    const source = useRemoteDesktopBrowseStore.getState().sources["tab-1"];
    expect(source.channel.user).toBe("root");
    expect(source.dir).toBe("/home/pi/in");
    expect(source.openCount).toBe(1);

    closeRemoteDesktopBrowser("tab-1");
    expect(hoisted.close).toHaveBeenCalledWith("rd-1");
    expect(useRemoteDesktopBrowseStore.getState().sources["tab-1"]).toBeUndefined();
    closeRemoteDesktopBrowser("tab-1");
    expect(hoisted.close).toHaveBeenCalledTimes(1);
  });

  it("lists only the folders of a resolved path for the folder picker (#4204)", async () => {
    hoisted.list.mockResolvedValue([
      { name: "zeta", path: "/home/pi/zeta", isDirectory: true },
      { name: "notes.md", path: "/home/pi/notes.md", isDirectory: false },
      { name: "Alpha", path: "/home/pi/Alpha", isDirectory: true },
    ]);
    const listing = await listRemoteFolders("rd-1", "~");
    expect(hoisted.open).toHaveBeenCalledWith("rd-1", "~");
    expect(hoisted.list).toHaveBeenCalledWith("rd-1", "~");
    expect(listing.folders.map((f) => f.name)).toEqual(["Alpha", "zeta"]);
  });

  it("orders the folder picker naturally via the shared collator (#4374)", async () => {
    hoisted.list.mockResolvedValue([
      { name: "dir10", path: "/home/pi/dir10", isDirectory: true },
      { name: "dir2", path: "/home/pi/dir2", isDirectory: true },
    ]);
    const listing = await listRemoteFolders("rd-1", "~");
    expect(listing.folders.map((f) => f.name)).toEqual(["dir2", "dir10"]);
  });
});
