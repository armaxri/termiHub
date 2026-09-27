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

/**
 * The editor's *own* connection renamed or moved while the editor is open
 * (#3622): the tab's `connectionEditorMeta` follows the new id, so saving updates
 * the renamed connection instead of adding a duplicate at the old path, and the
 * draft (with its dirty state) is kept.
 */
describe("ConnectionEditor — follows its own connection's id change (#3622)", () => {
  const WORK_X: SavedConnection = { ...ssh("Work/x"), folderId: "Work" };
  const JOB_X: SavedConnection = { ...ssh("Work/x"), id: "Job/x", folderId: "Job" };
  const folder = (id: string) => ({
    id,
    name: id.split("/").pop()!,
    parentId: null,
    isExpanded: true,
  });

  /** Renders the editor from the store's tab content, like SplitView does. */
  function Host({ tabId }: { tabId: string }) {
    const meta = useAppStore((s) => s.tabContent[tabId]?.connectionEditorMeta);
    return meta ? <ConnectionEditor tabId={tabId} meta={meta} isVisible={true} /> : null;
  }

  function openEditor(connectionId: string, folderId?: string): string {
    act(() => useAppStore.getState().openConnectionEditorTab(connectionId, folderId));
    const [tabId] = Object.entries(useAppStore.getState().tabContent).find(
      ([, c]) => c.contentType === "connection-editor"
    )!;
    act(() => {
      root.render(
        <TooltipProvider>
          <Host tabId={tabId} />
        </TooltipProvider>
      );
    });
    return tabId;
  }

  /** What the backend does on a rename: announce the batch, then publish the tree. */
  function renameInBackend(
    events: ReturnType<typeof installConnectionIdChangesHarness>,
    changes: { oldId: string; newId: string }[],
    tree: Parameters<typeof seedConnectionsRegion>[0]
  ): void {
    events.emit(changes);
    act(() => useAppStore.getState().followConnectionIdChanges(changes));
    act(() => seedConnectionsRegion(tree));
  }

  function setInput(el: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!;
    act(() => {
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  const nameInput = () =>
    container.querySelector<HTMLInputElement>('[data-testid="connection-editor-name-input"]')!;

  async function save(): Promise<SavedConnection[]> {
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="connection-editor-save"]')!.click();
    });
    await flushAsync();
    return mockedInvoke.mock.calls
      .filter(([cmd]) => cmd === "save_connection")
      .map(([, args]) => (args as { connection: SavedConnection }).connection);
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetRuntimeCache();
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "save_connection") return Promise.resolve();
      if (cmd === "list_workflows") return Promise.resolve([]);
      return Promise.resolve(null);
    });
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [SSH_TYPE],
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });
    seedConnectionsRegion({ folders: [folder("Work")], connections: [WORK_X] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("a folder rename re-points the editor; saving updates the moved connection", async () => {
    const events = installConnectionIdChangesHarness();
    const tabId = openEditor("Work/x");
    await flushAsync();
    expect(useAppStore.getState().editorDirtyTabs[tabId]).toBe(false);

    renameInBackend(events, [{ oldId: "Work/x", newId: "Job/x" }], {
      folders: [folder("Job")],
      connections: [JOB_X],
    });
    await flushAsync();
    expect(useAppStore.getState().tabContent[tabId].connectionEditorMeta?.connectionId).toBe(
      "Job/x"
    );
    expect(useAppStore.getState().editorDirtyTabs[tabId]).toBe(false);

    const saved = await save();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: "Job/x", folderId: "Job", name: "x" });
  });

  it("keeps unsaved edits across the rename and saves them to the new id", async () => {
    const events = installConnectionIdChangesHarness();
    const tabId = openEditor("Work/x");
    await flushAsync();
    setInput(nameInput(), "edited");
    await flushAsync();
    expect(useAppStore.getState().editorDirtyTabs[tabId]).toBe(true);

    renameInBackend(events, [{ oldId: "Work/x", newId: "Job/x" }], {
      folders: [folder("Job")],
      connections: [JOB_X],
    });
    await flushAsync();
    expect(nameInput().value).toBe("edited");
    expect(useAppStore.getState().editorDirtyTabs[tabId]).toBe(true);

    const saved = await save();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: "Job/x", folderId: "Job", name: "edited" });
  });

  it("a rename of the connection itself follows the new name while clean", async () => {
    const events = installConnectionIdChangesHarness();
    const tabId = openEditor("Work/x");
    await flushAsync();
    expect(useAppStore.getState().tabContent[tabId].title).toBe("Edit: x");

    const renamed: SavedConnection = { ...WORK_X, id: "Work/y", name: "y" };
    renameInBackend(events, [{ oldId: "Work/x", newId: "Work/y" }], {
      connections: [renamed],
    });
    await flushAsync();
    expect(nameInput().value).toBe("y");
    expect(useAppStore.getState().editorDirtyTabs[tabId]).toBe(false);
    expect(useAppStore.getState().tabContent[tabId].title).toBe("Edit: y");

    const saved = await save();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: "Work/y", name: "y" });
  });

  it("a new connection's target folder follows a folder rename once the folder is gone", async () => {
    const events = installConnectionIdChangesHarness();
    const tabId = openEditor("new", "Work");
    await flushAsync();

    const changes = [{ oldId: "Work/x", newId: "Job/x" }];
    events.emit(changes);
    act(() => useAppStore.getState().followConnectionIdChanges(changes));
    await flushAsync();
    // The tree still shows `Work`: nothing is retargeted on a guess.
    expect(useAppStore.getState().tabContent[tabId].connectionEditorMeta?.folderId).toBe("Work");

    act(() => seedConnectionsRegion({ folders: [folder("Job")], connections: [JOB_X] }));
    await flushAsync();
    expect(useAppStore.getState().tabContent[tabId].connectionEditorMeta?.folderId).toBe("Job");
  });

  it("a new connection's folder stays put when only a connection moved out of it", async () => {
    const events = installConnectionIdChangesHarness();
    const tabId = openEditor("new", "Work");
    await flushAsync();

    renameInBackend(events, [{ oldId: "Work/x", newId: "Job/x" }], {
      folders: [folder("Work"), folder("Job")],
      connections: [JOB_X],
    });
    await flushAsync();
    expect(useAppStore.getState().tabContent[tabId].connectionEditorMeta?.folderId).toBe("Work");
  });
});
