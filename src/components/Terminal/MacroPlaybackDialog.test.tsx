import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { MacroPlaybackDialog } from "./MacroPlaybackDialog";
import type { Macro } from "@/types/macro";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

const macro = (id: string, name: string, stepCount: number): Macro => ({
  id,
  name,
  description: "",
  tags: [],
  steps: Array.from({ length: stepCount }, (_, i) => ({ data: `s${i}`, delayMs: 0 })),
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

const baseProps = {
  open: true,
  macros: [macro("m1", "Deploy", 3), macro("m2", "Login", 2)],
  onOpenChange: () => {},
  onPlay: () => {},
};

describe("MacroPlaybackDialog", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders nothing when closed", () => {
    render(<MacroPlaybackDialog {...baseProps} open={false} />);
    expect(document.querySelector('[data-testid="macro-playback-select"]')).toBeNull();
  });

  it("renders the macro and timing pickers when open with macros", () => {
    render(<MacroPlaybackDialog {...baseProps} />);
    expect(document.querySelector(".ui-modal")).toBeTruthy();
    expect(document.querySelector('[data-testid="macro-playback-select"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="macro-playback-timing"]')).toBeTruthy();
  });

  it("explains how to record when there are no macros, and disables Play", () => {
    render(<MacroPlaybackDialog {...baseProps} macros={[]} />);
    expect(document.querySelector('[data-testid="macro-playback-select"]')).toBeNull();
    expect(document.body.textContent).toContain("No macros saved yet");
    const play = document.querySelector(
      '[data-testid="macro-playback-confirm"]'
    ) as HTMLButtonElement;
    expect(play.disabled).toBe(true);
  });

  it("Play fires onPlay with the default (first) macro and real-time timing", () => {
    const onPlay = vi.fn();
    render(<MacroPlaybackDialog {...baseProps} onPlay={onPlay} />);

    act(() => {
      (document.querySelector('[data-testid="macro-playback-confirm"]') as HTMLElement).click();
    });

    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onPlay).toHaveBeenCalledWith("m1", "real-time");
  });

  it("disables Play for a macro with no steps", () => {
    const onPlay = vi.fn();
    render(<MacroPlaybackDialog {...baseProps} macros={[macro("empty", "Empty", 0)]} onPlay={onPlay} />);

    const play = document.querySelector(
      '[data-testid="macro-playback-confirm"]'
    ) as HTMLButtonElement;
    expect(play.disabled).toBe(true);

    act(() => play.click());
    expect(onPlay).not.toHaveBeenCalled();
  });

  it("Cancel closes the dialog without playing", () => {
    const onPlay = vi.fn();
    const onOpenChange = vi.fn();
    render(<MacroPlaybackDialog {...baseProps} onPlay={onPlay} onOpenChange={onOpenChange} />);

    act(() => {
      (document.querySelector('[data-testid="macro-playback-cancel"]') as HTMLElement).click();
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onPlay).not.toHaveBeenCalled();
  });
});
