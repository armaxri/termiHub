/**
 * Test Connection button tests for the connection editor (UX-007).
 *
 * The editor exposes a secondary "Test" button beside Save & Connect that
 * validates the current form's connection WITHOUT saving it: it invokes the
 * `test_connection` command, shows a pending state, then a success toast or a
 * classified error toast (auth vs. other). These tests pin that behavior and,
 * critically, that a test never persists the form (no `save_connection`, no
 * store mutation).
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
import type { ConnectionTypeInfo } from "@/types/connection";

const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastInfo = vi.fn();

// Mock the Toast module directly: the @/components/ui barrel re-exports `toast`
// from here AND the async Button imports it from "./Toast", so this captures
// both the editor's success/error toasts and the Button's own error path.
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

/** Minimal local connection type — no credential prompt, no jump hosts. */
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

const TAB_ID = "tab-test-conn-1";

let container: HTMLDivElement;
let root: Root;

function renderNew() {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <ConnectionEditor
          tabId={TAB_ID}
          meta={{ connectionId: "new", folderId: null }}
          isVisible={true}
        />
      </TooltipProvider>
    );
  });
}

function typeName(value: string) {
  const input = container.querySelector<HTMLInputElement>(
    '[data-testid="connection-editor-name-input"]'
  )!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickTest() {
  const btn = container.querySelector<HTMLButtonElement>('[data-testid="connection-editor-test"]')!;
  act(() => {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

setupSettingsRegion();
setupConnectionsRegion();
setupAgentsRegion();

describe("ConnectionEditor — Test Connection (UX-007)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetRuntimeCache();
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [LOCAL_TYPE],
      credentialStoreStatus: { mode: "none", status: "unlocked" },
    });
    seedConnectionsRegion({ connections: [] });
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders a Test button beside Save & Connect", async () => {
    mockedInvoke.mockImplementation(() => Promise.resolve(undefined));
    renderNew();
    await flush();

    expect(container.querySelector('[data-testid="connection-editor-test"]')).not.toBeNull();
  });

  it("invokes test_connection and shows a success toast without saving the form", async () => {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "test_connection") return Promise.resolve(undefined);
      // Every other command (including save_connection) resolves benignly; we
      // assert below that save_connection was never called.
      return Promise.resolve(undefined);
    });

    renderNew();
    await flush();
    typeName("My Local Shell");
    await flush();

    clickTest();
    await flush();

    const testCalls = mockedInvoke.mock.calls.filter((c) => c[0] === "test_connection");
    expect(testCalls).toHaveLength(1);
    expect(testCalls[0][1]).toMatchObject({ typeId: "local" });

    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();

    // The form must NOT have been persisted by a test.
    expect(mockedInvoke.mock.calls.some((c) => c[0] === "save_connection")).toBe(false);
    expect(currentConnectionsView().connections).toHaveLength(0);
  });

  it("shows an auth-failure error toast when test_connection reports auth_failed", async () => {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "test_connection") {
        // The structured IPC error envelope for a rejected credential.
        return Promise.reject({ code: "auth_failed", message: "Authentication failed" });
      }
      return Promise.resolve(undefined);
    });

    renderNew();
    await flush();
    typeName("My Local Shell");
    await flush();

    clickTest();
    await flush();

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0][0]).toBe("Authentication failed");
    // Still no persistence on a failed test.
    expect(mockedInvoke.mock.calls.some((c) => c[0] === "save_connection")).toBe(false);
  });

  it("shows a generic connection-failed toast for a non-auth failure", async () => {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "test_connection") {
        return Promise.reject({ code: "unreachable", message: "no route to host" });
      }
      return Promise.resolve(undefined);
    });

    renderNew();
    await flush();
    typeName("My Local Shell");
    await flush();

    clickTest();
    await flush();

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0][0]).toBe("Connection failed");
  });
});
