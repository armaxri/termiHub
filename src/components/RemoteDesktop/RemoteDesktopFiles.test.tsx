import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { withTooltip } from "@/test/tooltip";
import { flushAsync } from "@/test/flushAsync";
import type { RemoteDesktopFilesStatus } from "@/hooks/useRemoteDesktopFiles";
import type { TransferEntry } from "@/types/generated/TransferEntry";
import { RemoteDesktopFiles } from "./RemoteDesktopFiles";

const hoisted = vi.hoisted(() => ({ queue: {} as Record<string, unknown> }));

vi.mock("@/store/useProjectedTransfers", () => ({
  useProjectedTransfers: () => ({ queue: hoisted.queue, minimized: false }),
}));

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
    total: 100,
  } as TransferEntry;
}

function render(files: RemoteDesktopFilesStatus, destDir: string | null = null) {
  const props = {
    onUpload: vi.fn(() => Promise.resolve()),
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

describe("RemoteDesktopFiles popover (#4192)", () => {
  beforeEach(() => {
    hoisted.queue = {};
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

  it("uploads into a chosen folder via Upload to folder…", async () => {
    const props = render(READY);
    act(() => query("remote-desktop-files-upload-folder")?.click());
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

  it("keeps Browse remote files for remote browsing (#4193)", () => {
    render(READY);
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
