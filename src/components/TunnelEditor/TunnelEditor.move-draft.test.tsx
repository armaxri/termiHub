/**
 * "Move tabs" carries a dirty tunnel editor's unsaved values to another window
 * (#4500): the editor mounted for the moved tab shows them and is dirty, and
 * nothing is saved on the way.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { flushAsync } from "@/test/flushAsync";
import { typeInto, byTestId } from "@/test/dirtyDismiss";
import { hydrateInDestination, moveTabs, seedSingleTab } from "@/test/formDraftMove";
import { clearEditorBuffers } from "@/utils/editorBufferRegistry";
import { TunnelEditor } from "./TunnelEditor";
import { TooltipProvider } from "@/components/ui";
import type { SavedConnection } from "@/types/connection";
import type { TunnelConfig } from "@/types/tunnel";
import type { TerminalTab } from "@/types/terminal";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const SSH_CONN: SavedConnection = {
  id: "ssh-1",
  name: "My SSH",
  config: { type: "ssh", config: { host: "h", username: "u" } },
  folderId: null,
};

let container: HTMLDivElement;
let root: Root;

function editorTab(tunnelId: string | null): TerminalTab {
  return {
    id: "tab-src",
    sessionId: null,
    title: tunnelId ? "Edit: DB" : "New Tunnel",
    connectionType: "local",
    contentType: "tunnel-editor",
    config: { type: "local", config: {} },
    panelId: "panel-src",
    isActive: true,
    tunnelEditorMeta: { tunnelId },
  };
}

async function render(tabId: string, tunnelId: string | null) {
  act(() => {
    root.render(
      <TooltipProvider>
        <TunnelEditor key={tabId} tabId={tabId} meta={{ tunnelId }} isVisible={true} />
      </TooltipProvider>
    );
  });
  await flushAsync();
}

const nameValue = () => (byTestId("tunnel-editor-name") as HTMLInputElement).value;

setupConnectionsRegion();

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  clearEditorBuffers();
  seedConnectionsRegion({ connections: [SSH_CONN] });
  useAppStore.setState({
    ...useAppStore.getInitialState(),
    tunnels: [],
    saveTunnel: vi.fn(() => Promise.resolve()),
    startTunnel: vi.fn(() => Promise.resolve()),
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("TunnelEditor — Move tabs carries the unsaved draft (#4500)", () => {
  it("a dirty new tunnel reappears dirty with its values in the target window", async () => {
    seedSingleTab(editorTab(null));
    await render("tab-src", null);
    typeInto("tunnel-editor-name", "Dev DB");
    expect(useAppStore.getState().editorDirtyTabs["tab-src"]).toBe(true);

    const record = await moveTabs();
    expect(record.tab.editorDirty).toBe(true);
    expect(record.tab.formDraft?.kind).toBe("tunnel-editor");

    act(() => root.unmount());
    root = createRoot(container);
    const newTabId = hydrateInDestination(record, "panel-dst");
    await render(newTabId, null);

    expect(nameValue()).toBe("Dev DB");
    expect(useAppStore.getState().editorDirtyTabs[newTabId]).toBe(true);
    expect(useAppStore.getState().saveTunnel).not.toHaveBeenCalled();
  });

  it("a dirty saved tunnel keeps its edits over the loaded tunnel, still dirty", async () => {
    const tunnel: TunnelConfig = {
      id: "tun-1",
      name: "DB",
      sshConnectionId: "ssh-1",
      tunnelType: {
        type: "local",
        config: { localHost: "127.0.0.1", localPort: 5432, remoteHost: "db", remotePort: 5432 },
      },
      autoStart: false,
      reconnectOnDisconnect: false,
    };
    useAppStore.setState({ tunnels: [tunnel] });
    seedSingleTab(editorTab("tun-1"));
    await render("tab-src", "tun-1");
    expect(nameValue()).toBe("DB");
    typeInto("tunnel-editor-name", "DB (prod)");

    const record = await moveTabs();
    act(() => root.unmount());
    root = createRoot(container);
    const newTabId = hydrateInDestination(record, "panel-dst");
    await render(newTabId, "tun-1");

    expect(nameValue()).toBe("DB (prod)");
    expect(useAppStore.getState().editorDirtyTabs[newTabId]).toBe(true);
    // Reverting to the saved name is clean again: the baseline is the saved tunnel.
    typeInto("tunnel-editor-name", "DB");
    expect(useAppStore.getState().editorDirtyTabs[newTabId]).toBe(false);
  });

  it("a clean tunnel editor moves without a draft and opens clean", async () => {
    seedSingleTab(editorTab(null));
    await render("tab-src", null);

    const record = await moveTabs();
    expect(record.tab.formDraft).toBeUndefined();
    expect(record.tab.editorDirty).toBeUndefined();
  });
});
