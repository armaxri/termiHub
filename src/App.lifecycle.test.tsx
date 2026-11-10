/**
 * App lifecycle wiring (#5173, COV-014).
 *
 * The store halves are unit-tested on their own (`appStore.windowClose*.test.ts`,
 * the restore/handoff slices); what was left untested is the glue in `App.tsx`
 * that sequences them: the startup restore decision (CLI workspace vs. last
 * session vs. a "never" clear), the secondary-window restore → hand-off ordering,
 * and the close-request effect when the window list cannot be read. Those are
 * exactly the branches that run when something is already wrong, so they are
 * driven here against the real `App` and the real store.
 *
 * Only the Tauri boundary is faked: `invoke` is routed through a small
 * command table (the "backend"), and the current window is a fake whose
 * close/focus handlers the test can fire. A few IPC-backed store actions that
 * would only start debounce timers are swapped for spies.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "@/store/appStore";
import { clearFrontendLogHistory, getFrontendLogHistory } from "@/utils/frontendLog";
import { CLI_WORKSPACE_REQUESTED_EVENT } from "@/utils/cliWorkspace";
import App from "./App";

type Handler = (args?: Record<string, unknown>) => unknown;

/** The fake backend: one handler per IPC command; anything else resolves `undefined`. */
let backend: Record<string, Handler>;
/** Tauri event listeners App (and its hooks) registered, by event name. */
let eventListeners: Map<string, ((event: { payload: unknown }) => void)[]>;

interface FakeWindow {
  label: string;
  closeHandler: ((event: { preventDefault: () => void }) => Promise<void>) | null;
  focusHandler: ((event: { payload: boolean }) => void) | null;
  destroy: ReturnType<typeof vi.fn>;
}
let win: FakeWindow;

function makeWindow(label: string): FakeWindow {
  const fake: FakeWindow = {
    label,
    closeHandler: null,
    focusHandler: null,
    destroy: vi.fn(() => Promise.resolve()),
  };
  vi.mocked(getCurrentWindow).mockImplementation(
    () =>
      ({
        label,
        onFocusChanged: vi.fn((cb: FakeWindow["focusHandler"]) => {
          fake.focusHandler = cb;
          return Promise.resolve(() => {});
        }),
        onCloseRequested: vi.fn((cb: FakeWindow["closeHandler"]) => {
          fake.closeHandler = cb;
          return Promise.resolve(() => {});
        }),
        onDragDropEvent: vi.fn(() => Promise.resolve(() => {})),
        setSize: vi.fn(() => Promise.resolve()),
        destroy: fake.destroy,
      }) as unknown as ReturnType<typeof getCurrentWindow>
  );
  return fake;
}

function emitEvent(name: string, payload?: unknown): void {
  for (const cb of eventListeners.get(name) ?? []) cb({ payload });
}

function logMessages(fragment: string): string[] {
  return getFrontendLogHistory()
    .map((e) => e.message)
    .filter((m) => m.includes(fragment));
}

/** Spies wrapping (or replacing) the store actions the startup effect sequences. */
function spyStore() {
  const real = useAppStore.getState();
  const calls: string[] = [];
  const wrap = <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    vi.fn((...args: A) => {
      calls.push(name);
      return fn(...args);
    });
  const spies = {
    restoreLastSession: wrap("restoreLastSession", real.restoreLastSession),
    promptRestore: wrap("promptRestore", real.promptRestore),
    clearLastSession: wrap("clearLastSession", real.clearLastSession),
    receivePendingWindowRestore: wrap(
      "receivePendingWindowRestore",
      real.receivePendingWindowRestore
    ),
    receivePendingHandoffs: wrap("receivePendingHandoffs", real.receivePendingHandoffs),
    launchWorkspace: wrap("launchWorkspace", async (_id: string) => {}),
    requestLaunchWorkspace: wrap("requestLaunchWorkspace", (_id: string) => {}),
    loadWorkspaces: wrap("loadWorkspaces", async () => {}),
    reloadConnectionsFromBackend: wrap("reloadConnectionsFromBackend", async () => {}),
    // Timer/IPC-only side effects: observed, not run.
    scheduleLastSessionSave: wrap("scheduleLastSessionSave", () => {}),
    scheduleWindowLayoutReport: wrap("scheduleWindowLayoutReport", () => {}),
    reportOwnWindowLayout: wrap("reportOwnWindowLayout", async () => {}),
  };
  useAppStore.setState(spies);
  return { spies, calls };
}

describe("App lifecycle (#5173)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    clearFrontendLogHistory();
    eventListeners = new Map();
    backend = {
      list_session_owners: () => ({}),
      restore_resolve_mode: () => "always",
      load_last_session: () => null,
      get_cli_workspace: () => null,
      list_windows: () => [{ label: "main" }],
      take_pending_handoffs: () => [],
    };
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) =>
      backend[cmd] ? backend[cmd](args as Record<string, unknown>) : undefined
    );
    vi.mocked(listen).mockImplementation(async (name, cb) => {
      const list = eventListeners.get(name) ?? [];
      list.push(cb as (event: { payload: unknown }) => void);
      eventListeners.set(name, list);
      return () => {
        const at = list.indexOf(cb as (event: { payload: unknown }) => void);
        if (at >= 0) list.splice(at, 1);
      };
    });
    win = makeWindow("main");
    // Cold start, as in App.smoke.test.tsx: backend hydration is neutered (it
    // would overwrite the store's defaults with the stubbed `undefined`).
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      loadFromBackend: async () => {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
    vi.mocked(listen).mockImplementation(() => Promise.resolve(() => {}));
  });

  async function mount(): Promise<void> {
    await act(async () => {
      root.render(<App />);
    });
  }

  async function requestClose(): Promise<{ preventDefault: ReturnType<typeof vi.fn> }> {
    if (!win.closeHandler) throw new Error("close handler was never registered");
    const event = { preventDefault: vi.fn() };
    await act(async () => {
      await win.closeHandler!(event);
    });
    return event;
  }

  describe("startup restore decision (main window)", () => {
    it("restores the last session in 'always' mode when no CLI workspace is given", async () => {
      const { spies } = spyStore();
      await mount();
      expect(spies.restoreLastSession).toHaveBeenCalledTimes(1);
      expect(spies.promptRestore).not.toHaveBeenCalled();
      expect(spies.clearLastSession).not.toHaveBeenCalled();
      expect(spies.launchWorkspace).not.toHaveBeenCalled();
    });

    it("raises the restore prompt in 'ask' mode", async () => {
      backend.restore_resolve_mode = () => "ask";
      const { spies } = spyStore();
      await mount();
      expect(spies.promptRestore).toHaveBeenCalledTimes(1);
      expect(spies.restoreLastSession).not.toHaveBeenCalled();
    });

    it("clears the stored session and restores nothing in 'never' mode", async () => {
      backend.restore_resolve_mode = () => "never";
      const { spies } = spyStore();
      await mount();
      expect(spies.clearLastSession).toHaveBeenCalledTimes(1);
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("clear_last_session");
      expect(spies.restoreLastSession).not.toHaveBeenCalled();
      expect(spies.promptRestore).not.toHaveBeenCalled();
    });

    it("launches the CLI workspace instead of restoring the last session", async () => {
      backend.get_cli_workspace = () => "Prod";
      const { spies } = spyStore();
      useAppStore.setState({
        workspaces: [{ id: "ws-prod", name: "Prod", connectionCount: 0 }],
      });
      await mount();
      expect(spies.launchWorkspace).toHaveBeenCalledWith("ws-prod");
      expect(spies.restoreLastSession).not.toHaveBeenCalled();
      expect(spies.promptRestore).not.toHaveBeenCalled();
    });

    it("still clears the stored session in 'never' mode when a CLI workspace launched", async () => {
      backend.get_cli_workspace = () => "prod";
      backend.restore_resolve_mode = () => "never";
      const { spies } = spyStore();
      useAppStore.setState({
        workspaces: [{ id: "ws-prod", name: "Prod", connectionCount: 0 }],
      });
      await mount();
      expect(spies.launchWorkspace).toHaveBeenCalledWith("ws-prod");
      expect(spies.clearLastSession).toHaveBeenCalledTimes(1);
      expect(spies.restoreLastSession).not.toHaveBeenCalled();
    });

    it("falls back to the last session when the named CLI workspace no longer exists", async () => {
      backend.get_cli_workspace = () => "Deleted";
      const { spies } = spyStore();
      await mount();
      expect(spies.launchWorkspace).not.toHaveBeenCalled();
      expect(spies.restoreLastSession).toHaveBeenCalledTimes(1);
    });

    it("falls back to the last session and logs when launching the CLI workspace throws", async () => {
      backend.get_cli_workspace = () => "Prod";
      const { spies } = spyStore();
      useAppStore.setState({
        workspaces: [{ id: "ws-prod", name: "Prod", connectionCount: 0 }],
        launchWorkspace: vi.fn(() => Promise.reject(new Error("workspace file unreadable"))),
      });
      await mount();
      expect(spies.restoreLastSession).toHaveBeenCalledTimes(1);
      expect(logMessages("CLI workspace lookup unavailable")).toEqual([
        "CLI workspace lookup unavailable: workspace file unreadable",
      ]);
    });

    it("falls back to the last session and logs when the CLI lookup itself is unavailable", async () => {
      backend.get_cli_workspace = () => {
        throw new Error("cli plugin missing");
      };
      const { spies } = spyStore();
      await mount();
      expect(spies.restoreLastSession).toHaveBeenCalledTimes(1);
      expect(logMessages("CLI workspace lookup unavailable")).toEqual([
        "CLI workspace lookup unavailable: cli plugin missing",
      ]);
    });

    it("auto-saves on layout changes only after the restore, and re-saves on a window's report", async () => {
      const { spies } = spyStore();
      await mount();
      expect(spies.scheduleLastSessionSave).not.toHaveBeenCalled();

      await act(async () => {
        useAppStore.getState().addTab("shell", "local");
      });
      expect(spies.scheduleLastSessionSave).toHaveBeenCalled();

      spies.scheduleLastSessionSave.mockClear();
      await act(async () => emitEvent("window-layout-changed"));
      expect(spies.scheduleLastSessionSave).toHaveBeenCalledTimes(1);
    });

    it("attaches nothing when unmounted before the async restore finishes", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const { spies } = spyStore();
      useAppStore.setState({ loadFromBackend: () => gate });
      await mount();
      act(() => root.unmount());
      await act(async () => {
        release();
        await gate;
      });

      await act(async () => {
        useAppStore.getState().addTab("shell", "local");
      });
      expect(spies.scheduleLastSessionSave).not.toHaveBeenCalled();
      expect(eventListeners.get("window-layout-changed") ?? []).toHaveLength(0);
      // Re-create the root so afterEach's unmount has something to unmount.
      root = createRoot(container);
    });
  });

  describe("secondary window", () => {
    it("applies its pending window restore before draining any hand-off", async () => {
      win = makeWindow("win-1");
      let releaseRestore!: () => void;
      backend.take_pending_window_restore = () =>
        new Promise((resolve) => (releaseRestore = () => resolve(null)));
      backend.take_pending_handoffs = () => [];
      const { spies, calls } = spyStore();

      await mount();
      // The restore is still in flight: no hand-off may be taken yet.
      expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("take_pending_handoffs");
      expect(spies.receivePendingHandoffs).not.toHaveBeenCalled();

      await act(async () => releaseRestore());
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("take_pending_handoffs");
      expect(calls.filter((c) => c.startsWith("receivePending"))).toEqual([
        "receivePendingWindowRestore",
        "receivePendingHandoffs",
      ]);
      // A secondary window never touches the main window's last session.
      expect(spies.restoreLastSession).not.toHaveBeenCalled();
      expect(spies.promptRestore).not.toHaveBeenCalled();
      expect(spies.clearLastSession).not.toHaveBeenCalled();
      expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("get_cli_workspace");
      // It reports its initial slice once, then on every layout change.
      expect(spies.reportOwnWindowLayout).toHaveBeenCalledTimes(1);
      await act(async () => {
        useAppStore.getState().addTab("shell", "local");
      });
      expect(spies.scheduleWindowLayoutReport).toHaveBeenCalled();
      expect(spies.scheduleLastSessionSave).not.toHaveBeenCalled();
    });

    it("does not listen for forwarded CLI workspace requests", async () => {
      win = makeWindow("win-1");
      spyStore();
      await mount();
      expect(eventListeners.get(CLI_WORKSPACE_REQUESTED_EVENT) ?? []).toHaveLength(0);
    });
  });

  describe("runtime events", () => {
    it("launches a forwarded CLI workspace with a live-session confirm", async () => {
      const { spies } = spyStore();
      useAppStore.setState({
        workspaces: [{ id: "ws-prod", name: "Prod", connectionCount: 0 }],
      });
      await mount();
      await act(async () => emitEvent(CLI_WORKSPACE_REQUESTED_EVENT, "PROD"));
      expect(spies.loadWorkspaces).toHaveBeenCalledTimes(1);
      expect(spies.requestLaunchWorkspace).toHaveBeenCalledWith("ws-prod");
    });

    it("reloads connections on focus and on a connections-changed event, not on blur", async () => {
      const { spies } = spyStore();
      await mount();
      await act(async () => win.focusHandler!({ payload: false }));
      expect(spies.reloadConnectionsFromBackend).not.toHaveBeenCalled();
      await act(async () => win.focusHandler!({ payload: true }));
      expect(spies.reloadConnectionsFromBackend).toHaveBeenCalledTimes(1);
      await act(async () => emitEvent("connections-changed"));
      expect(spies.reloadConnectionsFromBackend).toHaveBeenCalledTimes(2);
    });

    it("drains hand-offs on a window-handoff nudge", async () => {
      const { spies } = spyStore();
      backend.take_pending_handoffs = () => [];
      await mount();
      await act(async () => emitEvent("window-handoff"));
      expect(spies.receivePendingHandoffs).toHaveBeenCalledTimes(1);
    });
  });

  describe("window close", () => {
    it("closes an empty window straight away", async () => {
      await mount();
      const event = await requestClose();
      expect(event.preventDefault).toHaveBeenCalled();
      expect(win.destroy).toHaveBeenCalledTimes(1);
    });

    it("passes the other open windows (not this one) to the close decision", async () => {
      backend.list_windows = () => [{ label: "main" }, { label: "win-1" }];
      await mount();
      await act(async () => {
        useAppStore.getState().addTab("build", "local", undefined, { sessionId: "s1" });
      });
      await requestClose();
      expect(win.destroy).not.toHaveBeenCalled();
      expect(useAppStore.getState().pendingWindowClose?.otherWindows).toEqual([{ label: "win-1" }]);
    });

    it("still asks before ending a live session when the window list fails, and logs once", async () => {
      backend.list_windows = () => {
        throw new Error("ipc unavailable");
      };
      await mount();
      await act(async () => {
        useAppStore.getState().addTab("build", "local", undefined, { sessionId: "s-live" });
      });

      vi.mocked(invoke).mockClear();
      const event = await requestClose();

      expect(event.preventDefault).toHaveBeenCalled();
      // The session would be lost, so the window stays open behind the dialog.
      expect(win.destroy).not.toHaveBeenCalled();
      expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("close_terminal", expect.anything());
      const pending = useAppStore.getState().pendingWindowClose;
      expect(pending?.otherWindows).toEqual([]);
      expect(pending?.sessions.map((s) => s.sessionId)).toEqual(["s-live"]);
      expect(document.querySelector('[data-testid="close-window-decision-dialog"]')).not.toBeNull();
      expect(logMessages("window listing on close unavailable")).toEqual([
        "window listing on close unavailable: ipc unavailable",
      ]);
    });

    it("closes an empty window even when the window list fails", async () => {
      backend.list_windows = () => {
        throw new Error("ipc unavailable");
      };
      await mount();
      await requestClose();
      expect(win.destroy).toHaveBeenCalledTimes(1);
      expect(logMessages("window listing on close unavailable")).toHaveLength(1);
    });
  });

  describe("dialog wiring", () => {
    it("large paste: confirm runs the paste and closes; cancel runs the decline and closes", async () => {
      await mount();
      const onConfirm = vi.fn();
      const onCancel = vi.fn();

      await act(async () => {
        useAppStore.getState().showLargePasteDialog(5000, onConfirm, undefined, onCancel);
      });
      await act(async () => {
        document.querySelector<HTMLButtonElement>('[data-testid="large-paste-confirm"]')!.click();
      });
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onCancel).not.toHaveBeenCalled();
      expect(useAppStore.getState().largePasteDialog.open).toBe(false);

      await act(async () => {
        useAppStore.getState().showLargePasteDialog(5000, onConfirm, undefined, onCancel);
      });
      await act(async () => {
        document.querySelector<HTMLButtonElement>('[data-testid="large-paste-cancel"]')!.click();
      });
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(useAppStore.getState().largePasteDialog.open).toBe(false);
    });

    it("spawn picker: cancel hides it; open hides it and resolves the picked shell", async () => {
      backend.list_spawn_options = () => ({
        shells: ["bash"],
        wslDistros: [],
        dockerAvailable: false,
        dockerImages: [],
        podmanAvailable: false,
        podmanImages: [],
      });
      await mount();

      await act(async () => {
        useAppStore.getState().showSpawnPicker({ location: "/tmp/project" });
      });
      expect(document.querySelector('[data-testid="spawn-picker"]')).not.toBeNull();
      await act(async () => {
        document.querySelector<HTMLButtonElement>('[data-testid="spawn-picker-cancel"]')!.click();
      });
      expect(useAppStore.getState().spawnPickerVisible).toBe(false);
      expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("resolve_shell_spawn", expect.anything());

      await act(async () => {
        useAppStore.getState().showSpawnPicker({ location: "/tmp/project" });
      });
      await act(async () => {
        document.querySelector<HTMLButtonElement>('[data-testid="spawn-picker-open"]')!.click();
      });
      expect(useAppStore.getState().spawnPickerVisible).toBe(false);
      expect(useAppStore.getState().spawnPickerRequest).toBeUndefined();
      expect(vi.mocked(invoke)).toHaveBeenCalledWith(
        "resolve_shell_spawn",
        expect.objectContaining({ location: "/tmp/project" })
      );
    });
  });

  describe("layout variants", () => {
    it("renders the sidebar on the right and the activity bar on top", async () => {
      useAppStore.setState({
        layoutConfig: {
          ...useAppStore.getState().layoutConfig,
          sidebarPosition: "right",
          activityBarPosition: "top",
        },
      });
      await mount();
      const main = container.querySelector(".app__main")!;
      expect(main.className).toContain("app__main--ab-top");
      // Activity bar sits above the main row, sidebar is the last child of it.
      expect(container.querySelector(".app > .activity-bar")).not.toBeNull();
      expect(main.lastElementChild?.classList.contains("sidebar")).toBe(true);
      expect(container.querySelector('[data-testid="sidebar-resize-handle"]')).not.toBeNull();
    });

    it("puts the activity bar on the right when configured", async () => {
      useAppStore.setState({
        layoutConfig: { ...useAppStore.getState().layoutConfig, activityBarPosition: "right" },
      });
      await mount();
      const main = container.querySelector(".app__main")!;
      expect(main.lastElementChild?.classList.contains("activity-bar")).toBe(true);
    });
  });
});
