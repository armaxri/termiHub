/**
 * #3377: an agent host configured with keyboard-interactive auth (OTP / 2FA)
 * must not get the pre-connect password prompt before architecture
 * detection — its challenges are answered in the in-app keyboard-interactive
 * dialog that the SSH connect raises.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { AgentSetupDialog } from "./AgentSetupDialog";
import type { RemoteArchInfo } from "@/services/api";
import type { RemoteAgentDefinition } from "@/types/connection";
import type { RemoteAgentConfig } from "@/types/terminal";
import type { RequestPassword } from "@/store/slices/passwordPromptSlice";

const detectAgentArch = vi.fn(async (_config: unknown): Promise<RemoteArchInfo> => archInfo());
const requestPassword = vi.fn<RequestPassword>(async () => ({ password: "pw", shouldSave: false }));

vi.mock("@/services/api", () => ({
  detectAgentArch: (config: unknown) => detectAgentArch(config),
  setupRemoteAgent: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

vi.mock("@/store/appStore", () => ({
  useAppStore: (selector: (s: unknown) => unknown) =>
    selector({
      addTab: vi.fn(),
      requestPassword: (...args: Parameters<RequestPassword>) => requestPassword(...args),
    }),
}));

let container: HTMLDivElement;
let root: Root;

const baseUrl = "https://example.invalid/termihub-agent-";

function archInfo(): RemoteArchInfo {
  return {
    arch: "x86_64",
    os: "Linux",
    archSuffix: "linux-x64",
    downloadBaseUrl: baseUrl,
    downloadUrl: `${baseUrl}linux-x64`,
    buildBranch: null,
  };
}

function makeAgent(authMethod: RemoteAgentConfig["authMethod"]): RemoteAgentDefinition {
  return {
    id: "agent-ki",
    name: "Bastion Host",
    config: { host: "bastion.example.com", port: 22, username: "ops", authMethod },
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

async function renderAndDetect(agent: RemoteAgentDefinition) {
  await act(async () => {
    root.render(<AgentSetupDialog open={true} onOpenChange={vi.fn()} agent={agent} />);
  });
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("AgentSetupDialog keyboard-interactive auth (#3377)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    detectAgentArch.mockClear();
    requestPassword.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("skips the password prompt and detects with keyboard-interactive auth", async () => {
    await renderAndDetect(makeAgent("keyboard-interactive"));

    expect(requestPassword).not.toHaveBeenCalled();
    expect(detectAgentArch).toHaveBeenCalledTimes(1);
    const config = detectAgentArch.mock.calls[0][0] as RemoteAgentConfig;
    expect(config.authMethod).toBe("keyboard-interactive");
    expect(config.password).toBeUndefined();
  });

  it("still prompts for a missing password with password auth", async () => {
    await renderAndDetect(makeAgent("password"));

    // The agent's name titles the prompt (#4475).
    expect(requestPassword).toHaveBeenCalledWith("bastion.example.com", "ops", "", "password", {
      label: "Bastion Host",
    });
    const config = detectAgentArch.mock.calls[0][0] as RemoteAgentConfig;
    expect(config.password).toBe("pw");
  });
});
