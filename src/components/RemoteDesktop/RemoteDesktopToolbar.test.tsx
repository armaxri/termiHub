import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { RemoteDesktopToolbar, type FilesButtonState } from "./RemoteDesktopToolbar";
import type { MonitorRect, ScaleMode } from "@/types/remoteDesktop";

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
    monitors: MonitorRect[];
    viewport: number | null;
    onCycleViewport: () => void;
    filesButton: FilesButtonState;
    filesTitle: string;
    onToggleFiles: () => void;
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
        monitors={overrides.monitors}
        viewport={overrides.viewport}
        onCycleViewport={overrides.onCycleViewport}
        filesButton={overrides.filesButton}
        filesTitle={overrides.filesTitle}
        onToggleFiles={overrides.onToggleFiles}
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

  it("discloses the keyboard release chord (#4328)", () => {
    render();
    const hint = query("remote-desktop-release-hint");
    expect(hint?.textContent).toContain("Ctrl+Alt+Shift");
    expect(hint?.getAttribute("title")).toMatch(/return keyboard focus to termiHub/i);
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

  describe("multi-monitor viewport selector (#3696)", () => {
    const monitors: MonitorRect[] = [
      { x: 0, y: 0, width: 1920, height: 1080, primary: true, scale: 100 },
      { x: 1920, y: 0, width: 1280, height: 1024, primary: false, scale: 100 },
    ];

    it("is hidden for a single-monitor session", () => {
      render({ onCycleViewport: vi.fn() });
      expect(query("remote-desktop-monitor")).toBeNull();
      render({ monitors: [monitors[0]], onCycleViewport: vi.fn() });
      expect(query("remote-desktop-monitor")).toBeNull();
    });

    it("shows all monitors and cycles on click", () => {
      const onCycleViewport = vi.fn();
      render({ monitors, viewport: null, onCycleViewport });
      const btn = query("remote-desktop-monitor") as HTMLButtonElement;
      expect(btn.textContent).toContain("All");
      expect(btn.title).toBe("Showing: All monitors (2)");
      act(() => btn.click());
      expect(onCycleViewport).toHaveBeenCalledTimes(1);
    });

    it("names the shown monitor", () => {
      render({ monitors, viewport: 1, onCycleViewport: vi.fn() });
      const btn = query("remote-desktop-monitor") as HTMLButtonElement;
      expect(btn.textContent).toContain("2/2");
      expect(btn.title).toBe("Showing: Monitor 2 (1280×1024)");
    });
  });

  describe("Files button (#4192)", () => {
    it("is hidden by default and in view-only sessions", () => {
      render({ onToggleFiles: vi.fn() });
      expect(query("remote-desktop-files-btn")).toBeNull();
      render({ filesButton: "hidden", onToggleFiles: vi.fn() });
      expect(query("remote-desktop-files-btn")).toBeNull();
    });

    it("sits after Clipboard and toggles the popover when active", () => {
      const onToggleFiles = vi.fn();
      render({ filesButton: "active", onToggleFiles });
      const btn = query("remote-desktop-files-btn") as HTMLButtonElement;
      const clipboard = query("remote-desktop-clipboard-btn") as HTMLElement;
      expect(
        clipboard.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      expect(btn.disabled).toBe(false);
      act(() => btn.click());
      expect(onToggleFiles).toHaveBeenCalledOnce();
      expect(query("remote-desktop-files-warning")).toBeNull();
    });

    it("is disabled with the reason as tooltip when there is no route", () => {
      const onToggleFiles = vi.fn();
      render({ filesButton: "disabled", filesTitle: "Enable the SSH Tunnel", onToggleFiles });
      const btn = query("remote-desktop-files-btn") as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(btn.closest(".rd-toolbar__files")?.getAttribute("title")).toBe(
        "Enable the SSH Tunnel"
      );
      act(() => btn.click());
      expect(onToggleFiles).not.toHaveBeenCalled();
    });

    it("carries a warning dot when the route's host refused", () => {
      render({ filesButton: "warning", filesTitle: "SFTP is not enabled", onToggleFiles: vi.fn() });
      expect(query("remote-desktop-files-btn")?.getAttribute("data-state")).toBe("warning");
      expect(query("remote-desktop-files-warning")).not.toBeNull();
    });
  });
});
