/**
 * Regression tests for {@link useConnectSavedConnection}.
 *
 * This hook is the extracted saved-connection connect flow that previously
 * lived inline in `ConnectionList` (#1484). These tests pin the credential
 * behavior — password/passphrase prompting (#885), inline-password shortcut
 * (#963), stale-credential clearing, and store opt-in — so the extraction and
 * any future refactor stay behavior-identical to the sidebar's connect path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { useConnectSavedConnection } from "./useConnectSavedConnection";
import type { SavedConnection } from "@/types/connection";
import {
  resolveCredential,
  createTerminal,
  removeCredential,
  storeCredential,
  isSshKeyEncrypted,
} from "@/services/api";

vi.mock("@/services/api", () => ({
  createTerminal: vi.fn(() => Promise.resolve("session-1")),
  removeCredential: vi.fn(() => Promise.resolve()),
  storeCredential: vi.fn(() => Promise.resolve()),
  resolveCredential: vi.fn(() => Promise.resolve(null)),
  // Default: key files are encrypted. Tests override per-case.
  isSshKeyEncrypted: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("@/utils/frontendLog", () => ({
  frontendLog: vi.fn(),
}));

const mockedResolveCredential = vi.mocked(resolveCredential);
const mockedCreateTerminal = vi.mocked(createTerminal);
const mockedRemoveCredential = vi.mocked(removeCredential);
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
let addTabSpy: ReturnType<typeof vi.fn>;

async function renderHook(): Promise<ReturnType<typeof useConnectSavedConnection>> {
  let api: ReturnType<typeof useConnectSavedConnection> | undefined;
  function Harness() {
    api = useConnectSavedConnection();
    return null;
  }
  await act(async () => {
    root.render(React.createElement(Harness));
  });
  return api!;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  mockedResolveCredential.mockResolvedValue(null);
  mockedCreateTerminal.mockResolvedValue("session-1");
  mockedIsSshKeyEncrypted.mockResolvedValue(true);
  addTabSpy = vi.fn(() => "tab-1");
  useAppStore.setState({
    ...useAppStore.getInitialState(),
    addTab: addTabSpy as unknown as ReturnType<typeof useAppStore.getState>["addTab"],
    credentialStoreStatus: { mode: "master_password", status: "unlocked" },
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("useConnectSavedConnection", () => {
  it("prompts for password auth when no credential is stored", async () => {
    const { connect } = await renderHook();
    await act(async () => {
      void connect(makeSshConn("pw-no-cred", "password"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useAppStore.getState().passwordPromptOpen).toBe(true);
    expect(addTabSpy).not.toHaveBeenCalled();
  });

  it("does not prompt for password auth when a stored credential exists", async () => {
    mockedResolveCredential.mockResolvedValue("stored-secret");
    const { connect } = await renderHook();
    await act(async () => {
      await connect(makeSshConn("pw-with-cred", "password"));
    });
    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
    expect(mockedCreateTerminal).toHaveBeenCalledOnce();
    // Opened against the pre-validated session id.
    expect(addTabSpy).toHaveBeenCalledWith(
      "SSH pw-with-cred",
      "ssh",
      expect.anything(),
      expect.objectContaining({ sessionId: "session-1" })
    );
  });

  it("prompts for an encrypted key when no passphrase is stored", async () => {
    const { connect } = await renderHook();
    await act(async () => {
      void connect(makeSshConn("key-no-pass", "key", true));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useAppStore.getState().passwordPromptOpen).toBe(true);
  });

  it("prompts for an encrypted key even when savePassword is off (#885)", async () => {
    const { connect } = await renderHook();
    await act(async () => {
      void connect(makeSshConn("key-enc-no-save", "key", false));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useAppStore.getState().passwordPromptOpen).toBe(true);
  });

  it("does not prompt for an unencrypted key even with savePassword on (#885)", async () => {
    mockedIsSshKeyEncrypted.mockResolvedValue(false);
    const { connect } = await renderHook();
    await act(async () => {
      await connect(makeSshConn("key-unencrypted", "key", true));
    });
    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
    expect(addTabSpy).toHaveBeenCalledOnce();
  });

  it("uses an inline password directly without consulting the store (#963)", async () => {
    const conn = makeSshConn("pw-inline", "password");
    (conn.config.config as Record<string, unknown>).password = "inline-secret";
    const { connect } = await renderHook();
    await act(async () => {
      await connect(conn);
    });
    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
    expect(mockedResolveCredential).not.toHaveBeenCalled();
    expect(addTabSpy).toHaveBeenCalledOnce();
  });

  it("does not prompt for agent auth", async () => {
    const { connect } = await renderHook();
    await act(async () => {
      await connect(makeSshConn("agent-auth", "agent"));
    });
    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
    expect(addTabSpy).toHaveBeenCalledOnce();
  });

  it("opens a local (non-SSH) connection directly", async () => {
    const conn: SavedConnection = {
      id: "local-conn",
      name: "Local Shell",
      folderId: null,
      config: { type: "local", config: { shell: "bash" } },
    };
    const { connect } = await renderHook();
    await act(async () => {
      await connect(conn);
    });
    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
    expect(addTabSpy).toHaveBeenCalledOnce();
  });

  it("clears a stale credential and prompts when the pre-connect auth fails", async () => {
    mockedResolveCredential.mockResolvedValue("stale-secret");
    mockedCreateTerminal.mockRejectedValue(new Error("Authentication failed"));
    const { connect } = await renderHook();
    await act(async () => {
      void connect(makeSshConn("pw-stale", "password"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockedRemoveCredential).toHaveBeenCalledWith("pw-stale", "password");
    expect(useAppStore.getState().passwordPromptOpen).toBe(true);
  });

  it("stores the passphrase as key_passphrase when the user opts in for key auth", async () => {
    const { connect } = await renderHook();
    await act(async () => {
      void connect(makeSshConn("key-store", "key", true));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      useAppStore.getState().submitPassword("my-passphrase", true);
      await Promise.resolve();
    });
    expect(mockedStoreCredential).toHaveBeenCalledWith(
      "key-store",
      "key_passphrase",
      "my-passphrase"
    );
  });
});
