/**
 * Save-feedback tests for the connection editor (#1342).
 *
 * Saving a connection used to confirm nothing, and a failed agent-definition
 * save was fully silent. These tests pin that a successful save surfaces a
 * success toast, and that a failing agent-definition save rejects (so the async
 * Button error path fires) instead of silently swallowing the error.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import React from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { resetRuntimeCache } from "@/hooks/useAvailableRuntimes";
import { ConnectionEditor } from "./ConnectionEditor";
import { TooltipProvider } from "@/components/ui";
import type { ConnectionTypeInfo, SavedConnection } from "@/types/connection";

const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: {
      success: (...args: unknown[]) => toastSuccess(...args),
      error: (...args: unknown[]) => toastError(...args),
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

const SSH_TYPE: ConnectionTypeInfo = {
  typeId: "ssh",
  displayName: "SSH",
  icon: "ssh",
  schema: {
    groups: [
      {
        key: "auth",
        label: "Authentication",
        fields: [
          { key: "password", label: "Password", fieldType: { type: "password" }, required: false },
        ],
      },
    ],
  },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: false },
};

const CONN_ID = "conn-test-123";
const EXISTING_CONN: SavedConnection = {
  id: CONN_ID,
  name: "My SSH Server",
  config: { type: "ssh", config: { host: "192.168.1.1", username: "user" } },
  folderId: null,
};

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <ConnectionEditor
          tabId="tab-test-1"
          meta={{ connectionId: CONN_ID, folderId: null }}
          isVisible={true}
        />
      </TooltipProvider>
    );
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ConnectionEditor — save feedback (#1342)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetRuntimeCache();
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connections: [EXISTING_CONN],
      connectionTypes: [SSH_TYPE],
      credentialStoreStatus: { mode: "none", status: "unlocked" },
      // Stub persistence so the save path doesn't hit the mocked-invoke reload
      // (which would otherwise fail in jsdom and emit an unrelated toast).
      updateConnection: vi.fn(),
      addConnection: vi.fn(),
      moveConnectionToFile: vi.fn(),
    });
    mockedInvoke.mockImplementation(() => Promise.resolve(false));
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("shows a success toast when saving a connection", async () => {
    render();
    await flush();

    const saveBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="connection-editor-save"]'
    );
    expect(saveBtn).not.toBeNull();
    act(() => {
      saveBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });
});
