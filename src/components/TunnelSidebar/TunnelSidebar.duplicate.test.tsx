/**
 * Feedback tests for tunnel duplication (#1342).
 *
 * Duplicating a tunnel used to `console.error` on failure (invisible to the
 * user) and confirm nothing on success. These tests pin that a successful
 * duplicate surfaces a success toast and a failing duplicate surfaces an error
 * toast instead of a silent console log.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import type { TunnelConfig } from "@/types/tunnel";
import { TooltipProvider } from "@/components/ui";
import { TunnelSidebar } from "./TunnelSidebar";

const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: {
      success: (...args: unknown[]) => toastSuccess(...args),
      error: (...args: unknown[]) => toastError(...args),
      info: vi.fn(),
      loading: vi.fn(),
      dismiss: vi.fn(),
    },
  };
});

vi.mock("@/store/appStore", () => {
  const state: Record<string, unknown> = {};
  const useAppStore = (selector: (s: Record<string, unknown>) => unknown) => selector(state);
  useAppStore.setState = (patch: Record<string, unknown>) => Object.assign(state, patch);
  return { useAppStore };
});

function makeTunnel(id: string, name: string): TunnelConfig {
  return {
    id,
    name,
    sshConnectionId: "conn-1",
    tunnelType: {
      type: "local",
      config: { localHost: "127.0.0.1", localPort: 8080, remoteHost: "127.0.0.1", remotePort: 80 },
    },
    autoStart: false,
    reconnectOnDisconnect: false,
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function seedStore(saveTunnel: (config: TunnelConfig) => Promise<void>) {
  (useAppStore as unknown as { setState: (p: Record<string, unknown>) => void }).setState({
    tunnels: [makeTunnel("tun-1", "My Tunnel")],
    tunnelStates: {},
    connections: [],
    startTunnel: vi.fn(),
    stopTunnel: vi.fn(),
    reconnectTunnel: vi.fn(),
    saveTunnel,
    deleteTunnel: vi.fn(),
    openTunnelEditorTab: vi.fn(),
  });
}

async function renderSidebar() {
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <TunnelSidebar />
      </TooltipProvider>
    );
  });
  await flush();
}

async function clickDuplicate() {
  const btn = container.querySelector<HTMLButtonElement>('[data-testid="tunnel-duplicate-tun-1"]');
  expect(btn).not.toBeNull();
  await act(async () => {
    btn!.click();
  });
  await flush();
}

describe("TunnelSidebar — duplicate feedback (#1342)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("shows a success toast when duplication succeeds", async () => {
    const saveTunnel = vi.fn(() => Promise.resolve());
    seedStore(saveTunnel);
    await renderSidebar();
    await clickDuplicate();

    expect(saveTunnel).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows an error toast when duplication fails", async () => {
    const saveTunnel = vi.fn(() => Promise.reject(new Error("disk full")));
    seedStore(saveTunnel);
    await renderSidebar();
    await clickDuplicate();

    expect(saveTunnel).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
