/**
 * Save and connect never does nothing (#6079): a click either saves and
 * connects, or says on screen why it did not.
 */
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { flushAsync, flushMacrotask } from "@/test/flushAsync";
import { useAppStore } from "@/store/appStore";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { resetRuntimeCache } from "@/hooks/useAvailableRuntimes";
import { getAllTabsAcrossGroupTrees } from "@/store/layoutSelectors";
import { ConnectionEditor } from "./ConnectionEditor";
import { TooltipProvider, toast } from "@/components/ui";
import type { ConnectionTypeInfo, SavedConnection } from "@/types/connection";

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: {
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      loading: vi.fn(),
      dismiss: vi.fn(),
    },
  };
});

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const mockedInvoke = vi.mocked(invoke);

const TELNET_TYPE: ConnectionTypeInfo = {
  typeId: "telnet",
  displayName: "Telnet",
  icon: "telnet",
  schema: {
    groups: [
      {
        key: "connection",
        label: "Connection",
        fields: [
          { key: "host", label: "Host", fieldType: { type: "text" }, required: true },
          { key: "port", label: "Port", fieldType: { type: "port" }, required: false },
        ],
      },
    ],
  },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: false },
};

/** The type a new connection's editor starts on. */
const LOCAL_TYPE: ConnectionTypeInfo = {
  ...TELNET_TYPE,
  typeId: "local",
  displayName: "Local",
  icon: "local",
};

const EXISTING: SavedConnection = {
  id: "Lab switch",
  name: "Lab switch",
  config: { type: "telnet", config: { host: "10.0.0.5", port: 23 } },
  folderId: null,
};

/** The id the (mocked) backend stores the saved connection under. */
let persistedId: string;
/** When set, `save_connection` rejects with this message. */
let saveFailure: string | null;

setupSettingsRegion();
setupConnectionsRegion();
setupAgentsRegion();

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
    await flushMacrotask();
  });
}

async function render(connectionId: string) {
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <ConnectionEditor
          tabId="tab-save-connect-id"
          meta={{ connectionId, folderId: null }}
          isVisible={true}
        />
      </TooltipProvider>
    );
  });
  await flushAsync();
}

function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function saveAndConnect() {
  const btn = container.querySelector<HTMLButtonElement>(
    '[data-testid="connection-editor-save-connect"]'
  );
  expect(btn).not.toBeNull();
  await act(async () => {
    btn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
  await flushAsync();
}

/** The terminal tabs opened so far (the editor's own tab excluded). */
function terminalTabs() {
  return getAllTabsAcrossGroupTrees().filter((t) => t.contentType === "terminal");
}

const blocked = () =>
  container.querySelector('[data-testid="connection-editor-blocked"]')?.textContent ?? "";

describe("ConnectionEditor — Save and connect never does nothing (#6079)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetRuntimeCache();
    persistedId = "Lab switch";
    saveFailure = null;
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "save_connection") {
        return saveFailure === null
          ? Promise.resolve(persistedId)
          : Promise.reject(new Error(saveFailure));
      }
      if (cmd === "load_connections_and_folders")
        return Promise.resolve({ connections: [EXISTING], folders: [] });
      return Promise.resolve(null);
    });
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [LOCAL_TYPE, TELNET_TYPE],
      credentialStoreStatus: { mode: "none", status: "unlocked" },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("says why when what blocks it is on another page of the editor", async () => {
    seedConnectionsRegion({ connections: [{ ...EXISTING, iconColor: "not a color" }] });
    await render(EXISTING.id);
    await saveAndConnect();
    expect(terminalTabs()).toHaveLength(0);
    expect(blocked()).toContain("Appearance");
    expect(blocked()).toContain("Choose a palette color");
    // It shows the page that has it.
    expect(container.querySelector('[data-testid="settings-nav-appearance"]')?.className).toContain(
      "active"
    );
  });

  it("says why for a missing field, and the note goes once it is fixed", async () => {
    seedConnectionsRegion({ connections: [EXISTING] });
    await render("new");
    await flush();
    await act(async () =>
      setValue(
        container.querySelector<HTMLInputElement>('[data-testid="connection-editor-name-input"]')!,
        "Core router"
      )
    );
    await flush();
    await saveAndConnect();
    expect(terminalTabs()).toHaveLength(0);
    expect(blocked()).toContain("Host");
    await act(async () =>
      setValue(container.querySelector<HTMLInputElement>('[data-testid="field-host"]')!, "10.0.0.1")
    );
    await flush();
    expect(blocked()).toBe("");
    // Broken again: nothing says so before the next click.
    await act(async () =>
      setValue(container.querySelector<HTMLInputElement>('[data-testid="field-host"]')!, "")
    );
    await flush();
    expect(blocked()).toBe("");
  });

  it("names a missing name", async () => {
    seedConnectionsRegion({ connections: [EXISTING] });
    await render("new");
    await flush();
    await act(async () =>
      setValue(container.querySelector<HTMLInputElement>('[data-testid="field-host"]')!, "10.0.0.1")
    );
    await flush();
    await saveAndConnect();
    expect(blocked()).toContain("Name is required");
  });

  it("says so when connecting fails in a way nobody expected", async () => {
    seedConnectionsRegion({ connections: [EXISTING] });
    await render(EXISTING.id);
    act(() =>
      useAppStore.setState({
        addTab: () => {
          throw new Error("no room for another tab");
        },
      })
    );
    await saveAndConnect();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringContaining("Lab switch"),
      expect.objectContaining({ description: expect.stringContaining("no room for another tab") })
    );
  });
});
