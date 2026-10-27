/**
 * Sidebar folder rows render a folder's icon colour / emoji (#5020), and the
 * folder context menu's "Appearance…" entry opens the dialog whose Save
 * persists the folder with its new style.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { flushAsync } from "@/test/flushAsync";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { TooltipProvider } from "@/components/ui";
import { persistFolder } from "@/services/storage";
import type { ConnectionFolder } from "@/types/connection";

vi.mock("@/services/api", () => ({
  listAvailableShells: vi.fn(() => Promise.resolve([])),
  createTerminal: vi.fn(() => Promise.resolve({ sessionId: "s1" })),
  removeCredential: vi.fn(),
  storeCredential: vi.fn(),
  isSshKeyEncrypted: vi.fn(() => Promise.resolve(false)),
  resolveCredential: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

vi.mock("@/services/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/storage")>()),
  persistFolder: vi.fn(() => Promise.resolve()),
}));

const baseSettings = {
  version: "1",
  externalConnectionFiles: [] as [],
  powerMonitoringEnabled: false,
  fileBrowserEnabled: false,
  experimentalFeaturesEnabled: false,
};

function folder(id: string, patch: Partial<ConnectionFolder> = {}): ConnectionFolder {
  return { id, name: id, parentId: null, isExpanded: false, ...patch };
}

setupConnectionsRegion();
setupSettingsRegion();

describe("ConnectionList — folder icon colour and emoji (#5020)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    seedSettings({ ...baseSettings });
    vi.mocked(persistFolder).mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(folders: ConnectionFolder[]) {
    seedConnectionsRegion({ folders, connections: [] });
    await act(async () =>
      root.render(
        React.createElement(TooltipProvider, {
          delayDuration: 0,
          children: React.createElement(ConnectionList),
        })
      )
    );
    await flushAsync();
  }

  const row = (id: string) => container.querySelector(`[data-testid="folder-toggle-${id}"]`)!;
  const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

  it("shows the emoji, the tinted folder icon, and the plain folder icon", async () => {
    await render([
      folder("Emoji", { iconEmoji: "🐳" }),
      folder("Coloured", { iconColor: "green" }),
      folder("Plain"),
    ]);

    expect(row("Emoji").querySelector('[data-testid="folder-icon-emoji"]')?.textContent).toBe("🐳");
    expect(row("Emoji").querySelector('[data-testid="folder-icon"]')).toBeNull();
    const coloured = row("Coloured").querySelector('[data-testid="folder-icon"]');
    expect(coloured?.getAttribute("data-icon-color")).toBe("green");
    expect(coloured?.getAttribute("stroke")).not.toBe("currentColor");
    const plain = row("Plain").querySelector('[data-testid="folder-icon"]');
    expect(plain?.getAttribute("stroke")).toBe("currentColor");
    expect(plain?.hasAttribute("data-icon-color")).toBe(false);
  });

  it("ignores an invalid stored emoji or colour and draws the plain folder icon", async () => {
    await render([folder("Bad", { iconEmoji: "ab", iconColor: "not-a-colour" })]);
    const icon = row("Bad").querySelector('[data-testid="folder-icon"]');
    expect(icon?.getAttribute("stroke")).toBe("currentColor");
    expect(row("Bad").querySelector('[data-testid="folder-icon-emoji"]')).toBeNull();
  });

  it("Appearance… opens the dialog and Save persists and renders the new style", async () => {
    await render([folder("Work")]);
    await act(async () => {
      row("Work").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    await flushAsync();
    await act(async () => {
      q("context-folder-appearance")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushAsync();

    expect(q("folder-appearance-dialog")).not.toBeNull();
    await act(async () => q("icon-color-swatch-blue")!.click());
    await act(async () => q("folder-appearance-save")!.click());
    await flushAsync();

    expect(persistFolder).toHaveBeenCalledWith(
      expect.objectContaining({ id: "Work", name: "Work", iconColor: "blue" })
    );
    expect(q("folder-appearance-dialog")).toBeNull();
    expect(
      row("Work").querySelector('[data-testid="folder-icon"]')?.getAttribute("data-icon-color")
    ).toBe("blue");
  });
});
