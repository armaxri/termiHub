/**
 * Cancel-button unsaved-changes guard tests (UX-006): the visible Cancel button
 * must route through the same dirty guard as Escape and tab-close, so a dirty
 * form opens the confirmation dialog instead of silently discarding edits.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { seedLayoutState } from "@/test/layoutState";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { resetRuntimeCache } from "@/hooks/useAvailableRuntimes";
import { ConnectionEditor } from "./ConnectionEditor";
import { TooltipProvider } from "@/components/ui";
import type { ConnectionTypeInfo, SavedConnection } from "@/types/connection";

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
  schema: { groups: [] },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: false },
};

const CONN_ID = "conn-cancel-1";
const TAB_ID = "tab-cancel-1";
const PANEL_ID = "panel-cancel-1";

const EXISTING_CONN: SavedConnection = {
  id: CONN_ID,
  name: "My SSH Server",
  config: { type: "ssh", config: { host: "192.168.1.1", username: "user" } },
  folderId: null,
};

/** rootPanel containing the edited tab so closeThisTab can resolve its leaf. */
const ROOT_PANEL = {
  type: "leaf",
  id: PANEL_ID,
  tabs: [{ id: TAB_ID }],
  activeTabId: TAB_ID,
};

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root.render(
      <TooltipProvider>
        <ConnectionEditor
          tabId={TAB_ID}
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
  });
}

function nameInput(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('[data-testid="connection-editor-name-input"]')!;
}

function cancelButton(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[data-testid="connection-editor-cancel"]')!;
}

function setName(value: string) {
  const input = nameInput();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

setupConnectionsRegion();

describe("ConnectionEditor — Cancel button unsaved-changes guard (UX-006)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetRuntimeCache();
    seedConnectionsRegion({ connections: [EXISTING_CONN] });
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [SSH_TYPE],
      credentialStoreStatus: { mode: "none", status: "unlocked" },
      updateConnection: vi.fn(),
      closeTab: vi.fn(),
      setPendingCloseRequest: vi.fn(),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seedLayoutState({ rootPanel: ROOT_PANEL as any });
    mockedInvoke.mockImplementation(() => Promise.resolve(false));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("closes directly when the form is unchanged (not dirty)", async () => {
    render();
    await flush();
    click(cancelButton());
    await flush();
    expect(useAppStore.getState().closeTab).toHaveBeenCalledWith(TAB_ID, PANEL_ID);
    expect(useAppStore.getState().setPendingCloseRequest).not.toHaveBeenCalled();
  });

  it("routes through the unsaved-changes guard when dirty (does not discard)", async () => {
    render();
    await flush();
    setName("My SSH Server — edited");
    await flush();
    click(cancelButton());
    await flush();
    expect(useAppStore.getState().setPendingCloseRequest).toHaveBeenCalledWith({
      tabId: TAB_ID,
      panelId: PANEL_ID,
    });
    expect(useAppStore.getState().closeTab).not.toHaveBeenCalled();
  });
});
