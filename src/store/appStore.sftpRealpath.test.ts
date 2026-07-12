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

describe("appStore — SFTP home resolved via realpath (C2)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    _resetSftpListSeq();
    vi.clearAllMocks();
  });

  it("connectSftp uses the realpath-resolved home as the initial directory", async () => {
    vi.mocked(sftpOpen).mockResolvedValue("session-1");
    // Real home is NOT the /home/<user> guess — e.g. a non-Linux layout.
    vi.mocked(sftpRealpath).mockResolvedValue("/Users/alice");
    vi.mocked(sftpListDir).mockResolvedValue([makeEntry("Documents")]);

    await useAppStore.getState().connectSftp(SAMPLE_CONFIG);

    // The remote home must be resolved via realpath(".") rather than string-built.
    expect(sftpRealpath).toHaveBeenCalledWith("session-1", ".");
    // The listing must target the resolved path, not "/home/alice".
    expect(sftpListDir).toHaveBeenCalledWith("session-1", "/Users/alice");

    const state = useAppStore.getState();
    expect(state.sftpSessionId).toBe("session-1");
    expect(state.currentPath).toBe("/Users/alice");
    expect(state.fileEntries).toEqual([makeEntry("Documents")]);
    expect(state.sftpError).toBeNull();
  });

  it("connectSftp falls back to root when realpath resolution fails", async () => {
    vi.mocked(sftpOpen).mockResolvedValue("session-2");
    vi.mocked(sftpRealpath).mockRejectedValue(new Error("realpath unsupported"));
    vi.mocked(sftpListDir).mockResolvedValue([makeEntry("etc")]);

    await useAppStore.getState().connectSftp(SAMPLE_CONFIG);

    // Graceful fallback: still connect, listing root.
    expect(sftpListDir).toHaveBeenCalledWith("session-2", "/");

    const state = useAppStore.getState();
    expect(state.sftpSessionId).toBe("session-2");
    expect(state.currentPath).toBe("/");
    expect(state.fileEntries).toEqual([makeEntry("etc")]);
    // Fallback is graceful — the connect itself must not surface as an error.
    expect(state.sftpError).toBeNull();
  });

  it("connectSftp falls back to root when listing the resolved home fails", async () => {
    vi.mocked(sftpOpen).mockResolvedValue("session-3");
    vi.mocked(sftpRealpath).mockResolvedValue("/home/alice");
    vi.mocked(sftpListDir).mockImplementation(async (_id: string, path: string) => {
      if (path === "/home/alice") throw new Error("permission denied");
      return [makeEntry("root")];
    });

    await useAppStore.getState().connectSftp(SAMPLE_CONFIG);

    const state = useAppStore.getState();
    expect(state.sftpSessionId).toBe("session-3");
    expect(state.currentPath).toBe("/");
    expect(state.fileEntries).toEqual([makeEntry("root")]);
    expect(state.sftpError).toBeNull();
  });
});
