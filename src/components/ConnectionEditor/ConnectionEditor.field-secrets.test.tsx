/**
 * Schema field secrets in the connection editor (#4429): Test and Save &
 * Connect use the secrets stored for a saved connection (a VNC SSH-tunnel
 * password, a plugin secret) and prompt for missing ones; a save that writes
 * one to a locked store unlocks it first.
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
import { PasswordPrompt } from "@/components/PasswordPrompt/PasswordPrompt";
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
            key: "tokenAuth",
            label: "Auth",
            fieldType: {
              type: "select",
              options: [
                { value: "password", label: "Token" },
                { value: "none", label: "None" },
              ],
            },
            required: true,
            default: "password",
          },
          {
            key: "apiToken",
            label: "API Token",
            fieldType: { type: "password" },
            required: false,
            visibleWhen: { field: "tokenAuth", equals: "password" },
          },
        ],
      },
    ],
  },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: false },
};

/** Saved connection whose token lives only in the credential store. */
const CONN: SavedConnection = {
  id: "tok-1",
  name: "Token Server",
  config: { type: "tokenized", config: { host: "10.0.0.9", tokenAuth: "password" } },
  folderId: null,
};

let container: HTMLDivElement;
let root: Root;
type AppState = ReturnType<typeof useAppStore.getState>;
let requestPassword: ReturnType<typeof vi.fn<AppState["requestPassword"]>>;
let addTab: ReturnType<typeof vi.fn<AppState["addTab"]>>;

function render(connectionId: string, { withPrompt = false } = {}) {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <ConnectionEditor
          tabId="tab-test-cred"
          meta={{ connectionId, folderId: null }}
          isVisible={true}
        />
        {withPrompt && <PasswordPrompt />}
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

async function clickTest() {
  await clickButton("connection-editor-test");
}

function commandCalls(cmd: string) {
  return mockedInvoke.mock.calls.filter((c) => c[0] === cmd);
}

function testedSettings(): Record<string, unknown> {
  const calls = commandCalls("test_connection");
  expect(calls).toHaveLength(1);
  return (calls[0][1] as { settings: Record<string, unknown> }).settings;
}

function mockBackend(stored: Record<string, string> | null) {
  mockedInvoke.mockImplementation((cmd) => {
    if (cmd === "resolve_field_secrets") return Promise.resolve(stored ? { fields: stored } : null);
    return Promise.resolve(undefined);
  });
}

setupSettingsRegion();
setupConnectionsRegion();
setupAgentsRegion();

describe("ConnectionEditor — schema field secrets (#4429)", () => {
  let requestUnlock: ReturnType<typeof vi.fn<() => Promise<boolean>>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetRuntimeCache();
    requestPassword = vi.fn<AppState["requestPassword"]>();
    requestUnlock = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    addTab = vi.fn<AppState["addTab"]>();
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [TOKEN_TYPE],
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
      requestPassword,
      requestUnlock,
      addTab,
    });
    seedConnectionsRegion({ connections: [CONN] });
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("Test uses the stored field secret without prompting or persisting", async () => {
    mockBackend({ apiToken: "stored-token" });
    render(CONN.id);
    await flush();

    await clickTest();

    expect(requestPassword).not.toHaveBeenCalled();
    expect(commandCalls("resolve_field_secrets")[0][1]).toMatchObject({ connectionId: CONN.id });
    expect(testedSettings().apiToken).toBe("stored-token");
    expect(commandCalls("store_field_secrets")).toHaveLength(0);
    expect(addTab).not.toHaveBeenCalled();
  });

  it("Test with a locked store asks to unlock, then uses the stored secret", async () => {
    useAppStore.setState({ credentialStoreStatus: { mode: "master_password", status: "locked" } });
    mockBackend({ apiToken: "stored-token" });
    render(CONN.id);
    await flush();

    await clickTest();

    expect(requestUnlock).toHaveBeenCalledTimes(1);
    expect(testedSettings().apiToken).toBe("stored-token");
  });

  it("Test prompts for a missing secret and a dismissed prompt cancels cleanly", async () => {
    mockBackend({});
    requestPassword.mockResolvedValue(null);
    render(CONN.id);
    await flush();

    await clickTest();

    expect(requestPassword).toHaveBeenCalledTimes(1);
    expect(requestPassword.mock.calls[0][4]).toEqual({ allowSave: false });
    expect(commandCalls("test_connection")).toHaveLength(0);
    expect(toastInfo).toHaveBeenCalledWith("Connect canceled — API Token is required.");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("saving a typed secret to a locked store unlocks first; a dismissed unlock saves nothing", async () => {
    useAppStore.setState({ credentialStoreStatus: { mode: "master_password", status: "locked" } });
    requestUnlock.mockResolvedValue(false);
    mockBackend(null);
    render(CONN.id);
    await flush();
    setInput('[data-testid="field-apiToken"]', "new-token");

    await clickButton("connection-editor-save");

    expect(requestUnlock).toHaveBeenCalledTimes(1);
    expect(commandCalls("save_connection")).toHaveLength(0);
    expect(toastInfo).toHaveBeenCalled();
  });
});
