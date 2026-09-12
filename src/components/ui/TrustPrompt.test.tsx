/**
 * Tests for the shared {@link TrustPrompt} primitive (UISF-007) — the
 * trust-on-first-use dialog behind both the SSH host-key and RDP certificate
 * prompts. Verifies the three verdicts fire the right callbacks, that a changed
 * identity surfaces the MITM warning, and that a `copyable` fact copies its
 * value to the clipboard and confirms (UX-034).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import { TrustPrompt, type TrustFact } from "./TrustPrompt";
import { toast } from "./Toast";

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

const facts: TrustFact[] = [
  { label: "Host", value: "server.example:2222", testId: "tp-host" },
  {
    label: "Fingerprint",
    value: "SHA256:AABBCCDD",
    mono: true,
    copyable: true,
    testId: "tp-fingerprint",
    copyTestId: "tp-fingerprint-copy",
  },
];

function renderPrompt(props: Partial<React.ComponentProps<typeof TrustPrompt>> = {}) {
  const onReject = vi.fn();
  const onAcceptOnce = vi.fn();
  const onAcceptForHost = vi.fn();
  render(
    <TrustPrompt
      open
      changed={false}
      unknownTitle="Unknown host key"
      changedTitle="Host key changed"
      unknownLead="not yet trusted for:"
      changedLead="different key for:"
      changedWarningSubject="host key for this server"
      facts={facts}
      onReject={onReject}
      onAcceptOnce={onAcceptOnce}
      onAcceptForHost={onAcceptForHost}
      modalTestId="tp-prompt"
      rejectTestId="tp-reject"
      acceptOnceTestId="tp-accept-once"
      acceptForHostTestId="tp-accept-remember"
      warningTestId="tp-mitm-warning"
      {...props}
    />
  );
  return { onReject, onAcceptOnce, onAcceptForHost };
}

describe("TrustPrompt", () => {
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

  it("renders the facts and the three verdict buttons", () => {
    renderPrompt();
    expect(document.querySelector('[data-testid="tp-host"]')?.textContent).toBe(
      "server.example:2222"
    );
    expect(document.querySelector('[data-testid="tp-fingerprint"]')?.textContent).toBe(
      "SHA256:AABBCCDD"
    );
    expect(document.querySelector('[data-testid="tp-reject"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="tp-accept-once"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="tp-accept-remember"]')).not.toBeNull();
  });

  it("routes each verdict to its callback", () => {
    const { onReject, onAcceptOnce, onAcceptForHost } = renderPrompt();
    click("tp-reject");
    expect(onReject).toHaveBeenCalledTimes(1);
    click("tp-accept-once");
    expect(onAcceptOnce).toHaveBeenCalledTimes(1);
    click("tp-accept-remember");
    expect(onAcceptForHost).toHaveBeenCalledTimes(1);
  });

  it("hides the MITM warning for a new identity and shows it for a changed one", () => {
    renderPrompt({ changed: false });
    expect(document.querySelector('[data-testid="tp-mitm-warning"]')).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    renderPrompt({ changed: true });
    const warning = document.querySelector('[data-testid="tp-mitm-warning"]');
    expect(warning).not.toBeNull();
    expect(warning?.getAttribute("role")).toBe("alert");
    expect(warning?.textContent).toContain("changed");
  });

  it("copies a copyable fact to the clipboard and confirms", () => {
    const success = vi.spyOn(toast, "success").mockReturnValue("id");
    renderPrompt();
    click("tp-fingerprint-copy");
    expect(writeClipboard).toHaveBeenCalledWith("SHA256:AABBCCDD");
    success.mockRestore();
  });

  it("only copyable facts get a copy button", () => {
    renderPrompt();
    // The host fact is not copyable; the fingerprint is.
    expect(document.querySelector('[data-testid="tp-fingerprint-copy"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="tp-host"] .ui-trust-prompt__copy')).toBeNull();
  });
});
