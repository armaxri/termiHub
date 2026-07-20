/**
 * Tests for {@link RemoteDesktopCertPrompt} — the interactive RDP
 * certificate-trust dialog (#1767). Verifies the three verdicts route the right
 * (accept, remember) pair and that a changed fingerprint shows the MITM warning.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { RemoteDesktopCertPrompt } from "./RemoteDesktopCertPrompt";
import type { RemoteDesktopCertPromptPayload } from "@/types/remoteDesktop";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => root.render(ui));
}

function click(testid: string) {
  act(() => {
    (document.querySelector(`[data-testid="${testid}"]`) as HTMLElement).click();
  });
}

const unknownPrompt: RemoteDesktopCertPromptPayload = {
  session_id: "rd-1",
  host: "server.example:3389",
  fingerprint: "sha256:AB:CD:EF",
  subject: "CN=server.example",
  changed: false,
};

const changedPrompt: RemoteDesktopCertPromptPayload = {
  session_id: "rd-1",
  host: "server.example:3389",
  fingerprint: "sha256:99:88:77",
  changed: true,
};

describe("RemoteDesktopCertPrompt", () => {
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

  it("renders nothing when there is no prompt", () => {
    render(<RemoteDesktopCertPrompt prompt={null} onDecision={vi.fn()} />);
    expect(document.querySelector('[data-testid="remote-desktop-cert-prompt"]')).toBeNull();
  });

  it("shows the host and fingerprint", () => {
    render(<RemoteDesktopCertPrompt prompt={unknownPrompt} onDecision={vi.fn()} />);
    expect(document.querySelector('[data-testid="cert-host"]')?.textContent).toBe(
      "server.example:3389"
    );
    expect(document.querySelector('[data-testid="cert-fingerprint"]')?.textContent).toBe(
      "sha256:AB:CD:EF"
    );
    // No MITM warning for first contact.
    expect(document.querySelector('[data-testid="cert-mitm-warning"]')).toBeNull();
  });

  it("routes reject as (false, false)", () => {
    const onDecision = vi.fn();
    render(<RemoteDesktopCertPrompt prompt={unknownPrompt} onDecision={onDecision} />);
    click("cert-reject");
    expect(onDecision).toHaveBeenCalledWith(false, false);
  });

  it("routes accept-once as (true, false)", () => {
    const onDecision = vi.fn();
    render(<RemoteDesktopCertPrompt prompt={unknownPrompt} onDecision={onDecision} />);
    click("cert-accept-once");
    expect(onDecision).toHaveBeenCalledWith(true, false);
  });

  it("routes accept-for-host as (true, true)", () => {
    const onDecision = vi.fn();
    render(<RemoteDesktopCertPrompt prompt={unknownPrompt} onDecision={onDecision} />);
    click("cert-accept-remember");
    expect(onDecision).toHaveBeenCalledWith(true, true);
  });

  it("shows a MITM warning when the fingerprint changed", () => {
    render(<RemoteDesktopCertPrompt prompt={changedPrompt} onDecision={vi.fn()} />);
    const warning = document.querySelector('[data-testid="cert-mitm-warning"]');
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain("changed");
  });
});
