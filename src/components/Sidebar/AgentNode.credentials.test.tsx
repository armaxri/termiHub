/**
 * Agent connect credential paths (#5322, COV-027).
 *
 * - Cancelling a password prompt (the first prompt, or the retry after a
 *   rejected saved password) ends the connect attempt: no reconnect is made and
 *   the in-flight guard is released, so the next Connect click prompts again.
 * - A shared named credential (#3557) is never written as a per-agent secret:
 *   not when it is missing (the user types it), and not when the server rejects
 *   it and the user retries. Its retry prompt offers no Save choice.
 * - A non-auth failure with a stored credential is not a rejection: no retry
 *   prompt is shown.
 *
 * The issue also named a "missing shared credential logs through
 * `frontendError` and removes the local entry" branch. That branch no longer
 * exists: #5156 made a rejected saved password always kept (see
 * AgentNode.credential-rejection.test.tsx), so the tests below pin the current
 * shared-credential behaviour instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { AgentNode } from "./AgentNode";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { storeCredential } from "@/services/api";
import {
  resolveConnectionCredential,
  type CredentialResolution,
} from "@/utils/resolveConnectionCredential";

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), isDragging: false }),
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
  useDndContext: () => ({ active: null }),
  useDndMonitor: () => {},
}));

vi.mock("@dnd-kit/utilities", () => ({ CSS: { Transform: { toString: () => "" } } }));

vi.mock("@/services/api", () => ({
  storeCredential: vi.fn(() => Promise.resolve()),
  cancelConnectAgent: vi.fn(() => Promise.resolve()),
  listAgentConnections: vi.fn(() => Promise.resolve({ connections: [], folders: [] })),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn(), frontendError: vi.fn() }));
vi.mock("@/utils/resolveConnectionCredential", () => ({
  resolveConnectionCredential: vi.fn(),
}));
vi.mock("@/utils/ensureCredentialStoreUnlocked", () => ({
  ensureCredentialStoreUnlocked: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("./AgentSetupDialog", () => ({ AgentSetupDialog: () => null }));
vi.mock("./ConnectionErrorDialog", () => ({ ConnectionErrorDialog: () => null }));
vi.mock("./InlineFolderInput", () => ({ InlineFolderInput: () => null }));

vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return { ...actual, Tooltip: ({ children }: { children: React.ReactNode }) => children };
});

const AGENT_ID = "agent-credentials-test";
const AUTH_FAILED = new Error("[thub-code:auth_failed] Authentication failed");

function makeAgent(config: Partial<RemoteAgentDefinition["config"]> = {}): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Jump Agent",
    config: {
      host: "jump.example.com",
      port: 22,
      username: "ops",
      authMethod: "password",
      savePassword: true,
      ...config,
    },
    connectionState: "disconnected",
    isExpanded: true,
    agentSettings: DEFAULT_AGENT_SETTINGS,
  };
}

function resolution(partial: Partial<CredentialResolution>): CredentialResolution {
  return { password: null, usedStoredCredential: false, credentialType: "password", ...partial };
}

let container: HTMLDivElement;
let root: Root;
const mockConnect = vi.fn();
const mockRequestPassword = vi.fn();

function renderAgent(agent: RemoteAgentDefinition) {
  seedAgentsRegion({
    agentDefinitions: { [AGENT_ID]: [] },
    agentFolders: { [AGENT_ID]: [] },
    agentSessions: { [AGENT_ID]: [] },
    remoteAgents: [agent],
  });
  act(() => {
    root.render(React.createElement(AgentNode, { agent }));
  });
}

async function clickConnect() {
  const btn = container.querySelector<HTMLButtonElement>(
    `[data-testid="agent-reconnect-${AGENT_ID}"]`
  );
  expect(btn).not.toBeNull();
  await act(async () => {
    btn!.click();
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

setupAgentsRegion();

describe("AgentNode — connect credential paths (#5322)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    vi.mocked(storeCredential).mockClear();
    vi.mocked(resolveConnectionCredential).mockReset();
    mockConnect.mockReset();
    mockRequestPassword.mockReset();
    useAppStore.setState({
      connectRemoteAgent: mockConnect,
      requestPassword: mockRequestPassword,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  describe("cancelled prompts", () => {
    it("a cancelled first prompt makes no connect and lets the next click prompt again", async () => {
      vi.mocked(resolveConnectionCredential).mockResolvedValue(resolution({}));
      mockRequestPassword.mockResolvedValue(null);
      renderAgent(makeAgent({ savePassword: false }));

      await clickConnect();
      expect(mockRequestPassword).toHaveBeenCalledTimes(1);
      expect(mockConnect).not.toHaveBeenCalled();

      // The in-flight guard was released: a second click is not swallowed.
      await clickConnect();
      expect(mockRequestPassword).toHaveBeenCalledTimes(2);
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it("a prompt answered with an empty password counts as cancelled", async () => {
      vi.mocked(resolveConnectionCredential).mockResolvedValue(resolution({}));
      mockRequestPassword.mockResolvedValue({ password: "", shouldSave: true });
      renderAgent(makeAgent({ savePassword: false }));

      await clickConnect();

      expect(mockConnect).not.toHaveBeenCalled();
      expect(storeCredential).not.toHaveBeenCalled();
    });

    it("a cancelled retry after a rejected saved password does not reconnect", async () => {
      vi.mocked(resolveConnectionCredential).mockResolvedValue(
        resolution({ password: "saved-pw", usedStoredCredential: true })
      );
      mockConnect.mockRejectedValue(AUTH_FAILED);
      mockRequestPassword.mockResolvedValue(null);
      renderAgent(makeAgent());

      await clickConnect();
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockConnect).toHaveBeenCalledWith(AGENT_ID, "saved-pw");
      expect(mockRequestPassword).toHaveBeenCalledTimes(1);
      expect(storeCredential).not.toHaveBeenCalled();

      // The guard was released: the next click tries the saved password again.
      await clickConnect();
      expect(mockConnect).toHaveBeenCalledTimes(2);
      expect(mockRequestPassword).toHaveBeenCalledTimes(2);
    });

    it("a non-auth failure with a stored credential shows no retry prompt", async () => {
      vi.mocked(resolveConnectionCredential).mockResolvedValue(
        resolution({ password: "saved-pw", usedStoredCredential: true })
      );
      mockConnect.mockRejectedValue(new Error("connection refused"));
      renderAgent(makeAgent());

      await clickConnect();

      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockRequestPassword).not.toHaveBeenCalled();
      expect(storeCredential).not.toHaveBeenCalled();
    });
  });

  describe("shared named credential (#3557)", () => {
    const shared = () => makeAgent({ credentialRef: "cred-team" });

    it("a missing shared credential prompts, connects, and never stores a per-agent copy", async () => {
      vi.mocked(resolveConnectionCredential).mockResolvedValue(
        resolution({ namedCredentialId: "cred-team" })
      );
      mockConnect.mockResolvedValue(undefined);
      mockRequestPassword.mockResolvedValue({ password: "typed-pw", shouldSave: true });
      renderAgent(shared());

      await clickConnect();

      expect(resolveConnectionCredential).toHaveBeenCalledWith(
        AGENT_ID,
        "password",
        true,
        "cred-team"
      );
      expect(mockConnect).toHaveBeenCalledWith(AGENT_ID, "typed-pw");
      expect(storeCredential).not.toHaveBeenCalled();
    });

    it("a rejected shared credential re-prompts without a Save choice", async () => {
      vi.mocked(resolveConnectionCredential).mockResolvedValue(
        resolution({
          password: "shared-pw",
          usedStoredCredential: true,
          namedCredentialId: "cred-team",
        })
      );
      mockConnect.mockRejectedValueOnce(AUTH_FAILED).mockResolvedValueOnce(undefined);
      mockRequestPassword.mockResolvedValue({ password: "retry-pw", shouldSave: true });
      renderAgent(shared());

      await clickConnect();

      expect(mockRequestPassword).toHaveBeenCalledWith(
        "jump.example.com",
        "ops",
        expect.stringContaining("shared credential was rejected"),
        "password",
        { allowSave: false, label: "Jump Agent" }
      );
      expect(mockConnect).toHaveBeenLastCalledWith(AGENT_ID, "retry-pw");
      expect(storeCredential).not.toHaveBeenCalled();
    });

    it("a cancelled shared-credential retry does not reconnect", async () => {
      vi.mocked(resolveConnectionCredential).mockResolvedValue(
        resolution({
          password: "shared-pw",
          usedStoredCredential: true,
          namedCredentialId: "cred-team",
        })
      );
      mockConnect.mockRejectedValue(AUTH_FAILED);
      mockRequestPassword.mockResolvedValue(null);
      renderAgent(shared());

      await clickConnect();

      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(storeCredential).not.toHaveBeenCalled();
    });
  });

  it("a prompted password ticked for saving is stored after the connect succeeds", async () => {
    vi.mocked(resolveConnectionCredential).mockResolvedValue(resolution({}));
    mockConnect.mockResolvedValue(undefined);
    mockRequestPassword.mockResolvedValue({ password: "typed-pw", shouldSave: true });
    renderAgent(makeAgent({ savePassword: false }));

    await clickConnect();

    expect(mockConnect).toHaveBeenCalledWith(AGENT_ID, "typed-pw");
    expect(storeCredential).toHaveBeenCalledWith(AGENT_ID, "password", "typed-pw");
  });
});
