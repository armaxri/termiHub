/**
 * Test connection's certificate review (#4510).
 *
 * An interactive Test asks the backend to put an untrusted RDP certificate to
 * the user (`reviewCert`), which raises `connection-test-cert-prompt` for the
 * test's `connectId`. The editor shows the remote-desktop certificate dialog
 * and routes only the user's explicit verdict back through
 * `test_connection_cert_decision`; the probe then reports the real outcome.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen, type EventCallback } from "@tauri-apps/api/event";
import { useAppStore } from "@/store/appStore";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { resetRuntimeCache } from "@/hooks/useAvailableRuntimes";
import { ConnectionEditor } from "./ConnectionEditor";
import { TooltipProvider } from "@/components/ui";
import type { ConnectionTypeInfo } from "@/types/connection";
import type { RemoteDesktopCertPromptPayload } from "@/types/remoteDesktop";

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

const TAB_ID = "tab-test-conn-cert";

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

const CERT_EVENT = "connection-test-cert-prompt";
const mockedListen = vi.mocked(listen);

/** Captured `connection-test-cert-prompt` subscribers. */
const certHandlers = new Set<EventCallback<RemoteDesktopCertPromptPayload>>();

/** A `test_connection` call the test resolves or rejects by hand. */
interface PendingTest {
  args: Record<string, unknown>;
  resolve: () => void;
  reject: (err: unknown) => void;
}
let pendingTest: PendingTest | null;

function installMocks() {
  pendingTest = null;
  certHandlers.clear();
  mockedListen.mockImplementation(((event: string, handler: EventCallback<unknown>) => {
    if (event === CERT_EVENT) {
      const h = handler as EventCallback<RemoteDesktopCertPromptPayload>;
      certHandlers.add(h);
      return Promise.resolve(() => {
        certHandlers.delete(h);
      });
    }
    return Promise.resolve(() => {});
  }) as unknown as typeof listen);
  mockedInvoke.mockImplementation(((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "test_connection") {
      return new Promise<void>((resolve, reject) => {
        pendingTest = { args: args ?? {}, resolve, reject };
      });
    }
    if (cmd === "test_connection_cert_decision") return Promise.resolve(true);
    return Promise.resolve(undefined);
  }) as unknown as typeof invoke);
}

function emitCertPrompt(overrides: Partial<RemoteDesktopCertPromptPayload> = {}) {
  const payload: RemoteDesktopCertPromptPayload = {
    session_id: String(pendingTest!.args.connectId),
    host: "rdp.example",
    fingerprint: "AB:CD:EF",
    changed: false,
    ...overrides,
  };
  act(() => {
    for (const h of certHandlers) h({ event: CERT_EVENT, id: 1, payload });
  });
}

function dialog(): HTMLElement | null {
  return document.body.querySelector('[data-testid="remote-desktop-cert-prompt"]');
}

function click(testId: string) {
  const el = document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function decisionCalls() {
  return mockedInvoke.mock.calls.filter((c) => c[0] === "test_connection_cert_decision");
}

async function startTest() {
  renderNew();
  await flush();
  typeName("My RDP");
  await flush();
  clickTest();
  await flush();
  await flush();
  expect(pendingTest).not.toBeNull();
}

setupSettingsRegion();
setupConnectionsRegion();
setupAgentsRegion();

describe("ConnectionEditor — Test connection certificate review (#4510)", () => {
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
    installMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    mockedListen.mockImplementation(() => Promise.resolve(() => {}));
  });

  it("runs the test interactively and shows no dialog until a prompt arrives", async () => {
    await startTest();

    expect(pendingTest!.args).toMatchObject({ reviewCert: true });
    expect(String(pendingTest!.args.connectId)).toMatch(/^test:/);
    expect(certHandlers.size).toBe(1);
    expect(dialog()).toBeNull();
  });

  it("accept once: answers accept without remember, then reports the real verdict", async () => {
    await startTest();
    emitCertPrompt();
    expect(dialog()).not.toBeNull();
    expect(document.body.querySelector('[data-testid="cert-fingerprint"]')?.textContent).toContain(
      "AB:CD:EF"
    );

    click("cert-accept-once");
    await flush();

    expect(decisionCalls()).toEqual([
      [
        "test_connection_cert_decision",
        { connectId: pendingTest!.args.connectId, accept: true, remember: false },
      ],
    ]);
    expect(dialog()).toBeNull();

    // The probe continues to CredSSP; here the credentials are rejected.
    await act(async () => {
      pendingTest!.reject({ code: "auth_failed", message: "Authentication failed" });
    });
    await flush();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0][0]).toBe("Authentication failed");
  });

  it("remember: answers accept with remember and succeeds", async () => {
    await startTest();
    emitCertPrompt();

    click("cert-accept-remember");
    await flush();

    expect(decisionCalls()).toEqual([
      [
        "test_connection_cert_decision",
        { connectId: pendingTest!.args.connectId, accept: true, remember: true },
      ],
    ]);
    await act(async () => {
      pendingTest!.resolve();
    });
    await flush();
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(mockedInvoke.mock.calls.some((c) => c[0] === "save_connection")).toBe(false);
  });

  it("reject: answers reject (never remember) and shows the failure", async () => {
    await startTest();
    emitCertPrompt({ changed: true });
    expect(document.body.querySelector('[data-testid="cert-mitm-warning"]')).not.toBeNull();

    click("cert-reject");
    await flush();

    expect(decisionCalls()).toEqual([
      [
        "test_connection_cert_decision",
        { connectId: pendingTest!.args.connectId, accept: false, remember: false },
      ],
    ]);
    expect(dialog()).toBeNull();
    await act(async () => {
      pendingTest!.reject({
        code: "host_key_untrusted",
        message: "You did not accept the certificate of rdp.example",
      });
    });
    await flush();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("closing the dialog with Escape answers reject", async () => {
    await startTest();
    emitCertPrompt();

    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      );
    });
    await flush();

    expect(decisionCalls()).toEqual([
      [
        "test_connection_cert_decision",
        { connectId: pendingTest!.args.connectId, accept: false, remember: false },
      ],
    ]);
    expect(dialog()).toBeNull();
  });

  it("timeout: the test ending without a verdict closes the dialog and sends nothing", async () => {
    await startTest();
    emitCertPrompt();
    expect(dialog()).not.toBeNull();

    await act(async () => {
      pendingTest!.reject({
        code: "host_key_untrusted",
        message: "The certificate of rdp.example was not reviewed within 120s",
      });
    });
    await flush();

    expect(dialog()).toBeNull();
    expect(decisionCalls()).toHaveLength(0);
    expect(toastError).toHaveBeenCalledTimes(1);
    // The listener is released with the test.
    expect(certHandlers.size).toBe(0);
  });

  it("ignores a certificate prompt for another test", async () => {
    await startTest();
    emitCertPrompt({ session_id: "test:someone-else" });

    expect(dialog()).toBeNull();
  });
});
