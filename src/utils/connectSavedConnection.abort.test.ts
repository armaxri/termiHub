/**
 * The abortable saved-credential pre-connect (#5180): the "Connecting…" toast
 * carries an Abort that ends the pre-tab window at any step (unlock, stored
 * credential resolve, the blocking pre-connect), cancels the backend connect,
 * ignores and cleans up late results, and saves nothing. A pre-connect that
 * fails for a non-auth reason connects exactly once: the tab is handed that
 * failure instead of connecting again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ConnectProgressEvent } from "@/services/events";

vi.mock("@/services/api", () => ({
  createTerminal: vi.fn(() => Promise.resolve("session-1")),
  cancelConnecting: vi.fn(() => Promise.resolve(true)),
  closeTerminal: vi.fn(() => Promise.resolve()),
  storeCredential: vi.fn(() => Promise.resolve()),
  resolveCredential: vi.fn(() => Promise.resolve("stored-secret")),
  isSshKeyEncrypted: vi.fn(() => Promise.resolve(true)),
}));

let progressListener: ((event: ConnectProgressEvent) => void) | null = null;
const unlistenSpy = vi.fn();
vi.mock("@/services/events", () => ({
  onConnectProgress: vi.fn((cb: (event: ConnectProgressEvent) => void) => {
    progressListener = cb;
    return Promise.resolve(unlistenSpy);
  }),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn(), frontendError: vi.fn() }));

import { toast, type ToastOptions } from "@/components/ui";
import {
  cancelConnecting,
  closeTerminal,
  createTerminal,
  resolveCredential,
  storeCredential,
} from "@/services/api";
import { useAppStore } from "@/store/appStore";
import type { SavedConnection } from "@/types/connection";
import {
  connectSavedConnection,
  type ConnectSavedConnectionResult,
} from "./connectSavedConnection";
import { takePreconnectFailure } from "./preconnect";

const mockedCreateTerminal = vi.mocked(createTerminal);
const mockedResolveCredential = vi.mocked(resolveCredential);

let addTabSpy: ReturnType<typeof vi.fn>;
let loadingSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;

/** A promise whose settling the test controls. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
      config: {
        host: "unreachable.example",
        username: "ops",
        authMethod: "password",
        savePassword: true,
      },
    },
  };
}

/** Press the Abort action on the "Connecting…" toast. */
function pressAbort(): void {
  const opts = loadingSpy.mock.calls[0]?.[1] as ToastOptions | undefined;
  expect(opts?.action?.label).toBe("Abort");
  opts?.action?.onClick();
}

/** Abort was acknowledged and nothing was opened or saved. */
function expectCleanCancel(result: ConnectSavedConnectionResult): void {
  expect(result).toEqual({ status: "canceled" });
  expect(infoSpy).toHaveBeenCalledWith("Connection cancelled");
  expect(addTabSpy).not.toHaveBeenCalled();
  expect(vi.mocked(storeCredential)).not.toHaveBeenCalled();
  expect(useAppStore.getState().passwordPromptOpen).toBe(false);
}

beforeEach(() => {
  vi.clearAllMocks();
  progressListener = null;
  mockedCreateTerminal.mockResolvedValue("session-1");
  mockedResolveCredential.mockResolvedValue("stored-secret");
  addTabSpy = vi.fn(() => "tab-new");
  loadingSpy = vi.spyOn(toast, "loading").mockReturnValue("connecting-toast");
  vi.spyOn(toast, "dismiss").mockImplementation(() => {});
  infoSpy = vi.spyOn(toast, "info").mockReturnValue("info-toast");
  useAppStore.setState({
    ...useAppStore.getInitialState(),
    addTab: addTabSpy as unknown as ReturnType<typeof useAppStore.getState>["addTab"],
    credentialStoreStatus: { mode: "master_password", status: "unlocked" },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("connectSavedConnection — abortable pre-connect (#5180)", () => {
  it("aborts while the credential store unlock is pending and ignores a late unlock", async () => {
    const unlock = deferred<boolean>();
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "locked" },
      requestUnlock: (() => unlock.promise) as unknown as ReturnType<
        typeof useAppStore.getState
      >["requestUnlock"],
    });
    const pending = connectSavedConnection(sshPassword());
    await flush();
    pressAbort();
    expectCleanCancel(await pending);

    unlock.resolve(true);
    await flush();
    expect(mockedResolveCredential).not.toHaveBeenCalled();
    expect(mockedCreateTerminal).not.toHaveBeenCalled();
    expect(addTabSpy).not.toHaveBeenCalled();
  });

  it("aborts while the stored credential resolves and ignores the late secret", async () => {
    const secret = deferred<string | null>();
    mockedResolveCredential.mockReturnValue(secret.promise);
    const pending = connectSavedConnection(sshPassword());
    await flush();
    pressAbort();
    expectCleanCancel(await pending);

    secret.resolve("stored-secret");
    await flush();
    expect(mockedCreateTerminal).not.toHaveBeenCalled();
    expect(addTabSpy).not.toHaveBeenCalled();
  });

  it("aborts the blocking pre-connect: cancels it in the backend by its connect id", async () => {
    const connect = deferred<string>();
    mockedCreateTerminal.mockReturnValue(connect.promise);
    const pending = connectSavedConnection(sshPassword());
    await flush();
    expect(mockedCreateTerminal).toHaveBeenCalledOnce();
    const connectId = mockedCreateTerminal.mock.calls[0]?.[1];
    expect(connectId).toMatch(/^preconnect-/);

    pressAbort();
    expectCleanCancel(await pending);
    expect(vi.mocked(cancelConnecting)).toHaveBeenCalledWith(connectId);
    // The progress subscription is released with the attempt.
    await flush();
    expect(unlistenSpy).toHaveBeenCalled();
  });

  it("closes a session that still comes up after Abort, never adopting it", async () => {
    const connect = deferred<string>();
    mockedCreateTerminal.mockReturnValue(connect.promise);
    const pending = connectSavedConnection(sshPassword());
    await flush();
    pressAbort();
    expectCleanCancel(await pending);

    connect.resolve("late-session");
    await flush();
    expect(vi.mocked(closeTerminal)).toHaveBeenCalledWith("late-session");
    expect(addTabSpy).not.toHaveBeenCalled();
  });

  it("drops a late failure after Abort: no tab, no prompt, no second connect", async () => {
    const connect = deferred<string>();
    mockedCreateTerminal.mockReturnValue(connect.promise);
    const pending = connectSavedConnection(sshPassword());
    await flush();
    pressAbort();
    expectCleanCancel(await pending);

    connect.reject({ code: "cancelled", message: "Connection cancelled", details: null });
    await flush();
    expect(mockedCreateTerminal).toHaveBeenCalledOnce();
    expect(addTabSpy).not.toHaveBeenCalled();
    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
  });

  it("an Abort pressed twice cancels once and acknowledges once", async () => {
    const connect = deferred<string>();
    mockedCreateTerminal.mockReturnValue(connect.promise);
    const pending = connectSavedConnection(sshPassword());
    await flush();
    pressAbort();
    pressAbort();
    await pending;
    expect(vi.mocked(cancelConnecting)).toHaveBeenCalledOnce();
    expect(infoSpy).toHaveBeenCalledOnce();
  });

  it("shows the backend's connect stage on the toast while the pre-connect runs", async () => {
    const connect = deferred<string>();
    mockedCreateTerminal.mockReturnValue(connect.promise);
    const pending = connectSavedConnection(sshPassword());
    await flush();
    const connectId = mockedCreateTerminal.mock.calls[0]?.[1] as string;
    // Another attempt's report is not this toast's.
    progressListener?.({ connectId: "tab-x:0", stage: "authenticate", status: null });
    progressListener?.({ connectId, stage: "connect", status: null });
    expect(loadingSpy).toHaveBeenCalledTimes(2);
    expect(loadingSpy).toHaveBeenLastCalledWith(
      "Connecting…",
      expect.objectContaining({ id: "connecting-toast", description: "Connect (2 of 5)" })
    );
    connect.resolve("session-1");
    await pending;
  });

  it("an unreachable host connects exactly once: the tab is handed the failure", async () => {
    const unreachable = { code: "timeout", message: "Connection timed out", details: null };
    mockedCreateTerminal.mockRejectedValue(unreachable);
    const result = await connectSavedConnection(sshPassword());

    expect(mockedCreateTerminal).toHaveBeenCalledOnce();
    expect(result).toEqual({ status: "opened", tabId: "tab-new", sessionId: null });
    // The tab keeps the stored credential, so its Retry uses it.
    expect(addTabSpy).toHaveBeenCalledWith(
      "web-1",
      "ssh",
      expect.objectContaining({
        config: expect.objectContaining({ password: "stored-secret" }),
      }),
      expect.anything()
    );
    // The tab takes the failure on mount instead of connecting a second time.
    expect(takePreconnectFailure("tab-new")).toEqual({ found: true, error: unreachable });
    expect(takePreconnectFailure("tab-new")).toEqual({ found: false });
    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
  });

  it("leaves the auth-failure path unchanged: the saved secret is kept and re-prompted", async () => {
    mockedCreateTerminal.mockRejectedValue(
      new Error("[thub-code:auth_failed] Authentication failed")
    );
    void connectSavedConnection(sshPassword());
    await flush();
    expect(useAppStore.getState().passwordPromptOpen).toBe(true);
    expect(useAppStore.getState().passwordPromptSavedRejected).toBe(true);
    expect(addTabSpy).not.toHaveBeenCalled();
    expect(takePreconnectFailure("tab-new")).toEqual({ found: false });
    expect(vi.mocked(storeCredential)).not.toHaveBeenCalled();
  });
});
