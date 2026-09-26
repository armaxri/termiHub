/**
 * Connection editor + shared named credentials (#3557): a connection that
 * references a shared credential hides its own password fields, resolves the
 * shared secret on connect without prompting, and keeps the reference through
 * later schema-form edits.
 */
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { flushMacrotask } from "@/test/flushAsync";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { resetRuntimeCache } from "@/hooks/useAvailableRuntimes";
import { ConnectionEditor } from "./ConnectionEditor";
import { TooltipProvider } from "@/components/ui";
import type { ConnectionTypeInfo, SavedConnection } from "@/types/connection";
import type { NamedCredentialEntry } from "@/types/generated/NamedCredentialEntry";

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
                { value: "password", label: "Password" },
                { value: "key", label: "Key" },
              ],
            },
            required: true,
            default: "password",
          },
          {
            key: "password",
            label: "Password",
            fieldType: { type: "password" },
            required: false,
            visibleWhen: { field: "authMethod", equals: "password" },
          },
          {
            key: "savePassword",
            label: "Save Password",
            fieldType: { type: "boolean" },
            required: false,
          },
          { key: "shell", label: "Shell", fieldType: { type: "text" }, required: false },
        ],
      },
    ],
  },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: false },
};

const SHARED: NamedCredentialEntry[] = [
  {
    credential: { id: "nc-pw", name: "Bastion", kind: "password", createdAt: "t" },
    usages: [],
  },
];

const CONN: SavedConnection = {
  id: "ssh-shared",
  name: "Uses shared",
  config: {
    type: "ssh",
    config: {
      host: "10.0.0.1",
      username: "ops",
      authMethod: "password",
      credentialRef: "nc-pw",
    },
  },
  folderId: null,
};

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await flushMacrotask();
  });
}

function renderEditor() {
  act(() => {
    root.render(
      <TooltipProvider>
        <ConnectionEditor
          tabId="tab-shared-1"
          meta={{ connectionId: CONN.id, folderId: null }}
          isVisible={true}
        />
      </TooltipProvider>
    );
  });
}

setupSettingsRegion();
setupConnectionsRegion();
setupAgentsRegion();

describe("ConnectionEditor — shared named credential (#3557)", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetRuntimeCache();
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "list_named_credentials") return Promise.resolve(SHARED);
      if (cmd === "resolve_named_credential") return Promise.resolve("shared-secret");
      if (cmd === "resolve_credential") return Promise.resolve("stale-own");
      if (cmd === "save_connection") return Promise.resolve();
      if (cmd === "load_connections_and_folders")
        return Promise.resolve({ connections: [CONN], folders: [] });
      return Promise.resolve(null);
    });
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [SSH_TYPE],
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });
    seedConnectionsRegion({ connections: [CONN] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("shows the picker and hides the connection's own password fields", async () => {
    renderEditor();
    await flush();

    expect(query("named-credential-picker")).not.toBeNull();
    expect(query("named-credential-select")?.textContent).toContain("Bastion");
    expect(query("field-password")).toBeNull();
    expect(query("field-savePassword")).toBeNull();
  });

  it("keeps the reference through a later schema-field edit and save", async () => {
    renderEditor();
    await flush();

    const shell = query("field-shell") as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(shell, "/bin/zsh");
      shell.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();

    act(() => {
      (query("connection-editor-save") as HTMLButtonElement).click();
    });
    await flush();

    const saveCall = mockedInvoke.mock.calls.find(([cmd]) => cmd === "save_connection");
    const persisted = (saveCall?.[1] as { connection: SavedConnection }).connection;
    const cfg = persisted.config.config as Record<string, unknown>;
    expect(cfg.shell).toBe("/bin/zsh");
    expect(cfg.credentialRef).toBe("nc-pw");
  });

  it("Save & Connect uses the shared secret without prompting", async () => {
    renderEditor();
    await flush();

    await act(async () => {
      (query("connection-editor-save-connect") as HTMLButtonElement).click();
    });
    await flush();

    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
    expect(mockedInvoke).toHaveBeenCalledWith("resolve_named_credential", {
      id: "nc-pw",
      credentialType: "password",
    });
    expect(mockedInvoke.mock.calls.some(([cmd]) => cmd === "resolve_credential")).toBe(false);
  });
});
