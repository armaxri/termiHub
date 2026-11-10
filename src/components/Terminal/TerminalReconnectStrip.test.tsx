/**
 * The reconnecting state renders as a non-blocking strip, not a full overlay
 * (#5179): while auto-reconnect retries, the scrollback underneath must stay
 * readable, scrollable and selectable, and Cancel must still stop the loop.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TerminalDisconnectOverlay } from "./TerminalDisconnectOverlay";
import { INPUT_PAUSED_NOTE } from "./TerminalReconnectStrip";
import { withTooltip } from "@/test/tooltip";
import { useAppStore } from "@/store/appStore";
import {
  failed,
  flushSessionRegion,
  installSessionLifecycleHarness,
  reconnecting,
} from "@/test/sessionLifecycleRegionTestHarness";
import type { ProjectedReconnect, ProjectedSessionLifecycle } from "@/store/sessionBridge";

const TAB = "tab-strip";
const SCROLLBACK = "fatal: connection reset by peer (the line the user wants to copy)";
const harness = installSessionLifecycleHarness();

// The real component CSS, so the layout assertions run against what ships.
const CSS = [
  "src/components/Terminal/TerminalDisconnectOverlay.css",
  "src/components/Terminal/TerminalReconnectStrip.css",
]
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

let style: HTMLStyleElement;
let slot: HTMLDivElement;
let scrollback: HTMLDivElement;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function waiting(over: Partial<ProjectedReconnect> = {}): ProjectedReconnect {
  return { phase: "waiting", attempt: 0, delayMs: 8_000, ...over };
}

beforeEach(() => {
  style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  // Mirror the SplitView terminal slot: the xterm element and the overlay mount
  // side by side inside one positioned container.
  slot = document.createElement("div");
  slot.className = "terminal-container";
  scrollback = document.createElement("div");
  scrollback.className = "xterm";
  scrollback.tabIndex = 0;
  scrollback.textContent = SCROLLBACK;
  host = document.createElement("div");
  slot.append(scrollback, host);
  document.body.appendChild(slot);
  root = createRoot(host);
  useAppStore.setState({ terminalViewMode: {}, terminalReconnectPrompt: {} });
});

afterEach(() => {
  act(() => root.unmount());
  slot.remove();
  style.remove();
  vi.useRealTimers();
});

async function renderWith(life: ProjectedSessionLifecycle): Promise<void> {
  harness.transport.setSession(TAB, life);
  act(() => {
    root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} isActive />));
  });
  await flushSessionRegion();
}

function byTestId(id: string): HTMLElement | null {
  return slot.querySelector(`[data-testid='${id}']`);
}

/** Elements laid out to cover the whole terminal slot (`inset: 0`). */
function fullInsetCovers(): Element[] {
  return Array.from(host.querySelectorAll("*")).filter((el) => {
    const cs = getComputedStyle(el);
    if (cs.position !== "absolute" && cs.position !== "fixed") return false;
    const inset = cs.getPropertyValue("inset").trim();
    if (inset === "0" || inset === "0px") return true;
    return [cs.top, cs.right, cs.bottom, cs.left].every((v) => v === "0" || v === "0px");
  });
}

describe("reconnect strip (#5179)", () => {
  it("covers no part of the terminal with an inset:0 element while retrying", async () => {
    await renderWith(reconnecting(waiting({ attempt: 2 })));
    expect(byTestId("terminal-auto-reconnect-countdown")).not.toBeNull();
    expect(fullInsetCovers()).toEqual([]);
    expect(host.querySelector(".terminal-disconnect-overlay")).toBeNull();
    // Pinned to the top edge only — never stretched down over the scrollback.
    const strip = byTestId("terminal-disconnect-overlay") as HTMLElement;
    expect(strip.dataset.variant).toBe("strip");
    const cs = getComputedStyle(strip);
    expect(cs.top).toBe("0px");
    expect(cs.bottom).not.toBe("0px");
    expect(cs.backdropFilter ?? "").toBe("");
  });

  it("guards the control: a terminal failure still uses the full overlay", async () => {
    await renderWith(failed("all attempts exhausted"));
    expect(fullInsetCovers()).toContain(host.querySelector(".terminal-disconnect-overlay"));
  });

  it("keeps the scrollback selectable underneath while retrying", async () => {
    await renderWith(reconnecting(waiting()));
    expect(getComputedStyle(scrollback).userSelect).not.toBe("none");
    const range = document.createRange();
    range.selectNodeContents(scrollback);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.toString()).toBe(SCROLLBACK);
    // The strip moves no focus off the terminal, so keyboard scroll / copy work.
    scrollback.focus();
    expect(document.activeElement).toBe(scrollback);
    expect(byTestId("terminal-auto-reconnect-countdown")).not.toBeNull();
  });

  it("Cancel stops the loop via session.cancelReconnect", async () => {
    await renderWith(reconnecting(waiting()));
    const cancel = byTestId("terminal-auto-reconnect-cancel-btn") as HTMLButtonElement;
    expect(cancel.tagName).toBe("BUTTON");
    expect(cancel.textContent).toBe("Cancel");
    act(() => cancel.click());
    expect(
      harness.transport.dispatched.some(
        (i) =>
          i.kind === "session.cancelReconnect" &&
          (i.payload as { sessionId: string }).sessionId === TAB
      )
    ).toBe(true);
  });

  it("ticks the countdown and follows the attempt, announcing only attempt changes", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    await renderWith(reconnecting(waiting({ attempt: 0, delayMs: 8_000 })));
    const countdown = () => byTestId("terminal-auto-reconnect-countdown")?.textContent;
    const announcement = () => byTestId("terminal-reconnect-strip-announcement")?.textContent;
    expect(countdown()).toBe("Retrying in 8s · Attempt 1 of 10");
    const announced = announcement();
    expect(announced).toBe("Connection lost — reconnecting… Attempt 1 of 10.");

    act(() => vi.advanceTimersByTime(3_000));
    expect(countdown()).toBe("Retrying in 5s · Attempt 1 of 10");
    // The per-second countdown is never spoken.
    expect(announcement()).toBe(announced);

    harness.transport.setSession(TAB, reconnecting(waiting({ attempt: 1, delayMs: 2_000 })));
    await flushSessionRegion();
    expect(countdown()).toBe("Retrying in 2s · Attempt 2 of 10");
    expect(announcement()).toBe("Connection lost — reconnecting… Attempt 2 of 10.");

    // The attempt in flight keeps the strip (no full overlay) with a Stop control.
    harness.transport.setSession(
      TAB,
      reconnecting({ phase: "connecting", attempt: 2, delayMs: 0 })
    );
    await flushSessionRegion();
    expect(countdown()).toBe("Reconnecting… · Attempt 2 of 10");
    expect(byTestId("terminal-disconnect-stop-btn")).not.toBeNull();
    expect(fullInsetCovers()).toEqual([]);
  });

  it("says typing is paused, and flags it when the user types into the terminal", async () => {
    await renderWith(reconnecting(waiting()));
    const note = byTestId("terminal-reconnect-input-paused") as HTMLElement;
    expect(note.textContent).toBe(INPUT_PAUSED_NOTE);
    expect(note.className).not.toContain("--typed");

    // A copy shortcut is not typing: no nudge.
    act(() => {
      scrollback.dispatchEvent(
        new KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true })
      );
    });
    expect(note.className).not.toContain("--typed");

    act(() => {
      scrollback.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true }));
    });
    expect(note.className).toContain("--typed");
    expect(byTestId("terminal-reconnect-strip-announcement")?.textContent).toContain(
      INPUT_PAUSED_NOTE
    );
  });

  it("ignores keys typed outside its own terminal slot", async () => {
    await renderWith(reconnecting(waiting()));
    const elsewhere = document.createElement("input");
    document.body.appendChild(elsewhere);
    act(() => {
      elsewhere.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
    });
    elsewhere.remove();
    expect(byTestId("terminal-reconnect-input-paused")?.className).not.toContain("--typed");
  });
});
