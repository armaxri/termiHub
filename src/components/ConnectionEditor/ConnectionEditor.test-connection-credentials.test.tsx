/**
 * Test Connection credential resolution (#3284, UX-007 follow-up).
 *
 * Test probes a connection without saving it. When the live form does not carry
 * the secret (a stored-vault password, or a passphrase-protected key), Test must
 * resolve it the same way Save & Connect does — stored credential first, else a
 * prompt — but in a non-persisting mode: it never saves the connection, never
 * stores the secret, never opens a tab, and never writes the secret into the
 * form. A dismissed prompt cancels the test cleanly with no auth-failure toast.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { currentConnectionsView } from "@/store/connectionsBridge";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { resetRuntimeCache } from "@/hooks/useAvailableRuntimes";
import { ConnectionEditor } from "./ConnectionEditor";
import { TooltipProvider } from "@/components/ui";
import type { ConnectionTypeInfo, SavedConnection } from "@/types/connection";

const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastInfo = vi.fn();

vi.mock("@/components/ui/Toast", async () => {
  const actual =
    await vi.importActual<typeof import("@/components/ui/Toast")>("@/components/ui/Toast");
  return {
    ...actual,
    toast: {
      success: (...args: unknown[]) => toastSuccess(...args),
      error: (...args: unknown[]) => toastError(...args),
      info: (...args: unknown[]) => toastInfo(...args),
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
            key: "keyPath",
            label: "Key",
            fieldType: { type: "text" },
            required: false,
            visibleWhen: { field: "authMethod", equals: "key" },
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

/** Saved password-auth connection whose password lives only in the vault. */
const CONN_STORED_PW: SavedConnection = {
  id: "ssh-pw",
  name: "Vault Server",
  config: {
    type: "ssh",
    config: { host: "10.0.0.1", username: "admin", authMethod: "password", savePassword: true },
  },
  folderId: null,
};

/** Saved key-auth connection with an (encrypted) key and no saved passphrase. */
const CONN_KEY: SavedConnection = {
  id: "ssh-key",
  name: "Key Server",
  config: {
    type: "ssh",
    config: {
      host: "10.0.0.2",
      username: "admin",
      authMethod: "key",
      keyPath: "/home/a/.ssh/id_enc",
      savePassword: false,
    },
  },
  folderId: null,
};

/** Saved password-auth connection with the password carried in the config. */
const CONN_TYPED_PW: SavedConnection = {
  id: "ssh-typed",
  name: "Typed Server",
  config: {
    type: "ssh",
    config: { host: "10.0.0.3", username: "admin", authMethod: "password", password: "typed" },
  },
  folderId: null,
};

let container: HTMLDivElement;
let root: Root;
type AppState = ReturnType<typeof useAppStore.getState>;
let requestPassword: ReturnType<typeof vi.fn<AppState["requestPassword"]>>;
let addTab: ReturnType<typeof vi.fn<AppState["addTab"]>>;

function render(connectionId: string) {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <ConnectionEditor
          tabId="tab-test-cred"
          meta={{ connectionId, folderId: null }}
          isVisible={true}
        />
      </TooltipProvider>
    );
  });
}

function setInput(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector)!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Open the Radix type-select and return its rendered option elements. */
function openTypeOptions(): HTMLElement[] {
  const trigger = container.querySelector<HTMLElement>(
    '[data-testid="connection-editor-type-select"]'
  )!;
  for (let i = 0; i < 3 && document.querySelectorAll(".ui-select__item").length === 0; i++) {
    act(() => {
      trigger.focus();
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
      );
    });
  }
  return Array.from(document.querySelectorAll<HTMLElement>(".ui-select__item"));
}

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function clickTest() {
  const btn = container.querySelector<HTMLButtonElement>('[data-testid="connection-editor-test"]')!;
  act(() => {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

function commandCalls(cmd: string) {
  return mockedInvoke.mock.calls.filter((c) => c[0] === cmd);
}

function testedSettings(): Record<string, unknown> {
  const calls = commandCalls("test_connection");
  expect(calls).toHaveLength(1);
  return (calls[0][1] as { settings: Record<string, unknown> }).settings;
}

/** Nothing was persisted and no session was opened. */
function expectNothingPersisted() {
  expect(commandCalls("store_credential")).toHaveLength(0);
  expect(commandCalls("save_connection")).toHaveLength(0);
  expect(addTab).not.toHaveBeenCalled();
}

function mockBackend({
  stored = null,
  keyEncrypted = false,
}: {
  stored?: string | null;
  keyEncrypted?: boolean;
}) {
  mockedInvoke.mockImplementation((cmd) => {
    if (cmd === "resolve_credential") return Promise.resolve(stored);
    if (cmd === "is_ssh_key_encrypted") return Promise.resolve(keyEncrypted);
    return Promise.resolve(undefined);
  });
}

setupSettingsRegion();
setupConnectionsRegion();
setupAgentsRegion();

describe("ConnectionEditor — Test Connection credential resolution (#3284)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetRuntimeCache();
    requestPassword = vi.fn<AppState["requestPassword"]>();
    addTab = vi.fn<AppState["addTab"]>();
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [SSH_TYPE],
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
      requestPassword,
      addTab,
    });
    seedConnectionsRegion({ connections: [CONN_STORED_PW, CONN_KEY, CONN_TYPED_PW] });
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("uses the stored credential without prompting and persists nothing", async () => {
    mockBackend({ stored: "vault-secret" });
    render(CONN_STORED_PW.id);
    await flush();

    await clickTest();

    expect(requestPassword).not.toHaveBeenCalled();
    expect(commandCalls("resolve_credential")[0][1]).toMatchObject({
      connectionId: CONN_STORED_PW.id,
      credentialType: "password",
    });
    expect(testedSettings().password).toBe("vault-secret");
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
    expectNothingPersisted();
    // The secret must not leak into form state.
    const pw = container.querySelector<HTMLInputElement>('[data-testid="field-password"]');
    expect(pw?.value ?? "").toBe("");
  });

  it("prompts for a passphrase-protected key and never stores the entry", async () => {
    mockBackend({ keyEncrypted: true });
    requestPassword.mockImplementation(async () => {
      // Even with the prompt's "Save" box checked, Test must not store it.
      useAppStore.setState({ passwordPromptShouldSave: true });
      return "key-pass";
    });
    render(CONN_KEY.id);
    await flush();

    await clickTest();

    expect(requestPassword).toHaveBeenCalledWith("10.0.0.2", "admin", "", "key_passphrase");
    expect(testedSettings().password).toBe("key-pass");
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expectNothingPersisted();
  });

  it("prompts on an unsaved (new) connection without a vault lookup", async () => {
    mockBackend({ stored: "should-not-be-used" });
    requestPassword.mockResolvedValue("entered");
    render("new");
    await flush();
    const ssh = openTypeOptions().find((o) => o.getAttribute("data-value") === "ssh");
    expect(ssh).toBeTruthy();
    act(() => ssh!.click());
    await flush();
    setInput('[data-testid="connection-editor-name-input"]', "Brand New");
    setInput('[data-testid="field-host"]', "10.0.0.9");
    setInput('[data-testid="field-username"]', "root");
    await flush();

    await clickTest();

    expect(commandCalls("resolve_credential")).toHaveLength(0);
    expect(requestPassword).toHaveBeenCalledWith("10.0.0.9", "root", "", "password");
    expect(testedSettings().password).toBe("entered");
    expectNothingPersisted();
    expect(currentConnectionsView().connections).toHaveLength(3);
  });

  it("cancels cleanly when the prompt is dismissed — no probe, no auth-failure toast", async () => {
    mockBackend({ keyEncrypted: true });
    requestPassword.mockResolvedValue(null);
    render(CONN_KEY.id);
    await flush();

    await clickTest();

    expect(commandCalls("test_connection")).toHaveLength(0);
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledWith("Connection test canceled.");
    expectNothingPersisted();
  });

  it("cancels cleanly when the store unlock dialog is dismissed", async () => {
    mockBackend({ stored: "vault-secret" });
    const requestUnlock = vi.fn().mockResolvedValue(false);
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "locked" },
      requestUnlock,
    });
    render(CONN_STORED_PW.id);
    await flush();

    await clickTest();

    expect(requestUnlock).toHaveBeenCalled();
    expect(commandCalls("test_connection")).toHaveLength(0);
    expect(toastError).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledWith("Connection test canceled.");
    expectNothingPersisted();
  });

  it("leaves the typed-password path unchanged (no vault lookup, no prompt)", async () => {
    mockBackend({ stored: "vault-secret" });
    render(CONN_TYPED_PW.id);
    await flush();

    await clickTest();

    expect(commandCalls("resolve_credential")).toHaveLength(0);
    expect(requestPassword).not.toHaveBeenCalled();
    expect(testedSettings().password).toBe("typed");
    expectNothingPersisted();
  });
});
