/**
 * Tests for the Trusted Publishers settings group (#2036): listing bundled and
 * user-pinned publisher keys, and revoking a user-pinned key (bundled keys carry
 * no revoke action).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import React from "react";
import type { TrustedPublisher } from "@/types/plugin";
import { withTooltip } from "@/test/tooltip";
import { TrustedPublishersSettings } from "./TrustedPublishersSettings";

const listMock = vi.fn();
const revokeMock = vi.fn();

vi.mock("@/services/api", () => ({
  listTrustedPublishers: (...a: unknown[]) => listMock(...a),
  revokeTrustedPublisher: (...a: unknown[]) => revokeMock(...a),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

function publisher(overrides: Partial<TrustedPublisher> = {}): TrustedPublisher {
  return {
    keyId: "sha256:ab12cd34ef56ab12cd34ef569f0e9f0e",
    publicKey: "cHVia2V5",
    label: "ACME Terminals",
    source: "user-pinned",
    addedAt: "2026-07-26T12:00:00Z",
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function render() {
  act(() => root.render(withTooltip(React.createElement(TrustedPublishersSettings))));
}

describe("TrustedPublishersSettings (#2036)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    listMock.mockReset();
    revokeMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the empty state when no publishers are trusted", async () => {
    listMock.mockResolvedValue([]);
    render();
    await flush();
    expect(document.querySelector('[data-testid="trusted-publishers-empty"]')).not.toBeNull();
  });

  it("lists bundled (no revoke) and user-pinned (with revoke) keys", async () => {
    listMock.mockResolvedValue([
      publisher({ keyId: "sha256:bundled0000", label: "termiHub Official", source: "bundled" }),
      publisher(),
    ]);
    render();
    await flush();

    const rows = document.querySelectorAll('[data-testid="trusted-publisher-row"]');
    expect(rows).toHaveLength(2);
    // Bundled: no revoke button; user-pinned: has one.
    expect(
      document.querySelector('[data-testid="trusted-publisher-revoke-sha256:bundled0000"]')
    ).toBeNull();
    expect(
      document.querySelector(
        '[data-testid="trusted-publisher-revoke-sha256:ab12cd34ef56ab12cd34ef569f0e9f0e"]'
      )
    ).not.toBeNull();
  });

  it("revokes a user-pinned key on click", async () => {
    listMock.mockResolvedValue([publisher()]);
    render();
    await flush();

    await act(async () => {
      document
        .querySelector(
          '[data-testid="trusted-publisher-revoke-sha256:ab12cd34ef56ab12cd34ef569f0e9f0e"]'
        )!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(revokeMock).toHaveBeenCalledWith("sha256:ab12cd34ef56ab12cd34ef569f0e9f0e");
  });
});
