/**
 * The one close-tab decision every single-tab close path shares (#5189).
 *
 * Each case runs for both triggers — the pointer (tab X, middle-click, context
 * menu) and the close-tab shortcut — so the same tab gets the same dialog (or
 * none) and the same Reopen toast whatever closed it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useAppStore } from "@/store/appStore";
import { ensureSessionSubscribed } from "@/store/sessionBridge";
import type { TerminalTab } from "@/types/terminal";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import {
  disconnected,
  flushSessionRegion,
  installSessionLifecycleHarness,
} from "@/test/sessionLifecycleRegionTestHarness";
import {
  continueTabClose,
  liveCloseSettingFor,
  requestTabClose,
  type TabCloseTrigger,
} from "./tabCloseFlow";

const toastSuccess = vi.fn();
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return {
    ...actual,
    toast: { ...actual.toast, success: (m: string, o?: unknown) => toastSuccess(m, o) },
  };
});

const PANEL = "panel-1";
const TRIGGERS: TabCloseTrigger[] = ["pointer", "shortcut"];

setupSettingsRegion();
const harness = installSessionLifecycleHarness();

let closeTab: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  closeTab = vi.fn();
  useAppStore.setState({ closeTab });
  toastSuccess.mockClear();
});

function terminal(id: string, extra: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    sessionId: `sess-${id}`,
    title: `term-${id}`,
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: { host: "prod" } },
    panelId: PANEL,
    isActive: true,
    ...extra,
  };
}

function settingsTab(): TerminalTab {
  return { ...terminal("settings"), title: "Settings", contentType: "settings" };
}

function pending() {
  const s = useAppStore.getState();
  return {
    session: s.pendingSessionCloseConfirm,
    detach: s.pendingAttachedTabCloseConfirm,
    shortcut: s.pendingShortcutCloseConfirm,
  };
}

/** The Reopen action label of the last success toast, if any. */
function lastToastAction(): string | undefined {
  const opts = toastSuccess.mock.calls.at(-1)?.[1] as { action?: { label: string } } | undefined;
  return opts?.action?.label;
}

describe.each(TRIGGERS)("close decision — %s trigger", (trigger) => {
  it("a live session asks the live-session confirm with Reopen captured", () => {
    requestTabClose(terminal("live"), PANEL, trigger);
    expect(closeTab).not.toHaveBeenCalled();
    const req = pending().session;
    expect(req).toMatchObject({ kind: "tab", tabId: "live", panelId: PANEL });
    expect(req?.kind === "tab" && req.reopen?.connectionType).toBe("ssh");
    // "Don't ask again" clears the setting that gated this trigger.
    expect(req?.kind === "tab" && req.optOutSetting).toBe(liveCloseSettingFor(trigger));
    expect(pending().shortcut).toBeNull();
  });

  it("an exited session closes at once with a Reopen toast", async () => {
    void ensureSessionSubscribed();
    harness.transport.setSession("dead", disconnected());
    await flushSessionRegion();
    requestTabClose(terminal("dead"), PANEL, trigger);
    expect(closeTab).toHaveBeenCalledWith("dead", PANEL);
    expect(pending().session).toBeNull();
    expect(lastToastAction()).toBe("Reopen");
  });

  it("a terminal that failed to spawn closes at once with a Reopen toast", () => {
    useAppStore.setState({ terminalSpawnErrors: { failed: "boom" } });
    requestTabClose(terminal("failed"), PANEL, trigger);
    expect(closeTab).toHaveBeenCalledWith("failed", PANEL);
    expect(pending().session).toBeNull();
    expect(lastToastAction()).toBe("Reopen");
  });

  it("a clean settings tab closes at once without a prompt", () => {
    requestTabClose(settingsTab(), PANEL, trigger);
    expect(closeTab).toHaveBeenCalledWith("settings", PANEL);
    expect(pending()).toEqual({ session: null, detach: null, shortcut: null });
    // Nothing reconnectable to offer.
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("a persistent session gets the background notice, never the live-session warning", () => {
    requestTabClose(terminal("bg", { persistentConnectionId: "pc-1" }), PANEL, trigger);
    expect(closeTab).not.toHaveBeenCalled();
    expect(pending().detach).toMatchObject({ tabId: "bg", panelId: PANEL });
    expect(pending().session).toBeNull();
  });

  it("a persistent session closes silently once its notice is opted out of", () => {
    seedSettings({ confirmCloseAttachedTab: false });
    requestTabClose(terminal("bg", { persistentConnectionId: "pc-1" }), PANEL, trigger);
    expect(closeTab).toHaveBeenCalledWith("bg", PANEL);
    expect(pending().detach).toBeNull();
    // Closing only detaches — there is nothing to reopen.
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("a dirty self-prompting editor defers to its own unsaved prompt", () => {
    useAppStore.setState({ editorDirtyTabs: { settings: true } });
    expect(requestTabClose(settingsTab(), PANEL, trigger)).toBe("handled");
    expect(useAppStore.getState().pendingCloseRequest).toEqual({
      tabId: "settings",
      panelId: PANEL,
    });
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("a dirty tab without its own prompt asks the caller for the generic prompt", () => {
    useAppStore.setState({ editorDirtyTabs: { live: true } });
    expect(requestTabClose(terminal("live"), PANEL, trigger)).toBe("generic-prompt");
    expect(closeTab).not.toHaveBeenCalled();
    expect(pending().session).toBeNull();
  });
});

describe("per-trigger opt-outs", () => {
  it("the live-session opt-out silences the pointer, not the shortcut", () => {
    seedSettings({ confirmCloseLiveSession: false });
    continueTabClose(terminal("a"), PANEL, "pointer");
    expect(closeTab).toHaveBeenCalledWith("a", PANEL);
    expect(lastToastAction()).toBe("Reopen");

    continueTabClose(terminal("b"), PANEL, "shortcut");
    expect(pending().session).toMatchObject({ tabId: "b" });
  });

  it("the shortcut opt-out silences the shortcut (live and persistent), not the pointer", () => {
    seedSettings({ confirmCloseTabOnShortcut: false });
    continueTabClose(terminal("a"), PANEL, "shortcut");
    expect(closeTab).toHaveBeenCalledWith("a", PANEL);
    expect(lastToastAction()).toBe("Reopen");
    continueTabClose(terminal("bg", { persistentConnectionId: "pc" }), PANEL, "shortcut");
    expect(closeTab).toHaveBeenCalledWith("bg", PANEL);
    expect(pending().detach).toBeNull();

    continueTabClose(terminal("c"), PANEL, "pointer");
    expect(pending().session).toMatchObject({ tabId: "c" });
  });
});
