/**
 * The X11 forwarding mode chip on an SSH session row (#5586): a short label
 * per mode, with the why (and the server fix for the fallback) in its tooltip.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TooltipProvider } from "@/components/ui";
import type { X11ForwardingMode } from "@/types/generated/X11ForwardingMode";
import { checkA11y } from "@/test/axe";
import { X11ForwardingChip, x11ModeCopy } from "./X11ForwardingChip";

let container: HTMLDivElement;
let root: Root;

function render(mode: X11ForwardingMode) {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <X11ForwardingChip mode={mode} data-testid="x11-chip" />
      </TooltipProvider>
    );
  });
  return container.querySelector<HTMLElement>('[data-testid="x11-chip"]')!;
}

/** Focus the chip and return the text of the tooltip it describes itself with. */
function tooltipText(chip: HTMLElement): string {
  act(() => {
    chip.focus();
    chip.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
  });
  const id = chip.getAttribute("aria-describedby");
  expect(id).toBeTruthy();
  return document.getElementById(id!)?.textContent ?? "";
}

describe("X11ForwardingChip", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows a quiet X11 label when the server forwards X11", () => {
    const chip = render("serverForwarded");
    expect(chip.textContent).toBe("X11");
    expect(chip.closest(".oc-x11")?.classList.contains("oc-x11--ok")).toBe(true);
    expect(tooltipText(chip)).toContain("the SSH server sets DISPLAY");
  });

  it("flags the fallback after a refusal and says how to fix the server", () => {
    const chip = render("fallbackRefused");
    expect(chip.textContent).toBe("X11 fallback");
    expect(chip.closest(".oc-x11")?.classList.contains("oc-x11--fallback")).toBe(true);
    const hint = tooltipText(chip);
    expect(hint).toContain("X11Forwarding no");
    expect(hint).toContain("Set X11Forwarding yes");
    expect(hint).toContain("typed into the shell");
  });

  it("flags the fallback when the server did not answer", () => {
    const chip = render("fallbackNoReply");
    expect(chip.textContent).toBe("X11 fallback");
    expect(tooltipText(chip)).toContain("did not answer");
  });

  it("shows a failure when X11 forwarding could not be set up", () => {
    const chip = render("failed");
    expect(chip.textContent).toBe("X11 failed");
    expect(chip.closest(".oc-x11")?.classList.contains("oc-x11--failed")).toBe(true);
    expect(tooltipText(chip)).toContain("runs without it");
  });

  it("is keyboard-focusable so the hint is reachable", () => {
    expect(render("fallbackRefused").getAttribute("tabindex")).toBe("0");
  });

  it("has no a11y violations", async () => {
    render("fallbackRefused");
    expect(await checkA11y()).toHaveNoViolations();
  });

  it("uses sentence case for every label", () => {
    const modes: X11ForwardingMode[] = [
      "serverForwarded",
      "fallbackRefused",
      "fallbackNoReply",
      "failed",
    ];
    for (const mode of modes) {
      const words = x11ModeCopy(mode).label.split(" ").slice(1);
      expect(words.every((w) => w === w.toLowerCase())).toBe(true);
    }
  });
});
