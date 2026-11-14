/**
 * The connection's optional short description (#5757): an 80-character,
 * single-line input under the name; saved normalised (blank = none) and dirty
 * when changed.
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

const CONN_ID = "conn-desc-1";
const TAB_ID = "tab-desc-1";
const PANEL_ID = "panel-desc-1";

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

function descriptionInput(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(
    '[data-testid="connection-editor-description-input"]'
  )!;
}

function setDescription(value: string) {
  const input = descriptionInput();
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

describe("ConnectionEditor — description (#5757)", () => {
  let updateConnection: ReturnType<typeof vi.fn<(c: SavedConnection) => Promise<string | null>>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetRuntimeCache();
    updateConnection = vi.fn((_c: SavedConnection) => Promise.resolve<string | null>(CONN_ID));
    seedConnectionsRegion({ connections: [{ ...EXISTING_CONN, description: "Old note" }] });
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [SSH_TYPE],
      credentialStoreStatus: { mode: "none", status: "unlocked" },
      updateConnection,
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

  it("pre-fills a short single-line description input", async () => {
    render();
    await flush();
    const input = descriptionInput();
    expect(input.value).toBe("Old note");
    expect(input.tagName).toBe("INPUT");
    expect(input.maxLength).toBe(80);
  });

  it("saves the edited description as one trimmed line", async () => {
    render();
    await flush();
    setDescription("  Shop\n front  ");
    await flush();
    click(container.querySelector<HTMLElement>('[data-testid="connection-editor-save"]')!);
    await flush();
    const saved = updateConnection.mock.calls[0][0];
    expect(saved.description).toBe("Shop front");
  });

  it("saves a cleared description as none", async () => {
    render();
    await flush();
    setDescription("   ");
    await flush();
    click(container.querySelector<HTMLElement>('[data-testid="connection-editor-save"]')!);
    await flush();
    const saved = updateConnection.mock.calls[0][0];
    expect(saved.description).toBeUndefined();
  });

  it("marks the editor dirty when only the description changes", async () => {
    render();
    await flush();
    setDescription("New note");
    await flush();
    click(container.querySelector<HTMLElement>('[data-testid="connection-editor-cancel"]')!);
    await flush();
    expect(useAppStore.getState().setPendingCloseRequest).toHaveBeenCalledWith({
      tabId: TAB_ID,
      panelId: PANEL_ID,
    });
  });
});
