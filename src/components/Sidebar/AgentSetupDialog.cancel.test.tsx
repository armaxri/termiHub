/**
 * Cancel an in-progress agent setup (#3686, MT-AGENT-29).
 *
 * While a setup runs, the dialog shows the live step with a "Cancel Setup"
 * button. Clicking it fires the backend cancellation token (which aborts the
 * background upload and rolls back the partial upload), confirms with a toast and
 * closes the dialog. The rollback on the host itself is covered by the bridge
 * harness (`test_remote_agent.py::test_cancel_setup_leaves_no_partial_upload`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { AgentSetupDialog } from "./AgentSetupDialog";
import type { RemoteArchInfo } from "@/services/api";
import type { RemoteAgentDefinition } from "@/types/connection";

// ── Mocks ────────────────────────────────────────────────────────────────

const baseUrl = "https://github.com/armaxri/termiHub/releases/download/dev-latest/termihub-agent-";

const archInfo: RemoteArchInfo = {
  arch: "x86_64",
  os: "Linux",
  archSuffix: "linux-x64",
  downloadBaseUrl: baseUrl,
  downloadUrl: `${baseUrl}linux-x64`,
  buildBranch: null,
};

const detectAgentArch = vi.fn(async (): Promise<RemoteArchInfo> => archInfo);
const setupRemoteAgent = vi.fn(async () => ({ sessionId: "setup-session" }));
const cancelAgentSetup = vi.fn(async (_agentId: string): Promise<void> => undefined);

vi.mock("@/services/api", () => ({
  detectAgentArch: () => detectAgentArch(),
  setupRemoteAgent: () => setupRemoteAgent(),
  cancelAgentSetup: (agentId: string) => cancelAgentSetup(agentId),
}));

type ProgressCallback = (agentId: string, step: string, message: string) => void;
let progressCallback: ProgressCallback | null = null;
const unlistenProgress = vi.fn();

vi.mock("@/services/events", () => ({
  onAgentSetupProgress: vi.fn(async (cb: ProgressCallback) => {
    progressCallback = cb;
    return unlistenProgress;
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

const addTab = vi.fn();
vi.mock("@/store/appStore", () => ({
  useAppStore: (selector: (s: unknown) => unknown) =>
    selector({ addTab, requestPassword: vi.fn() }),
}));

const toastMock = vi.hoisted(() => ({
  loading: vi.fn(() => "toast-1"),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/components/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui")>()),
  toast: toastMock,
}));

// ── Helpers ──────────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;
let onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;

function makeAgent(): RemoteAgentDefinition {
  return {
    id: "agent-1",
    name: "Test Host",
    config: {
      host: "host.local",
      port: 22,
      username: "user",
      // Key auth so detection skips the password prompt.
      authMethod: "key",
      keyPath: "/home/user/.ssh/id_ed25519",
    },
    agentSettings: {
      enableMonitoring: true,
      enableFileBrowser: true,
      enableDocker: false,
      defaultShell: null,
      startingDirectory: "",
      logLevel: "info",
      verboseTracing: false,
      persistentScrollbackBufferSizeMb: 4,
    },
    isExpanded: false,
    connectionState: "disconnected",
  };
}

async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

/** Render, let detection settle, click Start Setup and enter the running phase. */
async function startSetup(): Promise<void> {
  await act(async () => {
    root.render(<AgentSetupDialog open={true} onOpenChange={onOpenChange} agent={makeAgent()} />);
  });
  await flush();
  const submit = byTestId("agent-setup-submit") as HTMLButtonElement;
  expect(submit.disabled).toBe(false);
  await act(async () => {
    submit.click();
  });
  await flush();
  // A live background step streams in.
  act(() => {
    progressCallback?.("agent-1", "upload", "Uploading agent binary...");
  });
}

describe("AgentSetupDialog — cancel an in-progress setup (MT-AGENT-29)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onOpenChange = vi.fn<(open: boolean) => void>();
    progressCallback = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the live setup step with a Cancel Setup button", async () => {
    await startSetup();

    expect(setupRemoteAgent).toHaveBeenCalledTimes(1);
    const progress = byTestId("agent-setup-progress");
    expect(progress).not.toBeNull();
    expect(progress!.textContent).toContain("Uploading agent binary...");
    const cancel = byTestId("agent-setup-cancel-running");
    expect(cancel).not.toBeNull();
    expect(cancel!.textContent).toContain("Cancel Setup");
    // The idle footer (Start Setup) is replaced while running.
    expect(byTestId("agent-setup-submit")).toBeNull();
  });

  it("fires the backend cancel, confirms with a toast and closes the dialog", async () => {
    await startSetup();

    await act(async () => {
      byTestId("agent-setup-cancel-running")!.click();
    });
    await flush();

    expect(cancelAgentSetup).toHaveBeenCalledTimes(1);
    expect(cancelAgentSetup).toHaveBeenCalledWith("agent-1");
    // The confirmation resolves the deploy's loading toast in place.
    expect(toastMock.success).toHaveBeenCalledWith("Cancelling agent deploy to Test Host…", {
      id: "toast-1",
    });
    // The progress subscription is dropped and the dialog closes.
    expect(unlistenProgress).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("surfaces an error toast and keeps the dialog open when the cancel fails", async () => {
    cancelAgentSetup.mockRejectedValueOnce(new Error("no setup in flight"));
    await startSetup();

    await act(async () => {
      byTestId("agent-setup-cancel-running")!.click();
    });
    await flush();

    expect(toastMock.error).toHaveBeenCalledWith(
      "Failed to cancel agent deploy: no setup in flight"
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
