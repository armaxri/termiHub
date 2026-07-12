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
import { sftpListDir } from "@/services/api";
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

/** A promise plus its resolve fn, so a test can control settle order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("appStore — SFTP overlapping-list race guard (R1)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({ sftpSessionId: "session-1" });
    _resetSftpListSeq();
    vi.clearAllMocks();
  });

  it("navigateSftp: a stale (superseded) response does not overwrite the newer one", async () => {
    const firstEntries = [makeEntry("stale-dir")];
    const secondEntries = [makeEntry("fresh-dir")];

    const firstList = deferred<FileEntry[]>();
    const secondList = deferred<FileEntry[]>();

    // First call (to /old) gets the first deferred; second call (to /new) the second.
    vi.mocked(sftpListDir)
      .mockImplementationOnce(() => firstList.promise)
      .mockImplementationOnce(() => secondList.promise);

    const store = useAppStore.getState();

    // Fire two navigations back-to-back. The SECOND is the user's latest intent.
    const p1 = store.navigateSftp("/old");
    const p2 = store.navigateSftp("/new");

    // Resolve out of order: the newer (second) request settles FIRST...
    secondList.resolve(secondEntries);
    await p2;

    // ...then the stale (first) request settles LAST. Without a guard, this
    // would clobber currentPath/fileEntries back to the superseded values.
    firstList.resolve(firstEntries);
    await p1;

    const state = useAppStore.getState();
    expect(state.currentPath).toBe("/new");
    expect(state.fileEntries).toEqual(secondEntries);
  });

  it("refreshSftp: a stale navigate response does not clobber a newer refresh", async () => {
    const navEntries = [makeEntry("nav-dir")];
    const refreshEntries = [makeEntry("refresh-dir")];

    const navList = deferred<FileEntry[]>();
    const refreshList = deferred<FileEntry[]>();

    vi.mocked(sftpListDir)
      .mockImplementationOnce(() => navList.promise)
      .mockImplementationOnce(() => refreshList.promise);

    const store = useAppStore.getState();

    const pNav = store.navigateSftp("/somewhere");
    const pRefresh = store.refreshSftp();

    // The later refresh settles first and should win.
    refreshList.resolve(refreshEntries);
    await pRefresh;

    // The earlier, now-stale navigate settles last and must be ignored.
    navList.resolve(navEntries);
    await pNav;

    const state = useAppStore.getState();
    expect(state.fileEntries).toEqual(refreshEntries);
  });
});
