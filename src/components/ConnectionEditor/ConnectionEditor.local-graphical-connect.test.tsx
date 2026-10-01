/**
 * Save & Connect of a direct (non-agent) connection opens the tab its type
 * needs (#4017).
 *
 * The editor's local Save & Connect called `addTab` with no `contentType`, so
 * a VNC/RDP connection opened as a *terminal* tab: the backend session started
 * and immediately stopped, and the tab showed "Session disconnected" instead of
 * the remote-desktop canvas. The nightly `test_vnc` suite failed on exactly
 * this. The editor must pick the content type from the registry capabilities,
 * the same way the sidebar's connect flow does.
 */
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { flushAsync } from "@/test/flushAsync";
import { useAppStore } from "@/store/appStore";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { resetRuntimeCache } from "@/hooks/useAvailableRuntimes";
import { ConnectionEditor } from "./ConnectionEditor";
import { TooltipProvider } from "@/components/ui";
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

const HOST_PORT_SCHEMA: ConnectionTypeInfo["schema"] = {
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
};

function makeType(
  typeId: string,
  capabilities: Partial<ConnectionTypeInfo["capabilities"]>
): ConnectionTypeInfo {
  return {
    typeId,
    displayName: typeId.toUpperCase(),
    icon: typeId,
    schema: HOST_PORT_SCHEMA,
    capabilities: {
      monitoring: false,
      fileBrowser: false,
      resize: false,
      persistent: false,
      ...capabilities,
    },
  };
}

const VNC_TYPE = makeType("vnc", { terminal: false, graphical: true });
const FTP_TYPE = makeType("ftp", { terminal: false, fileBrowser: true });
const TELNET_TYPE = makeType("telnet", { resize: true });

function makeConn(id: string, type: string, name: string): SavedConnection {
  return {
    id,
    name,
    config: { type, config: { host: "10.0.0.5", port: 5901 } },
    folderId: null,
  };
}

const CONNS = [
  makeConn("conn-vnc", "vnc", "Lab desktop"),
  makeConn("conn-ftp", "ftp", "Lab files"),
  makeConn("conn-telnet", "telnet", "Lab switch"),
];

setupSettingsRegion();
setupConnectionsRegion();
setupAgentsRegion();

let container: HTMLDivElement;
let root: Root;

async function renderFor(connectionId: string) {
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <ConnectionEditor
          tabId="tab-local-graphical"
          meta={{ connectionId, folderId: null }}
          isVisible={true}
        />
      </TooltipProvider>
    );
  });
  await flushAsync();
}

let addTab: ReturnType<typeof vi.fn>;

async function saveAndConnect(): Promise<ReturnType<typeof vi.fn>> {
  const btn = container.querySelector(
    '[data-testid="connection-editor-save-connect"]'
  ) as HTMLButtonElement | null;
  expect(btn).not.toBeNull();
  await act(async () => {
    btn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flushAsync();
  return addTab;
}

describe("ConnectionEditor — local Save & Connect opens the type's tab (#4017)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetRuntimeCache();
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "load_connections_and_folders")
        return Promise.resolve({ connections: CONNS, folders: [] });
      return Promise.resolve(null);
    });
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [VNC_TYPE, FTP_TYPE, TELNET_TYPE],
    });
    // Installed before render: the editor reads `addTab` from the store.
    addTab = vi.fn(() => "tab-new");
    useAppStore.setState({ addTab });
    seedConnectionsRegion({ connections: CONNS });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("opens a graphical (VNC) connection into a remote-desktop tab", async () => {
    await renderFor("conn-vnc");
    const addTab = await saveAndConnect();

    expect(addTab).toHaveBeenCalledTimes(1);
    const [title, connectionType, config, options] = addTab.mock.calls[0] as unknown as [
      string,
      string,
      { type: string },
      { contentType?: string },
    ];
    expect(title).toBe("Lab desktop");
    expect(connectionType).toBe("vnc");
    expect(config.type).toBe("vnc");
    expect(options.contentType).toBe("remote-desktop");
  });

  it("opens a terminal-less (FTP) connection into a file-browser tab", async () => {
    await renderFor("conn-ftp");
    const addTab = await saveAndConnect();

    expect(addTab).toHaveBeenCalledTimes(1);
    const options = addTab.mock.calls[0][3] as { contentType?: string };
    expect(options.contentType).toBe("file-browser");
  });

  it("keeps the terminal default for a terminal type", async () => {
    await renderFor("conn-telnet");
    const addTab = await saveAndConnect();

    expect(addTab).toHaveBeenCalledTimes(1);
    const options = addTab.mock.calls[0][3] as { contentType?: string };
    expect(options.contentType).toBeUndefined();
  });
});
