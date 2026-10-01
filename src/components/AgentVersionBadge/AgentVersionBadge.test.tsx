import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { AgentVersionBadge } from "./AgentVersionBadge";
import { mockReducedMotion } from "@/test/reducedMotion";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

describe("AgentVersionBadge", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the version chip prefixed with v", () => {
    render(<AgentVersionBadge version="0.1.0" state="up-to-date" />);
    const chip = container.querySelector(".agent-version-badge__chip");
    expect(chip?.textContent).toBe("v0.1.0");
  });

  it.each([
    ["up-to-date", "agent-version-badge__state--up-to-date"],
    ["update-available", "agent-version-badge__state--update-available"],
    ["incompatible", "agent-version-badge__state--incompatible"],
    ["updating", "agent-version-badge__state--updating"],
  ] as const)("applies the %s state modifier class", (state, expectedClass) => {
    render(<AgentVersionBadge version="0.1.0" state={state} />);
    expect(container.querySelector(`.${expectedClass}`)).toBeTruthy();
  });

  // #2603: while updating, the badge icon is the sole "work in progress" cue.
  // The `motion-essential-spinner` marker renders it static under reduced motion
  // (#4039) beside a steady label. It must be present only in the updating state
  // so idle states keep their plain icon.
  it("marks the icon as essential motion only while updating", () => {
    render(<AgentVersionBadge version="0.1.0" state="updating" />);
    const updatingIcon = container.querySelector(".agent-version-badge__icon") as HTMLElement;
    expect(updatingIcon.getAttribute("class")).toContain("motion-essential-spinner");

    act(() => root.unmount());
    root = createRoot(container);
    render(<AgentVersionBadge version="0.1.0" state="up-to-date" />);
    const idleIcon = container.querySelector(".agent-version-badge__icon") as HTMLElement;
    expect(idleIcon.getAttribute("class")).not.toContain("motion-essential-spinner");
  });

  // #4039: under reduced motion the updating icon is static, so the steady
  // "Updating…" word is shown even where the label is normally hidden.
  it("shows the steady 'Updating…' label only while updating under reduced motion", () => {
    const motion = mockReducedMotion(true);
    try {
      render(<AgentVersionBadge version="0.1.0" state="updating" />);
      expect(container.querySelector(".agent-version-badge__label")?.textContent).toBe("Updating…");
      render(<AgentVersionBadge version="0.1.0" state="up-to-date" />);
      expect(container.querySelector(".agent-version-badge__label")).toBeNull();
    } finally {
      motion.restore();
    }
  });

  it("keeps the label hidden while updating with full motion (nothing changes)", () => {
    const motion = mockReducedMotion(false);
    try {
      render(<AgentVersionBadge version="0.1.0" state="updating" />);
      expect(container.querySelector(".agent-version-badge__label")).toBeNull();
    } finally {
      motion.restore();
    }
  });

  it("exposes an accessible label describing the update state", () => {
    render(<AgentVersionBadge version="0.1.0" state="update-available" />);
    const badge = container.querySelector(".agent-version-badge__state");
    expect(badge?.getAttribute("aria-label")).toMatch(/update available/i);
  });

  it("renders a text label when showLabel is set", () => {
    render(<AgentVersionBadge version="0.1.0" state="update-available" showLabel />);
    const label = container.querySelector(".agent-version-badge__label");
    expect(label?.textContent).toMatch(/update available/i);
  });

  it("renders nothing when the state is unknown", () => {
    render(<AgentVersionBadge version="" state="unknown" />);
    expect(container.querySelector(".agent-version-badge")).toBeNull();
  });

  it("renders nothing when no version is supplied", () => {
    render(<AgentVersionBadge state="up-to-date" />);
    expect(container.querySelector(".agent-version-badge")).toBeNull();
  });

  it("forwards a data-testid to the root", () => {
    render(
      <AgentVersionBadge version="0.1.0" state="up-to-date" data-testid="agent-version-badge-x" />
    );
    expect(document.querySelector('[data-testid="agent-version-badge-x"]')).toBeTruthy();
  });
});
