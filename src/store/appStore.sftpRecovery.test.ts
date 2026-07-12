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
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
}));

import { useAppStore, _resetSftpListSeq } from "./appStore";
import { sftpOpen, sftpListDir } from "@/services/api";
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

describe("appStore — SFTP failed-connect recovery (S1)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    _resetSftpListSeq();
    vi.clearAllMocks();
  });

  it("connectSftp persists the config used so Retry has something to call", async () => {
    vi.mocked(sftpOpen).mockRejectedValue(new Error("auth failed"));

    await useAppStore.getState().connectSftp(SAMPLE_CONFIG);

    const state = useAppStore.getState();
    expect(state.sftpError).toBe("auth failed");
    expect(state.sftpSessionId).toBeNull();
    // The last config must be retained so a Retry control can re-invoke connect.
    expect(state.sftpLastConfig).toEqual(SAMPLE_CONFIG);
  });

  it("retrySftp re-invokes connectSftp with the last config and can succeed", async () => {
    // First attempt fails.
    vi.mocked(sftpOpen).mockRejectedValueOnce(new Error("host down"));
    await useAppStore.getState().connectSftp(SAMPLE_CONFIG);
    expect(useAppStore.getState().sftpError).toBe("host down");

    // Second attempt (via retry) succeeds.
    vi.mocked(sftpOpen).mockResolvedValueOnce("session-xyz");
    vi.mocked(sftpListDir).mockResolvedValue([makeEntry("home")]);

    await useAppStore.getState().retrySftp();

    const state = useAppStore.getState();
    expect(sftpOpen).toHaveBeenCalledTimes(2);
    expect(sftpOpen).toHaveBeenLastCalledWith(SAMPLE_CONFIG);
    expect(state.sftpSessionId).toBe("session-xyz");
    expect(state.sftpError).toBeNull();
  });

  it("retrySftp is a no-op when there is no persisted config", async () => {
    await useAppStore.getState().retrySftp();
    expect(sftpOpen).not.toHaveBeenCalled();
  });

  it("dismissSftpError clears the error so the failed-connect placeholder resets", async () => {
    vi.mocked(sftpOpen).mockRejectedValue(new Error("nope"));
    await useAppStore.getState().connectSftp(SAMPLE_CONFIG);
    expect(useAppStore.getState().sftpError).toBe("nope");

    useAppStore.getState().dismissSftpError();

    expect(useAppStore.getState().sftpError).toBeNull();
  });

  it("disconnectSftp clears the persisted last config", async () => {
    vi.mocked(sftpOpen).mockResolvedValue("session-1");
    vi.mocked(sftpListDir).mockResolvedValue([makeEntry("home")]);
    await useAppStore.getState().connectSftp(SAMPLE_CONFIG);
    expect(useAppStore.getState().sftpLastConfig).toEqual(SAMPLE_CONFIG);

    await useAppStore.getState().disconnectSftp();

    expect(useAppStore.getState().sftpLastConfig).toBeNull();
  });
});

describe("appStore — SFTP dropped-session recovery (S2)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({
      sftpSessionId: "session-1",
      sftpConnectedHost: "alice@example.com:22",
    });
    _resetSftpListSeq();
    vi.clearAllMocks();
  });

  it("navigateSftp clears sftpSessionId on a session-not-found error", async () => {
    vi.mocked(sftpListDir).mockRejectedValue(new Error("SFTP session not found: session-1"));

    await useAppStore.getState().navigateSftp("/tmp");

    const state = useAppStore.getState();
    // The dead session must no longer look "connected" — clearing the id lets
    // the auto-connect effect re-establish and exposes a Reconnect control.
    expect(state.sftpSessionId).toBeNull();
    expect(state.sftpConnectedHost).toBeNull();
    expect(state.sftpError).toContain("session not found");
    // The overloaded `sftpLoading` boolean was replaced by an explicit status
    // enum (audit gap A1); a failed list settles on `error`, not a loading flag.
    expect(state.sftpStatus).toBe("error");
  });

  it("refreshSftp clears sftpSessionId on a transport/channel error", async () => {
    vi.mocked(sftpListDir).mockRejectedValue(new Error("channel closed by peer"));

    await useAppStore.getState().refreshSftp();

    const state = useAppStore.getState();
    expect(state.sftpSessionId).toBeNull();
    expect(state.sftpConnectedHost).toBeNull();
    expect(state.sftpStatus).toBe("error");
  });

  it("navigateSftp keeps sftpSessionId on an ordinary listing error (e.g. permission denied)", async () => {
    vi.mocked(sftpListDir).mockRejectedValue(new Error("permission denied"));

    await useAppStore.getState().navigateSftp("/root");

    const state = useAppStore.getState();
    // A recoverable per-directory error must NOT drop the whole session.
    expect(state.sftpSessionId).toBe("session-1");
    expect(state.sftpError).toContain("permission denied");
  });
});
