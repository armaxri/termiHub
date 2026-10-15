/**
 * Stored schema field secrets in the connection editor (#4431): an empty
 * password field whose secret is stored shows "saved" with a Clear control —
 * in the DynamicForm and in the jump-host hop editor. Only the names cross
 * from the backend; a cleared secret is removed on Save, and an empty field
 * without Clear keeps the stored value.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
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

const SSH_SCHEMA_FIELDS = [
  { key: "host", label: "Host", fieldType: { type: "text" }, required: true },
  { key: "port", label: "Port", fieldType: { type: "port" }, required: true, default: 22 },
  { key: "username", label: "Username", fieldType: { type: "text" }, required: false },
  {
    key: "authMethod",
    label: "Method",
    fieldType: {
      type: "select",
      options: [
        { value: "key", label: "SSH Key" },
        { value: "password", label: "Password" },
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
] as const;

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
          {
            key: "apiToken",
            label: "API Token",
            fieldType: { type: "password" },
            required: false,
          },
          { key: "pin", label: "PIN", fieldType: { type: "password" }, required: false },
        ],
      },
    ],
  },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: false },
};

const SSH_TYPE = {
  typeId: "ssh",
  displayName: "SSH",
  icon: "terminal",
  schema: { groups: [{ key: "connection", label: "Connection", fields: SSH_SCHEMA_FIELDS }] },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: false },
} as unknown as ConnectionTypeInfo;

/** Saved connection whose secrets live only in the credential store. */
const CONN: SavedConnection = {
  id: "tok-1",
  name: "Token Server",
  config: { type: "tokenized", config: { host: "10.0.0.9" } },
  folderId: null,
};

/** SSH connection through one inline password-auth hop. */
const HOP_CONN: SavedConnection = {
  id: "ssh-1",
  name: "Behind Bastion",
  config: {
    type: "ssh",
    config: {
      host: "10.0.0.5",
      port: 22,
      username: "me",
      authMethod: "key",
      proxyJump: [{ host: "bastion", port: 22, username: "ops", authMethod: "password" }],
    },
  },
  folderId: null,
};

let container: HTMLDivElement;
let root: Root;

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

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function clickButton(testId: string) {
  const btn = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!;
  act(() => {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

function commandCalls(cmd: string) {
  return mockedInvoke.mock.calls.filter((c) => c[0] === cmd);
}

function mockBackend(stored: { fields?: string[]; hops?: string[] } | null) {
  mockedInvoke.mockImplementation((cmd) => {
    if (cmd === "list_stored_field_secret_keys") {
      return Promise.resolve(
        stored ? { fields: stored.fields ?? [], hops: stored.hops ?? [] } : null
      );
    }
    if (cmd === "save_connection") return Promise.resolve("saved-id");
    return Promise.resolve(undefined);
  });
}

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function savedConnectionSettings(): Record<string, unknown> {
  const calls = commandCalls("save_connection");
  expect(calls).toHaveLength(1);
  return (calls[0][1] as { connection: SavedConnection }).connection.config.config;
}

setupSettingsRegion();
setupConnectionsRegion();
setupAgentsRegion();

describe("ConnectionEditor — stored field secrets (#4431)", () => {
  let requestUnlock: ReturnType<typeof vi.fn<() => Promise<boolean>>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetRuntimeCache();
    requestUnlock = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [TOKEN_TYPE, SSH_TYPE],
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
      requestUnlock,
    });
    seedConnectionsRegion({ connections: [CONN, HOP_CONN] });
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("shows a stored field secret as saved, and only that one", async () => {
    mockBackend({ fields: ["apiToken"] });
    render(CONN.id);
    await flush();

    expect(commandCalls("list_stored_field_secret_keys")[0][1]).toEqual({
      connectionId: CONN.id,
      sourceFile: null,
    });
    const token = query("field-apiToken") as HTMLInputElement;
    expect(token.value).toBe("");
    expect(token.placeholder).toBe("Saved — leave empty to keep");
    expect(query("field-apiToken-secret-saved")?.textContent).toBe("Saved in credential store");
    expect(query("field-apiToken-secret-clear")).toBeTruthy();
    expect(query("field-pin-stored-secret")).toBeNull();
    expect((query("field-pin") as HTMLInputElement).placeholder).not.toContain("Saved");
  });

  it("typing a replacement hides the saved indicator", async () => {
    mockBackend({ fields: ["apiToken"] });
    render(CONN.id);
    await flush();

    setInput('[data-testid="field-apiToken"]', "new-token");

    expect(query("field-apiToken-stored-secret")).toBeNull();
  });

  it("an empty field without Clear keeps the stored value on save", async () => {
    mockBackend({ fields: ["apiToken"] });
    render(CONN.id);
    await flush();
    setInput('[data-testid="field-host"]', "10.0.0.10");

    await clickButton("connection-editor-save");
    await flush();

    expect(commandCalls("clear_field_secrets")).toHaveLength(0);
    expect(savedConnectionSettings().apiToken).toBeUndefined();
  });

  it("Clear then Save removes exactly the cleared secret before persisting", async () => {
    mockBackend({ fields: ["apiToken", "pin"] });
    render(CONN.id);
    await flush();

    await clickButton("field-apiToken-secret-clear");
    expect(query("field-apiToken-secret-cleared")).toBeTruthy();
    expect((query("field-apiToken") as HTMLInputElement).placeholder).not.toContain("Saved");

    await clickButton("connection-editor-save");
    await flush();

    const clears = commandCalls("clear_field_secrets");
    expect(clears).toHaveLength(1);
    expect(clears[0][1]).toEqual({
      connectionId: CONN.id,
      sourceFile: null,
      fields: ["apiToken"],
      hops: [],
    });
    const order = mockedInvoke.mock.calls.map((c) => c[0]);
    expect(order.indexOf("clear_field_secrets")).toBeLessThan(order.indexOf("save_connection"));
    // The cleared secret no longer shows as saved; the other one still does.
    expect(query("field-apiToken-stored-secret")).toBeNull();
    expect(query("field-pin-secret-saved")).toBeTruthy();
  });

  it("Undo takes a pending clear back", async () => {
    mockBackend({ fields: ["apiToken"] });
    render(CONN.id);
    await flush();

    await clickButton("field-apiToken-secret-clear");
    await clickButton("field-apiToken-secret-undo");
    setInput('[data-testid="field-host"]', "10.0.0.10");
    await clickButton("connection-editor-save");
    await flush();

    expect(commandCalls("clear_field_secrets")).toHaveLength(0);
    expect(query("field-apiToken-secret-saved")).toBeTruthy();
  });

  it("clearing with a locked store unlocks first; a dismissed unlock removes and saves nothing", async () => {
    mockBackend({ fields: ["apiToken"] });
    render(CONN.id);
    await flush();
    await clickButton("field-apiToken-secret-clear");
    useAppStore.setState({ credentialStoreStatus: { mode: "master_password", status: "locked" } });
    requestUnlock.mockResolvedValue(false);

    await clickButton("connection-editor-save");

    expect(requestUnlock).toHaveBeenCalledTimes(1);
    expect(commandCalls("clear_field_secrets")).toHaveLength(0);
    expect(commandCalls("save_connection")).toHaveLength(0);
    expect(toastInfo).toHaveBeenCalled();
  });

  it("shows nothing while the store cannot list the names", async () => {
    mockBackend(null);
    render(CONN.id);
    await flush();

    expect(query("field-apiToken-stored-secret")).toBeNull();
    expect((query("field-apiToken") as HTMLInputElement).placeholder).not.toContain("Saved");
  });

  it("does not ask the backend with credential storage off", async () => {
    mockBackend({ fields: ["apiToken"] });
    useAppStore.setState({ credentialStoreStatus: { mode: "none", status: "unavailable" } });
    render(CONN.id);
    await flush();

    expect(commandCalls("list_stored_field_secret_keys")).toHaveLength(0);
    expect(query("field-apiToken-stored-secret")).toBeNull();
  });

  it("shows and clears a stored inline hop password in the jump-host editor", async () => {
    mockBackend({ hops: ["ops@bastion:22"] });
    render(HOP_CONN.id);
    await flush();

    const hopPassword = query("jump-host-password-0") as HTMLInputElement;
    expect(hopPassword.placeholder).toBe("Saved — leave empty to keep");
    expect(query("jump-host-password-0-secret-saved")).toBeTruthy();

    await clickButton("jump-host-password-0-secret-clear");
    await clickButton("connection-editor-save");
    await flush();

    const clears = commandCalls("clear_field_secrets");
    expect(clears).toHaveLength(1);
    expect(clears[0][1]).toMatchObject({ fields: [], hops: ["ops@bastion:22"] });
    const hops = savedConnectionSettings().proxyJump as Record<string, unknown>[];
    expect(hops[0].password).toBeUndefined();
  });
});
