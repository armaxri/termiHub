import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import React from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { resetRuntimeCache } from "@/hooks/useAvailableRuntimes";
import { ConnectionEditor } from "./ConnectionEditor";
import type { ConnectionTypeInfo } from "@/types/connection";
import type { SavedConnection } from "@/types/connection";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

// ResizeObserver is not available in jsdom
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const mockedInvoke = vi.mocked(invoke);

/** Minimal SSH connection type schema with password and savePassword fields. */
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
          {
            key: "password",
            label: "Password",
            fieldType: { type: "password" },
            required: false,
          },
          {
            key: "savePassword",
            label: "Save Password",
            fieldType: { type: "boolean" },
            required: false,
          },
        ],
      },
    ],
  },
  capabilities: {
    monitoring: false,
    fileBrowser: false,
    resize: true,
    persistent: false,
  },
};

const CONN_ID = "conn-test-123";

/** Existing SSH connection with savePassword=true but password stripped (as stored). */
const EXISTING_CONN: SavedConnection = {
  id: CONN_ID,
  name: "My SSH Server",
  config: {
    type: "ssh",
    config: {
      host: "192.168.1.1",
      username: "user",
      savePassword: true,
      // password is absent — stripped when saved to disk
    },
  },
  folderId: null,
};

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root.render(
      <ConnectionEditor
        tabId="tab-test-1"
        meta={{ connectionId: CONN_ID, folderId: null }}
        isVisible={true}
      />
    );
  });
}

describe("ConnectionEditor — credential hint", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetRuntimeCache();
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connections: [EXISTING_CONN],
      connectionTypes: [SSH_TYPE],
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });

    mockedInvoke.mockImplementation(() => Promise.resolve(false));
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("does not show 'Password saved' hint when resolve_credential returns null", async () => {
    // Regression: previously the hint appeared for any connection with savePassword=true,
    // even when no credential was actually stored. It must only appear after resolveCredential
    // confirms the credential exists.
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "resolve_credential") return Promise.resolve(null);
      return Promise.resolve(false);
    });

    render();

    // Flush the resolveCredential promise
    await act(async () => {
      await Promise.resolve();
    });

    const hint = container.querySelector('[data-testid="field-password-credential-saved"]');
    expect(hint).toBeNull();
  });

  it("shows 'Password saved' hint when resolve_credential returns a value", async () => {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "resolve_credential") return Promise.resolve("s3cr3t");
      return Promise.resolve(false);
    });

    render();

    await act(async () => {
      await Promise.resolve();
    });

    const hint = container.querySelector('[data-testid="field-password-credential-saved"]');
    expect(hint).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Minimal connection type used for dirty-state tests (no auth, no credentials)
// ---------------------------------------------------------------------------

const LOCAL_TYPE: ConnectionTypeInfo = {
  typeId: "local",
  displayName: "Local Shell",
  icon: "local",
  schema: {
    groups: [
      {
        key: "general",
        label: "General",
        fields: [
          {
            key: "shell",
            label: "Shell",
            fieldType: { type: "text" },
            required: false,
            default: "bash",
          },
        ],
      },
    ],
  },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: false },
};

const DIRTY_CONN: SavedConnection = {
  id: "conn-dirty-test",
  name: "Test Server",
  config: { type: "local", config: { shell: "bash" } },
  folderId: null,
};

describe("ConnectionEditor — unsaved-changes dirty state", () => {
  const TAB_ID = "tab-dirty-1";

  function renderEditor(connectionId: string, strictMode = false) {
    const editor = (
      <ConnectionEditor tabId={TAB_ID} meta={{ connectionId, folderId: null }} isVisible={true} />
    );
    act(() => {
      root.render(strictMode ? <React.StrictMode>{editor}</React.StrictMode> : editor);
    });
  }

  async function flushEffects() {
    await act(async () => {
      await Promise.resolve();
    });
  }

  /** Simulate a controlled text-input change the way React handles it. */
  function changeInput(input: HTMLInputElement, value: string): void {
    const nativeValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!;
    nativeValueSetter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetRuntimeCache();

    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "check_docker_available") return Promise.resolve(false);
      if (cmd === "check_podman_available") return Promise.resolve(false);
      if (cmd === "resolve_credential") return Promise.resolve(null);
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("does not mark tab dirty when opening an existing connection without changes", async () => {
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connections: [DIRTY_CONN],
      connectionTypes: [LOCAL_TYPE],
    });
    renderEditor(DIRTY_CONN.id);
    await flushEffects();

    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBeFalsy();
  });

  it("does not mark tab dirty in StrictMode when opening an existing connection without changes", async () => {
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connections: [DIRTY_CONN],
      connectionTypes: [LOCAL_TYPE],
    });
    renderEditor(DIRTY_CONN.id, true);
    await flushEffects();

    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBeFalsy();
  });

  it("does not mark tab dirty when opening a new connection with default values without changes", async () => {
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connections: [],
      connectionTypes: [LOCAL_TYPE],
    });
    renderEditor("new");
    await flushEffects();

    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBeFalsy();
  });

  it("does not mark tab dirty in StrictMode when opening a new connection with default values", async () => {
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connections: [],
      connectionTypes: [LOCAL_TYPE],
    });
    renderEditor("new", true);
    await flushEffects();

    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBeFalsy();
  });

  it("marks tab dirty when user changes the connection name", async () => {
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connections: [DIRTY_CONN],
      connectionTypes: [LOCAL_TYPE],
    });
    renderEditor(DIRTY_CONN.id);
    await flushEffects();

    const nameInput = container.querySelector(
      '[data-testid="connection-editor-name-input"]'
    ) as HTMLInputElement;
    expect(nameInput).not.toBeNull();

    await act(async () => {
      changeInput(nameInput, "Modified Name");
    });

    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(true);
  });

  it("clears dirty flag when name is changed back to its original value", async () => {
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connections: [DIRTY_CONN],
      connectionTypes: [LOCAL_TYPE],
    });
    renderEditor(DIRTY_CONN.id);
    await flushEffects();

    const nameInput = container.querySelector(
      '[data-testid="connection-editor-name-input"]'
    ) as HTMLInputElement;
    expect(nameInput).not.toBeNull();

    // Change name → dirty
    await act(async () => {
      changeInput(nameInput, "Modified Name");
    });
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(true);

    // Revert to original name → clean
    await act(async () => {
      changeInput(nameInput, DIRTY_CONN.name);
    });
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(false);
  });

  // A connection type where shellIntegration defaults to true but is NOT present in
  // the stored config — exactly the situation for connections created with an older
  // app version or where the default was never explicitly persisted.
  const LOCAL_TYPE_WITH_DEFAULTS: ConnectionTypeInfo = {
    typeId: "local",
    displayName: "Local Shell",
    icon: "local",
    schema: {
      groups: [
        {
          key: "general",
          label: "General",
          fields: [
            {
              key: "shellIntegration",
              label: "Shell Integration",
              fieldType: { type: "boolean" },
              required: false,
              default: true,
            },
          ],
        },
      ],
    },
    capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: false },
  };

  // Config deliberately omits shellIntegration — the schema default (true) is used
  // for display, but the key is absent from the stored object.
  const CONN_WITHOUT_EXPLICIT_DEFAULTS: SavedConnection = {
    id: "conn-default-test",
    name: "My Local Shell",
    config: { type: "local", config: {} },
    folderId: null,
  };

  it("clears dirty when a schema-defaulted boolean is toggled off then back to its default", async () => {
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connections: [CONN_WITHOUT_EXPLICIT_DEFAULTS],
      connectionTypes: [LOCAL_TYPE_WITH_DEFAULTS],
    });
    renderEditor(CONN_WITHOUT_EXPLICIT_DEFAULTS.id);
    await flushEffects();

    // Checkbox shows as checked because the schema default is true
    const checkbox = container.querySelector(
      '[data-testid="field-shellIntegration"]'
    ) as HTMLInputElement;
    expect(checkbox).not.toBeNull();
    expect(checkbox.checked).toBe(true);

    // Uncheck → dirty
    await act(async () => {
      checkbox.click();
    });
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(true);

    // Re-check (back to schema default) → clean
    await act(async () => {
      checkbox.click();
    });
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(false);
  });
});
