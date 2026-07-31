/**
 * File-browsers mutation cut (#2228, part of #2139 and #2153) — cut-vs-local
 * parity.
 *
 * The mutation cut routes each file-browser UI-state action through a granular
 * `fileBrowser.*` intent so the client-scoped backend `FileBrowserStore` becomes
 * authoritative, while the local `appStore` reducer path stays in place as the
 * render source and the resilience / rollback fallback (the reducer removal is a
 * later step).
 *
 * These tests prove the cut is parity-safe end to end: with the flag **on**, the
 * intents dispatched by the actions — applied by a faithful in-memory port of the
 * Rust store (mirroring `file_browser_projection/store.rs`) — reproduce the exact
 * `appStore` file-browser view (the active pane, the three panes and the
 * clipboard, in the same shape `useProjectedFileBrowsers` renders) for every
 * action and its fan-out. With the flag **off**, no intents are dispatched and the
 * local slice is byte-identical — the instant rollback path the flip relies on.
 *
 * # Scope (#2236)
 *
 * The SFTP list operations (`navigateSftp` / `refreshSftp`) mirror only the
 * browser *view* fields (path / listing / list flags); the SFTP session model
 * (`sftpStatus`, session ids) and the connect / disconnect / session-death pane
 * resets stay `appStore`-driven and out of this cut, carried into the region by
 * the render-cut `fileBrowser.replace` mirror instead.
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
import { localListDir, sessionListFiles, sftpListDir } from "@/services/api";
import {
  FILE_BROWSERS_REGION,
  setFileBrowsersIntentsEnabled,
  setFileBrowsersTransportForTest,
  type FileBrowsersView,
} from "./fileBrowsersBridge";
import type { FileEntry } from "@/types/connection";
import type {
  FrameHandler,
  Intent,
  IntentAck,
  ProjectionFrame,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";

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

interface Pane {
  path: string;
  entries: FileEntry[];
  loading: boolean;
  error: string | null;
}

function emptyPane(): Pane {
  return { path: "/", entries: [], loading: false, error: null };
}

/**
 * An in-memory substrate double that applies the granular `fileBrowser.*` intents
 * with the same semantics as the Rust `FileBrowserStore`, so a run of the real
 * `appStore` actions (which mirror those intents) reconstructs the region view the
 * file-browser panel would render. Only `fileBrowser.replace` (the render-cut
 * mirror) is intentionally not applied here — the mutation cut drives the region
 * through the per-transition intents.
 */
class FileBrowserStoreTransport implements Transport {
  dispatched: Intent[] = [];
  private mode = "none";
  private local = emptyPane();
  private sftp = emptyPane();
  private session = emptyPane();
  private clipboard: FileClipboard | null = null;
  private version = 0;
  private handlers: FrameHandler[] = [];

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    this.apply(intent);
    this.version += 1;
    this.fan();
    return {
      intentId: intent.intentId,
      status: "accepted",
      produced: [{ region: FILE_BROWSERS_REGION, version: this.version }],
    };
  }

  private paneOf(name: string): Pane {
    if (name === "local") return this.local;
    if (name === "sftp") return this.sftp;
    return this.session;
  }

  private apply(intent: Intent): void {
    const p = intent.payload as Record<string, unknown>;
    switch (intent.kind) {
      case "fileBrowser.setMode": {
        this.mode = p.mode as string;
        break;
      }
      case "fileBrowser.loadStarted": {
        const pane = this.paneOf(p.pane as string);
        pane.loading = true;
        pane.error = null;
        break;
      }
      case "fileBrowser.loadSucceeded": {
        const pane = this.paneOf(p.pane as string);
        pane.path = p.path as string;
        pane.entries = structuredClone(p.entries as FileEntry[]);
        pane.loading = false;
        pane.error = null;
        break;
      }
      case "fileBrowser.loadFailed": {
        const pane = this.paneOf(p.pane as string);
        pane.loading = false;
        pane.error = (p.error as string | undefined) ?? null;
        break;
      }
      case "fileBrowser.setClipboard": {
        this.clipboard = (p.clipboard as FileClipboard | null) ?? null;
        break;
      }
      default:
        break;
    }
  }

  /** The reconstructed region view, twin of the store snapshot. */
  regionView(): FileBrowsersView {
    return structuredClone({
      mode: this.mode as FileBrowsersView["mode"],
      local: this.local,
      sftp: this.sftp,
      session: this.session,
      clipboard: this.clipboard,
    });
  }

  kinds(): string[] {
    return this.dispatched.map((i) => i.kind);
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    this.handlers.push(onFrame);
    return {
      snapshot: this.snapshot(region),
      unsubscribe: () => {
        this.handlers = this.handlers.filter((h) => h !== onFrame);
      },
    };
  }

  async resync(): Promise<SnapshotFrame | null> {
    return null;
  }

  private snapshot(region: string): SnapshotFrame {
    return { kind: "snapshot", region, version: this.version, view: this.regionView() };
  }

  private fan(): void {
    const frame: ProjectionFrame = this.snapshot(FILE_BROWSERS_REGION);
    for (const h of this.handlers) h(frame);
  }
}

let transport: FileBrowserStoreTransport;

/**
 * The `appStore` file-browser view in the region's shape, mirroring
 * `useProjectedFileBrowsers` exactly (including the SFTP pane's `sftpStatus`-derived
 * `loading`), so the region the intents reconstruct can be asserted equal to it.
 */
function sliceOf(): FileBrowsersView {
  const s = useAppStore.getState();
  return {
    mode: s.fileBrowserMode,
    local: {
      path: s.localCurrentPath,
      entries: s.localFileEntries,
      loading: s.localFileLoading,
      error: s.localFileError,
    },
    sftp: {
      path: s.currentPath,
      entries: s.fileEntries,
      loading: s.sftpStatus === "connecting" || s.sftpStatus === "listing",
      error: s.sftpError,
    },
    session: {
      path: s.sessionCurrentPath,
      entries: s.sessionFileEntries,
      loading: s.sessionFileLoading,
      error: s.sessionFileError,
    },
    clipboard: s.fileClipboard,
  };
}

/** Assert the region the intents reconstruct equals the local appStore view. */
function expectParity() {
  expect(transport.regionView()).toEqual(sliceOf());
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
  transport = new FileBrowserStoreTransport();
  setFileBrowsersTransportForTest(transport);
  setFileBrowsersIntentsEnabled(true);
});

afterEach(() => {
  setFileBrowsersTransportForTest(null);
  setFileBrowsersIntentsEnabled(null);
});

describe("file-browsers mutation cut — cut-vs-local parity (flag on)", () => {
  it("setFileBrowserMode reproduces the active pane", () => {
    useAppStore.getState().setFileBrowserMode("local");
    expect(transport.kinds()).toEqual(["fileBrowser.setMode"]);
    expectParity();
    expect(transport.regionView().mode).toBe("local");

    useAppStore.getState().setFileBrowserMode("none");
    expectParity();
    expect(transport.regionView().mode).toBe("none");
  });

  it("navigateLocal commits the pane path + listing", async () => {
    vi.mocked(localListDir).mockResolvedValue([entry("a"), entry("dir", true)]);

    await useAppStore.getState().navigateLocal("/home/user");

    expect(transport.kinds()).toEqual(["fileBrowser.loadStarted", "fileBrowser.loadSucceeded"]);
    expectParity();
    const view = transport.regionView();
    expect(view.local.path).toBe("/home/user");
    expect(view.local.entries.map((e) => e.name)).toEqual(["a", "dir"]);
    expect(view.local.loading).toBe(false);
  });

  it("navigateLocal records the pane error on failure", async () => {
    vi.mocked(localListDir).mockRejectedValue(new Error("nope"));

    await useAppStore.getState().navigateLocal("/root");

    expect(transport.kinds()).toEqual(["fileBrowser.loadStarted", "fileBrowser.loadFailed"]);
    expectParity();
    expect(transport.regionView().local.error).toBe("nope");
    expect(transport.regionView().local.loading).toBe(false);
  });

  it("refreshLocal re-lists the current local path", async () => {
    vi.mocked(localListDir).mockResolvedValue([entry("x")]);
    await useAppStore.getState().navigateLocal("/tmp");
    vi.mocked(localListDir).mockResolvedValue([entry("x"), entry("y")]);

    await useAppStore.getState().refreshLocal();

    expectParity();
    expect(transport.regionView().local.path).toBe("/tmp");
    expect(transport.regionView().local.entries.map((e) => e.name)).toEqual(["x", "y"]);
  });

  it("navigateSession commits the session pane path + listing", async () => {
    vi.mocked(sessionListFiles).mockResolvedValue([entry("s")]);

    await useAppStore.getState().navigateSession("sess-1", "/srv");

    expect(transport.kinds()).toEqual(["fileBrowser.loadStarted", "fileBrowser.loadSucceeded"]);
    expectParity();
    expect(transport.regionView().session.path).toBe("/srv");
    expect(transport.regionView().session.entries.map((e) => e.name)).toEqual(["s"]);
  });

  it("navigateSession records the session pane error on failure", async () => {
    vi.mocked(sessionListFiles).mockRejectedValue(new Error("denied"));

    await useAppStore.getState().navigateSession("sess-1", "/srv");

    expectParity();
    expect(transport.regionView().session.error).toBe("denied");
  });

  it("refreshSession re-lists the current session path", async () => {
    useAppStore.setState({ sessionFileBrowserId: "sess-1", sessionCurrentPath: "/srv" });
    vi.mocked(sessionListFiles).mockResolvedValue([entry("s"), entry("t")]);

    await useAppStore.getState().refreshSession();

    expect(transport.kinds()).toEqual(["fileBrowser.loadStarted", "fileBrowser.loadSucceeded"]);
    expectParity();
    expect(transport.regionView().session.entries.map((e) => e.name)).toEqual(["s", "t"]);
  });

  it("navigateSftp commits the sftp pane path + listing (view fields only)", async () => {
    useAppStore.setState({ sftpSessionId: "sftp-1" });
    vi.mocked(sftpListDir).mockResolvedValue([entry("f")]);

    await useAppStore.getState().navigateSftp("/var/log");

    expect(transport.kinds()).toEqual(["fileBrowser.loadStarted", "fileBrowser.loadSucceeded"]);
    expectParity();
    expect(transport.regionView().sftp.path).toBe("/var/log");
    expect(transport.regionView().sftp.entries.map((e) => e.name)).toEqual(["f"]);
    expect(transport.regionView().sftp.loading).toBe(false);
  });

  it("navigateSftp records the sftp pane error on a non-fatal failure", async () => {
    useAppStore.setState({ sftpSessionId: "sftp-1" });
    vi.mocked(sftpListDir).mockRejectedValue(new Error("boom"));

    await useAppStore.getState().navigateSftp("/var/log");

    expect(transport.kinds()).toEqual(["fileBrowser.loadStarted", "fileBrowser.loadFailed"]);
    expectParity();
    expect(transport.regionView().sftp.error).toBe("boom");
    expect(transport.regionView().sftp.loading).toBe(false);
  });

  it("refreshSftp re-lists the current sftp path", async () => {
    useAppStore.setState({ sftpSessionId: "sftp-1", currentPath: "/etc" });
    vi.mocked(sftpListDir).mockResolvedValue([entry("hosts")]);

    await useAppStore.getState().refreshSftp();

    expectParity();
    expect(transport.regionView().sftp.path).toBe("/etc");
    expect(transport.regionView().sftp.entries.map((e) => e.name)).toEqual(["hosts"]);
  });

  it("setFileClipboard sets then clears the clipboard", () => {
    const clipboard: FileClipboard = {
      entries: [entry("c")],
      operation: "copy",
      sourceMode: "local",
      sourcePath: "/home",
      sftpSessionId: null,
    };

    useAppStore.getState().setFileClipboard(clipboard);
    expect(transport.kinds()).toEqual(["fileBrowser.setClipboard"]);
    expectParity();
    expect(transport.regionView().clipboard).toEqual(clipboard);

    useAppStore.getState().setFileClipboard(null);
    expectParity();
    expect(transport.regionView().clipboard).toBeNull();
  });

  it("a full browser lifecycle stays in parity across every step", async () => {
    vi.mocked(localListDir).mockResolvedValue([entry("a")]);
    vi.mocked(sessionListFiles).mockResolvedValue([entry("s")]);

    useAppStore.getState().setFileBrowserMode("local");
    expectParity();
    await useAppStore.getState().navigateLocal("/home");
    expectParity();
    useAppStore.getState().setFileBrowserMode("session");
    expectParity();
    await useAppStore.getState().navigateSession("sess-1", "/srv");
    expectParity();
    useAppStore.getState().setFileClipboard({
      entries: [entry("a")],
      operation: "cut",
      sourceMode: "local",
      sourcePath: "/home",
      sftpSessionId: null,
    });
    expectParity();
    useAppStore.getState().setFileClipboard(null);
    expectParity();
    useAppStore.getState().setFileBrowserMode("none");
    expectParity();
  });
});

describe("file-browsers mutation cut — flag off (rollback path)", () => {
  beforeEach(() => setFileBrowsersIntentsEnabled(false));

  it("dispatches no intents and drives the slice locally", async () => {
    vi.mocked(localListDir).mockResolvedValue([entry("a")]);

    useAppStore.getState().setFileBrowserMode("local");
    await useAppStore.getState().navigateLocal("/home");
    useAppStore.getState().setFileClipboard({
      entries: [entry("a")],
      operation: "copy",
      sourceMode: "local",
      sourcePath: "/home",
      sftpSessionId: null,
    });

    // No mirror reached the region — the pre-cut local path is intact.
    expect(transport.dispatched).toHaveLength(0);
    // The local slice still behaves exactly as before the cut.
    expect(useAppStore.getState().fileBrowserMode).toBe("local");
    expect(useAppStore.getState().localCurrentPath).toBe("/home");
    expect(useAppStore.getState().localFileEntries.map((e) => e.name)).toEqual(["a"]);
  });
});
