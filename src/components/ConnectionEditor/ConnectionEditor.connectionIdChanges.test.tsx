/**
 * An open connection editor follows another saved connection's id change
 * (#3603): its saved-connection jump-host hops are re-pointed, so saving does
 * not write the old id back over the backend's follow (#3596). The remap is not
 * a user edit, so a clean editor stays clean.
 */
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { resetRuntimeCache } from "@/hooks/useAvailableRuntimes";
import { flushAsync } from "@/test/flushAsync";
import { installConnectionIdChangesHarness } from "@/test/connectionIdChangesHarness";
import { TooltipProvider } from "@/components/ui";
import type { ConnectionTypeInfo, SavedConnection } from "@/types/connection";
import { ConnectionEditor } from "./ConnectionEditor";

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
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

const SSH_TYPE: ConnectionTypeInfo = {
  typeId: "ssh",
  displayName: "SSH",
  icon: "ssh",
  schema: {
    groups: [
      {
        key: "conn",
        label: "Connection",
        fields: [
          { key: "host", label: "Host", fieldType: { type: "text" }, required: true },
          { key: "username", label: "Username", fieldType: { type: "text" }, required: true },
          {
            key: "authMethod",
            label: "Auth Method",
            fieldType: {
              type: "select",
              options: [
                { value: "key", label: "Key" },
                { value: "agent", label: "Agent" },
              ],
            },
            required: true,
            default: "agent",
          },
        ],
      },
    ],
  },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: false },
};

function ssh(id: string, extra: Record<string, unknown> = {}): SavedConnection {
  return {
    id,
    name: id.split("/").pop()!,
    config: { type: "ssh", config: { host: id, username: "u", authMethod: "agent", ...extra } },
    folderId: null,
  };
}

const TARGET = ssh("target", {
  proxyJump: [
    { connectionId: "Work/bastion", host: "", port: 22, username: "", authMethod: "key" },
  ],
});
const TAB_ID = "tab-jh-follow";

let container: HTMLDivElement;
let root: Root;

setupSettingsRegion();
setupConnectionsRegion();
setupAgentsRegion();

describe("ConnectionEditor — jump-host hops follow connection id changes (#3603)", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetRuntimeCache();
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "save_connection") return Promise.resolve();
      return Promise.resolve(null);
    });
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [SSH_TYPE],
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });
    // Both ids resolve, so the chain validates before and after the rename.
    seedConnectionsRegion({ connections: [TARGET, ssh("Work/bastion"), ssh("Job/bastion")] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("saves the hop with the renamed connection's new id and stays clean", async () => {
    const events = installConnectionIdChangesHarness();
    act(() => {
      root.render(
        <TooltipProvider>
          <ConnectionEditor
            tabId={TAB_ID}
            meta={{ connectionId: TARGET.id, folderId: null }}
            isVisible={true}
          />
        </TooltipProvider>
      );
    });
    await flushAsync();
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(false);

    events.emit([{ oldId: "Work/bastion", newId: "Job/bastion" }]);
    await flushAsync();
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(false);

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="connection-editor-save"]')!.click();
    });
    await flushAsync();

    const saveCall = mockedInvoke.mock.calls.find(([cmd]) => cmd === "save_connection");
    const persisted = (saveCall?.[1] as { connection: SavedConnection }).connection;
    expect((persisted.config.config as Record<string, unknown>).proxyJump).toEqual([
      { connectionId: "Job/bastion", host: "", port: 22, username: "", authMethod: "key" },
    ]);
  });
});
