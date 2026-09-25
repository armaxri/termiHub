/**
 * Tests for {@link SshHostKeyPrompt} — the global interactive SSH host-key
 * trust dialog (#1959). Verifies the three verdicts route the right
 * (accept, remember) pair through `sshHostKeyDecision`, that a changed key shows
 * the MITM warning, and that concurrent prompts are shown one at a time.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import type { SshHostKeyPromptPayload } from "@/types/sshHostKey";

// Capture the event callback the component registers so tests can fire prompts.
let emitPrompt: ((p: SshHostKeyPromptPayload) => void) | undefined;
const decisionMock = vi.fn().mockResolvedValue(true);

vi.mock("@/services/events", () => ({
  onSshHostKeyPrompt: (cb: (p: SshHostKeyPromptPayload) => void) => {
    emitPrompt = cb;
    return Promise.resolve(() => {});
  },
}));

vi.mock("@/services/api", () => ({
  sshHostKeyDecision: (promptId: string, accept: boolean, remember: boolean) =>
    decisionMock(promptId, accept, remember),
}));

import { SshHostKeyPrompt } from "./SshHostKeyPrompt";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => root.render(ui));
}

async function fire(payload: SshHostKeyPromptPayload) {
  // Flush the mocked listener registration, then deliver the event.
  await act(async () => {
    await Promise.resolve();
  });
  act(() => emitPrompt?.(payload));
}

function click(testid: string) {
  act(() => {
    (document.querySelector(`[data-testid="${testid}"]`) as HTMLElement).click();
  });
}

const unknownPrompt: SshHostKeyPromptPayload = {
  prompt_id: "p-1",
  host: "server.example",
  port: 2222,
  key_type: "ssh-ed25519",
  fingerprint: "SHA256:AABBCCDD",
  changed: false,
  previous_fingerprints: null,
};

const changedPrompt: SshHostKeyPromptPayload = {
  prompt_id: "p-2",
  host: "server.example",
  port: 2222,
  key_type: "ssh-ed25519",
  fingerprint: "SHA256:99887766",
  changed: true,
  previous_fingerprints: null,
};

// A changed key that carries the previously-trusted fingerprint for comparison.
const changedWithPriorPrompt: SshHostKeyPromptPayload = {
  prompt_id: "p-3",
  host: "server.example",
  port: 2222,
  key_type: "ssh-ed25519",
  fingerprint: "SHA256:99887766",
  changed: true,
  previous_fingerprints: ["SHA256:AABBCCDD"],
};

describe("SshHostKeyPrompt", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    emitPrompt = undefined;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders nothing until a prompt arrives", () => {
    render(<SshHostKeyPrompt />);
    expect(document.querySelector('[data-testid="ssh-hostkey-prompt"]')).toBeNull();
  });

  it("shows the host:port, key type and fingerprint", async () => {
    render(<SshHostKeyPrompt />);
    await fire(unknownPrompt);
    expect(document.querySelector('[data-testid="ssh-hostkey-host"]')?.textContent).toBe(
      "server.example:2222"
    );
    expect(document.querySelector('[data-testid="ssh-hostkey-type"]')?.textContent).toBe(
      "ssh-ed25519"
    );
    expect(document.querySelector('[data-testid="ssh-hostkey-fingerprint"]')?.textContent).toBe(
      "SHA256:AABBCCDD"
    );
    // No MITM warning on first contact.
    expect(document.querySelector('[data-testid="ssh-hostkey-mitm-warning"]')).toBeNull();
  });

  it("routes reject as (false, false)", async () => {
    render(<SshHostKeyPrompt />);
    await fire(unknownPrompt);
    click("ssh-hostkey-reject");
    expect(decisionMock).toHaveBeenCalledWith("p-1", false, false);
  });

  it("routes accept-once as (true, false)", async () => {
    render(<SshHostKeyPrompt />);
    await fire(unknownPrompt);
    click("ssh-hostkey-accept-once");
    expect(decisionMock).toHaveBeenCalledWith("p-1", true, false);
  });

  it("routes accept-for-host as (true, true)", async () => {
    render(<SshHostKeyPrompt />);
    await fire(unknownPrompt);
    click("ssh-hostkey-accept-remember");
    expect(decisionMock).toHaveBeenCalledWith("p-1", true, true);
  });

  it("copies the fingerprint to the clipboard from the copy button", async () => {
    render(<SshHostKeyPrompt />);
    await fire(unknownPrompt);
    click("ssh-hostkey-fingerprint-copy");
    expect(writeClipboard).toHaveBeenCalledWith("SHA256:AABBCCDD");
  });

  it("shows a MITM warning when the key changed", async () => {
    render(<SshHostKeyPrompt />);
    await fire(changedPrompt);
    const warning = document.querySelector('[data-testid="ssh-hostkey-mitm-warning"]');
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain("changed");
  });

  it("shows only the new fingerprint (no prior) on a changed key without a stored prior", async () => {
    render(<SshHostKeyPrompt />);
    await fire(changedPrompt);
    // No previously-trusted fingerprint to compare against.
    expect(document.querySelector('[data-testid="ssh-hostkey-prev-fingerprint"]')).toBeNull();
    // The single fingerprint keeps the "Fingerprint" label (not "New").
    const fp = document.querySelector('[data-testid="ssh-hostkey-fingerprint"]');
    expect(fp?.textContent).toContain("SHA256:99887766");
    expect(fp?.previousElementSibling?.textContent).toBe("Fingerprint");
  });

  it("renders previously-trusted and new fingerprints side-by-side when a prior is present", async () => {
    render(<SshHostKeyPrompt />);
    await fire(changedWithPriorPrompt);
    // Both fingerprints render, each labeled and copyable.
    const prev = document.querySelector('[data-testid="ssh-hostkey-prev-fingerprint"]');
    const next = document.querySelector('[data-testid="ssh-hostkey-fingerprint"]');
    expect(prev?.textContent).toContain("SHA256:AABBCCDD");
    expect(next?.textContent).toContain("SHA256:99887766");
    // Labels make the comparison explicit.
    expect(prev?.previousElementSibling?.textContent).toBe("Previously trusted");
    expect(next?.previousElementSibling?.textContent).toBe("New");
    // Both have their own copy affordance.
    expect(
      document.querySelector('[data-testid="ssh-hostkey-prev-fingerprint-copy"]')
    ).not.toBeNull();
    expect(document.querySelector('[data-testid="ssh-hostkey-fingerprint-copy"]')).not.toBeNull();
  });

  it("copies the previously-trusted fingerprint from its copy button", async () => {
    render(<SshHostKeyPrompt />);
    await fire(changedWithPriorPrompt);
    click("ssh-hostkey-prev-fingerprint-copy");
    expect(writeClipboard).toHaveBeenCalledWith("SHA256:AABBCCDD");
  });

  it("serialises concurrent prompts one at a time", async () => {
    render(<SshHostKeyPrompt />);
    await fire(unknownPrompt);
    act(() => emitPrompt?.(changedPrompt));
    // The first prompt is shown; the second is queued behind it.
    expect(document.querySelector('[data-testid="ssh-hostkey-fingerprint"]')?.textContent).toBe(
      "SHA256:AABBCCDD"
    );
    click("ssh-hostkey-accept-once");
    expect(decisionMock).toHaveBeenCalledWith("p-1", true, false);
    // After deciding the first, the queued changed-key prompt surfaces.
    expect(document.querySelector('[data-testid="ssh-hostkey-fingerprint"]')?.textContent).toBe(
      "SHA256:99887766"
    );
    expect(document.querySelector('[data-testid="ssh-hostkey-mitm-warning"]')).not.toBeNull();
  });
});
