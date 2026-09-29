/**
 * The unattended mode of the shared saved-connection connect flow (#3527): a
 * scheduled run's connect never prompts. Every point where the attended flow
 * would ask the user — a password, a key passphrase, a locked credential
 * store, an untrusted host key, a keyboard-interactive / one-time-code round —
 * is refused with its reason instead, and a successful connect opens the tab
 * on the live session it produced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/services/api", () => ({
  createTerminal: vi.fn(() => Promise.resolve("session-1")),
  removeCredential: vi.fn(() => Promise.resolve()),
  storeCredential: vi.fn(() => Promise.resolve()),
  resolveCredential: vi.fn(() => Promise.resolve(null)),
  isSshKeyEncrypted: vi.fn(() => Promise.resolve(false)),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn(), frontendError: vi.fn() }));

import { toast } from "@/components/ui";
import {
  createTerminal,
  isSshKeyEncrypted,
  removeCredential,
  resolveCredential,
} from "@/services/api";
import { useAppStore } from "@/store/appStore";
import { EMPTY_AGENTS_VIEW, setAgentsViewForTest } from "@/store/agentsBridge";
import type { AgentCapabilities, RemoteAgentDefinition, SavedConnection } from "@/types/connection";
import { connectSavedConnection } from "./connectSavedConnection";

const mockedCreateTerminal = vi.mocked(createTerminal);
const mockedResolveCredential = vi.mocked(resolveCredential);
const mockedIsSshKeyEncrypted = vi.mocked(isSshKeyEncrypted);
const mockedRemoveCredential = vi.mocked(removeCredential);

let addTabSpy: ReturnType<typeof vi.fn>;
let requestUnlockSpy: ReturnType<typeof vi.fn>;

function ssh(authMethod: string, extra: Record<string, unknown> = {}): SavedConnection {
  return {
    id: "conn-1",
    name: "web-1",
    folderId: null,
    config: {
      type: "ssh",
      config: { host: "web-1.example", username: "ops", authMethod, ...extra },
    },
  };
}

/** A backend IPC error envelope with the given code. */
function ipcError(code: string, message = "refused"): { code: string; message: string } {
  return { code, message };
}

const unattended = { unattended: true } as const;

beforeEach(() => {
  vi.clearAllMocks();
  mockedCreateTerminal.mockResolvedValue("session-1");
  mockedResolveCredential.mockResolvedValue(null);
  mockedIsSshKeyEncrypted.mockResolvedValue(false);
  addTabSpy = vi.fn(() => "tab-new");
  requestUnlockSpy = vi.fn(() => Promise.resolve(true));
  vi.spyOn(toast, "loading").mockReturnValue("toast");
  vi.spyOn(toast, "dismiss").mockImplementation(() => {});
  useAppStore.setState({
    ...useAppStore.getInitialState(),
    addTab: addTabSpy as unknown as ReturnType<typeof useAppStore.getState>["addTab"],
    requestUnlock: requestUnlockSpy as unknown as ReturnType<
      typeof useAppStore.getState
    >["requestUnlock"],
    credentialStoreStatus: { mode: "master_password", status: "unlocked" },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  setAgentsViewForTest(EMPTY_AGENTS_VIEW);
});

/** Nothing may have asked the user anything, and no tab may have opened. */
function expectNoPromptAndNoTab(): void {
  expect(useAppStore.getState().passwordPromptOpen).toBe(false);
  expect(requestUnlockSpy).not.toHaveBeenCalled();
  expect(addTabSpy).not.toHaveBeenCalled();
}

describe("connectSavedConnection — unattended refusals (#3527)", () => {
  it("refuses password auth with no stored password: needs a password", async () => {
    const result = await connectSavedConnection(ssh("password"), unattended);
    expect(result).toEqual({ status: "refused", reason: "needs a password" });
    expect(mockedCreateTerminal).not.toHaveBeenCalled();
    expectNoPromptAndNoTab();
  });

  it("refuses an encrypted key with no stored passphrase: needs a key passphrase", async () => {
    mockedIsSshKeyEncrypted.mockResolvedValue(true);
    const result = await connectSavedConnection(
      ssh("key", { keyPath: "~/.ssh/id_ed25519", savePassword: true }),
      unattended
    );
    expect(result).toEqual({ status: "refused", reason: "needs a key passphrase" });
    expect(mockedCreateTerminal).not.toHaveBeenCalled();
    expectNoPromptAndNoTab();
  });

  it("refuses when the credential store is locked, without asking to unlock it", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "locked" },
    });
    const result = await connectSavedConnection(ssh("password"), unattended);
    expect(result).toEqual({ status: "refused", reason: "credential store locked" });
    expect(mockedResolveCredential).not.toHaveBeenCalled();
    expectNoPromptAndNoTab();
  });

  it("refuses an untrusted host key from the typed backend code", async () => {
    mockedCreateTerminal.mockRejectedValue(ipcError("host_key_untrusted"));
    const result = await connectSavedConnection(ssh("agent"), unattended);
    expect(result).toEqual({ status: "refused", reason: "host key not trusted" });
    expectNoPromptAndNoTab();
  });

  it("refuses a keyboard-interactive / one-time-code round from the typed code", async () => {
    mockedCreateTerminal.mockRejectedValue(ipcError("interaction_required"));
    const result = await connectSavedConnection(ssh("keyboard-interactive"), unattended);
    expect(result).toEqual({
      status: "refused",
      reason: "needs interactive input (e.g. a one-time code)",
    });
    expectNoPromptAndNoTab();
  });

  it("refuses a rejected stored password and keeps it (no re-prompt, no discard)", async () => {
    mockedResolveCredential.mockResolvedValue("stale");
    mockedCreateTerminal.mockRejectedValue(ipcError("auth_failed"));
    const result = await connectSavedConnection(ssh("password"), unattended);
    expect(result).toEqual({ status: "refused", reason: "the saved credential was rejected" });
    expect(mockedRemoveCredential).not.toHaveBeenCalled();
    expectNoPromptAndNoTab();
  });

  it("reports a connect that fails for another reason as failed, with the message", async () => {
    mockedCreateTerminal.mockRejectedValue(ipcError("unreachable", "No route to host"));
    const result = await connectSavedConnection(ssh("agent"), unattended);
    expect(result).toEqual({ status: "failed", reason: "could not connect: No route to host" });
    expectNoPromptAndNoTab();
  });
});

describe("connectSavedConnection — unattended success (#3527)", () => {
  it("connects with the stored password, never prompting, and opens the tab on the session", async () => {
    mockedResolveCredential.mockResolvedValue("s3cret");
    const result = await connectSavedConnection(ssh("password"), unattended);

    expect(result).toEqual({ status: "opened", tabId: "tab-new", sessionId: "session-1" });
    expect(mockedCreateTerminal).toHaveBeenCalledOnce();
    const [config, connectId, spawned, resilient, flag] = mockedCreateTerminal.mock.calls[0];
    expect(config.config).toMatchObject({ password: "s3cret" });
    expect([connectId, spawned, resilient, flag]).toEqual([undefined, false, false, true]);
    expect(addTabSpy).toHaveBeenCalledWith(
      "web-1",
      "ssh",
      expect.anything(),
      expect.objectContaining({ connectionId: "conn-1", sessionId: "session-1" })
    );
    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
  });

  it("connects key / agent auth that needs no secret with the never-prompt flag", async () => {
    const result = await connectSavedConnection(ssh("agent"), unattended);
    expect(result.status).toBe("opened");
    expect(mockedCreateTerminal.mock.calls[0][4]).toBe(true);
  });

  it("connects a telnet target (no credentials) the same way", async () => {
    const telnet: SavedConnection = {
      id: "conn-t",
      name: "switch",
      folderId: null,
      config: { type: "telnet", config: { host: "10.0.0.2", port: 23 } },
    };
    const result = await connectSavedConnection(telnet, unattended);
    expect(result).toEqual({ status: "opened", tabId: "tab-new", sessionId: "session-1" });
    expect(mockedCreateTerminal.mock.calls[0][4]).toBe(true);
  });

  it("attended, the same connection still prompts (the flag is opt-in)", async () => {
    void connectSavedConnection(ssh("password"));
    await vi.waitFor(() => expect(useAppStore.getState().passwordPromptOpen).toBe(true));
    useAppStore.getState().dismissPasswordPrompt();
  });
});

describe("connectSavedConnection — unattended agent-hosted targets (#3877)", () => {
  /** An agent-hosted SSH target on agent `a1`, key auth on the agent host. */
  const agentTarget: SavedConnection = {
    id: "conn-r",
    name: "remote",
    folderId: null,
    config: {
      type: "remote-session",
      config: {
        agentId: "a1",
        sessionType: "ssh",
        host: "db-1.internal",
        username: "ops",
        authMethod: "key",
        keyPath: "~/.ssh/id_ed25519",
      },
    },
  };

  /** Put agent `a1` into the agents view with the given state. */
  function withAgent(
    connectionState: RemoteAgentDefinition["connectionState"],
    capabilities?: Partial<AgentCapabilities>
  ): void {
    const agent = {
      id: "a1",
      name: "pi",
      connectionState,
      capabilities: capabilities
        ? ({ connectionTypes: [], maxSessions: 10, ...capabilities } as AgentCapabilities)
        : undefined,
    } as RemoteAgentDefinition;
    setAgentsViewForTest({ ...EMPTY_AGENTS_VIEW, remoteAgents: [agent] });
  }

  it("connects an agent target on a new enough agent, with the never-prompt flag", async () => {
    withAgent("connected", { unattendedConnect: true });
    const result = await connectSavedConnection(agentTarget, unattended);

    expect(result).toEqual({ status: "opened", tabId: "tab-new", sessionId: "session-1" });
    expect(mockedCreateTerminal).toHaveBeenCalledOnce();
    const [config, , , , flag] = mockedCreateTerminal.mock.calls[0];
    expect(config.type).toBe("remote-session");
    expect(flag).toBe(true);
    // The key lives on the agent host: the agent decides whether it needs a
    // passphrase (and refuses typed when it does), not a desktop-side probe.
    expect(mockedIsSshKeyEncrypted).not.toHaveBeenCalled();
    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
  });

  it("skips an agent target on an agent too old for unattended connect", async () => {
    withAgent("connected", { sessionFiles: true });
    const result = await connectSavedConnection(agentTarget, unattended);
    expect(result).toEqual({
      status: "refused",
      reason: "agent too old for unattended connect",
    });
    expect(mockedCreateTerminal).not.toHaveBeenCalled();
    expectNoPromptAndNoTab();
  });

  it("skips an agent target whose agent is not connected", async () => {
    withAgent("disconnected");
    const result = await connectSavedConnection(agentTarget, unattended);
    expect(result).toEqual({ status: "refused", reason: "agent not connected" });
    expect(mockedCreateTerminal).not.toHaveBeenCalled();
    expectNoPromptAndNoTab();
  });

  it("maps the backend's agent_outdated refusal to the same reason", async () => {
    withAgent("connected", { unattendedConnect: true });
    mockedCreateTerminal.mockRejectedValue(ipcError("agent_outdated"));
    const result = await connectSavedConnection(agentTarget, unattended);
    expect(result).toEqual({
      status: "refused",
      reason: "agent too old for unattended connect",
    });
    expectNoPromptAndNoTab();
  });

  it("refuses an agent-side prompt from its typed code", async () => {
    withAgent("connected", { unattendedConnect: true });
    mockedCreateTerminal.mockRejectedValue(ipcError("interaction_required"));
    const result = await connectSavedConnection(agentTarget, unattended);
    expect(result).toEqual({
      status: "refused",
      reason: "needs interactive input (e.g. a one-time code)",
    });
    expectNoPromptAndNoTab();
  });
});
