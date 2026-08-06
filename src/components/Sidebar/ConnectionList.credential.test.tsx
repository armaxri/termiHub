/**
 * Tests for credential prompting behavior in ConnectionList.handleConnect.
 *
 * The dialog must appear in exactly two cases:
 *   1. authMethod="password" with no stored credential (or stale one)
 *   2. authMethod="key" with an *encrypted* key and no stored passphrase —
 *      independent of the savePassword flag (#885)
 *
 * All other cases (valid stored credential, unencrypted key, agent auth,
 * non-SSH connection types) must NOT show a dialog.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { TooltipProvider } from "@/components/ui";
import type { SavedConnection, RemoteAgentDefinition } from "@/types/connection";
import { resolveCredential, storeCredential, isSshKeyEncrypted } from "@/services/api";

vi.mock("@/services/api", () => ({
  listAvailableShells: vi.fn(() => Promise.resolve([])),
  createTerminal: vi.fn(() => Promise.resolve({ sessionId: "s1" })),
  removeCredential: vi.fn(),
  storeCredential: vi.fn(() => Promise.resolve()),
  resolveCredential: vi.fn(() => Promise.resolve(null)),
  // Default: key files are encrypted. Tests override per-case.
  isSshKeyEncrypted: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("@/utils/frontendLog", () => ({
  frontendLog: vi.fn(),
}));

vi.mock("./AgentNode", () => ({
  AgentNode: ({ agent }: { agent: RemoteAgentDefinition }) =>
    React.createElement("div", { "data-testid": `agent-node-${agent.id}` }),
}));

const mockedResolveCredential = vi.mocked(resolveCredential);
const mockedStoreCredential = vi.mocked(storeCredential);
const mockedIsSshKeyEncrypted = vi.mocked(isSshKeyEncrypted);

function makeSshConn(id: string, authMethod: string, savePassword?: boolean): SavedConnection {
  return {
    id,
    name: `SSH ${id}`,
    folderId: null,
    config: {
      type: "ssh",
      config: {
        host: "host.example.com",
        username: "user",
        authMethod,
        ...(savePassword !== undefined ? { savePassword } : {}),
      },
    },
  };
}

let container: HTMLDivElement;
let root: Root;

function render(connections: SavedConnection[]) {
  useAppStore.setState({
    ...useAppStore.getInitialState(),
    credentialStoreStatus: { mode: "master_password", status: "unlocked" },
  });
  seedConnectionsRegion({ connections });
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <ConnectionList />
      </TooltipProvider>
    );
  });
}

async function clickConnectButton(id: string) {
  const item = container.querySelector(
    `[data-testid="connection-item-${id}"]`
  ) as HTMLElement | null;
  if (!item) throw new Error(`connection item for ${id} not found`);
  await act(async () => {
    item.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  mockedResolveCredential.mockResolvedValue(null);
  mockedIsSshKeyEncrypted.mockResolvedValue(true);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

setupConnectionsRegion();

describe("ConnectionList — password dialog conditions", () => {
  it("shows dialog for password auth when no credential is stored", async () => {
    const conn = makeSshConn("pw-no-cred", "password");
    render([conn]);
    await act(async () => {
      await Promise.resolve();
    });

    await clickConnectButton(conn.id);

    expect(useAppStore.getState().passwordPromptOpen).toBe(true);
  });

  it("does not show dialog for password auth when stored credential exists", async () => {
    mockedResolveCredential.mockResolvedValue("stored-secret");
    const conn = makeSshConn("pw-with-cred", "password");
    render([conn]);
    await act(async () => {
      await Promise.resolve();
    });

    await clickConnectButton(conn.id);

    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
  });

  it("shows dialog for an encrypted key when no passphrase is stored", async () => {
    // Regression: a passphrase-protected key with no stored passphrase must
    // prompt so the user can provide (and optionally save) it, otherwise the
    // backend fails to unlock the key.
    const conn = makeSshConn("key-no-pass", "key", true);
    render([conn]);
    await act(async () => {
      await Promise.resolve();
    });

    await clickConnectButton(conn.id);

    expect(useAppStore.getState().passwordPromptOpen).toBe(true);
  });

  it("shows dialog for an encrypted key even when savePassword is off (#885)", async () => {
    // The core #885 fix: prompting is driven by the key's actual encryption, not
    // the savePassword flag — so an encrypted key must prompt even with save off.
    const conn = makeSshConn("key-enc-no-save", "key", false);
    render([conn]);
    await act(async () => {
      await Promise.resolve();
    });

    await clickConnectButton(conn.id);

    expect(useAppStore.getState().passwordPromptOpen).toBe(true);
  });

  it("does not show dialog for an encrypted key when passphrase is stored", async () => {
    mockedResolveCredential.mockResolvedValue("stored-passphrase");
    const conn = makeSshConn("key-with-pass", "key", true);
    render([conn]);
    await act(async () => {
      await Promise.resolve();
    });

    await clickConnectButton(conn.id);

    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
  });

  it("does not show dialog for an unencrypted key even with savePassword on (#885)", async () => {
    // No spurious prompt: an unencrypted key needs no passphrase regardless of
    // the savePassword flag.
    mockedIsSshKeyEncrypted.mockResolvedValue(false);
    const conn = makeSshConn("key-unencrypted", "key", true);
    render([conn]);
    await act(async () => {
      await Promise.resolve();
    });

    await clickConnectButton(conn.id);

    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
  });

  it("does not show dialog for password auth when an inline password is present (#963)", async () => {
    // A config that already carries a non-empty password (e.g. an "Open Jump
    // Host Terminal" gateway built from an inline hop) is the credential itself
    // — handleConnect must use it and not consult the store or prompt.
    const conn = makeSshConn("pw-inline", "password");
    (conn.config.config as Record<string, unknown>).password = "inline-secret";
    render([conn]);
    await act(async () => {
      await Promise.resolve();
    });

    await clickConnectButton(conn.id);

    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
    // The store lookup is skipped entirely for an inline password.
    expect(mockedResolveCredential).not.toHaveBeenCalled();
  });

  it("does not show dialog for agent auth", async () => {
    const conn = makeSshConn("agent-auth", "agent");
    render([conn]);
    await act(async () => {
      await Promise.resolve();
    });

    await clickConnectButton(conn.id);

    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
  });

  it("stores passphrase as key_passphrase type when user opts in for key auth", async () => {
    const conn = makeSshConn("key-store-test", "key", true);
    render([conn]);
    await act(async () => {
      await Promise.resolve();
    });

    await clickConnectButton(conn.id);
    // Dialog is open — simulate the user entering a passphrase and opting to save
    await act(async () => {
      useAppStore.getState().submitPassword("my-passphrase", true);
      await Promise.resolve();
    });

    expect(mockedStoreCredential).toHaveBeenCalledWith(conn.id, "key_passphrase", "my-passphrase");
  });

  it("does not show dialog for a local (non-SSH) connection", async () => {
    const conn: SavedConnection = {
      id: "local-conn",
      name: "Local Shell",
      folderId: null,
      config: { type: "local", config: { shell: "bash" } },
    };
    render([conn]);
    await act(async () => {
      await Promise.resolve();
    });

    await clickConnectButton(conn.id);

    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
  });
});
