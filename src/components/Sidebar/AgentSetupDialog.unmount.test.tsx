/**
 * Unmount during an agent deploy (#4576, follow-up of #4375).
 *
 * Start Setup subscribes to deploy progress behind an await. If the dialog
 * unmounts while that registration is pending, the listener that registers
 * afterwards must be unlistened at once, and no deploy is started for the gone
 * dialog.
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

const onAgentSetupProgress = vi.hoisted(() =>
  vi.fn(
    async (_cb: (agentId: string, step: string, message: string) => void) =>
      (() => {}) as () => void
  )
);

vi.mock("@/services/events", () => ({ onAgentSetupProgress }));

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
  dismiss: vi.fn(),
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

let mounted = false;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function renderAndSubmit(): Promise<void> {
  await act(async () => {
    root.render(<AgentSetupDialog open={true} onOpenChange={onOpenChange} agent={makeAgent()} />);
  });
  mounted = true;
  await flush();
  const submit = byTestId("agent-setup-submit") as HTMLButtonElement;
  expect(submit.disabled).toBe(false);
  await act(async () => {
    submit.click();
  });
}

function unmount(): void {
  act(() => root.unmount());
  mounted = false;
}

describe("AgentSetupDialog — unmount during deploy (#4576)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onOpenChange = vi.fn<(open: boolean) => void>();
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (mounted) unmount();
    container.remove();
  });

  it("unlistens a progress listener whose registration resolves after unmount", async () => {
    const pending = deferred<() => void>();
    const unlisten = vi.fn();
    onAgentSetupProgress.mockReturnValueOnce(pending.promise);

    await renderAndSubmit();
    expect(onAgentSetupProgress).toHaveBeenCalledTimes(1);
    unmount();

    await act(async () => {
      pending.resolve(unlisten);
    });
    await flush();

    expect(unlisten).toHaveBeenCalledTimes(1);
    // The deploy is abandoned rather than started for a gone dialog.
    expect(setupRemoteAgent).not.toHaveBeenCalled();
    // Its loading toast does not hang around.
    expect(toastMock.dismiss).toHaveBeenCalledWith("toast-1");
  });

  it("unlistens a registered progress listener on unmount", async () => {
    const unlisten = vi.fn();
    onAgentSetupProgress.mockResolvedValueOnce(unlisten);

    await renderAndSubmit();
    await flush();
    expect(setupRemoteAgent).toHaveBeenCalledTimes(1);
    unmount();

    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
