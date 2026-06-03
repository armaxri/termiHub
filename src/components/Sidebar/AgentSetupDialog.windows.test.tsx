import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { AgentSetupDialog } from "./AgentSetupDialog";
import type { RemoteArchInfo } from "@/services/api";
import type { RemoteAgentDefinition } from "@/types/connection";

// ── Mocks ────────────────────────────────────────────────────────────────

const detectAgentArch = vi.fn(async (_config: unknown): Promise<RemoteArchInfo> => makeArchInfo());
const setupRemoteAgent = vi.fn();

vi.mock("@/services/api", () => ({
  detectAgentArch: (config: unknown) => detectAgentArch(config),
  setupRemoteAgent: (...args: unknown[]) => setupRemoteAgent(...args),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@/store/appStore", () => ({
  useAppStore: (selector: (s: unknown) => unknown) =>
    selector({ addTab: vi.fn(), requestPassword: vi.fn() }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;

const baseUrl = "https://github.com/armaxri/termiHub/releases/download/dev-latest/termihub-agent-";

function makeArchInfo(overrides: Partial<RemoteArchInfo> = {}): RemoteArchInfo {
  return {
    arch: "x86_64",
    os: "Linux",
    archSuffix: "linux-x64",
    downloadBaseUrl: baseUrl,
    downloadUrl: `${baseUrl}linux-x64`,
    buildBranch: null,
    ...overrides,
  };
}

function makeAgent(): RemoteAgentDefinition {
  return {
    id: "agent-1",
    name: "Test Host",
    config: {
      host: "host.local",
      port: 22,
      username: "user",
      // Use key auth so the dialog skips the password prompt during detection.
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

/** Render the dialog and let the async architecture detection settle. */
async function renderAndDetect(agent: RemoteAgentDefinition) {
  await act(async () => {
    root.render(<AgentSetupDialog open={true} onOpenChange={vi.fn()} agent={agent} />);
  });
  // Flush the detection promise + the state updates it triggers.
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("AgentSetupDialog Windows support", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    detectAgentArch.mockReset();
    setupRemoteAgent.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("hides the systemd-service checkbox and marks the install path read-only for Windows hosts", async () => {
    detectAgentArch.mockResolvedValue(
      makeArchInfo({ os: "Windows_NT", arch: "AMD64", archSuffix: "windows-x64" })
    );

    await renderAndDetect(makeAgent());

    // No systemd service on Windows.
    expect(document.querySelector('[data-testid="agent-setup-install-service"]')).toBeNull();

    // Install path is fixed/read-only and points at %LOCALAPPDATA%.
    const pathInput = document.querySelector(
      '[data-testid="agent-setup-remote-path"]'
    ) as HTMLInputElement | null;
    expect(pathInput).not.toBeNull();
    expect(pathInput!.readOnly).toBe(true);
    expect(pathInput!.value).toContain("%LOCALAPPDATA%");
    expect(pathInput!.value).toContain("termihub-agent.exe");
  });

  it("shows the systemd-service checkbox and an editable install path for POSIX hosts", async () => {
    detectAgentArch.mockResolvedValue(makeArchInfo());

    await renderAndDetect(makeAgent());

    expect(document.querySelector('[data-testid="agent-setup-install-service"]')).not.toBeNull();

    const pathInput = document.querySelector(
      '[data-testid="agent-setup-remote-path"]'
    ) as HTMLInputElement | null;
    expect(pathInput).not.toBeNull();
    expect(pathInput!.readOnly).toBe(false);
    expect(pathInput!.value).toBe("~/.local/bin/termihub-agent");
  });
});
