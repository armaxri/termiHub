/**
 * Connect-time secret of a VNC/RDP connection tunnelled through an agent
 * (#3803): the password lives in this computer's credential store (keyed by
 * agent + definition) or is prompted for — never on the agent host.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useAppStore } from "@/store/appStore";
import { resolveCredential, storeCredential } from "@/services/api";
import { agentGraphicalCredentialId, resolveAgentGraphicalSettings } from "./agentGraphicalSecret";

vi.mock("@/services/api", () => ({
  resolveCredential: vi.fn(),
  storeCredential: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

const mockedResolve = vi.mocked(resolveCredential);
const mockedStore = vi.mocked(storeCredential);

const AGENT = "agent-1";
const DEF = "def-vnc";
const SETTINGS = { host: "10.0.0.5", port: 5901, username: "alice" };

describe("agentGraphicalCredentialId", () => {
  it("matches the backend's agent-graphical owner id", () => {
    expect(agentGraphicalCredentialId("agent-1", "def-9")).toBe("agent-graphical:agent-1:def-9");
  });
});

describe("resolveAgentGraphicalSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      credentialStoreStatus: { mode: "os_keychain", status: "unlocked" },
    });
  });

  it("uses a password typed into the form without any lookup or prompt", async () => {
    const requestPassword = vi.fn();
    const result = await resolveAgentGraphicalSettings({
      agentId: AGENT,
      definitionId: DEF,
      settings: { ...SETTINGS, password: "typed" },
      requestPassword,
    });
    expect(result).toEqual({ status: "resolved", settings: { ...SETTINGS, password: "typed" } });
    expect(mockedResolve).not.toHaveBeenCalled();
    expect(requestPassword).not.toHaveBeenCalled();
  });

  it("resolves the secret from the desktop credential store", async () => {
    mockedResolve.mockResolvedValue("from-store");
    const requestPassword = vi.fn();
    const result = await resolveAgentGraphicalSettings({
      agentId: AGENT,
      definitionId: DEF,
      settings: SETTINGS,
      requestPassword,
    });
    expect(mockedResolve).toHaveBeenCalledWith(
      agentGraphicalCredentialId(AGENT, DEF),
      "password",
      null
    );
    expect(result).toEqual({
      status: "resolved",
      settings: { ...SETTINGS, password: "from-store" },
    });
    expect(requestPassword).not.toHaveBeenCalled();
  });

  it("prompts when nothing is stored and saves the answer when asked to", async () => {
    mockedResolve.mockResolvedValue(null);
    const requestPassword = vi.fn(async () => {
      useAppStore.setState({ passwordPromptShouldSave: true });
      return "entered";
    });
    const result = await resolveAgentGraphicalSettings({
      agentId: AGENT,
      definitionId: DEF,
      settings: SETTINGS,
      requestPassword,
    });
    expect(requestPassword).toHaveBeenCalledWith("10.0.0.5", "alice", "", "password");
    expect(mockedStore).toHaveBeenCalledWith(
      agentGraphicalCredentialId(AGENT, DEF),
      "password",
      "entered",
      null
    );
    expect(result).toEqual({ status: "resolved", settings: { ...SETTINGS, password: "entered" } });
  });

  it("does not save a prompted answer when the Save box is left unchecked", async () => {
    mockedResolve.mockResolvedValue(null);
    const requestPassword = vi.fn(async () => "entered");
    await resolveAgentGraphicalSettings({
      agentId: AGENT,
      definitionId: DEF,
      settings: SETTINGS,
      requestPassword,
    });
    expect(mockedStore).not.toHaveBeenCalled();
  });

  it("reports a dismissed prompt as canceled", async () => {
    mockedResolve.mockResolvedValue(null);
    const result = await resolveAgentGraphicalSettings({
      agentId: AGENT,
      definitionId: DEF,
      settings: SETTINGS,
      requestPassword: vi.fn(async () => null),
    });
    expect(result).toEqual({ status: "canceled" });
  });

  it("prompts without a Save box for a definition that has no id yet", async () => {
    const requestPassword = vi.fn(async () => "entered");
    await resolveAgentGraphicalSettings({
      agentId: AGENT,
      definitionId: null,
      settings: SETTINGS,
      requestPassword,
    });
    expect(mockedResolve).not.toHaveBeenCalled();
    expect(requestPassword).toHaveBeenCalledWith("10.0.0.5", "alice", "", "password", {
      allowSave: false,
    });
  });

  it("asks to unlock a locked store before the lookup, and aborts if dismissed", async () => {
    const requestUnlock = vi.fn(async () => false);
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "locked" },
      requestUnlock,
    });
    const requestPassword = vi.fn();
    const result = await resolveAgentGraphicalSettings({
      agentId: AGENT,
      definitionId: DEF,
      settings: SETTINGS,
      requestPassword,
    });
    expect(requestUnlock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: "canceled" });
    expect(mockedResolve).not.toHaveBeenCalled();
    expect(requestPassword).not.toHaveBeenCalled();
  });
});
