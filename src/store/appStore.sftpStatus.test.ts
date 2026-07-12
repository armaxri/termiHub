import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve("persisted-id")),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  moveConnectionToFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  sftpRealpath: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
}));

import { useAppStore, _resetSftpListSeq } from "./appStore";
import { sftpOpen, sftpListDir, sftpRealpath } from "@/services/api";
import type { FileEntry } from "@/types/connection";

function makeEntry(name: string): FileEntry {
  return {
    name,
    path: `/${name}`,
    isDirectory: true,
    size: 0,
    modified: "",
    permissions: null,
    writable: null,
  };
}

const SAMPLE_CONFIG = { host: "example.com", port: 22, username: "alice", password: "pw" };

/**
 * Deferred promise helper: lets a test observe the intermediate store state
 * while an async store action is still in flight (before the mocked API call
 * resolves). Used to assert the transient `connecting` / `listing` statuses.
 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("appStore — sftpStatus enum transitions (A1)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    _resetSftpListSeq();
    vi.clearAllMocks();
    // connectSftp resolves the remote home via realpath(".") (audit gap C2);
    // default it so the connect path does not fall back to root.
    vi.mocked(sftpRealpath).mockResolvedValue("/home/alice");
  });

  it("starts in the 'idle' status", () => {
    expect(useAppStore.getState().sftpStatus).toBe("idle");
  });

  it("connectSftp transitions idle → connecting → connected on success", async () => {
    const open = deferred<string>();
    vi.mocked(sftpOpen).mockReturnValue(open.promise);
    vi.mocked(sftpListDir).mockResolvedValue([makeEntry("home")]);

    const connectPromise = useAppStore.getState().connectSftp(SAMPLE_CONFIG);

    // While sftpOpen is pending the status must read 'connecting'.
    expect(useAppStore.getState().sftpStatus).toBe("connecting");

    open.resolve("session-1");
    await connectPromise;

    expect(useAppStore.getState().sftpStatus).toBe("connected");
    expect(useAppStore.getState().sftpSessionId).toBe("session-1");
  });

  it("connectSftp transitions idle → connecting → error on failure", async () => {
    vi.mocked(sftpOpen).mockRejectedValue(new Error("auth failed"));

    await useAppStore.getState().connectSftp(SAMPLE_CONFIG);

    const state = useAppStore.getState();
    expect(state.sftpStatus).toBe("error");
    expect(state.sftpError).toBe("auth failed");
    expect(state.sftpSessionId).toBeNull();
  });

  it("navigateSftp transitions connected → listing → connected on success", async () => {
    // Establish a connected session first.
    vi.mocked(sftpOpen).mockResolvedValue("session-1");
    vi.mocked(sftpListDir).mockResolvedValue([makeEntry("home")]);
    await useAppStore.getState().connectSftp(SAMPLE_CONFIG);
    expect(useAppStore.getState().sftpStatus).toBe("connected");

    const list = deferred<FileEntry[]>();
    vi.mocked(sftpListDir).mockReturnValue(list.promise);

    const navPromise = useAppStore.getState().navigateSftp("/tmp");

    // While the list request is pending the status must read 'listing'.
    expect(useAppStore.getState().sftpStatus).toBe("listing");

    list.resolve([makeEntry("tmpfile")]);
    await navPromise;

    expect(useAppStore.getState().sftpStatus).toBe("connected");
    expect(useAppStore.getState().currentPath).toBe("/tmp");
  });

  it("refreshSftp transitions connected → listing → connected on success", async () => {
    vi.mocked(sftpOpen).mockResolvedValue("session-1");
    vi.mocked(sftpListDir).mockResolvedValue([makeEntry("home")]);
    await useAppStore.getState().connectSftp(SAMPLE_CONFIG);
    expect(useAppStore.getState().sftpStatus).toBe("connected");

    const list = deferred<FileEntry[]>();
    vi.mocked(sftpListDir).mockReturnValue(list.promise);

    const refreshPromise = useAppStore.getState().refreshSftp();
    expect(useAppStore.getState().sftpStatus).toBe("listing");

    list.resolve([makeEntry("home")]);
    await refreshPromise;

    expect(useAppStore.getState().sftpStatus).toBe("connected");
  });

  it("navigateSftp transitions connected → listing → error but stays connected on a recoverable listing error", async () => {
    vi.mocked(sftpOpen).mockResolvedValue("session-1");
    vi.mocked(sftpListDir).mockResolvedValue([makeEntry("home")]);
    await useAppStore.getState().connectSftp(SAMPLE_CONFIG);

    vi.mocked(sftpListDir).mockRejectedValue(new Error("permission denied"));
    await useAppStore.getState().navigateSftp("/root");

    const state = useAppStore.getState();
    expect(state.sftpStatus).toBe("error");
    expect(state.sftpError).toContain("permission denied");
    // Recoverable error keeps the underlying session.
    expect(state.sftpSessionId).toBe("session-1");
  });

  it("navigateSftp on a dead-session error transitions to error and clears the session", async () => {
    vi.mocked(sftpOpen).mockResolvedValue("session-1");
    vi.mocked(sftpListDir).mockResolvedValue([makeEntry("home")]);
    await useAppStore.getState().connectSftp(SAMPLE_CONFIG);

    vi.mocked(sftpListDir).mockRejectedValue(new Error("SFTP session not found: session-1"));
    await useAppStore.getState().navigateSftp("/tmp");

    const state = useAppStore.getState();
    expect(state.sftpStatus).toBe("error");
    expect(state.sftpSessionId).toBeNull();
    expect(state.sftpConnectedHost).toBeNull();
  });

  it("disconnectSftp returns the status to 'idle'", async () => {
    vi.mocked(sftpOpen).mockResolvedValue("session-1");
    vi.mocked(sftpListDir).mockResolvedValue([makeEntry("home")]);
    await useAppStore.getState().connectSftp(SAMPLE_CONFIG);
    expect(useAppStore.getState().sftpStatus).toBe("connected");

    await useAppStore.getState().disconnectSftp();

    expect(useAppStore.getState().sftpStatus).toBe("idle");
    expect(useAppStore.getState().sftpSessionId).toBeNull();
  });

  it("dismissSftpError clears an error status back to idle when disconnected", async () => {
    vi.mocked(sftpOpen).mockRejectedValue(new Error("nope"));
    await useAppStore.getState().connectSftp(SAMPLE_CONFIG);
    expect(useAppStore.getState().sftpStatus).toBe("error");

    useAppStore.getState().dismissSftpError();

    const state = useAppStore.getState();
    expect(state.sftpError).toBeNull();
    // With no live session, dismissing the error returns to idle.
    expect(state.sftpStatus).toBe("idle");
  });

  it("dismissSftpError returns to 'connected' when a live session survived the error", async () => {
    vi.mocked(sftpOpen).mockResolvedValue("session-1");
    vi.mocked(sftpListDir).mockResolvedValue([makeEntry("home")]);
    await useAppStore.getState().connectSftp(SAMPLE_CONFIG);

    // A recoverable listing error leaves the session intact but flips to error.
    vi.mocked(sftpListDir).mockRejectedValue(new Error("permission denied"));
    await useAppStore.getState().navigateSftp("/root");
    expect(useAppStore.getState().sftpStatus).toBe("error");
    expect(useAppStore.getState().sftpSessionId).toBe("session-1");

    useAppStore.getState().dismissSftpError();

    const state = useAppStore.getState();
    expect(state.sftpError).toBeNull();
    expect(state.sftpStatus).toBe("connected");
  });

  it("retrySftp goes back through connecting to connected on a successful retry", async () => {
    vi.mocked(sftpOpen).mockRejectedValueOnce(new Error("host down"));
    await useAppStore.getState().connectSftp(SAMPLE_CONFIG);
    expect(useAppStore.getState().sftpStatus).toBe("error");

    vi.mocked(sftpOpen).mockResolvedValueOnce("session-xyz");
    vi.mocked(sftpListDir).mockResolvedValue([makeEntry("home")]);
    await useAppStore.getState().retrySftp();

    expect(useAppStore.getState().sftpStatus).toBe("connected");
    expect(useAppStore.getState().sftpSessionId).toBe("session-xyz");
  });
});
