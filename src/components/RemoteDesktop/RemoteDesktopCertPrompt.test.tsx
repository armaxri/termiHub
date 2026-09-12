/**
 * Tests for {@link RemoteDesktopCertPrompt} — the RDP certificate-trust dialog
 * (#1767), now rendered through the shared {@link TrustPrompt} primitive
 * (UISF-007). Verifies the three verdicts route the right (accept, remember)
 * pair, that a changed certificate shows the MITM warning, and that the
 * fingerprint is copyable (UX-034).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
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

const untrusted: RemoteDesktopCertPromptPayload = {
  session_id: "s-1",
  host: "desktop.example",
  fingerprint: "sha256:AB:CD:EF",
  subject: "CN=desktop.example",
  changed: false,
};

const changed: RemoteDesktopCertPromptPayload = {
  ...untrusted,
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

  it("shows the host, subject and fingerprint", () => {
    render(<RemoteDesktopCertPrompt prompt={untrusted} onDecision={vi.fn()} />);
    expect(document.querySelector('[data-testid="cert-host"]')?.textContent).toBe(
      "desktop.example"
    );
    expect(document.querySelector('[data-testid="cert-subject"]')?.textContent).toBe(
      "CN=desktop.example"
    );
    expect(document.querySelector('[data-testid="cert-fingerprint"]')?.textContent).toBe(
      "sha256:AB:CD:EF"
    );
    expect(document.querySelector('[data-testid="cert-mitm-warning"]')).toBeNull();
  });

  it("routes the three verdicts", () => {
    const onDecision = vi.fn();
    render(<RemoteDesktopCertPrompt prompt={untrusted} onDecision={onDecision} />);
    click("cert-reject");
    expect(onDecision).toHaveBeenCalledWith(false, false);
    click("cert-accept-once");
    expect(onDecision).toHaveBeenCalledWith(true, false);
    click("cert-accept-remember");
    expect(onDecision).toHaveBeenCalledWith(true, true);
  });

  it("warns about a possible MITM when the certificate changed", () => {
    render(<RemoteDesktopCertPrompt prompt={changed} onDecision={vi.fn()} />);
    const warning = document.querySelector('[data-testid="cert-mitm-warning"]');
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain("changed");
  });

  it("copies the fingerprint to the clipboard", () => {
    render(<RemoteDesktopCertPrompt prompt={untrusted} onDecision={vi.fn()} />);
    click("cert-fingerprint-copy");
    expect(writeClipboard).toHaveBeenCalledWith("sha256:AB:CD:EF");
  });
});
