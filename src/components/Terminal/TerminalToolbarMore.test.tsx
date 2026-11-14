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
    macroRecording: false,
    onToggleRecording: vi.fn(),
    macroPlayback: null,
    onPlayMacro: vi.fn(),
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
    const rows = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((r) => ({
      id: r.getAttribute("data-testid"),
      text: r.textContent,
    }));
    expect(rows.map((r) => r.id)).toEqual([
      "terminal-view-broadcast",
      "terminal-view-toggle-logging",
      "terminal-view-record-macro",
      "terminal-view-play-macro",
    ]);
    expect(rows[0].text).toContain("Broadcast input…");
    expect(rows[3].text).toContain("Play macro…");
    expect(menu.getAttribute("data-align")).toBe("end");
  });

  it("right-aligns each bound action's shortcut from the registry", async () => {
    setOverride("toggle-broadcast", { key: "F6" });
    setOverride("toggle-macro-recording", { key: "F4", ctrl: true });
    render(props());
    await openMenu();
    const shortcut = (id: string) => q(id)!.querySelector(".ui-menu__shortcut")?.textContent;
    expect(shortcut("terminal-view-broadcast")).toBe("F6");
    expect(shortcut("terminal-view-record-macro")).toBe("Ctrl+F4");
    // No binding exists for logging or playback, so nothing is invented.
    expect(shortcut("terminal-view-toggle-logging")).toBeUndefined();
  });

  it("fires the row's action on select", async () => {
    const p = props();
    render(p);
    await openMenu();
    await act(async () => q("terminal-view-play-macro")!.click());
    expect(p.onPlayMacro).toHaveBeenCalledTimes(1);
  });

  it("shows a chip per running action and the count on the trigger", () => {
    render(
      props({
        broadcastActive: true,
        loggingActive: true,
        macroRecording: true,
        macroPlayback: { played: 2, total: 4 },
      })
    );
    const chips = Array.from(
      q("terminal-view-active-states")!.querySelectorAll("button"),
      (b) => b.textContent
    );
    expect(chips).toEqual(["Broadcasting", "Recording", "Playing 2/4", "Logging"]);
    expect(q("terminal-view-more-actions")!.getAttribute("data-active-count")).toBe("4");
  });

  it("stops an action from its chip", () => {
    const p = props({ broadcastActive: true });
    render(p);
    act(() => q("terminal-view-active-broadcast")!.click());
    expect(p.onToggleBroadcast).toHaveBeenCalledTimes(1);
  });
});
