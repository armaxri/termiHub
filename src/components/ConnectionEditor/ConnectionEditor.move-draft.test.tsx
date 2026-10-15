/**
 * "Move tabs" carries a dirty connection editor's unsaved values to another
 * window (#4500): the editor mounted for the moved tab shows them and is
 * dirty, nothing is saved on the way, and a secret typed into the form never
 * leaves it: the field reopens empty.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { resetRuntimeCache } from "@/hooks/useAvailableRuntimes";
import { hydrateInDestination, moveTabs, seedSingleTab } from "@/test/formDraftMove";
import { clearEditorBuffers } from "@/utils/editorBufferRegistry";
import { ConnectionEditor } from "./ConnectionEditor";
import { TooltipProvider } from "@/components/ui";
import type { ConnectionTypeInfo, SavedConnection } from "@/types/connection";
import type { TerminalTab } from "@/types/terminal";

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

const TOKEN_TYPE: ConnectionTypeInfo = {
  typeId: "tokenized",
  displayName: "Tokenized",
  icon: "terminal",
  schema: {
    groups: [
      {
        key: "conn",
        label: "Connection",
        fields: [
          { key: "host", label: "Host", fieldType: { type: "text" }, required: true },
          { key: "apiToken", label: "API Token", fieldType: { type: "password" }, required: false },
        ],
      },
    ],
  },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: false },
};

const CONN: SavedConnection = {
  id: "tok-1",
  name: "Token Server",
  config: { type: "tokenized", config: { host: "10.0.0.9" } },
  folderId: null,
};

let container: HTMLDivElement;
let root: Root;

function editorTab(): TerminalTab {
  return {
    id: "tab-src",
    sessionId: null,
    title: "Edit: Token Server",
    connectionType: "local",
    contentType: "connection-editor",
    config: { type: "local", config: {} },
    panelId: "panel-src",
    isActive: true,
    connectionEditorMeta: { connectionId: CONN.id, folderId: null },
  };
}

function render(tabId: string) {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <ConnectionEditor
          key={tabId}
          tabId={tabId}
          meta={{ connectionId: CONN.id, folderId: null }}
          isVisible={true}
        />
      </TooltipProvider>
    );
  });
}

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const input = (selector: string) => container.querySelector<HTMLInputElement>(selector)!;

function setInput(selector: string, value: string) {
  const el = input(selector);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const NAME = '[data-testid="connection-editor-name-input"]';
const HOST = '[data-testid="field-host"]';
const TOKEN = '[data-testid="field-apiToken"]';

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
    connectionTypes: [TOKEN_TYPE],
    credentialStoreStatus: { mode: "none", status: "unlocked" },
    updateConnection: vi.fn(),
    addConnection: vi.fn(),
  });
  mockedInvoke.mockImplementation(() => Promise.resolve(false));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("ConnectionEditor — Move tabs carries the unsaved draft (#4500)", () => {
  it("a dirty connection editor reappears dirty with its values, its typed secret empty", async () => {
    seedSingleTab(editorTab());
    render("tab-src");
    await flush();
    setInput(NAME, "Token Server (edited)");
    setInput(HOST, "10.0.0.10");
    setInput(TOKEN, "s3cret-token");
    expect(useAppStore.getState().editorDirtyTabs["tab-src"]).toBe(true);

    await useAppStore.getState().prepareWindowClose([{ label: "win-1" }]);
    expect(useAppStore.getState().pendingWindowClose?.dirtyEditors).toEqual([
      {
        tabId: "tab-src",
        title: "Edit: Token Server",
        movable: true,
        clearedSecrets: ["API Token"],
      },
    ]);

    const record = await moveTabs();
    expect(JSON.stringify(record)).not.toContain("s3cret-token");
    expect(record.tab.editorDirty).toBe(true);

    act(() => root.unmount());
    root = createRoot(container);
    const newTabId = hydrateInDestination(record, "panel-dst");
    render(newTabId);
    await flush();

    expect(input(NAME).value).toBe("Token Server (edited)");
    expect(input(HOST).value).toBe("10.0.0.10");
    expect(input(TOKEN).value).toBe("");
    expect(useAppStore.getState().editorDirtyTabs[newTabId]).toBe(true);
    expect(useAppStore.getState().updateConnection).not.toHaveBeenCalled();
    expect(useAppStore.getState().addConnection).not.toHaveBeenCalled();
  });

  it("a moved draft compares against the saved connection: reverting it is clean", async () => {
    seedSingleTab(editorTab());
    render("tab-src");
    await flush();
    setInput(NAME, "Renamed");

    const record = await moveTabs();
    act(() => root.unmount());
    root = createRoot(container);
    const newTabId = hydrateInDestination(record, "panel-dst");
    render(newTabId);
    await flush();
    expect(useAppStore.getState().editorDirtyTabs[newTabId]).toBe(true);

    setInput(NAME, "Token Server");
    await flush();
    expect(useAppStore.getState().editorDirtyTabs[newTabId]).toBe(false);
  });

  it("a clean connection editor moves without a draft", async () => {
    seedSingleTab(editorTab());
    render("tab-src");
    await flush();

    const record = await moveTabs();
    expect(record.tab.formDraft).toBeUndefined();
    expect(record.tab.editorDirty).toBeUndefined();
  });
});
