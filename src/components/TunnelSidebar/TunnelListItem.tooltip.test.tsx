/**
 * Verifies the tunnel list-item row adopts the shared `Tooltip` primitive for
 * its icon-only Start/Stop/Edit/Duplicate/Delete controls (issue #1114,
 * follow-up to #1102).
 *
 * A tooltip is not an accessible name, so each converted icon button must keep
 * an `aria-label`, must no longer carry a bare `title`, and the Radix tooltip
 * trigger must wire `aria-describedby` when focused. These assertions pin all
 * three. The stable `data-testid`s must survive the migration.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TunnelListItem } from "./TunnelListItem";
import { TooltipProvider } from "@/components/ui";
import type { TunnelConfig, TunnelState } from "@/types/tunnel";
import type { SavedConnection } from "@/types/connection";

// jsdom lacks the observer/pointer-capture APIs Radix Tooltip touches when it
// mounts its trigger; shim them so the tooltip-wrapped buttons render.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
    ResizeObserverStub;
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

const TUNNEL: TunnelConfig = {
  id: "tun-1",
  name: "My Tunnel",
  sshConnectionId: "ssh-1",
  autoStart: false,
  tunnelType: {
    type: "local",
    config: {
      localHost: "127.0.0.1",
      localPort: 8080,
      remoteHost: "example.com",
      remotePort: 80,
    },
  },
};

const noop = () => {};

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Wrap so the shared Tooltip primitive finds its provider (zero delay). */
function withTooltip(ui: React.ReactElement): React.ReactElement {
  return <TooltipProvider delayDuration={0}>{ui}</TooltipProvider>;
}

function renderItem(state: TunnelState | undefined): void {
  act(() => {
    root.render(
      withTooltip(
        <TunnelListItem
          tunnel={TUNNEL}
          state={state}
          connections={[] as SavedConnection[]}
          onStart={noop}
          onStop={noop}
          onEdit={noop}
          onDuplicate={noop}
          onDelete={noop}
        />
      )
    );
  });
}

describe("TunnelListItem — tooltip adoption (#1114)", () => {
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

  it("exposes accessible names via aria-label without a bare title on the action icons", async () => {
    renderItem(undefined);
    await flush();

    // Disconnected → Start is shown (not Stop).
    const start = container.querySelector<HTMLButtonElement>('[data-testid="tunnel-start-tun-1"]');
    const edit = container.querySelector<HTMLButtonElement>('[data-testid="tunnel-edit-tun-1"]');
    const dup = container.querySelector<HTMLButtonElement>(
      '[data-testid="tunnel-duplicate-tun-1"]'
    );
    const del = container.querySelector<HTMLButtonElement>('[data-testid="tunnel-delete-tun-1"]');

    for (const btn of [start, edit, dup, del]) {
      expect(btn).not.toBeNull();
      expect(btn?.getAttribute("aria-label")).toBeTruthy();
      // The tooltip must not leak into the accessible name as a bare title.
      expect(btn?.getAttribute("title")).toBeNull();
    }
  });

  it("shows the Stop icon with an accessible name when the tunnel is active", async () => {
    renderItem({
      tunnelId: "tun-1",
      status: "connected",
    } as TunnelState);
    await flush();

    const stop = container.querySelector<HTMLButtonElement>('[data-testid="tunnel-stop-tun-1"]');
    expect(stop).not.toBeNull();
    expect(stop?.getAttribute("aria-label")).toBeTruthy();
    expect(stop?.getAttribute("title")).toBeNull();
  });

  it("wires the Edit button to its tooltip via aria-describedby on focus", async () => {
    renderItem(undefined);
    await flush();

    const edit = container.querySelector<HTMLButtonElement>('[data-testid="tunnel-edit-tun-1"]')!;
    act(() => {
      edit.focus();
      edit.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    });

    // Radix associates the open tooltip with its trigger for screen readers.
    expect(edit.getAttribute("aria-describedby")).toBeTruthy();
  });
});
