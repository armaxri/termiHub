/**
 * The terminal toolbar's "…" menu (#5756) on the real Menu primitive: the
 * moved actions are menu rows with right-aligned registry shortcuts, the menu
 * is end-aligned to its trigger, and running actions show as chips.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TooltipProvider } from "@/components/ui";
import { clearOverrides, setOverride } from "@/services/keybindings";
import { TerminalToolbarMore, type TerminalToolbarMoreProps } from "./TerminalToolbarMore";

const MENU = '[data-testid="terminal-view-more-menu"]';

let container: HTMLDivElement;
let root: Root;

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function props(overrides: Partial<TerminalToolbarMoreProps> = {}): TerminalToolbarMoreProps {
  return {
    broadcastActive: false,
    onToggleBroadcast: vi.fn(),
    loggingActive: false,
    onToggleLogging: vi.fn(),
    recordingLabel: null,
    recording: (overrides.recordingLabel ?? null) !== null,
    onToggleRecording: vi.fn(),
    playback: null,
    onRunAutomation: vi.fn(),
    onStopPlayback: vi.fn(),
    ...overrides,
  };
}

function render(p: TerminalToolbarMoreProps): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <TerminalToolbarMore {...p} />
      </TooltipProvider>
    );
  });
}

function q(testId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

async function openMenu(): Promise<HTMLElement> {
  const trigger = q("terminal-view-more-actions")!;
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
    );
  });
  for (let i = 0; i < 20 && !document.querySelector(MENU); i++) {
    await act(async () => {
      await Promise.resolve();
      await nextFrame();
    });
  }
  const menu = document.querySelector<HTMLElement>(MENU);
  if (!menu) throw new Error("the … menu did not open");
  return menu;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  clearOverrides();
});

describe("TerminalToolbarMore (#5756)", () => {
  it("is one labelled … trigger; the actions mount only once it opens", () => {
    render(props());
    const trigger = q("terminal-view-more-actions")!;
    expect(trigger.getAttribute("aria-label")).toBe("More terminal actions");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(q("terminal-view-broadcast")).toBeNull();
  });

  it("lists broadcast, logging, record and play, end-aligned to the trigger", async () => {
    render(props());
    const menu = await openMenu();
    const rows = Array.from(menu.querySelectorAll('[role^="menuitem"]')).map((r) => ({
      id: r.getAttribute("data-testid"),
      text: r.textContent,
    }));
    expect(rows.map((r) => r.id)).toEqual([
      "terminal-view-broadcast",
      "terminal-view-toggle-logging",
      "terminal-view-record",
      "terminal-view-run-automation",
    ]);
    expect(rows[0].text).toContain("Broadcast input…");
    expect(rows[3].text).toContain("Run automation…");
    expect(menu.getAttribute("data-align")).toBe("end");
  });

  it("right-aligns each bound action's shortcut from the registry", async () => {
    setOverride("toggle-broadcast", { key: "F6" });
    setOverride("toggle-macro-recording", { key: "F4", ctrl: true });
    render(props());
    await openMenu();
    const shortcut = (id: string) => q(id)!.querySelector(".ui-menu__shortcut")?.textContent;
    expect(shortcut("terminal-view-broadcast")).toBe("F6");
    expect(shortcut("terminal-view-record")).toBe("Ctrl+F4");
    // Logging and playback ship unbound (#5779), so nothing is invented.
    expect(shortcut("terminal-view-toggle-logging")).toBeUndefined();
    expect(shortcut("terminal-view-run-automation")).toBeUndefined();
  });

  it("names the logging and play shortcuts once the user binds them (#5779)", async () => {
    setOverride("toggle-session-logging", { key: "L", alt: true, shift: true });
    setOverride("play-macro", { key: "F5", ctrl: true });
    render(props());
    await openMenu();
    const shortcut = (id: string) => q(id)!.querySelector(".ui-menu__shortcut")?.textContent;
    expect(shortcut("terminal-view-toggle-logging")).toBe("Shift+Alt+L");
    expect(shortcut("terminal-view-run-automation")).toBe("Ctrl+F5");
  });

  it("names the bound shortcut on the logging and playback chips (#5779)", () => {
    setOverride("toggle-session-logging", { key: "L", alt: true, shift: true });
    setOverride("play-macro", { key: "F5", ctrl: true });
    render(props({ loggingActive: true, playback: { macroName: "Deploy", played: 1, total: 3 } }));
    expect(q("terminal-view-active-logging")!.getAttribute("aria-label")).toBe(
      "Stop logging output (Shift+Alt+L)"
    );
    expect(q("terminal-view-active-playback")!.getAttribute("aria-label")).toBe(
      "Stop “Deploy” (33 % typed) (Ctrl+F5)"
    );
  });

  it("shows logging and recording as checkbox rows, ticked only while on (#5849)", async () => {
    render(props());
    let menu = await openMenu();
    const row = (id: string) => q(id)!;
    for (const id of ["terminal-view-toggle-logging", "terminal-view-record"]) {
      expect(row(id).getAttribute("role")).toBe("menuitemcheckbox");
      expect(row(id).getAttribute("aria-checked")).toBe("false");
      expect(row(id).querySelector(".lucide-check")).toBeNull();
    }
    // Broadcast and play are actions with a dialog, not on/off rows.
    expect(row("terminal-view-broadcast").getAttribute("role")).toBe("menuitem");
    expect(row("terminal-view-run-automation").getAttribute("role")).toBe("menuitem");
    // Every row has the tick column, so the labels line up.
    expect(menu.querySelectorAll(".ui-menu__indicator")).toHaveLength(4);
    act(() => root.unmount());
    root = createRoot(container);

    render(props({ loggingActive: true, recordingLabel: "Stop recording" }));
    menu = await openMenu();
    for (const [id, label] of [
      ["terminal-view-toggle-logging", "Log session output"],
      ["terminal-view-record", "Record automation"],
    ]) {
      expect(row(id).getAttribute("aria-checked")).toBe("true");
      expect(row(id).querySelector(".lucide-check")).not.toBeNull();
      expect(row(id).textContent).toBe(label);
    }
    expect(menu).not.toBeNull();
  });

  it("toggles logging from its checkbox row", async () => {
    const p = props({ loggingActive: true });
    render(p);
    await openMenu();
    await act(async () => q("terminal-view-toggle-logging")!.click());
    expect(p.onToggleLogging).toHaveBeenCalledTimes(1);
  });

  it("fires the row's action on select", async () => {
    const p = props();
    render(p);
    await openMenu();
    await act(async () => q("terminal-view-run-automation")!.click());
    expect(p.onRunAutomation).toHaveBeenCalledTimes(1);
  });

  it("shows a chip per running action and the count on the trigger", () => {
    render(
      props({
        broadcastActive: true,
        loggingActive: true,
        recordingLabel: "Stop recording",
        playback: { macroName: "Deploy", played: 2, total: 4 },
      })
    );
    const chips = Array.from(
      q("terminal-view-active-states")!.querySelectorAll("button"),
      (b) => b.textContent
    );
    expect(chips).toEqual([
      "Broadcasting",
      "Stop recording",
      "Stop “Deploy” (50 % typed)",
      "Logging",
    ]);
    expect(q("terminal-view-more-actions")!.getAttribute("data-active-count")).toBe("4");
  });

  it("stops an action from its chip", () => {
    const p = props({ broadcastActive: true });
    render(p);
    act(() => q("terminal-view-active-broadcast")!.click());
    expect(p.onToggleBroadcast).toHaveBeenCalledTimes(1);
  });
});
