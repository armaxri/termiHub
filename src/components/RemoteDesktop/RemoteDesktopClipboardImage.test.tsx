import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { ClipboardImageStatus } from "@/types/remoteDesktop";

const hoisted = vi.hoisted(() => ({
  status: vi.fn(),
  copy: vi.fn(),
  send: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("@/services/api", () => ({
  remoteDesktopClipboardImageStatus: hoisted.status,
  remoteDesktopCopyClipboardImage: hoisted.copy,
  remoteDesktopSendClipboardImage: hoisted.send,
}));

vi.mock("sonner", () => ({
  toast: {
    success: hoisted.toastSuccess,
    info: hoisted.toastInfo,
    error: vi.fn(),
  },
}));

import { RemoteDesktopClipboardImage } from "./RemoteDesktopClipboardImage";

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

async function render(status: ClipboardImageStatus, viewOnly = false) {
  hoisted.status.mockResolvedValue(status);
  await act(async () => {
    root.render(<RemoteDesktopClipboardImage sessionId="rd-1" viewOnly={viewOnly} />);
  });
}

async function click(testId: string) {
  await act(async () => {
    query(testId)?.click();
  });
}

describe("RemoteDesktopClipboardImage", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders nothing when the protocol has no image clipboard", async () => {
    await render({ supported: false, image: null });
    expect(hoisted.status).toHaveBeenCalledWith("rd-1");
    expect(query("remote-desktop-clipboard-image")).toBeNull();
  });

  it("shows the remote image's dimensions and a copy action", async () => {
    await render({ supported: true, image: { width: 640, height: 480 } });
    expect(query("remote-desktop-clipboard-image-meta")?.textContent).toBe(
      "Remote image · 640 × 480"
    );
    expect(query("remote-desktop-clipboard-copy-image")).not.toBeNull();
    expect(query("remote-desktop-clipboard-send-image")).not.toBeNull();
  });

  it("hides copy when the remote holds no image", async () => {
    await render({ supported: true, image: null });
    expect(query("remote-desktop-clipboard-image-meta")?.textContent).toBe("No remote image");
    expect(query("remote-desktop-clipboard-copy-image")).toBeNull();
  });

  it("hides send in a view-only session", async () => {
    await render({ supported: true, image: { width: 1, height: 1 } }, true);
    expect(query("remote-desktop-clipboard-send-image")).toBeNull();
    expect(query("remote-desktop-clipboard-copy-image")).not.toBeNull();
  });

  it("copies the remote image and confirms with its size", async () => {
    await render({ supported: true, image: { width: 2, height: 3 } });
    hoisted.copy.mockResolvedValue({ width: 2, height: 3 });
    await click("remote-desktop-clipboard-copy-image");
    expect(hoisted.copy).toHaveBeenCalledWith("rd-1");
    expect(hoisted.toastSuccess).toHaveBeenCalledWith("Image copied to clipboard (2 × 3)");
  });

  it("sends the local image and confirms with its size", async () => {
    await render({ supported: true, image: null });
    hoisted.send.mockResolvedValue({ width: 800, height: 600 });
    await click("remote-desktop-clipboard-send-image");
    expect(hoisted.send).toHaveBeenCalledWith("rd-1");
    expect(hoisted.toastSuccess).toHaveBeenCalledWith("Image sent to remote (800 × 600)");
  });

  it("tells the user when the local clipboard holds no image", async () => {
    await render({ supported: true, image: null });
    hoisted.send.mockResolvedValue(null);
    await click("remote-desktop-clipboard-send-image");
    expect(hoisted.toastInfo).toHaveBeenCalledWith("No image on the local clipboard");
  });
});
