/**
 * File-browser actions after the reducer removal (#2283) — the `appStore`
 * file-browser actions hold no local view slice: they do the async list op and
 * report each transition through granular `fileBrowser.*` intents against the
 * authoritative `file-browser` region. These tests prove that a run of the real
 * actions reconstructs the exact projected view a reader renders — the active pane,
 * the two panes, and the clipboard — for every action and its fan-out, with the
 * transitions overlaid synchronously (gap-free) and confirmed by the backend
 * substrate double.
 *
 * # Scope
 *
 * The per-pane list operations mirror only the browser *view* fields (path /
 * listing / list flags); the session model (`sessionFileBrowserId`) stays an
 * `appStore` field and is not part of the projected view.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  sessionListFiles: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  getConnectionTypes: vi.fn(() => Promise.resolve([])),
}));

import { useAppStore, type FileClipboard } from "./appStore";
import { localListDir, sessionListFiles } from "@/services/api";
import { currentFileBrowsersView } from "./fileBrowsersBridge";
import {
  fileBrowsersHarnessTransport,
  seedFileBrowsers,
  setupFileBrowsersRegion,
} from "@/test/fileBrowsersRegionTestHarness";
import type { FileEntry } from "@/types/connection";

function entry(name: string, isDirectory = false): FileEntry {
  return {
    name,
    path: `/${name}`,
    isDirectory,
    size: 0,
    modified: "",
    permissions: null,
    writable: null,
    isSymlink: false,
    symlinkTarget: null,
  };
}

/** A promise whose resolution is controlled externally, for out-of-order tests. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Settle the microtask queue a few times so overlay + reflected dispatch land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

setupFileBrowsersRegion();

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

const flush = () => Promise.resolve();

/** Assert the backend substrate view equals the projected view a reader renders. */
function expectParity() {
  expect(fileBrowsersHarnessTransport().regionView()).toEqual(currentFileBrowsersView());
}

describe("file-browser actions drive the authoritative region", () => {
  it("setFileBrowserMode reproduces the active pane", () => {
    useAppStore.getState().setFileBrowserMode("local");
    expect(fileBrowsersHarnessTransport().kinds()).toEqual(["fileBrowser.setMode"]);
    expect(currentFileBrowsersView().mode).toBe("local");
    expectParity();

    useAppStore.getState().setFileBrowserMode("none");
    expect(currentFileBrowsersView().mode).toBe("none");
    expectParity();
  });

  it("navigateLocal commits the pane path + listing", async () => {
    vi.mocked(localListDir).mockResolvedValue([entry("a"), entry("dir", true)]);

    await useAppStore.getState().navigateLocal("/home/user");
    await flush();

    expect(fileBrowsersHarnessTransport().kinds()).toEqual([
      "fileBrowser.loadStarted",
      "fileBrowser.loadSucceeded",
    ]);
    const view = currentFileBrowsersView();
    expect(view.local.path).toBe("/home/user");
    expect(view.local.entries.map((e) => e.name)).toEqual(["a", "dir"]);
    expect(view.local.loading).toBe(false);
    expectParity();
  });

  it("navigateLocal records the pane error on failure", async () => {
    vi.mocked(localListDir).mockRejectedValue(new Error("nope"));

    await useAppStore.getState().navigateLocal("/root");
    await flush();

    expect(fileBrowsersHarnessTransport().kinds()).toEqual([
      "fileBrowser.loadStarted",
      "fileBrowser.loadFailed",
    ]);
    expect(currentFileBrowsersView().local.error).toBe("nope");
    expect(currentFileBrowsersView().local.loading).toBe(false);
    expectParity();
  });

  it("refreshLocal re-lists the current local path from the region", async () => {
    vi.mocked(localListDir).mockResolvedValue([entry("x")]);
    await useAppStore.getState().navigateLocal("/tmp");
    vi.mocked(localListDir).mockResolvedValue([entry("x"), entry("y")]);

    await useAppStore.getState().refreshLocal();
    await flush();

    expect(currentFileBrowsersView().local.path).toBe("/tmp");
    expect(currentFileBrowsersView().local.entries.map((e) => e.name)).toEqual(["x", "y"]);
    expectParity();
  });

  it("navigateSession commits the session pane path + listing", async () => {
    vi.mocked(sessionListFiles).mockResolvedValue([entry("s")]);

    await useAppStore.getState().navigateSession("sess-1", "/srv");
    await flush();

    expect(fileBrowsersHarnessTransport().kinds()).toEqual([
      "fileBrowser.loadStarted",
      "fileBrowser.loadSucceeded",
    ]);
    expect(currentFileBrowsersView().session.path).toBe("/srv");
    expect(currentFileBrowsersView().session.entries.map((e) => e.name)).toEqual(["s"]);
    expectParity();
  });

  it("navigateSession records the session pane error on failure", async () => {
    vi.mocked(sessionListFiles).mockRejectedValue(new Error("denied"));

    await useAppStore.getState().navigateSession("sess-1", "/srv");
    await flush();

    expect(currentFileBrowsersView().session.error).toBe("denied");
    expectParity();
  });

  it("refreshSession re-lists the current session path (id from appStore, path from region)", async () => {
    useAppStore.setState({ sessionFileBrowserId: "sess-1" });
    seedFileBrowsers({ session: { path: "/srv", entries: [], loading: false, error: null } });
    vi.mocked(sessionListFiles).mockResolvedValue([entry("s"), entry("t")]);

    await useAppStore.getState().refreshSession();
    await flush();

    expect(vi.mocked(sessionListFiles)).toHaveBeenCalledWith("sess-1", "/srv");
    expect(currentFileBrowsersView().session.entries.map((e) => e.name)).toEqual(["s", "t"]);
    expectParity();
  });

  it("refreshSession is a no-op when there is no session file-browser id", async () => {
    useAppStore.setState({ sessionFileBrowserId: null });
    await useAppStore.getState().refreshSession();
    expect(vi.mocked(sessionListFiles)).not.toHaveBeenCalled();
    expect(fileBrowsersHarnessTransport().kinds()).toEqual([]);
  });

  it("setFileClipboard sets then clears the clipboard", () => {
    const clipboard: FileClipboard = {
      entries: [entry("c")],
      operation: "copy",
      sourceMode: "local",
      sourcePath: "/home",
    };

    useAppStore.getState().setFileClipboard(clipboard);
    expect(fileBrowsersHarnessTransport().kinds()).toEqual(["fileBrowser.setClipboard"]);
    expect(currentFileBrowsersView().clipboard).toEqual(clipboard);
    expectParity();

    useAppStore.getState().setFileClipboard(null);
    expect(currentFileBrowsersView().clipboard).toBeNull();
    expectParity();
  });

  it("a full browser lifecycle stays in parity across every step", async () => {
    vi.mocked(localListDir).mockResolvedValue([entry("a")]);
    vi.mocked(sessionListFiles).mockResolvedValue([entry("s")]);

    useAppStore.getState().setFileBrowserMode("local");
    expectParity();
    await useAppStore.getState().navigateLocal("/home");
    await flush();
    expectParity();
    useAppStore.getState().setFileBrowserMode("session");
    expectParity();
    await useAppStore.getState().navigateSession("sess-1", "/srv");
    await flush();
    expectParity();
    useAppStore.getState().setFileClipboard({
      entries: [entry("a")],
      operation: "cut",
      sourceMode: "local",
      sourcePath: "/home",
    });
    expectParity();
    useAppStore.getState().setFileClipboard(null);
    expectParity();
    useAppStore.getState().setFileBrowserMode("none");
    expectParity();
  });
});

describe("stale directory-list responses are dropped by request order (SM-007)", () => {
  // These tests drive the list mocks through per-call deferred promises. Fully
  // reset them (not just clear call history) so a persistent `mockResolvedValue`
  // left by an earlier test in this file cannot answer an unconsumed call.
  beforeEach(() => {
    vi.mocked(localListDir).mockReset();
    vi.mocked(sessionListFiles).mockReset();
  });

  it("navigateSession: an earlier response resolving LAST does not clobber the latest", async () => {
    const dA = deferred<FileEntry[]>();
    const dB = deferred<FileEntry[]>();
    vi.mocked(sessionListFiles)
      .mockImplementationOnce(() => dA.promise)
      .mockImplementationOnce(() => dB.promise);

    // Fire A then B without awaiting — both list requests are in flight.
    const pA = useAppStore.getState().navigateSession("sess-1", "/A");
    const pB = useAppStore.getState().navigateSession("sess-1", "/B");

    // The latest navigation (B) resolves first and wins.
    dB.resolve([entry("b")]);
    await pB;
    await settle();
    expect(currentFileBrowsersView().session.path).toBe("/B");

    // The stale earlier navigation (A) resolves LAST — it must be dropped, so the
    // view stays on B and A's listing never replaces it.
    dA.resolve([entry("a")]);
    await pA;
    await settle();

    expect(currentFileBrowsersView().session.path).toBe("/B");
    expect(currentFileBrowsersView().session.entries.map((e) => e.name)).toEqual(["b"]);
    expect(currentFileBrowsersView().session.loading).toBe(false);
    expect(currentFileBrowsersView().session.error).toBeNull();
    // Only B's terminal success is applied; A's stale success is dropped.
    expect(fileBrowsersHarnessTransport().kinds()).toEqual([
      "fileBrowser.loadStarted",
      "fileBrowser.loadStarted",
      "fileBrowser.loadSucceeded",
    ]);
    expectParity();
  });

  it("navigateSession: a stale response resolving FIRST does not clear the pending spinner", async () => {
    const dA = deferred<FileEntry[]>();
    const dB = deferred<FileEntry[]>();
    vi.mocked(sessionListFiles)
      .mockImplementationOnce(() => dA.promise)
      .mockImplementationOnce(() => dB.promise);

    const pA = useAppStore.getState().navigateSession("sess-1", "/A");
    const pB = useAppStore.getState().navigateSession("sess-1", "/B");

    // The superseded request (A) resolves first. It is dropped, and crucially it
    // must NOT clear loading — the newest request (B) is still in flight and its
    // own resolve is what clears the spinner.
    dA.resolve([entry("a")]);
    await pA;
    await settle();
    expect(currentFileBrowsersView().session.loading).toBe(true);
    expect(currentFileBrowsersView().session.path).not.toBe("/A");

    // B resolves and clears loading, landing the view on B.
    dB.resolve([entry("b")]);
    await pB;
    await settle();
    expect(currentFileBrowsersView().session.loading).toBe(false);
    expect(currentFileBrowsersView().session.path).toBe("/B");
    expect(currentFileBrowsersView().session.entries.map((e) => e.name)).toEqual(["b"]);
    expectParity();
  });

  it("navigateSession: a stale FAILURE resolving last does not overwrite the latest success", async () => {
    const dA = deferred<FileEntry[]>();
    const dB = deferred<FileEntry[]>();
    vi.mocked(sessionListFiles)
      .mockImplementationOnce(() => dA.promise)
      .mockImplementationOnce(() => dB.promise);

    const pA = useAppStore.getState().navigateSession("sess-1", "/A");
    const pB = useAppStore.getState().navigateSession("sess-1", "/B");

    dB.resolve([entry("b")]);
    await pB;
    await settle();

    // A fails late — its error must not surface over the successful newer view.
    dA.reject(new Error("A failed"));
    await pA;
    await settle();

    expect(currentFileBrowsersView().session.path).toBe("/B");
    expect(currentFileBrowsersView().session.error).toBeNull();
    expect(currentFileBrowsersView().session.loading).toBe(false);
    expectParity();
  });

  it("refreshSession: a stale refresh response resolving last is dropped", async () => {
    useAppStore.setState({ sessionFileBrowserId: "sess-1" });
    seedFileBrowsers({ session: { path: "/srv", entries: [], loading: false, error: null } });

    const d1 = deferred<FileEntry[]>();
    const d2 = deferred<FileEntry[]>();
    vi.mocked(sessionListFiles)
      .mockImplementationOnce(() => d1.promise)
      .mockImplementationOnce(() => d2.promise);

    const p1 = useAppStore.getState().refreshSession();
    const p2 = useAppStore.getState().refreshSession();

    d2.resolve([entry("s"), entry("t")]);
    await p2;
    await settle();

    d1.resolve([entry("stale")]);
    await p1;
    await settle();

    expect(currentFileBrowsersView().session.entries.map((e) => e.name)).toEqual(["s", "t"]);
    expect(currentFileBrowsersView().session.loading).toBe(false);
    expectParity();
  });

  it("navigateLocal: an earlier response resolving last is dropped (local pane guarded too)", async () => {
    const dA = deferred<FileEntry[]>();
    const dB = deferred<FileEntry[]>();
    vi.mocked(localListDir)
      .mockImplementationOnce(() => dA.promise)
      .mockImplementationOnce(() => dB.promise);

    const pA = useAppStore.getState().navigateLocal("/a");
    const pB = useAppStore.getState().navigateLocal("/b");

    dB.resolve([entry("b")]);
    await pB;
    await settle();

    dA.resolve([entry("a")]);
    await pA;
    await settle();

    expect(currentFileBrowsersView().local.path).toBe("/b");
    expect(currentFileBrowsersView().local.entries.map((e) => e.name)).toEqual(["b"]);
    expect(currentFileBrowsersView().local.loading).toBe(false);
    expectParity();
  });

  it("navigateLocal normalizes backslashes and expands a bare drive letter", async () => {
    vi.mocked(localListDir).mockReset();
    vi.mocked(localListDir).mockResolvedValue([entry("a")]);

    // A bare drive letter ("C:") is expanded to its root form ("C:/") so the Up
    // button can detect the drive-root boundary (line 90 branch).
    await useAppStore.getState().navigateLocal("C:");
    await flush();
    expect(vi.mocked(localListDir)).toHaveBeenLastCalledWith("C:/");
    expect(currentFileBrowsersView().local.path).toBe("C:/");

    // Backslashes are normalized to forward slashes uniformly across platforms.
    await useAppStore.getState().navigateLocal("C:\\Users\\me");
    await flush();
    expect(vi.mocked(localListDir)).toHaveBeenLastCalledWith("C:/Users/me");
    expect(currentFileBrowsersView().local.path).toBe("C:/Users/me");
  });

  it("navigateLocal stringifies a non-Error rejection (String(err) branch)", async () => {
    vi.mocked(localListDir).mockReset();
    // Reject with a plain string so the `err instanceof Error` guard takes its
    // `String(err)` alternate rather than reading `.message`.
    vi.mocked(localListDir).mockRejectedValue("disk gone");

    await useAppStore.getState().navigateLocal("/x");
    await flush();

    expect(currentFileBrowsersView().local.error).toBe("disk gone");
    expect(currentFileBrowsersView().local.loading).toBe(false);
    expectParity();
  });

  it("refreshLocal records the pane error on a failed re-list", async () => {
    vi.mocked(localListDir).mockReset();
    vi.mocked(localListDir).mockResolvedValueOnce([entry("x")]);
    await useAppStore.getState().navigateLocal("/tmp");
    await flush();

    vi.mocked(localListDir).mockRejectedValueOnce(new Error("refresh failed"));
    await useAppStore.getState().refreshLocal();
    await flush();

    expect(currentFileBrowsersView().local.error).toBe("refresh failed");
    expect(currentFileBrowsersView().local.loading).toBe(false);
    expectParity();
  });

  it("navigateSession stringifies a non-Error rejection (String(err) branch)", async () => {
    vi.mocked(sessionListFiles).mockReset();
    vi.mocked(sessionListFiles).mockRejectedValue("session dropped");

    await useAppStore.getState().navigateSession("sess-1", "/srv");
    await flush();

    expect(currentFileBrowsersView().session.error).toBe("session dropped");
    expect(currentFileBrowsersView().session.loading).toBe(false);
    expectParity();
  });

  it("refreshSession records the pane error on a failed re-list", async () => {
    useAppStore.setState({ sessionFileBrowserId: "sess-1" });
    seedFileBrowsers({ session: { path: "/srv", entries: [], loading: false, error: null } });
    vi.mocked(sessionListFiles).mockReset();
    vi.mocked(sessionListFiles).mockRejectedValueOnce(new Error("no route"));

    await useAppStore.getState().refreshSession();
    await flush();

    expect(currentFileBrowsersView().session.error).toBe("no route");
    expect(currentFileBrowsersView().session.loading).toBe(false);
    expectParity();
  });

  it("setSessionFileBrowserId sets then clears the active session id", () => {
    useAppStore.getState().setSessionFileBrowserId("sess-9");
    expect(useAppStore.getState().sessionFileBrowserId).toBe("sess-9");

    useAppStore.getState().setSessionFileBrowserId(null);
    expect(useAppStore.getState().sessionFileBrowserId).toBeNull();
  });

  it("clearFileBrowserError dismisses a pane error without re-listing (SM-008)", async () => {
    vi.mocked(localListDir).mockReset();
    vi.mocked(localListDir).mockRejectedValueOnce(new Error("boom"));
    await useAppStore.getState().navigateLocal("/root");
    await flush();
    expect(currentFileBrowsersView().local.error).toBe("boom");

    useAppStore.getState().clearFileBrowserError("local");
    expect(currentFileBrowsersView().local.error).toBeNull();
    // Dismiss is client-only — it does not issue a fresh directory listing.
    expect(vi.mocked(localListDir)).toHaveBeenCalledTimes(1);
    expectParity();
  });

  it("clearFileBrowserError dismisses the session pane error too", async () => {
    vi.mocked(sessionListFiles).mockReset();
    vi.mocked(sessionListFiles).mockRejectedValueOnce(new Error("denied"));
    await useAppStore.getState().navigateSession("sess-1", "/srv");
    await flush();
    expect(currentFileBrowsersView().session.error).toBe("denied");

    useAppStore.getState().clearFileBrowserError("session");
    expect(currentFileBrowsersView().session.error).toBeNull();
    expectParity();
  });

  it("navigateSession and navigateLocal keep independent per-pane request counters", async () => {
    const dLocal = deferred<FileEntry[]>();
    const dSession = deferred<FileEntry[]>();
    vi.mocked(localListDir).mockImplementationOnce(() => dLocal.promise);
    vi.mocked(sessionListFiles).mockImplementationOnce(() => dSession.promise);

    // Local and session navigations are concurrently in flight across the two panes.
    const pLocal = useAppStore.getState().navigateLocal("/local");
    const pSession = useAppStore.getState().navigateSession("sess-1", "/session");

    dSession.resolve([entry("s")]);
    await pSession;
    await settle();
    dLocal.resolve([entry("l")]);
    await pLocal;
    await settle();

    // Because each pane owns an independent counter, neither in-flight request is
    // the "latest" of the *other* pane, so BOTH terminal successes are applied —
    // both `loadSucceeded` intents are dispatched. A single shared counter would
    // treat the session navigation as superseding the local one (or vice-versa) and
    // drop one of the successes, leaving only three intents here. `.kinds()` is
    // recorded synchronously at dispatch, so this assertion is immune to
    // projection-timing races. The per-pane last-write-wins behaviour itself is
    // covered by the dedicated navigateSession / navigateLocal tests above.
    expect(fileBrowsersHarnessTransport().kinds()).toEqual([
      "fileBrowser.loadStarted",
      "fileBrowser.loadStarted",
      "fileBrowser.loadSucceeded",
      "fileBrowser.loadSucceeded",
    ]);
  });
});
