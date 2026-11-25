/**
 * The wait of a running automation (#6025), from the store to the bar: Continue
 * is the only thing that goes on, Stop, the end of the terminal and the time
 * limit end it, and a password prompt that still shows holds Continue back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));

import { toast } from "@/components/ui";
import { CONTEXT_COMMANDS } from "@/services/contextCommands";
import { registerTerminalPrompt } from "@/services/passwordPrompt";
import { WAIT_FOR_USER_LIMIT_MS, type WaitForUserResult } from "@/services/workflowRunner";
import { useAppStore } from "@/store/appStore";
import { __emitSessionViewForTest, type ProjectedSessionLifecycle } from "@/store/sessionBridge";
import {
  PROMPT_CHECK_LIMIT_MS,
  PROMPT_CHECK_SHOWS_MS,
  SHOW_WAITING_TERMINAL_EVENT,
} from "@/store/slices/automationWaitSlice";
import { checkA11y } from "@/test/axe";
import { click, query } from "@/test/automationEditorHarness";
import { flushAsync } from "@/test/flushAsync";
import { seedLayoutState } from "@/test/layoutState";
import { withTooltip } from "@/test/tooltip";
import type { LeafPanel, TerminalTab } from "@/types/terminal";
import { WaitingRunBar } from "./WaitingRunBar";

let container: HTMLDivElement;
let root: Root;
let version = 9000;
let prompt = "$ ";
/** Where the cursor is, for a prompt that shows again further down. */
let cursorLine = 0;
const pin = () => {
  const at = cursorLine;
  return { holds: () => at === cursorLine, dispose: () => {} };
};
let takeBack: (() => void)[] = [];

const store = () => useAppStore.getState();
const tab = (id: string, sessionId = `sess-${id}`): TerminalTab => ({
  id,
  sessionId,
  title: id === "a" ? "prod-web" : "db-1",
  connectionType: "local",
  contentType: "terminal",
  config: { type: "local", config: {} },
  panelId: "leaf",
  isActive: id === "a",
});
function seedTabs(tabs: TerminalTab[], active = tabs[0]?.id ?? null): void {
  const leaf: LeafPanel = { type: "leaf", id: "leaf", tabs, activeTabId: active };
  seedLayoutState({ rootPanel: leaf, activePanelId: "leaf" });
}
function emitSessions(sessions: Record<string, Partial<ProjectedSessionLifecycle>>): void {
  version += 1;
  __emitSessionViewForTest(
    { sessions: sessions as Record<string, ProjectedSessionLifecycle> },
    version
  );
}

/** Start a wait in tab `tabId`; its result once it ended. */
function startWait(tabId = "a", over: { message?: string; runId?: string } = {}) {
  const state: { result?: WaitForUserResult; cancel: () => void } = { cancel: () => {} };
  let cancelled = false;
  act(() => {
    void store()
      .waitForUser(
        {
          runId: over.runId ?? `run-${tabId}`,
          tabId,
          sessionId: `sess-${tabId}`,
          tabTitle: tabId === "a" ? "prod-web" : "db-1",
          automationName: "Deploy",
          message: "message" in over ? over.message : "Type your password",
        },
        {
          isCancelled: () => cancelled,
          whenCancelled: new Promise<void>((resolve) => {
            state.cancel = () => {
              cancelled = true;
              resolve();
            };
          }),
        }
      )
      .then((result) => (state.result = result));
  });
  return state;
}

beforeEach(async () => {
  useAppStore.setState(useAppStore.getInitialState());
  emitSessions({});
  seedTabs([tab("a"), tab("b")]);
  prompt = "$ ";
  cursorLine = 0;
  takeBack = ["a", "b"].map((id) =>
    registerTerminalPrompt(id, {
      read: (then) => then(prompt),
      arrived: () => 0,
      pin,
    })
  );
  vi.spyOn(toast, "info").mockReturnValue("t");
  vi.spyOn(toast, "dismiss").mockReturnValue(undefined as never);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(withTooltip(<WaitingRunBar />)));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  takeBack.forEach((fn) => fn());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the bar", () => {
  it("names the automation, the terminal and what to do, and offers Continue and Stop", async () => {
    startWait();
    const bar = query("automation-wait-a")!;
    expect(bar.textContent).toContain("“Deploy” waits for you in prod-web.");
    expect(query("automation-wait-message-a")?.textContent).toBe(
      "Type your password and press Enter in the terminal, then Continue."
    );
    expect(bar.textContent).toMatch(/Stops at .+ if you do nothing\./);
    expect(query("automation-wait-show-a")).toBeNull();
    await checkA11y(container);
  });

  it("has a wording of its own when the step has none", () => {
    startWait("a", { message: "  " });
    expect(query("automation-wait-message-a")?.textContent).toBe(
      "Type what the terminal asks for and press Enter there, then Continue."
    );
  });

  it("leaves the focus to the terminal", async () => {
    const focused: string[] = [];
    const listen = (e: Event) => focused.push((e as CustomEvent<{ tabId: string }>).detail.tabId);
    window.addEventListener("termihub:focus-terminal", listen);
    startWait();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(focused).toEqual(["a"]);
    window.removeEventListener("termihub:focus-terminal", listen);
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("leads to the terminal that waits when it does not show, and says it once", async () => {
    const wait = startWait("b");
    // The bar is enough: no message beside it (C-009).
    expect(toast.info).not.toHaveBeenCalled();
    // Shown first: Continue would type into a terminal nobody sees (B-001).
    expect(query("automation-wait-continue-b")).toBeNull();
    expect(query("automation-wait-show-b")?.textContent).toBe("Show db-1");
    expect(query("automation-wait-message-b")?.textContent).toBe(
      "Show it, type your password and press Enter."
    );
    expect(wait.result).toBeUndefined();
    act(() => seedTabs([tab("a"), tab("b")], "b"));
    expect(query("automation-wait-show-b")).toBeNull();
    click("automation-wait-continue-b");
    await flushAsync();
    expect(wait.result).toBe("continued");
  });

  it("keeps the waits of several terminals apart", async () => {
    const a = startWait("a");
    const b = startWait("b");
    click("automation-wait-continue-a");
    await flushAsync();
    expect([a.result, b.result]).toEqual(["continued", undefined]);
    expect(query("automation-wait-b")).not.toBeNull();
    expect(query("automation-wait-a")).toBeNull();
  });
});

describe("Continue", () => {
  it("goes on at once when nothing is asked any more", async () => {
    const wait = startWait();
    click("automation-wait-continue-a");
    await flushAsync();
    expect(wait.result).toBe("continued");
    expect(query("automation-waits")).toBeNull();
  });

  it("is held back while the terminal still asks for a password, and can be insisted on", async () => {
    prompt = "[sudo] password for arne: ";
    const wait = startWait();
    click("automation-wait-continue-a");
    await flushAsync();
    expect(wait.result).toBeUndefined();
    expect(query("automation-wait-message-a")?.textContent).toContain("still asks for a password");
    expect(query("automation-wait-continue-a")?.textContent).toBe("Continue anyway");
    click("automation-wait-continue-a");
    await flushAsync();
    expect(wait.result).toBe("continued");
  });

  it("says nothing of a password where none was asked for", () => {
    prompt = "$ ";
    startWait();
    act(() => store().recheckWaitingPrompts());
    expect(query("automation-wait-message-a")?.textContent).not.toContain("No password prompt");
  });

  it("asks in a terminal it cannot read, and the next press goes on (#6070)", async () => {
    takeBack.forEach((fn) => fn());
    const wait = startWait();
    click("automation-wait-continue-a");
    expect(query("automation-wait-message-a")?.textContent).toContain("It cannot be told yet");
    expect(query("automation-wait-continue-a")?.textContent).toBe("Continue anyway");
    await flushAsync();
    expect(wait.result).toBeUndefined();
    click("automation-wait-continue-a");
    await flushAsync();
    expect(wait.result).toBe("continued");
  });

  it("no longer asks once it can read the terminal (#6070)", () => {
    const back = takeBack.splice(0);
    back.forEach((fn) => fn());
    startWait();
    click("automation-wait-continue-a");
    const read = (before: string) => {
      prompt = before;
      act(() => store().recheckWaitingPrompts());
    };
    takeBack = [
      registerTerminalPrompt("a", { read: (then) => then(prompt), arrived: () => 0, pin }),
    ];
    read("$ ");
    expect(query("automation-wait-message-a")?.textContent).not.toContain("It cannot be told");
    expect(query("automation-wait-continue-a")?.textContent).toBe("Continue");
  });

  it("insists on the prompt it was said of, not on the next one (#6070)", async () => {
    prompt = "Password: ";
    const wait = startWait();
    click("automation-wait-continue-a");
    cursorLine = 2;
    click("automation-wait-continue-a");
    await flushAsync();
    expect(wait.result).toBeUndefined();
    click("automation-wait-continue-a");
    await flushAsync();
    expect(wait.result).toBe("continued");
  });

  it("does not go on while another computer controls the terminal (#6070)", async () => {
    const wait = startWait();
    act(() => emitSessions({ a: { status: "evicted" } }));
    click("automation-wait-continue-a");
    click("automation-wait-continue-a");
    await flushAsync();
    expect(wait.result).toBeUndefined();
    expect(query("automation-wait-message-a")?.textContent).toContain("Take it back first");
    act(() => emitSessions({ a: { status: "connected" } }));
    act(() => store().recheckWaitingPrompts());
    expect(query("automation-wait-message-a")?.textContent).not.toContain("Take it back");
    click("automation-wait-continue-a");
    await flushAsync();
    expect(wait.result).toBe("continued");
  });

  it("can be pressed again when reading the terminal fails (#6070)", async () => {
    let fails = true;
    takeBack.push(
      registerTerminalPrompt("a", {
        read: (then) => {
          if (fails) throw new Error("disposed");
          then("$ ");
        },
        arrived: () => 0,
        pin,
      })
    );
    const wait = startWait();
    click("automation-wait-continue-a");
    expect(query("automation-wait-message-a")?.textContent).toContain("It cannot be told yet");
    fails = false;
    click("automation-wait-continue-a");
    await flushAsync();
    expect(wait.result).toBe("continued");
  });

  it("reads again while output arrives, and not for ever (#6070)", () => {
    vi.useFakeTimers();
    let arrived = 0;
    const reads: ((before: string) => void)[] = [];
    const read = (then: (before: string | null) => void) => void reads.push(then);
    takeBack.push(registerTerminalPrompt("a", { read, arrived: () => arrived, pin }));
    startWait();
    click("automation-wait-continue-a");
    arrived += 1;
    act(() => reads[0]("$ "));
    expect(reads).toHaveLength(2);
    act(() => void vi.advanceTimersByTime(PROMPT_CHECK_LIMIT_MS));
    expect(query("automation-wait-message-a")?.textContent).toContain("It cannot be told yet");
    arrived += 1;
    // The bar looks now and then too.
    const before = reads.length;
    act(() => reads[1]("$ "));
    expect(reads).toHaveLength(before);
  });

  it("reads the terminal that took over the tab while it looked (#6077)", () => {
    vi.useFakeTimers();
    const old: ((before: string) => void)[] = [];
    takeBack.push(
      registerTerminalPrompt("a", { read: (then) => void old.push(then), arrived: () => 0, pin })
    );
    const wait = startWait();
    click("automation-wait-continue-a");
    prompt = "Password: ";
    takeBack.push(
      registerTerminalPrompt("a", { read: (then) => then(prompt), arrived: () => 0, pin })
    );
    act(() => old[0]("$ "));
    expect(wait.result).toBeUndefined();
    expect(query("automation-wait-message-a")?.textContent).toContain("still asks for a password");
  });

  it("holds back for a prompt it saw on the way, though it never settled (#6077)", () => {
    vi.useFakeTimers();
    let arrived = 0;
    const reads: ((before: string) => void)[] = [];
    const read = (then: (before: string | null) => void) => void reads.push(then);
    takeBack.push(registerTerminalPrompt("a", { read, arrived: () => arrived, pin }));
    startWait();
    click("automation-wait-continue-a");
    arrived += 1;
    act(() => reads[0]("Password: "));
    arrived += 1;
    act(() => reads[1]("Password: hunt"));
    act(() => void vi.advanceTimersByTime(PROMPT_CHECK_LIMIT_MS));
    expect(query("automation-wait-message-a")?.textContent).toContain("still asks for a password");
  });

  it("says that it looks when it takes a moment, and asks when it takes too long (#6070)", () => {
    vi.useFakeTimers();
    takeBack.push(registerTerminalPrompt("a", { read: () => {}, arrived: () => 0, pin }));
    startWait();
    click("automation-wait-continue-a");
    expect(query("automation-wait-message-a")?.textContent).toContain("Type your password");
    act(() => void vi.advanceTimersByTime(PROMPT_CHECK_SHOWS_MS));
    expect(query("automation-wait-message-a")?.textContent).toContain("Looking at");
    // It keeps the focus of who pressed it.
    expect(query("automation-wait-continue-a")?.getAttribute("aria-disabled")).toBe("true");
    expect((query("automation-wait-continue-a") as HTMLButtonElement).disabled).toBe(false);
    act(() => void vi.advanceTimersByTime(PROMPT_CHECK_LIMIT_MS));
    expect(query("automation-wait-message-a")?.textContent).toContain("It cannot be told yet");
  });

  it("is the way on again once the password is typed", async () => {
    prompt = "[sudo] password for arne: ";
    const wait = startWait();
    click("automation-wait-continue-a");
    expect(query("automation-wait-continue-a")?.textContent).toBe("Continue anyway");
    act(() => store().recheckWaitingPrompts());
    expect(query("automation-wait-continue-a")?.textContent).toBe("Continue anyway");
    prompt = "$ ";
    act(() => store().recheckWaitingPrompts());
    expect(query("automation-wait-continue-a")?.textContent).toBe("Continue");
    // Else a doubting user types it again, into a shell (C-006).
    expect(query("automation-wait-message-a")?.textContent).toBe(
      "No password prompt any more. Press Continue to go on."
    );
    prompt = "Password: ";
    act(() => store().recheckWaitingPrompts());
    expect(query("automation-wait-message-a")?.textContent).toContain("Type your password");
    expect(wait.result).toBeUndefined();
  });

  it("from anywhere else only shows the terminal that waits (B-001)", async () => {
    const wait = startWait("b");
    const shown: string[] = [];
    const listen = (e: Event) => shown.push((e as CustomEvent<{ tabId: string }>).detail.tabId);
    window.addEventListener(SHOW_WAITING_TERMINAL_EVENT, listen);
    act(() => CONTEXT_COMMANDS["continue-automation"].run());
    await flushAsync();
    expect(wait.result).toBeUndefined();
    expect(shown).toEqual(["b"]);
    // Shown now, so the next press means it.
    act(() => CONTEXT_COMMANDS["continue-automation"].run());
    await flushAsync();
    expect(wait.result).toBe("continued");
    window.removeEventListener(SHOW_WAITING_TERMINAL_EVENT, listen);
  });

  it("is in the command palette for the keyboard, the active terminal's wait first", async () => {
    const command = CONTEXT_COMMANDS["continue-automation"];
    expect(command.isAvailable()).toBe(false);
    const b = startWait("b");
    const a = startWait("a");
    expect(command.isAvailable()).toBe(true);
    act(() => command.run());
    await flushAsync();
    expect([a.result, b.result]).toEqual(["continued", undefined]);
  });

  it("does nothing for a wait that is over, or a run stopped before it waited", async () => {
    act(() => store().continueAutomationWait("gone"));
    act(() => store().recheckWaitingPrompts());
    expect(store().automationWaits).toEqual([]);
    const result = await store().waitForUser(
      { runId: "r", tabId: "a", sessionId: "s", tabTitle: "a", automationName: "x" },
      { isCancelled: () => true }
    );
    expect(result).toBe("cancelled");
    expect(store().automationWaits).toEqual([]);
  });

  it("ends once, whatever comes after", async () => {
    const wait = startWait();
    click("automation-wait-continue-a");
    act(() => wait.cancel());
    await flushAsync();
    expect(wait.result).toBe("continued");
  });

  it("is too late after the limit, also when the computer slept through the timer", async () => {
    const wait = startWait();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + WAIT_FOR_USER_LIMIT_MS);
    act(() => store().continueAutomationWait("run-a"));
    await flushAsync();
    expect(wait.result).toBe("timed-out");
  });
});

describe("what ends it", () => {
  it("Stop", async () => {
    const cancelWorkflowRun = vi.fn();
    act(() => useAppStore.setState({ cancelWorkflowRun }));
    const wait = startWait();
    click("automation-wait-stop-a");
    expect(cancelWorkflowRun).toHaveBeenCalledWith("run-a");
    await act(async () => wait.cancel());
    await flushAsync();
    expect(wait.result).toBe("cancelled");
    expect(query("automation-waits")).toBeNull();
  });

  it("the time limit", async () => {
    vi.useFakeTimers();
    const wait = startWait();
    await act(async () => vi.advanceTimersByTimeAsync(WAIT_FOR_USER_LIMIT_MS - 1));
    expect(wait.result).toBeUndefined();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(wait.result).toBe("timed-out");
    expect(store().automationWaits).toEqual([]);
  });

  it.each<[string, () => void]>([
    ["the terminal is closed", () => seedTabs([tab("b")])],
    ["its tab shows another session", () => seedTabs([tab("a", "sess-new"), tab("b")])],
    [
      "it disconnects",
      () =>
        emitSessions({ a: { status: "disconnected", exit: { code: null, reason: "dropped" } } }),
    ],
  ])("that %s", async (_what, end) => {
    const wait = startWait();
    act(end);
    await flushAsync();
    expect(wait.result).toBe("gone");
  });

  it("a run that was canceled before does not wait at all", async () => {
    const result = await store().waitForUser(
      {
        runId: "r",
        tabId: "a",
        sessionId: "sess-a",
        tabTitle: "prod-web",
        automationName: "Deploy",
      },
      { isCancelled: () => true }
    );
    expect(result).toBe("cancelled");
    expect(store().automationWaits).toEqual([]);
  });
});
