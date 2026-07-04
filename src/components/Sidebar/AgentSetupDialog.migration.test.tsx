/**
 * Migration regression guard for AgentSetupDialog (UI Modernization, Phase 4).
 *
 * Asserts the dialog renders through the shared `Modal` primitive (`.ui-modal`)
 * and that its primary "Start Setup" action fires the deploy path once the
 * architecture-detection phase has resolved to `ready`.
 */
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

const addTab = vi.fn();
vi.mock("@/store/appStore", () => ({
  useAppStore: (selector: (s: unknown) => unknown) =>
    selector({ addTab, requestPassword: vi.fn() }),
}));

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: {
      loading: vi.fn(() => "toast-1"),
      success: vi.fn(),
      error: vi.fn(),
    },
  };
});

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
async function renderAndDetect(agent: RemoteAgentDefinition, onOpenChange = vi.fn()) {
  await act(async () => {
    root.render(<AgentSetupDialog open={true} onOpenChange={onOpenChange} agent={agent} />);
  });
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("AgentSetupDialog — primitive migration", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    detectAgentArch.mockReset();
    detectAgentArch.mockResolvedValue(makeArchInfo());
    setupRemoteAgent.mockReset();
    setupRemoteAgent.mockResolvedValue({ sessionId: "sess-1" });
    addTab.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders through the shared Modal primitive", async () => {
    await renderAndDetect(makeAgent());
    expect(document.querySelector(".ui-modal")).not.toBeNull();
    expect(document.querySelector('[data-testid="agent-setup-submit"]')).not.toBeNull();
  });

  it("shows the detecting phase while architecture detection is in flight", async () => {
    // A detection that never resolves keeps the dialog in the detecting phase.
    detectAgentArch.mockImplementation(() => new Promise<RemoteArchInfo>(() => {}));
    await act(async () => {
      root.render(<AgentSetupDialog open={true} onOpenChange={vi.fn()} agent={makeAgent()} />);
    });
    expect(document.querySelector(".agent-setup-dialog__detecting")).not.toBeNull();
    // No form fields until detection completes.
    expect(document.querySelector('[data-testid="agent-setup-arch-select"]')).toBeNull();
  });

  it("fires the deploy path when the primary Start Setup action is clicked", async () => {
    await renderAndDetect(makeAgent());

    const submit = document.querySelector(
      '[data-testid="agent-setup-submit"]'
    ) as HTMLButtonElement;
    expect(submit).not.toBeNull();
    expect(submit.disabled).toBe(false);

    await act(async () => {
      submit.click();
    });
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(setupRemoteAgent).toHaveBeenCalledTimes(1);
    expect(addTab).toHaveBeenCalledTimes(1);
  });
});
