/**
 * The X11 forwarding mode chip on an SSH session row (#5586): a short label
 * per mode, with the why (and the server fix for the fallback) in its tooltip.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TooltipProvider } from "@/components/ui";
import type { X11ForwardingMode } from "@/types/generated/X11ForwardingMode";
import type { X11ForwardingReason } from "@/types/generated/X11ForwardingReason";
import { checkA11y } from "@/test/axe";
import { X11ForwardingChip, x11ChipHint, x11ModeCopy, x11ReasonCopy } from "./X11ForwardingChip";

let container: HTMLDivElement;
let root: Root;

function render(mode: X11ForwardingMode, reason?: X11ForwardingReason) {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <X11ForwardingChip mode={mode} reason={reason} data-testid="x11-chip" />
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

  it("explains the untrusted fail-closed case in the failure hint (#5585)", () => {
    const hint = x11ModeCopy("failed").hint;
    expect(hint).toContain("untrusted X11 forwarding");
    expect(hint).toContain("SECURITY extension");
    expect(hint).toContain("turn the option off");
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

  describe("with the exact reason (#5601)", () => {
    const CASES: [X11ForwardingMode, X11ForwardingReason, string, string][] = [
      ["failed", "noLocalXServer", "no local X server", "Start a local X server"],
      ["fallbackRefused", "serverRefused", "X11Forwarding no", "Set X11Forwarding yes"],
      ["fallbackNoReply", "serverNoReply", "did not answer", "sshd log"],
      [
        "failed",
        "untrustedNoSecurityExtension",
        "SECURITY extension",
        "Turn off Untrusted X11 forwarding",
      ],
      ["failed", "untrustedXauthMissing", "xauth, which is not installed", "Install xauth"],
      ["failed", "untrustedXauthFailed", "xauth could not create", "local X server is running"],
      ["failed", "fallbackFailed", "fallback could not start", "Set X11Forwarding yes"],
    ];

    it.each(CASES)("shows the %s / %s reason and its fix", (mode, reason, why, fix) => {
      const chip = render(mode, reason);
      expect(chip.textContent).toBe(x11ModeCopy(mode).label);
      expect(chip.closest(".oc-x11")?.getAttribute("data-x11-reason")).toBe(reason);
      const hint = tooltipText(chip);
      expect(hint).toContain(why);
      expect(hint).toContain(fix);
    });

    it("gives every reason one sentence-case line of why and one of fix", () => {
      for (const [, reason] of CASES) {
        const { why, fix } = x11ReasonCopy(reason);
        for (const line of [why, fix]) {
          expect(line[0]).toBe(line[0].toUpperCase());
          expect(line.endsWith(".")).toBe(true);
          expect(line).not.toContain("\n");
        }
      }
    });

    it("keeps the mode hint when no reason is known", () => {
      expect(x11ChipHint("failed")).toBe(x11ModeCopy("failed").hint);
      const chip = render("failed");
      expect(chip.closest(".oc-x11")?.hasAttribute("data-x11-reason")).toBe(false);
    });

    it("ignores a reason on a server-forwarded session", () => {
      expect(x11ChipHint("serverForwarded", "serverRefused")).toBe(
        x11ModeCopy("serverForwarded").hint
      );
    });

    it("has no a11y violations with a reason", async () => {
      const chip = render("failed", "untrustedNoSecurityExtension");
      expect(chip.getAttribute("tabindex")).toBe("0");
      tooltipText(chip);
      expect(await checkA11y()).toHaveNoViolations();
    });
  });
});
