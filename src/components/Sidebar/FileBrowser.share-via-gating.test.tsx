/**
 * The File Browser "Share via HTTP/FTP/TFTP Server" items (#4498, #5858).
 *
 * Sharing a folder switches the sidebar to the Services view. Services
 * graduated from the experimental switch (#5858), so the items are offered
 * whether experimental features are on or off.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { FileMenuItems } from "./FileBrowser";
import { OpenTestMenu } from "@/test/OpenTestMenu";
import type { FileEntry } from "@/types/connection";

setupSettingsRegion();

const dirEntry: FileEntry = {
  name: "shared",
  path: "/home/user/shared",
  isDirectory: true,
  size: 0,
  modified: "2026-01-01T00:00:00Z",
  permissions: null,
  writable: null,
};

const PROTOCOLS = ["http", "ftp", "tftp"] as const;

describe("FileMenuItems — Share via (#4498, #5858)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderMenu(onShareVia = vi.fn()) {
    act(() => {
      root.render(
        <OpenTestMenu container={container}>
          <FileMenuItems
            entry={dirEntry}
            vscodeAvailable={false}
            onNavigate={vi.fn()}
            onContextAction={vi.fn()}
            onPaste={vi.fn()}
            hasClipboard={false}
            onShareVia={onShareVia}
            testIdPrefix="file-menu"
          />
        </OpenTestMenu>
      );
    });
    return onShareVia;
  }

  const shareItem = (proto: string) =>
    container.querySelector<HTMLElement>(`[data-testid="file-menu-share-${proto}"]`);

  it("shows every Share via item with experimental features off (#5858)", () => {
    seedSettings({ experimentalFeaturesEnabled: false });
    const onShareVia = renderMenu();
    for (const proto of PROTOCOLS) {
      expect(shareItem(proto)).toBeTruthy();
    }
    expect(container.querySelector('[data-testid="file-menu-open-in-explorer"]')).toBeTruthy();
    act(() => shareItem("http")!.click());
    expect(onShareVia).toHaveBeenCalledWith(dirEntry.path, "http");
  });

  it("shows every Share via item when experimental features are on", () => {
    seedSettings({ experimentalFeaturesEnabled: true });
    const onShareVia = renderMenu();
    for (const proto of PROTOCOLS) {
      expect(shareItem(proto)).toBeTruthy();
    }
    act(() => shareItem("ftp")!.click());
    expect(onShareVia).toHaveBeenCalledWith(dirEntry.path, "ftp");
  });
});
