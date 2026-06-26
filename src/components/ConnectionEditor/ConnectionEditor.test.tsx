import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import React from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { resetRuntimeCache } from "@/hooks/useAvailableRuntimes";
import { ConnectionEditor } from "./ConnectionEditor";
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
      connections: [SSH_CONN_PASSWORD, SSH_CONN_KEY],
      connectionTypes: [SSH_TYPE_FULL],
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });
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

  it("prompts for the key passphrase on key auth when none is stored (#879)", async () => {
    // SSH_CONN_KEY uses key auth with savePassword=true. The password field is
    // hidden for key auth, so findPasswordPromptInfo returns null — but a
    // passphrase-protected key still needs a passphrase prompt. Previously Save
    // & Connect silently skipped it and the backend failed to unlock the key.
    mockedInvoke.mockImplementation((cmd) => {
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

  /** Click Save & Connect, then answer the password prompt with the given save flag. */
  async function saveConnectThenAnswerPrompt(connId: string, save: boolean): Promise<void> {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "resolve_credential") return Promise.resolve(null);
      if (cmd === "save_connection") return Promise.resolve("ssh-pw-conn");
      if (cmd === "store_credential") return Promise.resolve(null);
      if (cmd === "load_connections_and_folders")
        return Promise.resolve({ connections: [SSH_CONN_PASSWORD, SSH_CONN_KEY], folders: [] });
      return Promise.resolve(null);
    });

    renderFor(connId);
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
      useAppStore.getState().submitPassword("typed-secret", save);
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("stores the entered password when the prompt's Save box is checked (#874)", async () => {
    await saveConnectThenAnswerPrompt(SSH_CONN_PASSWORD.id, true);

    const storeCalls = mockedInvoke.mock.calls.filter((c) => c[0] === "store_credential");
    expect(storeCalls).toHaveLength(1);
    expect(storeCalls[0][1]).toMatchObject({
      connectionId: "ssh-pw-conn",
      credentialType: "password",
      value: "typed-secret",
    });
  });

  it("does not store the password when the prompt's Save box is unchecked (#874)", async () => {
    await saveConnectThenAnswerPrompt(SSH_CONN_PASSWORD.id, false);

    const storeCalls = mockedInvoke.mock.calls.filter((c) => c[0] === "store_credential");
    expect(storeCalls).toHaveLength(0);
  });

  /** Click Save & Connect on a key-auth connection, then answer the passphrase prompt. */
  async function saveConnectKeyThenAnswerPrompt(save: boolean): Promise<void> {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "resolve_credential") return Promise.resolve(null);
      if (cmd === "save_connection") return Promise.resolve("ssh-key-conn");
      if (cmd === "store_credential") return Promise.resolve(null);
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

    expect(useAppStore.getState().passwordPromptOpen).toBe(true);
    await act(async () => {
      useAppStore.getState().submitPassword("typed-passphrase", save);
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("stores the entered passphrase as key_passphrase when Save is checked (#879)", async () => {
    await saveConnectKeyThenAnswerPrompt(true);

    const storeCalls = mockedInvoke.mock.calls.filter((c) => c[0] === "store_credential");
    expect(storeCalls).toHaveLength(1);
    expect(storeCalls[0][1]).toMatchObject({
      connectionId: "ssh-key-conn",
      credentialType: "key_passphrase",
      value: "typed-passphrase",
    });
  });

  it("does not store the passphrase when Save is unchecked (#879)", async () => {
    await saveConnectKeyThenAnswerPrompt(false);

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
      connections: [],
      connectionTypes: [NAME_LOCAL_TYPE],
      remoteAgents: [makeAgent({ name: "Shared Name" })],
    });

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
      connections: [
        {
          id: "existing-1",
          name: "Duplicate",
          config: { type: "local", config: { shell: "bash" } },
          folderId: null,
        },
      ],
      connectionTypes: [NAME_LOCAL_TYPE],
      remoteAgents: [],
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
      connections: [
        {
          id: "existing-other-folder",
          name: "Shared Name",
          config: { type: "local", config: { shell: "bash" } },
          folderId: "folder-A",
        },
      ],
      connectionTypes: [NAME_LOCAL_TYPE],
      remoteAgents: [],
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
      connections: [
        {
          id: "existing-conn",
          name: "Shared Name",
          config: { type: "local", config: { shell: "bash" } },
          folderId: null,
        },
      ],
      connectionTypes: [NAME_LOCAL_TYPE],
      remoteAgents: [],
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
      connections: [],
      connectionTypes: [NAME_LOCAL_TYPE],
      remoteAgents: [makeAgent({ id: "agent-existing", name: "Duplicate Agent" })],
    });

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
      connections: [
        {
          id: "existing-conn",
          name: "Shared Name",
          config: { type: "local", config: { shell: "bash" } },
          folderId: null,
        },
      ],
      connectionTypes: [NAME_LOCAL_TYPE],
      remoteAgents: [agent],
      agentDefinitions: { [agent.id]: [] },
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
      connections: [],
      connectionTypes: [NAME_LOCAL_TYPE],
      remoteAgents: [agent],
      agentDefinitions: { [agent.id]: [existingDef] },
    });

    renderAgentDefinition(agent.id);
    await flush();

    await act(async () => {
      changeNameInput("Duplicate Def");
    });

    expect(nameErrorText()).toMatch(/definition with this name already exists/i);
  });
});
