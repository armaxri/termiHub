import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { AgentVersionBadge } from "./AgentVersionBadge";

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
  // The `motion-essential-spinner` marker keeps it pulsing under reduced motion
  // instead of freezing. It must be present only in the updating state so idle
  // states are not made to pulse.
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
