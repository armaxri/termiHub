/**
 * The "waiting for the first frame" overlay of a graphical tab (#5626): a
 * session that is up but has painted nothing yet shows its stage instead of a
 * blank pane, and after the timeout a "No picture" error with Retry / Edit /
 * Close tab.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RemoteDesktopFirstFrameOverlay } from "./RemoteDesktopFirstFrameOverlay";

let container: HTMLDivElement;
let root: Root;

const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function render(timedOut: boolean, opts: { via?: string | null; editable?: boolean } = {}) {
  const onRetry = vi.fn();
  const onEditConnection = vi.fn();
  const onCloseTab = vi.fn();
  act(() =>
    root.render(
      <RemoteDesktopFirstFrameOverlay
        host="desk"
        protocol="vnc"
        via={opts.via ?? null}
        timedOut={timedOut}
        onRetry={onRetry}
        onEditConnection={opts.editable === false ? undefined : onEditConnection}
        onCloseTab={onCloseTab}
      />
    )
  );
  return { onRetry, onEditConnection, onCloseTab };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("RemoteDesktopFirstFrameOverlay", () => {
  it("shows the waiting stage while no frame has painted", () => {
    render(false);
    const overlay = q("remote-desktop-overlay-first-frame");
    expect(overlay).not.toBeNull();
    expect(overlay?.textContent).toContain("Connected, waiting for the first frame");
    expect(overlay?.textContent).toContain("First frame");
    expect(q("remote-desktop-overlay-no-frame")).toBeNull();
  });

  it("names the SSH gateway of a tunnelled session", () => {
    render(false, { via: "arne@bastion" });
    const overlay = q("remote-desktop-overlay-first-frame");
    expect(overlay?.textContent).toContain("SSH tunnel");
    expect(overlay?.textContent).toContain("via SSH arne@bastion");
  });

  it("rests on a no-picture error with Retry, Edit and Close tab after the timeout", () => {
    const { onRetry, onEditConnection, onCloseTab } = render(true);
    expect(q("remote-desktop-overlay-first-frame")).toBeNull();
    const overlay = q("remote-desktop-overlay-no-frame");
    expect(overlay).not.toBeNull();
    expect(overlay?.textContent).toContain("No picture from the remote desktop");
    act(() => q("remote-desktop-first-frame-retry")?.click());
    act(() => q("remote-desktop-first-frame-edit")?.click());
    act(() => q("remote-desktop-first-frame-close-tab")?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onEditConnection).toHaveBeenCalledTimes(1);
    expect(onCloseTab).toHaveBeenCalledTimes(1);
  });

  it("offers no Edit for a tab not opened from a saved connection", () => {
    render(true, { editable: false });
    expect(q("remote-desktop-first-frame-edit")).toBeNull();
    expect(q("remote-desktop-first-frame-retry")).not.toBeNull();
  });
});
