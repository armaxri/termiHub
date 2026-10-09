/**
 * Experimental gating of the File Browser "Share via HTTP/FTP/TFTP Server" items
 * (#4498).
 *
 * Sharing a folder switches the sidebar to the Services view, which is an
 * experimental view hidden when experimental features are off. The menu items
 * use the same `useExperimentalFeatures` gate as the activity-bar Services item,
 * so they are absent with the toggle off and present with it on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { FileMenuItems } from "./FileBrowser";
import type { FileEntry } from "@/types/connection";

setupSettingsRegion();

function SimpleItem({
  children,
  onSelect,
  ...rest
}: {
  children: React.ReactNode;
  onSelect?: () => void;
  [key: string]: unknown;
}) {
  return (
    <div role="menuitem" onClick={onSelect} {...rest}>
      {children}
    </div>
  );
}

function SimpleSeparator() {
  return <hr />;
}

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

describe("FileMenuItems — Share via gating (#4498)", () => {
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
        <FileMenuItems
          entry={dirEntry}
          vscodeAvailable={false}
          onNavigate={vi.fn()}
          onContextAction={vi.fn()}
          onPaste={vi.fn()}
          hasClipboard={false}
          onShareVia={onShareVia}
          Item={SimpleItem}
          Separator={SimpleSeparator}
          testIdPrefix="file-menu"
        />
      );
    });
    return onShareVia;
  }

  const shareItem = (proto: string) =>
    container.querySelector<HTMLElement>(`[data-testid="file-menu-share-${proto}"]`);

  it("hides every Share via item when experimental features are off", () => {
    seedSettings({ experimentalFeaturesEnabled: false });
    renderMenu();
    for (const proto of PROTOCOLS) {
      expect(shareItem(proto)).toBeNull();
    }
    // The local-only OS-integration items share the same `onShareVia` local
    // gate and must stay available regardless of the experimental toggle.
    expect(container.querySelector('[data-testid="file-menu-open-in-explorer"]')).toBeTruthy();
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
