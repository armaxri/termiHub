/**
 * A locked vault never silently swallows a connect (#5188): "Connect without
 * saved password" on the unlock dialog falls through to the interactive
 * password prompt with the store still locked and nothing stored, and
 * dismissing the dialog (Escape/×) toasts "Connect canceled" like every
 * other cancel. Driven through the real unlock and password-prompt slices.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/services/api", () => ({
  createTerminal: vi.fn(() => Promise.resolve("session-1")),
  cancelConnecting: vi.fn(() => Promise.resolve(true)),
  closeTerminal: vi.fn(() => Promise.resolve()),
  storeCredential: vi.fn(() => Promise.resolve()),
  resolveCredential: vi.fn(() => Promise.resolve("stored-secret")),
  isSshKeyEncrypted: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("@/services/events", () => ({
  onConnectProgress: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn(), frontendError: vi.fn() }));

import { toast } from "@/components/ui";
import { createTerminal, resolveCredential, storeCredential } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import type { SavedConnection } from "@/types/connection";
import { CONNECT_CANCELED_MESSAGE, connectSavedConnection } from "./connectSavedConnection";

let addTabSpy: ReturnType<typeof vi.fn>;
let infoSpy: ReturnType<typeof vi.spyOn>;

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function sshPassword(): SavedConnection {
  return {
    id: "conn-1",
    name: "web-1",
    folderId: null,
    config: {
      type: "ssh",
      config: { host: "db.example", username: "ops", authMethod: "password", savePassword: true },
    },
  };
}

function sshEncryptedKey(): SavedConnection {
  return {
    id: "conn-2",
    name: "build-1",
    folderId: null,
    config: {
      type: "ssh",
      config: {
        host: "build.example",
        username: "ci",
        authMethod: "key",
        keyPath: "/home/ci/.ssh/id_ed25519",
        savePassword: true,
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  addTabSpy = vi.fn(() => "tab-new");
  vi.spyOn(toast, "loading").mockReturnValue("connecting-toast");
  vi.spyOn(toast, "dismiss").mockImplementation(() => {});
  infoSpy = vi.spyOn(toast, "info").mockReturnValue("info-toast");
  useAppStore.setState({
    ...useAppStore.getInitialState(),
    addTab: addTabSpy as unknown as ReturnType<typeof useAppStore.getState>["addTab"],
    credentialStoreStatus: { mode: "master_password", status: "locked" },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("connectSavedConnection — locked vault (#5188)", () => {
  it("offers the fall-through on the unlock dialog a connect opens", async () => {
    void connectSavedConnection(sshPassword());
    await flush();
    const state = useAppStore.getState();
    expect(state.unlockDialogOpen).toBe(true);
    expect(state.unlockConnectFallback).toBe(true);
  });

  it("connect without saved password: prompts, connects with the typed password, stores nothing", async () => {
    const pending = connectSavedConnection(sshPassword());
    await flush();

    useAppStore.getState().skipUnlock();
    await flush();

    // The vault stays locked and closed; the interactive prompt took over.
    let state = useAppStore.getState();
    expect(state.unlockDialogOpen).toBe(false);
    expect(state.unlockConnectFallback).toBe(false);
    expect(state.credentialStoreStatus?.status).toBe("locked");
    expect(state.passwordPromptOpen).toBe(true);
    expect(state.passwordPromptHost).toBe("db.example");
    expect(state.passwordPromptUsername).toBe("ops");
    // Nothing can be saved into a locked vault, so no Save box is offered.
    expect(state.passwordPromptAllowSave).toBe(false);
    // The stored credential was never read.
    expect(vi.mocked(resolveCredential)).not.toHaveBeenCalled();

    // Even a "save" answer from the prompt is not persisted.
    useAppStore.getState().submitPassword("typed-secret", true);
    const result = await pending;

    expect(result).toEqual({ status: "opened", tabId: "tab-new", sessionId: null });
    expect(addTabSpy).toHaveBeenCalledTimes(1);
    const tabConfig = addTabSpy.mock.calls[0][2] as { config: Record<string, unknown> };
    expect(tabConfig.config.password).toBe("typed-secret");
    // The connect proceeds in the tab; no stored-credential pre-connect ran.
    expect(vi.mocked(createTerminal)).not.toHaveBeenCalled();
    await flush();
    expect(vi.mocked(storeCredential)).not.toHaveBeenCalled();
    state = useAppStore.getState();
    expect(state.credentialStoreStatus?.status).toBe("locked");
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("connect without saved password asks for an encrypted key's passphrase", async () => {
    const pending = connectSavedConnection(sshEncryptedKey());
    await flush();
    useAppStore.getState().skipUnlock();
    await flush();

    const state = useAppStore.getState();
    expect(state.passwordPromptOpen).toBe(true);
    expect(state.passwordPromptKind).toBe("key_passphrase");
    expect(state.passwordPromptAllowSave).toBe(false);

    useAppStore.getState().submitPassword("typed-passphrase");
    const result = await pending;
    expect(result.status).toBe("opened");
    expect(vi.mocked(resolveCredential)).not.toHaveBeenCalled();
    expect(vi.mocked(storeCredential)).not.toHaveBeenCalled();
  });

  it("dismissing the unlock dialog (Escape/×) cancels with the shared toast", async () => {
    const pending = connectSavedConnection(sshPassword());
    await flush();

    // Escape and × close the Modal through onOpenChange(false).
    useAppStore.getState().setUnlockDialogOpen(false);
    const result = await pending;

    expect(result).toEqual({ status: "canceled" });
    expect(infoSpy).toHaveBeenCalledWith(CONNECT_CANCELED_MESSAGE);
    expect(CONNECT_CANCELED_MESSAGE).toBe("Connect canceled");
    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
    expect(addTabSpy).not.toHaveBeenCalled();
    expect(vi.mocked(resolveCredential)).not.toHaveBeenCalled();
    expect(vi.mocked(storeCredential)).not.toHaveBeenCalled();
  });

  it("dismissing the password prompt after the fall-through also toasts the shared cancel", async () => {
    const pending = connectSavedConnection(sshPassword());
    await flush();
    useAppStore.getState().skipUnlock();
    await flush();

    useAppStore.getState().dismissPasswordPrompt();
    const result = await pending;

    expect(result).toEqual({ status: "canceled" });
    expect(infoSpy).toHaveBeenCalledWith(CONNECT_CANCELED_MESSAGE);
    expect(addTabSpy).not.toHaveBeenCalled();
  });
});
