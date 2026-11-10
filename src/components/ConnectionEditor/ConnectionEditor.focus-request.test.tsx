/**
 * A failed connect's **Edit connection** action opens the editor with a focus
 * request (#5183): the editor lands on the host / port field instead of the
 * name, and a repeat request (new nonce) refocuses an editor that is open.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { resetRuntimeCache } from "@/hooks/useAvailableRuntimes";
import { clearEditorBuffers } from "@/utils/editorBufferRegistry";
import { ConnectionEditor } from "./ConnectionEditor";
import { TooltipProvider } from "@/components/ui";
import type { ConnectionTypeInfo, SavedConnection } from "@/types/connection";
import type { ConnectionEditorMeta } from "@/types/terminal";

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

const NET_TYPE: ConnectionTypeInfo = {
  typeId: "nettype",
  displayName: "Net",
  icon: "terminal",
  schema: {
    groups: [
      {
        key: "conn",
        label: "Connection",
        fields: [
          { key: "host", label: "Host", fieldType: { type: "text" }, required: true },
          { key: "port", label: "Port", fieldType: { type: "text" }, required: false },
        ],
      },
    ],
  },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: false },
};

const CONN: SavedConnection = {
  id: "net-1",
  name: "Net Server",
  config: { type: "nettype", config: { host: "db.internal", port: "2222" } },
  folderId: null,
};

let container: HTMLDivElement;
let root: Root;

function render(meta: ConnectionEditorMeta) {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <ConnectionEditor tabId="tab-edit" meta={meta} isVisible={true} />
      </TooltipProvider>
    );
  });
}

/** Let effects, store loads and the editor's focus frames run. */
async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}

const field = (key: string) =>
  container.querySelector<HTMLInputElement>(`[data-testid="field-${key}"]`);

setupConnectionsRegion();

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  resetRuntimeCache();
  clearEditorBuffers();
  seedConnectionsRegion({ connections: [CONN] });
  useAppStore.setState({
    ...useAppStore.getInitialState(),
    connectionTypes: [NET_TYPE],
    credentialStoreStatus: { mode: "none", status: "unlocked" },
  });
  mockedInvoke.mockImplementation(() => Promise.resolve(false));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("ConnectionEditor — focus request (#5183)", () => {
  it("focuses the requested field instead of the name", async () => {
    render({ connectionId: CONN.id, folderId: null, focusRequest: { field: "port", nonce: 1 } });
    await settle();
    expect(field("port")).not.toBeNull();
    expect(document.activeElement).toBe(field("port"));
  });

  it("refocuses on a repeat request for an open editor", async () => {
    render({ connectionId: CONN.id, folderId: null, focusRequest: { field: "port", nonce: 1 } });
    await settle();
    render({ connectionId: CONN.id, folderId: null, focusRequest: { field: "host", nonce: 2 } });
    await settle();
    expect(document.activeElement).toBe(field("host"));
  });

  it("keeps the name focused without a request", async () => {
    render({ connectionId: CONN.id, folderId: null });
    await settle();
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="connection-editor-name-input"]')
    );
  });
});
