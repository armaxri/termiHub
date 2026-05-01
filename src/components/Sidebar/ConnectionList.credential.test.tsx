/**
 * Tests for credential prompting behavior in ConnectionList.handleConnect.
 *
 * The dialog must appear in exactly two cases:
 *   1. authMethod="password" with no stored credential (or stale one)
 *   2. authMethod="key" + savePassword=true with no stored passphrase
 *
 * All other cases (valid stored credential, key without savePassword, agent
 * auth, non-SSH connection types) must NOT show a dialog.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import type { SavedConnection, RemoteAgentDefinition } from "@/types/connection";
import { resolveCredential, storeCredential } from "@/services/api";

vi.mock("@/services/api", () => ({
  listAvailableShells: vi.fn(() => Promise.resolve([])),
  createTerminal: vi.fn(() => Promise.resolve({ sessionId: "s1" })),
  removeCredential: vi.fn(),
  storeCredential: vi.fn(() => Promise.resolve()),
  resolveCredential: vi.fn(() => Promise.resolve(null)),
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
    connections,
    credentialStoreStatus: { mode: "master_password", status: "unlocked" },
  });
  act(() => {
    root.render(<ConnectionList />);
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
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

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

  it("shows dialog for key auth + savePassword when no passphrase is stored", async () => {
    // Regression: previously key+savePassword+no-stored-passphrase silently
    // fell through to connect without the passphrase, causing auth failure.
    // Now it must prompt so the user can provide (and optionally save) it.
    const conn = makeSshConn("key-no-pass", "key", true);
    render([conn]);
    await act(async () => {
      await Promise.resolve();
    });

    await clickConnectButton(conn.id);

    expect(useAppStore.getState().passwordPromptOpen).toBe(true);
  });

  it("does not show dialog for key auth + savePassword when passphrase is stored", async () => {
    mockedResolveCredential.mockResolvedValue("stored-passphrase");
    const conn = makeSshConn("key-with-pass", "key", true);
    render([conn]);
    await act(async () => {
      await Promise.resolve();
    });

    await clickConnectButton(conn.id);

    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
  });

  it("does not show dialog for key auth without savePassword", async () => {
    const conn = makeSshConn("key-no-save", "key", false);
    render([conn]);
    await act(async () => {
      await Promise.resolve();
    });

    await clickConnectButton(conn.id);

    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
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
