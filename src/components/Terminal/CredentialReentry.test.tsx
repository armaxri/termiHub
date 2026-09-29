/**
 * Inline credential re-entry on the terminal auth-failure overlays (#3089).
 *
 * A tab whose credentials the server rejected lands in the terminal, non-
 * retryable `authFailed` state (SM-005). Instead of only "Try Again" (which
 * re-sends the same rejected credential), the overlay lets the user enter a
 * new password / key passphrase / key file and reconnect from the tab, with
 * the familiar "Save" box deciding whether the secret goes to the credential
 * store. The host-key prompt raised by the retry's handshake is the existing
 * global trust dialog.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SshHostKeyPromptPayload } from "@/types/sshHostKey";
import type { ConnectionConfig } from "@/types/terminal";

const storeCredentialMock = vi.fn().mockResolvedValue(undefined);
const decisionMock = vi.fn().mockResolvedValue(true);
let emitHostKeyPrompt: ((p: SshHostKeyPromptPayload) => void) | undefined;

vi.mock("@/services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api")>()),
  storeCredential: (...args: unknown[]) => storeCredentialMock(...args),
  sshHostKeyDecision: (id: string, accept: boolean, remember: boolean) =>
    decisionMock(id, accept, remember),
  validateSshKey: () => Promise.resolve(null),
  getHomeDir: () => Promise.resolve("/home/u"),
  localListDir: () => Promise.resolve([]),
}));

vi.mock("@/services/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/events")>()),
  onSshHostKeyPrompt: (cb: (p: SshHostKeyPromptPayload) => void) => {
    emitHostKeyPrompt = cb;
    return Promise.resolve(() => {});
  },
}));

vi.mock("@/utils/ensureCredentialStoreUnlocked", () => ({
  ensureCredentialStoreUnlocked: () => Promise.resolve(true),
}));

import { useAppStore } from "@/store/appStore";
import { withTooltip } from "@/test/tooltip";
import {
  authFailed,
  flushSessionRegion,
  installSessionLifecycleHarness,
} from "@/test/sessionLifecycleRegionTestHarness";
import { TerminalDisconnectOverlay } from "./TerminalDisconnectOverlay";
import { TerminalConnectionOverlay } from "./TerminalConnectionOverlay";
import { SshHostKeyPrompt } from "@/components/SshHostKeyPrompt/SshHostKeyPrompt";
import { credentialReentryTarget } from "@/utils/credentialReentry";

const harness = installSessionLifecycleHarness();

let container: HTMLDivElement;
let root: Root;

const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

function click(testId: string) {
  const el = q(testId);
  if (!el) throw new Error(`missing ${testId}`);
  act(() => el.click());
}

function typeInto(testId: string, value: string) {
  const el = q(testId) as HTMLInputElement | null;
  if (!el) throw new Error(`missing ${testId}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function sshTab(
  settings: Record<string, unknown>,
  opts: { connectionId?: string; agent?: boolean } = {}
): string {
  const config: ConnectionConfig = opts.agent
    ? ({
        type: "remote-session",
        config: { agentId: "agent-1", sessionType: "ssh", ...settings },
      } as ConnectionConfig)
    : ({ type: "ssh", config: settings } as ConnectionConfig);
  return useAppStore.getState().addTab("Server", opts.agent ? "remote-session" : "ssh", config, {
    connectionId: opts.connectionId,
  });
}

function tabSettings(tabId: string): Record<string, unknown> {
  return useAppStore.getState().tabContent[tabId].config.config as Record<string, unknown>;
}

async function renderAuthFailedOverlay(tabId: string) {
  harness.transport.setSession(tabId, authFailed());
  act(() => {
    root.render(withTooltip(<TerminalDisconnectOverlay tabId={tabId} />));
  });
  await flushSessionRegion();
}

const PASSWORD = { host: "srv", username: "alice", authMethod: "password", savePassword: true };
const KEY = {
  host: "srv",
  username: "alice",
  authMethod: "key",
  keyPath: "/home/u/.ssh/id_old",
  savePassword: false,
};

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  useAppStore.setState({
    credentialStoreStatus: { mode: "master_password", status: "unlocked" },
  });
  storeCredentialMock.mockClear();
  decisionMock.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("credentialReentryTarget", () => {
  it("covers password and key auth, direct and agent-hosted", () => {
    expect(
      credentialReentryTarget({ type: "ssh", config: PASSWORD } as ConnectionConfig, "c1")
    ).toMatchObject({
      authMethod: "password",
      agentHosted: false,
      credentialId: "c1",
      saveDefault: true,
    });
    expect(
      credentialReentryTarget({ type: "ssh", config: KEY } as ConnectionConfig, "c1")
    ).toMatchObject({ authMethod: "key", keyPath: "/home/u/.ssh/id_old", saveDefault: false });
    // Agent-hosted: no desktop credential-store key, so no Save.
    expect(
      credentialReentryTarget(
        {
          type: "remote-session",
          config: { agentId: "a", sessionType: "ssh", ...PASSWORD },
        } as ConnectionConfig,
        undefined
      )
    ).toMatchObject({ authMethod: "password", agentHosted: true, credentialId: null });
  });

  it("offers nothing for auth without a re-enterable secret", () => {
    const agentAuth = { type: "ssh", config: { host: "srv", authMethod: "agent" } };
    expect(credentialReentryTarget(agentAuth as ConnectionConfig, "c1")).toBeNull();
    expect(credentialReentryTarget({ type: "local", config: {} } as ConnectionConfig)).toBeNull();
  });

  it("never saves over a shared named credential", () => {
    const shared = { type: "ssh", config: { ...PASSWORD, credentialRef: "named-1" } };
    expect(credentialReentryTarget(shared as ConnectionConfig, "c1")?.credentialId).toBeNull();
  });
});

describe("authFailed overlay — credential re-entry", () => {
  it("offers password re-entry and retries with the new password", async () => {
    const tabId = sshTab(PASSWORD, { connectionId: "conn-1" });
    await renderAuthFailedOverlay(tabId);

    expect(container.textContent).toContain("Authentication failed");
    click("terminal-credential-reentry-open-btn");
    expect(q("terminal-credential-reentry-form")).not.toBeNull();
    // Password auth: no key-file field.
    expect(q("terminal-credential-reentry-key-path-input")).toBeNull();

    typeInto("terminal-credential-reentry-secret", "n3w-pw");
    click("terminal-credential-reentry-submit");
    await flush();

    expect(tabSettings(tabId).password).toBe("n3w-pw");
    const state = useAppStore.getState();
    expect(state.terminalRetryCounters[tabId]).toBe(1);
    // A fresh create with the new credential — never a reattach.
    expect(state.terminalForceFreshReconnect[tabId]).toBe(true);
  });

  it("offers key-file selection plus passphrase for key auth", async () => {
    const tabId = sshTab(KEY, { connectionId: "conn-1" });
    await renderAuthFailedOverlay(tabId);
    click("terminal-credential-reentry-open-btn");

    const keyInput = q("terminal-credential-reentry-key-path-input") as HTMLInputElement;
    expect(keyInput.value).toBe("/home/u/.ssh/id_old");
    // A local key: the ~/.ssh picker with its Browse button.
    expect(q("terminal-credential-reentry-key-path-browse")).not.toBeNull();

    typeInto("terminal-credential-reentry-key-path-input", "/home/u/.ssh/id_new");
    typeInto("terminal-credential-reentry-secret", "phrase");
    click("terminal-credential-reentry-submit");
    await flush();

    expect(tabSettings(tabId).keyPath).toBe("/home/u/.ssh/id_new");
    expect(tabSettings(tabId).password).toBe("phrase");
    expect(useAppStore.getState().terminalRetryCounters[tabId]).toBe(1);
  });

  it("saves to the credential store under the connection key when Save is ticked", async () => {
    const tabId = sshTab(PASSWORD, { connectionId: "conn-1" });
    await renderAuthFailedOverlay(tabId);
    click("terminal-credential-reentry-open-btn");

    // Defaults to the connection's savePassword (true here).
    expect(q("terminal-credential-reentry-save")?.getAttribute("data-state")).toBe("checked");
    typeInto("terminal-credential-reentry-secret", "n3w-pw");
    click("terminal-credential-reentry-submit");
    await flush();

    expect(storeCredentialMock).toHaveBeenCalledWith("conn-1", "password", "n3w-pw", null);
  });

  it("stores a key passphrase as key_passphrase", async () => {
    const tabId = sshTab(KEY, { connectionId: "conn-1" });
    await renderAuthFailedOverlay(tabId);
    click("terminal-credential-reentry-open-btn");

    // savePassword false → unchecked by default; the user ticks it.
    expect(q("terminal-credential-reentry-save")?.getAttribute("data-state")).toBe("unchecked");
    click("terminal-credential-reentry-save");
    typeInto("terminal-credential-reentry-secret", "phrase");
    click("terminal-credential-reentry-submit");
    await flush();

    expect(storeCredentialMock).toHaveBeenCalledWith("conn-1", "key_passphrase", "phrase", null);
  });

  it("uses the credential for this attempt only when Save is unticked", async () => {
    const tabId = sshTab(PASSWORD, { connectionId: "conn-1" });
    await renderAuthFailedOverlay(tabId);
    click("terminal-credential-reentry-open-btn");

    click("terminal-credential-reentry-save");
    expect(q("terminal-credential-reentry-save")?.getAttribute("data-state")).toBe("unchecked");
    typeInto("terminal-credential-reentry-secret", "once");
    click("terminal-credential-reentry-submit");
    await flush();

    expect(storeCredentialMock).not.toHaveBeenCalled();
    expect(tabSettings(tabId).password).toBe("once");
    expect(useAppStore.getState().terminalRetryCounters[tabId]).toBe(1);
  });

  it("cancel closes the form and leaves the tab in authFailed", async () => {
    const tabId = sshTab(PASSWORD, { connectionId: "conn-1" });
    await renderAuthFailedOverlay(tabId);
    click("terminal-credential-reentry-open-btn");
    typeInto("terminal-credential-reentry-secret", "typed");

    click("terminal-credential-reentry-cancel");

    expect(q("terminal-credential-reentry-form")).toBeNull();
    expect(q("terminal-credential-reentry-open-btn")).not.toBeNull();
    expect(container.textContent).toContain("Authentication failed");
    const state = useAppStore.getState();
    expect(state.terminalRetryCounters[tabId]).toBeUndefined();
    expect(tabSettings(tabId).password).toBeUndefined();
    expect(storeCredentialMock).not.toHaveBeenCalled();
  });

  it("agent-hosted: offers re-entry without a Save box or a local key picker", async () => {
    const tabId = sshTab(KEY, { agent: true });
    await renderAuthFailedOverlay(tabId);
    click("terminal-credential-reentry-open-btn");

    expect(q("terminal-credential-reentry-save")).toBeNull();
    // The key lives on the agent host: a plain path field, no ~/.ssh picker.
    expect(q("terminal-credential-reentry-key-path-input")).not.toBeNull();
    expect(q("terminal-credential-reentry-key-path-browse")).toBeNull();

    typeInto("terminal-credential-reentry-secret", "phrase");
    click("terminal-credential-reentry-submit");
    await flush();

    expect(tabSettings(tabId).password).toBe("phrase");
    expect(tabSettings(tabId).agentId).toBe("agent-1");
    expect(storeCredentialMock).not.toHaveBeenCalled();
    expect(useAppStore.getState().terminalRetryCounters[tabId]).toBe(1);
  });

  it("does not offer re-entry for a plain (non-auth) failure", async () => {
    const tabId = sshTab(PASSWORD, { connectionId: "conn-1" });
    harness.transport.setSession(tabId, {
      status: "failed",
      reconnect: { phase: "idle", attempt: 0, delayMs: 0 },
      endReason: "error",
      error: "boom",
    });
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId={tabId} />));
    });
    await flushSessionRegion();
    expect(q("terminal-credential-reentry-open-btn")).toBeNull();
  });

  it("surfaces the host-key trust prompt raised by the retry's handshake", async () => {
    const tabId = sshTab(PASSWORD, { connectionId: "conn-1" });
    harness.transport.setSession(tabId, authFailed());
    act(() => {
      root.render(
        withTooltip(
          <>
            <TerminalDisconnectOverlay tabId={tabId} />
            <SshHostKeyPrompt />
          </>
        )
      );
    });
    await flushSessionRegion();

    click("terminal-credential-reentry-open-btn");
    typeInto("terminal-credential-reentry-secret", "n3w-pw");
    click("terminal-credential-reentry-submit");
    await flush();

    // The retried SSH handshake meets a changed host key: the existing trust
    // prompt appears (not a generic error), and accepting it answers the
    // blocked handshake through the trust-store path.
    act(() =>
      emitHostKeyPrompt?.({
        prompt_id: "hk-1",
        host: "srv",
        port: 22,
        key_type: "ssh-ed25519",
        fingerprint: "SHA256:NEW",
        changed: true,
        previous_fingerprints: ["SHA256:OLD"],
      })
    );
    expect(q("ssh-hostkey-mitm-warning")).not.toBeNull();
    click("ssh-hostkey-accept-remember");
    expect(decisionMock).toHaveBeenCalledWith("hk-1", true, true);
  });
});

describe("connection-failed overlay — credential re-entry", () => {
  it("offers re-entry when the spawn failed with an auth rejection", async () => {
    const tabId = sshTab(PASSWORD, { connectionId: "conn-1" });
    harness.transport.setSession(tabId, authFailed());
    useAppStore.getState().setTerminalSpawnError(tabId, "Authentication failed", "auth");
    act(() => {
      root.render(
        withTooltip(
          <TerminalConnectionOverlay tabId={tabId} panelId="p" tabTitle="Server" isVisible />
        )
      );
    });
    await flushSessionRegion();

    click("terminal-credential-reentry-open-btn");
    typeInto("terminal-credential-reentry-secret", "n3w-pw");
    click("terminal-credential-reentry-submit");
    await flush();

    expect(tabSettings(tabId).password).toBe("n3w-pw");
    expect(useAppStore.getState().terminalRetryCounters[tabId]).toBe(1);
  });

  it("does not offer re-entry for a non-auth spawn failure", async () => {
    const tabId = sshTab(PASSWORD, { connectionId: "conn-1" });
    useAppStore.getState().setTerminalSpawnError(tabId, "Connection timed out", "timeout");
    act(() => {
      root.render(
        withTooltip(
          <TerminalConnectionOverlay tabId={tabId} panelId="p" tabTitle="Server" isVisible />
        )
      );
    });
    await flushSessionRegion();
    expect(q("terminal-credential-reentry-open-btn")).toBeNull();
  });
});
