import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { flushMacrotask } from "@/test/flushAsync";
import React from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { currentConnectionsView } from "@/store/connectionsBridge";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { resetRuntimeCache } from "@/hooks/useAvailableRuntimes";
import { ConnectionEditor } from "./ConnectionEditor";
import { TooltipProvider, toast } from "@/components/ui";

// Partial-mock the toast surface so Save & Connect feedback can be asserted
// without a real Sonner portal. Other ui exports (TooltipProvider, Button, …)
// keep their real implementations.
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
import type { ConnectionTypeInfo } from "@/types/connection";
import type { SavedConnection, RemoteAgentDefinition } from "@/types/connection";
import { DEFAULT_AGENT_SETTINGS } from "@/types/connection";
import type { AgentDefinitionInfo } from "@/services/api";

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

setupSettingsRegion();
setupConnectionsRegion();
setupAgentsRegion();

describe("ConnectionEditor — credential hint", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetRuntimeCache();
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [SSH_TYPE],
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });
    seedConnectionsRegion({ connections: [EXISTING_CONN] });

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
// Realistic SSH type with authMethod selector and conditional password field.
// Used for Save & Connect credential-store tests.
// ---------------------------------------------------------------------------

const SSH_TYPE_FULL: ConnectionTypeInfo = {
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
                { value: "agent", label: "Agent" },
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
        ],
      },
    ],
  },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: false },
};

/** Existing SSH connection — password auth, savePassword=true, password stripped from storage. */
const SSH_CONN_PASSWORD: SavedConnection = {
  id: "ssh-pw-conn",
  name: "My SSH Server",
  config: {
    type: "ssh",
    config: { host: "192.168.1.1", username: "admin", authMethod: "password", savePassword: true },
  },
  folderId: null,
};

/** Existing SSH connection — key auth, savePassword=true (passphrase stored). */
const SSH_CONN_KEY: SavedConnection = {
  id: "ssh-key-conn",
  name: "My Key SSH",
  config: {
    type: "ssh",
    config: { host: "192.168.1.2", username: "admin", authMethod: "key", savePassword: true },
  },
  folderId: null,
};

describe("ConnectionEditor — Save & Connect credential handling", () => {
  function renderFor(connId: string) {
    act(() => {
      root.render(
        <ConnectionEditor
          tabId="tab-sc-1"
          meta={{ connectionId: connId, folderId: null }}
          isVisible={true}
        />
      );
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetRuntimeCache();
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [SSH_TYPE_FULL],
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });
    seedConnectionsRegion({ connections: [SSH_CONN_PASSWORD, SSH_CONN_KEY] });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("uses stored credential without prompting when password is already in the vault", async () => {
    // Regression: handleSaveAndConnect previously always prompted for the
    // password because connSettings.password is stripped from storage, even
    // when the vault already holds a valid credential. It must check the
    // store first and skip the dialog when a credential is found.
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "resolve_credential") return Promise.resolve("vault-secret");
      if (cmd === "save_connection") return Promise.resolve();
      if (cmd === "load_connections_and_folders")
        return Promise.resolve({ connections: [SSH_CONN_PASSWORD, SSH_CONN_KEY], folders: [] });
      return Promise.resolve(null);
    });

    renderFor(SSH_CONN_PASSWORD.id);

    // Flush initial effects (credential hint resolution, etc.)
    await act(async () => {
      await Promise.resolve();
    });

    const btn = container.querySelector(
      '[data-testid="connection-editor-save-connect"]'
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();

    await act(async () => {
      btn.click();
    });
    // Extra flush to let the async handleSaveAndConnect finish
    await act(async () => {
      await Promise.resolve();
    });

    // The password dialog must NOT have opened — the vault credential was used
    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
  });

  it("prompts for password when no stored credential exists", async () => {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "resolve_credential") return Promise.resolve(null);
      if (cmd === "save_connection") return Promise.resolve();
      if (cmd === "load_connections_and_folders")
        return Promise.resolve({ connections: [SSH_CONN_PASSWORD, SSH_CONN_KEY], folders: [] });
      return Promise.resolve(null);
    });

    renderFor(SSH_CONN_PASSWORD.id);

    await act(async () => {
      await Promise.resolve();
    });

    const btn = container.querySelector(
      '[data-testid="connection-editor-save-connect"]'
    ) as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // No stored credential → password dialog must appear
    expect(useAppStore.getState().passwordPromptOpen).toBe(true);
  });

  it("surfaces a recoverable state (no silent success) when the password prompt is cancelled", async () => {
    // #1344: handleSaveAndConnect previously returned silently when the user
    // dismissed the password prompt, so the async Button flashed success even
    // though nothing connected. It must instead surface a recoverable state
    // (toast) and never open a session / close the editor.
    const addTab = vi.fn();
    useAppStore.setState({
      requestPassword: vi.fn().mockResolvedValue(null), // user dismisses the prompt
      addTab,
    });
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "resolve_credential") return Promise.resolve(null);
      if (cmd === "save_connection") return Promise.resolve();
      if (cmd === "load_connections_and_folders")
        return Promise.resolve({ connections: [SSH_CONN_PASSWORD, SSH_CONN_KEY], folders: [] });
      return Promise.resolve(null);
    });

    renderFor(SSH_CONN_PASSWORD.id);
    await act(async () => {
      await Promise.resolve();
    });

    const btn = container.querySelector(
      '[data-testid="connection-editor-save-connect"]'
    ) as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // No session was opened (connect aborted)…
    expect(addTab).not.toHaveBeenCalled();
    // …and the cancellation surfaced a recoverable state instead of silence.
    expect(toast.info).toHaveBeenCalled();
  });

  it("prompts to unlock the credential store before resolving when locked (G3, #1144)", async () => {
    // Regression: Save & Connect was the only connect path missing the
    // mode===master_password && status===locked unlock gate. With the store
    // locked it silently fell back to an interactive password prompt instead
    // of first offering to unlock and use the saved credential. It must now
    // call requestUnlock() before resolveCredential, matching the sidebar path.
    const mockRequestUnlock = vi.fn().mockResolvedValue(false); // user dismisses
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "locked" },
      requestUnlock: mockRequestUnlock,
    });
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "resolve_credential") return Promise.resolve("vault-secret");
      if (cmd === "save_connection") return Promise.resolve();
      if (cmd === "load_connections_and_folders")
        return Promise.resolve({ connections: [SSH_CONN_PASSWORD, SSH_CONN_KEY], folders: [] });
      return Promise.resolve(null);
    });

    renderFor(SSH_CONN_PASSWORD.id);
    await act(async () => {
      await Promise.resolve();
    });

    const btn = container.querySelector(
      '[data-testid="connection-editor-save-connect"]'
    ) as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // The unlock gate must fire on the locked store.
    expect(mockRequestUnlock).toHaveBeenCalledTimes(1);
    // Dismissed unlock aborts the connect — no interactive password prompt.
    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
  });

  it("prompts for the key passphrase on key auth when the key is encrypted (#879/#885)", async () => {
    // SSH_CONN_KEY uses key auth. The password field is hidden for key auth, so
    // findPasswordPromptInfo returns null — but a passphrase-protected key still
    // needs a passphrase prompt. The prompt now fires because the key is
    // encrypted (is_ssh_key_encrypted → true), independent of savePassword.
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "is_ssh_key_encrypted") return Promise.resolve(true);
      if (cmd === "resolve_credential") return Promise.resolve(null);
      if (cmd === "save_connection") return Promise.resolve();
      if (cmd === "load_connections_and_folders")
        return Promise.resolve({ connections: [SSH_CONN_PASSWORD, SSH_CONN_KEY], folders: [] });
      return Promise.resolve(null);
    });

    renderFor(SSH_CONN_KEY.id);

    await act(async () => {
      await Promise.resolve();
    });

    const btn = container.querySelector(
      '[data-testid="connection-editor-save-connect"]'
    ) as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Key auth with no stored passphrase → passphrase dialog must appear
    expect(useAppStore.getState().passwordPromptOpen).toBe(true);
  });

  it("does not prompt for key auth when a passphrase is already stored (#879)", async () => {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "is_ssh_key_encrypted") return Promise.resolve(true);
      if (cmd === "resolve_credential") return Promise.resolve("stored-passphrase");
      if (cmd === "save_connection") return Promise.resolve();
      if (cmd === "load_connections_and_folders")
        return Promise.resolve({ connections: [SSH_CONN_PASSWORD, SSH_CONN_KEY], folders: [] });
      return Promise.resolve(null);
    });

    renderFor(SSH_CONN_KEY.id);

    await act(async () => {
      await Promise.resolve();
    });

    const btn = container.querySelector(
      '[data-testid="connection-editor-save-connect"]'
    ) as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Stored passphrase resolves → no prompt
    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
  });

  it("does not prompt for an unencrypted key even when savePassword is on (#885)", async () => {
    // SSH_CONN_KEY has savePassword=true, but the key is unencrypted, so no
    // passphrase is needed — the prompt must not appear (no spurious prompt).
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "is_ssh_key_encrypted") return Promise.resolve(false);
      if (cmd === "resolve_credential") return Promise.resolve(null);
      if (cmd === "save_connection") return Promise.resolve();
      if (cmd === "load_connections_and_folders")
        return Promise.resolve({ connections: [SSH_CONN_PASSWORD, SSH_CONN_KEY], folders: [] });
      return Promise.resolve(null);
    });

    renderFor(SSH_CONN_KEY.id);
    await act(async () => {
      await Promise.resolve();
    });
    const btn = container.querySelector(
      '[data-testid="connection-editor-save-connect"]'
    ) as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
  });

  /**
   * Click Save & Connect, then answer the credential prompt with the given save
   * flag. Parameterized over the connection (password vs key auth), the id the
   * save backend returns, and the secret typed into the prompt.
   */
  async function saveConnectThenAnswerPrompt(opts: {
    connId: string;
    persistedId: string;
    secret: string;
    save: boolean;
  }): Promise<void> {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "is_ssh_key_encrypted") return Promise.resolve(true);
      if (cmd === "resolve_credential") return Promise.resolve(null);
      if (cmd === "save_connection") return Promise.resolve(opts.persistedId);
      if (cmd === "store_credential") return Promise.resolve(null);
      if (cmd === "load_connections_and_folders")
        return Promise.resolve({ connections: [SSH_CONN_PASSWORD, SSH_CONN_KEY], folders: [] });
      return Promise.resolve(null);
    });

    renderFor(opts.connId);
    await act(async () => {
      await Promise.resolve();
    });
    const btn = container.querySelector(
      '[data-testid="connection-editor-save-connect"]'
    ) as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(useAppStore.getState().passwordPromptOpen).toBe(true);
    await act(async () => {
      useAppStore.getState().submitPassword(opts.secret, opts.save);
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("stores the entered password when the prompt's Save box is checked (#874)", async () => {
    await saveConnectThenAnswerPrompt({
      connId: SSH_CONN_PASSWORD.id,
      persistedId: "ssh-pw-conn",
      secret: "typed-secret",
      save: true,
    });

    const storeCalls = mockedInvoke.mock.calls.filter((c) => c[0] === "store_credential");
    expect(storeCalls).toHaveLength(1);
    expect(storeCalls[0][1]).toMatchObject({
      connectionId: "ssh-pw-conn",
      credentialType: "password",
      value: "typed-secret",
    });
  });

  it("does not store the password when the prompt's Save box is unchecked (#874)", async () => {
    await saveConnectThenAnswerPrompt({
      connId: SSH_CONN_PASSWORD.id,
      persistedId: "ssh-pw-conn",
      secret: "typed-secret",
      save: false,
    });

    const storeCalls = mockedInvoke.mock.calls.filter((c) => c[0] === "store_credential");
    expect(storeCalls).toHaveLength(0);
  });

  it("stores the entered passphrase as key_passphrase when Save is checked (#879)", async () => {
    await saveConnectThenAnswerPrompt({
      connId: SSH_CONN_KEY.id,
      persistedId: "ssh-key-conn",
      secret: "typed-passphrase",
      save: true,
    });

    const storeCalls = mockedInvoke.mock.calls.filter((c) => c[0] === "store_credential");
    expect(storeCalls).toHaveLength(1);
    expect(storeCalls[0][1]).toMatchObject({
      connectionId: "ssh-key-conn",
      credentialType: "key_passphrase",
      value: "typed-passphrase",
    });
  });

  it("does not store the passphrase when Save is unchecked (#879)", async () => {
    await saveConnectThenAnswerPrompt({
      connId: SSH_CONN_KEY.id,
      persistedId: "ssh-key-conn",
      secret: "typed-passphrase",
      save: false,
    });

    const storeCalls = mockedInvoke.mock.calls.filter((c) => c[0] === "store_credential");
    expect(storeCalls).toHaveLength(0);
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
      connectionTypes: [LOCAL_TYPE],
    });
    seedConnectionsRegion({ connections: [DIRTY_CONN] });
    renderEditor(DIRTY_CONN.id);
    await flushEffects();

    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBeFalsy();
  });

  it("does not mark tab dirty in StrictMode when opening an existing connection without changes", async () => {
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [LOCAL_TYPE],
    });
    seedConnectionsRegion({ connections: [DIRTY_CONN] });
    renderEditor(DIRTY_CONN.id, true);
    await flushEffects();

    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBeFalsy();
  });

  it("does not mark tab dirty when opening a new connection with default values without changes", async () => {
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [LOCAL_TYPE],
    });
    seedConnectionsRegion({ connections: [] });
    renderEditor("new");
    await flushEffects();

    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBeFalsy();
  });

  it("does not mark tab dirty in StrictMode when opening a new connection with default values", async () => {
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [LOCAL_TYPE],
    });
    seedConnectionsRegion({ connections: [] });
    renderEditor("new", true);
    await flushEffects();

    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBeFalsy();
  });

  it("marks tab dirty when user changes the connection name", async () => {
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [LOCAL_TYPE],
    });
    seedConnectionsRegion({ connections: [DIRTY_CONN] });
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
      connectionTypes: [LOCAL_TYPE],
    });
    seedConnectionsRegion({ connections: [DIRTY_CONN] });
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
      connectionTypes: [LOCAL_TYPE_WITH_DEFAULTS],
    });
    seedConnectionsRegion({ connections: [CONN_WITHOUT_EXPLICIT_DEFAULTS] });
    renderEditor(CONN_WITHOUT_EXPLICIT_DEFAULTS.id);
    await flushEffects();

    // Toggle shows as on because the schema default is true (Radix Switch:
    // read `aria-checked` rather than a native checkbox `.checked`).
    const toggle = container.querySelector(
      '[data-testid="field-shellIntegration"]'
    ) as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    // Toggle off → dirty
    await act(async () => {
      toggle.click();
    });
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(true);

    // Toggle back on (schema default) → clean
    await act(async () => {
      toggle.click();
    });
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mode-aware name conflict validation
//
// Regression: the editor previously checked the name against BOTH the
// `connections` list AND the `remoteAgents` list regardless of which kind of
// entity was being edited. This produced spurious "remote agent with this
// name already exists" errors when creating a local connection whose name
// happened to match an unrelated agent. Connections and agents live in
// separate namespaces and must be validated independently.
// ---------------------------------------------------------------------------

const NAME_LOCAL_TYPE: ConnectionTypeInfo = {
  typeId: "local",
  displayName: "Local Shell",
  icon: "local",
  schema: {
    groups: [
      {
        key: "general",
        label: "General",
        fields: [{ key: "shell", label: "Shell", fieldType: { type: "text" }, required: false }],
      },
    ],
  },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: false },
};

function makeAgent(overrides: Partial<RemoteAgentDefinition> = {}): RemoteAgentDefinition {
  return {
    id: "agent-1",
    name: "Production Server",
    config: {
      host: "host.example.com",
      port: 22,
      username: "user",
      authMethod: "password",
    },
    connectionState: "connected",
    isExpanded: true,
    agentSettings: DEFAULT_AGENT_SETTINGS,
    capabilities: {
      connectionTypes: [
        {
          typeId: "shell",
          displayName: "Shell",
          icon: "shell",
          schema: {
            groups: [
              {
                key: "general",
                label: "General",
                fields: [
                  { key: "shell", label: "Shell", fieldType: { type: "text" }, required: false },
                ],
              },
            ],
          },
          capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: true },
        },
      ],
      maxSessions: 10,
      availableShells: ["bash"],
      availableSerialPorts: [],
      availableDockerImages: [],
    },
    ...overrides,
  };
}

function changeNameInput(value: string): void {
  const input = container.querySelector(
    '[data-testid="connection-editor-name-input"]'
  ) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function nameErrorText(): string | null {
  return (
    container.querySelector('[data-testid="connection-editor-name-error"]')?.textContent ?? null
  );
}

describe("ConnectionEditor — name conflict validation namespaces", () => {
  const TAB_ID = "tab-name-1";

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

  function renderLocal(connectionId: string, folderId: string | null = null) {
    act(() => {
      root.render(
        <ConnectionEditor tabId={TAB_ID} meta={{ connectionId, folderId }} isVisible={true} />
      );
    });
  }

  function renderAgentDefinition(agentId: string) {
    act(() => {
      root.render(
        <ConnectionEditor
          tabId={TAB_ID}
          meta={{ connectionId: agentId, folderId: null, agentDefinitionId: "new" }}
          isVisible={true}
        />
      );
    });
  }

  async function flush() {
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("does NOT flag a new connection whose name matches a remote agent (separate namespaces)", async () => {
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [NAME_LOCAL_TYPE],
    });
    seedAgentsRegion({ remoteAgents: [makeAgent({ name: "Shared Name" })] });
    seedConnectionsRegion({ connections: [] });

    renderLocal("new");
    await flush();

    await act(async () => {
      changeNameInput("Shared Name");
    });

    expect(nameErrorText()).toBeNull();
  });

  it("still flags a new connection that duplicates another connection in the same folder", async () => {
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [NAME_LOCAL_TYPE],
    });
    seedConnectionsRegion({
      connections: [
        {
          id: "existing-1",
          name: "Duplicate",
          config: { type: "local", config: { shell: "bash" } },
          folderId: null,
        },
      ],
    });

    renderLocal("new");
    await flush();

    await act(async () => {
      changeNameInput("Duplicate");
    });

    expect(nameErrorText()).toMatch(/connection with this name already exists/i);
  });

  it("does NOT flag a new connection that duplicates a connection in a DIFFERENT folder", async () => {
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [NAME_LOCAL_TYPE],
    });
    seedConnectionsRegion({
      connections: [
        {
          id: "existing-other-folder",
          name: "Shared Name",
          config: { type: "local", config: { shell: "bash" } },
          folderId: "folder-A",
        },
      ],
    });

    renderLocal("new", "folder-B");
    await flush();

    await act(async () => {
      changeNameInput("Shared Name");
    });

    expect(nameErrorText()).toBeNull();
  });

  it("does NOT flag a new remote agent whose name matches a local connection", async () => {
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [NAME_LOCAL_TYPE],
    });
    seedConnectionsRegion({
      connections: [
        {
          id: "existing-conn",
          name: "Shared Name",
          config: { type: "local", config: { shell: "bash" } },
          folderId: null,
        },
      ],
    });

    renderLocal("new-remote-agent");
    await flush();

    await act(async () => {
      changeNameInput("Shared Name");
    });

    expect(nameErrorText()).toBeNull();
  });

  it("still flags a new remote agent that duplicates another agent's name", async () => {
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [NAME_LOCAL_TYPE],
    });
    seedAgentsRegion({
      remoteAgents: [makeAgent({ id: "agent-existing", name: "Duplicate Agent" })],
    });
    seedConnectionsRegion({ connections: [] });

    renderLocal("new-remote-agent");
    await flush();

    await act(async () => {
      changeNameInput("Duplicate Agent");
    });

    expect(nameErrorText()).toMatch(/remote agent with this name already exists/i);
  });

  it("does NOT flag an agent definition whose name matches a local connection", async () => {
    const agent = makeAgent({ id: "agent-with-defs" });
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [NAME_LOCAL_TYPE],
    });
    seedAgentsRegion({ remoteAgents: [agent], agentDefinitions: { [agent.id]: [] } });
    seedConnectionsRegion({
      connections: [
        {
          id: "existing-conn",
          name: "Shared Name",
          config: { type: "local", config: { shell: "bash" } },
          folderId: null,
        },
      ],
    });

    renderAgentDefinition(agent.id);
    await flush();

    await act(async () => {
      changeNameInput("Shared Name");
    });

    expect(nameErrorText()).toBeNull();
  });

  it("flags an agent definition that duplicates another definition on the same agent", async () => {
    const agent = makeAgent({ id: "agent-with-defs" });
    const existingDef: AgentDefinitionInfo = {
      id: "def-1",
      name: "Duplicate Def",
      sessionType: "shell",
      config: { shell: "bash" },
      persistent: false,
      folderId: null,
    };
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [NAME_LOCAL_TYPE],
    });
    seedAgentsRegion({ remoteAgents: [agent], agentDefinitions: { [agent.id]: [existingDef] } });
    seedConnectionsRegion({ connections: [] });

    renderAgentDefinition(agent.id);
    await flush();

    await act(async () => {
      changeNameInput("Duplicate Def");
    });

    expect(nameErrorText()).toMatch(/definition with this name already exists/i);
  });
});

describe("ConnectionEditor — SSH Jump Host section", () => {
  let container: HTMLDivElement;
  let root: Root;

  function query(testId: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${testId}"]`);
  }

  function setValue(el: HTMLInputElement | HTMLSelectElement, value: string, event = "input") {
    const proto =
      el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    act(() => {
      setter?.call(el, value);
      el.dispatchEvent(new Event(event, { bubbles: true }));
    });
  }

  const flush = () =>
    act(async () => {
      await Promise.resolve();
    });

  function renderFor(connId: string) {
    act(() => {
      root.render(
        <TooltipProvider>
          <ConnectionEditor
            tabId="tab-jh-1"
            meta={{ connectionId: connId, folderId: null }}
            isVisible={true}
          />
        </TooltipProvider>
      );
    });
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetRuntimeCache();
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "save_connection") return Promise.resolve();
      if (cmd === "load_connections_and_folders")
        return Promise.resolve({ connections: [SSH_CONN_PASSWORD], folders: [] });
      return Promise.resolve(null);
    });
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [SSH_TYPE_FULL],
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });
    seedConnectionsRegion({ connections: [SSH_CONN_PASSWORD] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("renders the Jump Host section for an SSH connection", () => {
    renderFor(SSH_CONN_PASSWORD.id);
    expect(query("jump-host-section")).toBeTruthy();
    expect((query("jump-host-enabled") as HTMLInputElement).checked).toBe(false);
  });

  it("persists an inline jump host through save, surviving a later schema-field edit", async () => {
    renderFor(SSH_CONN_PASSWORD.id);
    await flush();

    // Enable the jump host and fill its required fields (host + username, so
    // validation passes and save is not blocked).
    act(() => {
      (query("jump-host-enabled") as HTMLInputElement).click();
    });
    setValue(query("jump-host-host-0") as HTMLInputElement, "bastion.example.com");
    setValue(query("jump-host-username-0") as HTMLInputElement, "jumper");
    await flush();

    // Toggle a schema field afterwards — this fires the schema form's onChange,
    // which must NOT drop the sibling proxyJump key.
    act(() => {
      (query("field-savePassword") as HTMLInputElement).click();
    });
    await flush();

    act(() => {
      (query("connection-editor-save") as HTMLButtonElement).click();
    });
    await flush();

    // Assert on the persisted payload (the post-save reload overwrites the store).
    const saveCall = mockedInvoke.mock.calls.find(([cmd]) => cmd === "save_connection");
    const persisted = (saveCall?.[1] as { connection: SavedConnection }).connection;
    const cfg = persisted.config.config as Record<string, unknown>;
    // The schema edit landed...
    expect(cfg.savePassword).toBe(false);
    // ...and the jump host configured before it survived the schema onChange.
    expect(cfg.proxyJump).toEqual([
      { host: "bastion.example.com", port: 22, username: "jumper", authMethod: "key" },
    ]);
  });

  it("renders the SSH Agent Forwarding toggle, off by default (#1699)", () => {
    renderFor(SSH_CONN_PASSWORD.id);
    expect(query("ssh-agent-forwarding-section")).toBeTruthy();
    expect(query("connection-editor-forward-agent")?.getAttribute("aria-checked")).toBe("false");
  });

  it("persists forwardAgent through save, surviving a later schema-field edit (#1699)", async () => {
    renderFor(SSH_CONN_PASSWORD.id);
    await flush();

    // Turn on agent forwarding.
    act(() => {
      (query("connection-editor-forward-agent") as HTMLElement).click();
    });
    await flush();

    // Toggle a schema field afterwards — fires the schema form's onChange, which
    // must NOT drop the sibling forwardAgent key.
    act(() => {
      (query("field-savePassword") as HTMLInputElement).click();
    });
    await flush();

    act(() => {
      (query("connection-editor-save") as HTMLButtonElement).click();
    });
    await flush();

    const saveCall = mockedInvoke.mock.calls.find(([cmd]) => cmd === "save_connection");
    const persisted = (saveCall?.[1] as { connection: SavedConnection }).connection;
    const cfg = persisted.config.config as Record<string, unknown>;
    // The schema edit landed, and the forwardAgent flag set before it survived.
    expect(cfg.savePassword).toBe(false);
    expect(cfg.forwardAgent).toBe(true);
  });

  it("omits forwardAgent from saved settings when left off (#1699)", async () => {
    renderFor(SSH_CONN_PASSWORD.id);
    await flush();

    // Make a change so save is enabled, without touching agent forwarding.
    act(() => {
      (query("field-savePassword") as HTMLInputElement).click();
    });
    await flush();

    act(() => {
      (query("connection-editor-save") as HTMLButtonElement).click();
    });
    await flush();

    const saveCall = mockedInvoke.mock.calls.find(([cmd]) => cmd === "save_connection");
    const persisted = (saveCall?.[1] as { connection: SavedConnection }).connection;
    const cfg = persisted.config.config as Record<string, unknown>;
    // Off means the key is absent, keeping saved JSON stable for existing connections.
    expect(cfg.forwardAgent).toBeUndefined();
  });

  it("blocks save while a jump host is missing required fields", async () => {
    renderFor(SSH_CONN_PASSWORD.id);
    await flush();

    // Enable the jump host but leave host/username empty → invalid.
    act(() => {
      (query("jump-host-enabled") as HTMLInputElement).click();
    });
    await flush();

    expect(query("jump-host-errors")).toBeTruthy();

    act(() => {
      (query("connection-editor-save") as HTMLButtonElement).click();
    });
    await flush();

    // Save was prevented: no save_connection invoke.
    const saveCall = mockedInvoke.mock.calls.find(([cmd]) => cmd === "save_connection");
    expect(saveCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// "Setup SSH Agent" helper button (#955)
//
// The button must surface in the editor when SSH + agent auth is selected, be
// hidden for other auth methods, and open a "Setup SSH Agent" local tab that
// runs the agent-setup helper command.
// ---------------------------------------------------------------------------

/** Existing SSH connection — agent auth. */
const SSH_CONN_AGENT: SavedConnection = {
  id: "ssh-agent-conn",
  name: "My Agent SSH",
  config: {
    type: "ssh",
    config: { host: "192.168.1.3", username: "admin", authMethod: "agent" },
  },
  folderId: null,
};

describe("ConnectionEditor — Setup SSH Agent button", () => {
  function query(testId: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${testId}"]`);
  }

  const flush = () =>
    act(async () => {
      await Promise.resolve();
    });

  function renderFor(connId: string) {
    act(() => {
      root.render(
        <ConnectionEditor
          tabId="tab-agent-1"
          meta={{ connectionId: connId, folderId: null }}
          isVisible={true}
        />
      );
    });
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetRuntimeCache();
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "list_available_shells") return Promise.resolve(["zsh"]);
      return Promise.resolve(null);
    });
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [SSH_TYPE_FULL],
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });
    seedConnectionsRegion({ connections: [SSH_CONN_AGENT, SSH_CONN_PASSWORD, SSH_CONN_KEY] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("shows the Setup SSH Agent button for agent auth", () => {
    renderFor(SSH_CONN_AGENT.id);
    expect(query("ssh-setup-agent")).toBeTruthy();
  });

  it("hides the Setup SSH Agent button for non-agent auth", () => {
    renderFor(SSH_CONN_PASSWORD.id);
    expect(query("ssh-setup-agent")).toBeNull();
  });

  it("opens a 'Setup SSH Agent' local tab when clicked", async () => {
    const addTabSpy = vi.fn();
    useAppStore.setState({ addTab: addTabSpy });

    renderFor(SSH_CONN_AGENT.id);
    await flush();

    act(() => {
      (query("ssh-setup-agent") as HTMLButtonElement).click();
    });
    await flush();

    expect(addTabSpy).toHaveBeenCalledTimes(1);
    const [title, type, payload] = addTabSpy.mock.calls[0];
    expect(title).toBe("Setup SSH Agent");
    expect(type).toBe("local");
    expect((payload as { config: { initialCommand: string } }).config.initialCommand).toContain(
      "ssh-add"
    );
  });
});

// ---------------------------------------------------------------------------
// Storage-file picker — Radix Select forbids empty-string item values (#1105).
// The "Default (connections.json)" option must use a non-empty sentinel value
// that maps back to `null` (the default storage file) at the call site.
// ---------------------------------------------------------------------------

describe("ConnectionEditor — storage-file picker (#1105)", () => {
  function renderFor(connId: string) {
    act(() => {
      root.render(
        <ConnectionEditor
          tabId="tab-sf-1"
          meta={{ connectionId: connId, folderId: null }}
          isVisible={true}
        />
      );
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetRuntimeCache();
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [SSH_TYPE],
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });
    seedConnectionsRegion({ connections: [EXISTING_CONN] });
    // At least one enabled external file makes the storage-file picker render.
    seedSettings({ externalConnectionFiles: [{ path: "/tmp/team.json", enabled: true }] });
    mockedInvoke.mockImplementation(() => Promise.resolve(false));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the storage-file picker when an external file is enabled", () => {
    renderFor(CONN_ID);
    const select = container.querySelector('[data-testid="connection-editor-source-file"]');
    expect(select).not.toBeNull();
  });

  it("uses a non-empty sentinel value for the default option (Radix rejects empty string)", () => {
    // Regression: the default option previously used value="" and the select's
    // value fell back to "" when no source file was chosen. Radix Select forbids
    // empty-string item values, so the default must resolve to a non-empty
    // sentinel. EXISTING_CONN has no sourceFile, so this is the default case.
    renderFor(CONN_ID);
    const trigger = container.querySelector(
      '[data-testid="connection-editor-source-file"]'
    ) as HTMLElement | null;
    expect(trigger).not.toBeNull();
    // The trigger mirrors the controlled Select value via data-value.
    expect(trigger?.getAttribute("data-value")).not.toBe("");
    expect(trigger?.getAttribute("data-value")).toBeTruthy();
  });
});

/** Local connection type with a required host field, to exercise Save gating. */
const LOCAL_REQ_TYPE: ConnectionTypeInfo = {
  typeId: "local",
  displayName: "Local",
  icon: "local",
  schema: {
    groups: [
      {
        key: "connection",
        label: "Connection",
        fields: [{ key: "host", label: "Host", fieldType: { type: "text" }, required: true }],
      },
    ],
  },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: false },
};

describe("ConnectionEditor — Save gating on invalid input (#1357)", () => {
  function setValue(el: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function flush() {
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve();
      await flushMacrotask();
    });
  }

  function renderNew() {
    act(() => {
      root.render(
        <TooltipProvider>
          <ConnectionEditor
            tabId="tab-gate-1"
            meta={{ connectionId: "new", folderId: null }}
            isVisible={true}
          />
        </TooltipProvider>
      );
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetRuntimeCache();
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [LOCAL_REQ_TYPE],
      credentialStoreStatus: { mode: "none", status: "unlocked" },
    });
    seedConnectionsRegion({ connections: [] });
    mockedInvoke.mockImplementation(() => Promise.resolve(false));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("does not save a new connection while name and a required field are empty", async () => {
    renderNew();
    await flush();

    const saveBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="connection-editor-save"]'
    )!;
    await act(async () => saveBtn.click());
    await flush();

    expect(currentConnectionsView().connections).toHaveLength(0);
  });

  it("saves once the name and required field are filled", async () => {
    renderNew();
    await flush();

    const nameInput = container.querySelector<HTMLInputElement>(
      '[data-testid="connection-editor-name-input"]'
    )!;
    await act(async () => setValue(nameInput, "My Host"));
    const hostInput = container.querySelector<HTMLInputElement>('[data-testid="field-host"]')!;
    await act(async () => setValue(hostInput, "example.com"));
    await flush();

    const saveBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="connection-editor-save"]'
    )!;
    await act(async () => saveBtn.click());
    await flush();

    const conns = currentConnectionsView().connections;
    expect(conns).toHaveLength(1);
    expect(conns[0].name).toBe("My Host");
  });
});
