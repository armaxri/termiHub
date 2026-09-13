import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { RemoteDesktopToolbar } from "./RemoteDesktopToolbar";
import type { ScaleMode } from "@/types/remoteDesktop";

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function handlers() {
  return {
    onSendCtrlAltDel: vi.fn(),
    onToggleClipboard: vi.fn(),
    onCycleScaleMode: vi.fn(),
    onToggleFullscreen: vi.fn(),
    onDisconnect: vi.fn(),
  };
}

function render(
  overrides: Partial<{
    host: string;
    resolution: { width: number; height: number } | null;
    viewOnly: boolean;
    scaleMode: ScaleMode;
  }> = {},
  h = handlers()
) {
  act(() => {
    root.render(
      <RemoteDesktopToolbar
        host={overrides.host ?? "vnc-host"}
        resolution={
          overrides.resolution === undefined ? { width: 1920, height: 1080 } : overrides.resolution
        }
        viewOnly={overrides.viewOnly ?? false}
        scaleMode={overrides.scaleMode ?? "fit"}
        {...h}
      />
    );
  });
  return h;
}

describe("RemoteDesktopToolbar", () => {
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

  it("renders the host badge and resolution", () => {
    render({ host: "desk-1", resolution: { width: 1280, height: 720 } });
    expect(query("remote-desktop-toolbar")?.textContent).toContain("desk-1");
    expect(container.querySelector(".rd-toolbar__res")?.textContent).toBe("1280×720");
  });

  it("omits the resolution span before the first frame", () => {
    render({ resolution: null });
    expect(container.querySelector(".rd-toolbar__res")).toBeNull();
  });

  it("shows the full action set (incl. Ctrl+Alt+Del) when not view-only", () => {
    render({ viewOnly: false });
    expect(query("remote-desktop-cad")).not.toBeNull();
    expect(query("remote-desktop-clipboard-btn")).not.toBeNull();
    expect(query("remote-desktop-scale")).not.toBeNull();
    expect(query("remote-desktop-fullscreen")).not.toBeNull();
    expect(query("remote-desktop-disconnect")).not.toBeNull();
    expect(query("remote-desktop-viewonly")).toBeNull();
  });

  it("hides Ctrl+Alt+Del and shows the view-only badge in view-only mode", () => {
    render({ viewOnly: true });
    expect(query("remote-desktop-cad")).toBeNull();
    expect(query("remote-desktop-viewonly")?.textContent).toContain("View only");
    // The clipboard/scale/fullscreen/disconnect actions remain available.
    expect(query("remote-desktop-clipboard-btn")).not.toBeNull();
    expect(query("remote-desktop-disconnect")).not.toBeNull();
  });

  it("labels the scale button with the active scale mode", () => {
    render({ scaleMode: "pixel" });
    expect(query("remote-desktop-scale")?.getAttribute("title")).toBe("Scaling: 1:1 Pixel");
  });

  it("routes each toolbar action to its handler", () => {
    const h = render({ viewOnly: false });
    act(() => query("remote-desktop-cad")?.click());
    expect(h.onSendCtrlAltDel).toHaveBeenCalledOnce();
    act(() => query("remote-desktop-clipboard-btn")?.click());
    expect(h.onToggleClipboard).toHaveBeenCalledOnce();
    act(() => query("remote-desktop-scale")?.click());
    expect(h.onCycleScaleMode).toHaveBeenCalledOnce();
    act(() => query("remote-desktop-fullscreen")?.click());
    expect(h.onToggleFullscreen).toHaveBeenCalledOnce();
    act(() => query("remote-desktop-disconnect")?.click());
    expect(h.onDisconnect).toHaveBeenCalledOnce();
  });
});
