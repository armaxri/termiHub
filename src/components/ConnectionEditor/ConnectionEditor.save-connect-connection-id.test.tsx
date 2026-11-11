/**
 * Save & Connect binds its tab to the saved connection (#5257, #5258).
 *
 * The editor's Save & Connect opened its tab without a `connectionId`, while a
 * sidebar connect stamps one. Everything that looks up "the open tabs of saved
 * connection X" skipped such a tab: a schedule reported "None of the target
 * connections is connected" (#5257), and the session was never bound to its
 * saved connection, so its transfers could not resume after a restart (#5258,
 * `Terminal.tsx` sends the tab's `connectionId` as `savedConnectionId`).
 *
 * The id must be the *persisted* one: the backend recomputes it from folder +
 * name, so a new connection's optimistic `conn-<ulid>` id, or a renamed
 * connection's old id, would never match a schedule target.
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
import { claimedTargetIds } from "@/store/scheduledRuns";
import { ConnectionEditor } from "./ConnectionEditor";
import { TooltipProvider } from "@/components/ui";
import type { ConnectionTypeInfo, SavedConnection } from "@/types/connection";
import type { ScheduleFire } from "@/types/schedule";

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

function fire(connectionIds: string[]): ScheduleFire {
  return {
    token: "tok",
    scheduleId: "sch",
    scheduleName: "Health",
    action: { kind: "macro", macroId: "m1" },
    targets: { kind: "connections", connectionIds },
    catchUp: false,
  };
}

describe("ConnectionEditor — Save & Connect binds the tab to its connection (#5257, #5258)", () => {
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
    seedConnectionsRegion({ connections: [EXISTING] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("stamps an existing connection's id on the tab", async () => {
    await render(EXISTING.id);
    await saveAndConnect();

    const tabs = terminalTabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].connectionId).toBe("Lab switch");
  });

  it("stamps the persisted id, not the optimistic one, for a new connection", async () => {
    persistedId = "Core router";
    await render("new");
    await flush();
    await act(async () =>
      setValue(
        container.querySelector<HTMLInputElement>('[data-testid="connection-editor-name-input"]')!,
        "Core router"
      )
    );
    await act(async () =>
      setValue(container.querySelector<HTMLInputElement>('[data-testid="field-host"]')!, "10.0.0.1")
    );
    await flush();
    await saveAndConnect();

    const tabs = terminalTabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].connectionId).toBe("Core router");
    // The optimistic id the editor previewed the row under never reaches the tab.
    expect(tabs[0].connectionId).not.toMatch(/^conn-/);
  });

  it("is a schedule target once connected (#5257)", async () => {
    await render(EXISTING.id);
    await saveAndConnect();

    const [tab] = terminalTabs();
    useAppStore.getState().setTabSessionId(tab.id, "sess-1");

    expect(claimedTargetIds(fire(["Lab switch"]), useAppStore.getState())).toEqual(["Lab switch"]);
  });

  it("names its saved connection to the session, for a transfer resume (#5258)", async () => {
    await render(EXISTING.id);
    await saveAndConnect();

    // `Terminal.tsx` resolves the `savedConnectionId` it sends to
    // `create_terminal` from the tab like this (resolveTabConnectionId).
    const [tab] = terminalTabs();
    expect(getAllTabsAcrossGroupTrees().find((t) => t.id === tab.id)?.connectionId).toBe(
      "Lab switch"
    );
  });

  it("still connects, unbound, when the save fails", async () => {
    saveFailure = "disk full";
    await render(EXISTING.id);
    await saveAndConnect();

    const tabs = terminalTabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].connectionId).toBeUndefined();
    expect(claimedTargetIds(fire(["Lab switch"]), useAppStore.getState())).toEqual([]);
  });
});
