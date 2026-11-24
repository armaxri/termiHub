/**
 * The setup wizard tells the agent row what the setup is doing (#5906): it
 * marks the agent "installing" when the setup starts, "installed" on success
 * and forgets it when the setup fails, so the row never shows the failure
 * state of the connect that offered the setup while the install succeeds.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { AgentSetupDialog } from "./AgentSetupDialog";
import type { RemoteArchInfo } from "@/services/api";
import type { RemoteAgentDefinition } from "@/types/connection";
import { useAgentSetupStatus } from "@/store/agentSetupStatus";

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

/** Render, let detection settle, click Start setup and enter the running phase. */
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

const phase = () => useAgentSetupStatus.getState().phases["agent-1"];

describe("AgentSetupDialog — the agent row's setup phase (#5906)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onOpenChange = vi.fn<(open: boolean) => void>();
    progressCallback = null;
    vi.clearAllMocks();
    useAgentSetupStatus.setState({ phases: {} });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("marks the agent installing once the setup starts", async () => {
    await startSetup();
    expect(phase()).toBe("installing");
  });

  it("marks the agent installed when the setup reports success", async () => {
    await startSetup();
    act(() => progressCallback?.("agent-1", "done", "Agent installed"));
    expect(phase()).toBe("installed");
  });

  it("forgets the setup when it fails", async () => {
    await startSetup();
    act(() => progressCallback?.("agent-1", "error", "upload failed"));
    expect(phase()).toBeUndefined();
  });

  it("forgets the setup when it cannot even start", async () => {
    setupRemoteAgent.mockRejectedValueOnce(new Error("ssh refused"));
    await act(async () => {
      root.render(<AgentSetupDialog open={true} onOpenChange={onOpenChange} agent={makeAgent()} />);
    });
    await flush();
    await act(async () => {
      (byTestId("agent-setup-submit") as HTMLButtonElement).click();
    });
    await flush();
    expect(phase()).toBeUndefined();
  });
});

describe("AgentSetupDialog — the setup tab (#5865)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onOpenChange = vi.fn<(open: boolean) => void>();
    progressCallback = null;
    vi.clearAllMocks();
    addTab.mockReturnValue("tab-setup");
    useAgentSetupStatus.setState({ phases: {}, tabs: {} });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    addTab.mockReset();
  });

  it("records the tab it opened, reporting through the script's exit on POSIX", async () => {
    await startSetup();
    expect(useAgentSetupStatus.getState().tabs["tab-setup"]).toEqual({
      agentId: "agent-1",
      agentName: "Test Host",
      reportsExit: true,
      progress: { kind: "running" },
      dismissed: false,
    });
  });

  it("marks the tab failed with the backend's message", async () => {
    await startSetup();
    act(() => progressCallback?.("agent-1", "error", "upload failed"));
    expect(useAgentSetupStatus.getState().tabs["tab-setup"].progress).toEqual({
      kind: "failed",
      message: "upload failed",
    });
  });
});
