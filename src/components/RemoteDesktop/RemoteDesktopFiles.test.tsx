import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { withTooltip } from "@/test/tooltip";
import { flushAsync } from "@/test/flushAsync";
import type { RemoteDesktopFilesStatus } from "@/hooks/useRemoteDesktopFiles";
import type { TransferEntry } from "@/types/generated/TransferEntry";
import { RemoteDesktopFiles } from "./RemoteDesktopFiles";

const hoisted = vi.hoisted(() => ({
  queue: {} as Record<string, unknown>,
  list: vi.fn(),
}));

vi.mock("@/store/useProjectedTransfers", () => ({
  useProjectedTransfers: () => ({ queue: hoisted.queue, minimized: false }),
}));

vi.mock("./browseRemoteFiles", () => ({ listRemoteFolders: hoisted.list }));

/** A side-channel listing of `path` with the given sub-folders. */
function listing(path: string, names: string[]) {
  return { path, folders: names.map((name) => ({ name, path: `${path}/${name}` })) };
}

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

const READY: RemoteDesktopFilesStatus = {
  status: "ready",
  channel: { kind: "ssh", host: "tiger-box", user: "arne", sameHost: true },
  agentId: null,
  defaultDir: "/home/arne/Desktop",
};

function entry(id: string, sessionId: string): TransferEntry {
  return {
    id,
    sessionId,
    direction: "upload",
    name: `${id}.bin`,
    path: `/home/arne/Desktop/${id}.bin`,
    state: "active",
    transferred: 10,
    totalBytes: 100,
    percent: 10,
    speedBytesPerSec: null,
    etaSeconds: null,
    updatedAt: 0,
  };
}

function render(files: RemoteDesktopFilesStatus, destDir: string | null = null) {
  const props = {
    onUpload: vi.fn(() => Promise.resolve()),
    onBrowse: vi.fn(),
    onRetry: vi.fn(),
    onClose: vi.fn(),
  };
  act(() => {
    root.render(
      withTooltip(
        <RemoteDesktopFiles sessionId="rd-1" files={files} destDir={destDir} {...props} />
      )
    );
  });
  return props;
}

describe("RemoteDesktopFiles popover (#4192, #4193)", () => {
  beforeEach(() => {
    hoisted.queue = {};
    hoisted.list.mockReset();
    hoisted.list.mockImplementation((_sessionId: string, dir: string) =>
      Promise.resolve(listing(dir.replace(/^~/, "/home/arne"), ["inbox", "photos"]))
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the route line as the trust statement", () => {
    render(READY);
    const route = query("remote-desktop-files-route")?.textContent ?? "";
    expect(route).toContain("/home/arne/Desktop on tiger-box");
    expect(route).toContain("SFTP via SSH tunnel (arne@tiger-box, host key verified)");
  });

  it("uploads picked files into the current folder", async () => {
    const props = render(READY, "/home/arne/in");
    expect(query("remote-desktop-files-route")?.textContent).toContain(
      "/home/arne/in on tiger-box"
    );
    await act(async () => query("remote-desktop-files-upload")?.click());
    expect(props.onUpload).toHaveBeenCalledWith();
  });

  it("uploads into a typed folder via Upload to folder…", async () => {
    const props = render(READY);
    act(() => query("remote-desktop-files-upload-folder")?.click());
    await flushAsync();
    const input = query("remote-desktop-upload-folder-input") as HTMLInputElement;
    expect(input.value).toBe("/home/arne/Desktop");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "~/inbox");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => query("remote-desktop-upload-folder-submit")?.click());
    await flushAsync();
    expect(props.onUpload).toHaveBeenCalledWith("~/inbox");
    expect(query("remote-desktop-upload-folder-dialog")).toBeNull();
  });

  it("picks the folder by browsing the side-channel host (#4204)", async () => {
    const props = render(READY);
    act(() => query("remote-desktop-files-upload-folder")?.click());
    await flushAsync();
    expect(hoisted.list).toHaveBeenCalledWith("rd-1", "/home/arne/Desktop");
    const entries = () =>
      [...document.querySelectorAll('[data-testid="remote-desktop-folder-picker-entry"]')].map(
        (e) => e.textContent
      );
    expect(entries()).toEqual(["inbox", "photos"]);

    // Into a sub-folder, then up again, then into the other one.
    act(() =>
      (
        document.querySelector(
          '[data-testid="remote-desktop-folder-picker-entry"]'
        ) as HTMLButtonElement
      ).click()
    );
    await flushAsync();
    expect(hoisted.list).toHaveBeenLastCalledWith("rd-1", "/home/arne/Desktop/inbox");
    expect((query("remote-desktop-upload-folder-input") as HTMLInputElement).value).toBe(
      "/home/arne/Desktop/inbox"
    );
    act(() => query("remote-desktop-folder-picker-up")?.click());
    await flushAsync();
    expect(hoisted.list).toHaveBeenLastCalledWith("rd-1", "/home/arne/Desktop");

    act(() => query("remote-desktop-upload-folder-submit")?.click());
    await flushAsync();
    expect(props.onUpload).toHaveBeenCalledWith("/home/arne/Desktop");
  });

  it("opens a typed folder on Enter and shows a listing error", async () => {
    render(READY);
    act(() => query("remote-desktop-files-upload-folder")?.click());
    await flushAsync();
    hoisted.list.mockRejectedValueOnce("the folder /nope does not exist");
    const input = query("remote-desktop-upload-folder-input") as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "/nope");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushAsync();
    expect(hoisted.list).toHaveBeenLastCalledWith("rd-1", "/nope");
    expect(query("remote-desktop-folder-picker")?.textContent).toContain("does not exist");
  });

  it("opens Browse remote files on a ready route (#4193)", () => {
    const props = render(READY);
    const browse = query("remote-desktop-files-browse") as HTMLButtonElement;
    expect(browse.disabled).toBe(false);
    act(() => browse.click());
    expect(props.onBrowse).toHaveBeenCalledOnce();
  });

  it("offers no browsing without a ready route", () => {
    render({ status: "unavailable", reason: "disabled" });
    expect((query("remote-desktop-files-browse") as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables the upload actions without a route and says why", () => {
    render({ status: "unavailable", reason: "noRoute" });
    expect((query("remote-desktop-files-upload") as HTMLButtonElement).disabled).toBe(true);
    expect((query("remote-desktop-files-upload-folder") as HTMLButtonElement).disabled).toBe(true);
    expect(query("remote-desktop-files-route")?.textContent).toContain("Enable the SSH Tunnel");
  });

  it("shows a degraded route's message with a retry", () => {
    const props = render({
      status: "degraded",
      channel: { kind: "ssh", host: "tiger-box", user: "arne", sameHost: true },
      agentId: null,
      message: "File transfer to tiger-box is unavailable: SFTP is not enabled on the SSH server",
    });
    expect(query("remote-desktop-files-route")?.textContent).toContain("SFTP is not enabled");
    expect((query("remote-desktop-files-upload") as HTMLButtonElement).disabled).toBe(true);
    act(() => query("remote-desktop-files-retry")?.click());
    expect(props.onRetry).toHaveBeenCalledOnce();
  });

  it("lists only this session's transfers", () => {
    hoisted.queue = { a: entry("a", "rd-1"), b: entry("b", "ssh-9") };
    render(READY);
    const list = query("remote-desktop-files-transfers");
    expect(list?.textContent).toContain("a.bin");
    expect(list?.textContent).not.toContain("b.bin");
  });

  it("closes from its close button and on Escape", () => {
    const props = render(READY);
    act(() => query("remote-desktop-files-close")?.click());
    act(() => {
      query("remote-desktop-files")?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });
});
