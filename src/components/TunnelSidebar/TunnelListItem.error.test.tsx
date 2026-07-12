/**
 * Tests for the errored resting state of a tunnel row (#1240, Stage S1 / GAP 3).
 *
 * When `get_statuses()` returns a persisted `Error`, the sidebar row must:
 *   - replace the Play/Start button with a **Retry** control that fires
 *     `onStart` (Error → Connecting, clears the stored error via `start_tunnel`),
 *   - offer a **View last error** control that surfaces the persisted message,
 *   - render the persisted error text inline, and
 *   - carry the red `sidebar-list-item__status--error` resting dot (the shared
 *     shell maps the tunnel's error status onto the `error` tone, issue #1383).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TunnelListItem } from "./TunnelListItem";
import { withTooltip } from "@/test/tooltip";
import type { TunnelConfig, TunnelState } from "@/types/tunnel";
import type { SavedConnection } from "@/types/connection";

const TUNNEL: TunnelConfig = {
  id: "tun-1",
  name: "My Tunnel",
  sshConnectionId: "ssh-1",
  autoStart: false,
  reconnectOnDisconnect: false,
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

const ERROR_STATE: TunnelState = {
  tunnelId: "tun-1",
  status: "error",
  error: "SSH session closed by peer (bastion.corp)",
  stats: { bytesSent: 0, bytesReceived: 0, activeConnections: 0, totalConnections: 0 },
};

const noop = () => {};

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function renderItem(
  state: TunnelState | undefined,
  handlers: Partial<{
    onStart: (id: string) => void;
    onStop: (id: string) => void;
    onReconnect: (id: string) => void;
  }> = {}
): void {
  act(() => {
    root.render(
      withTooltip(
        <TunnelListItem
          tunnel={TUNNEL}
          state={state}
          connections={[] as SavedConnection[]}
          onStart={handlers.onStart ?? noop}
          onStop={handlers.onStop ?? noop}
          onReconnect={handlers.onReconnect ?? noop}
          onEdit={noop}
          onDuplicate={noop}
          onDelete={noop}
        />
      )
    );
  });
}

describe("TunnelListItem — errored resting state (#1240)", () => {
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

  it("renders a red status dot and the persisted error inline", async () => {
    renderItem(ERROR_STATE);
    await flush();

    const dot = container.querySelector('[data-testid="tunnel-status-tun-1"]');
    expect(dot?.className).toContain("sidebar-list-item__status--error");
    expect(container.textContent).toContain("SSH session closed by peer (bastion.corp)");
  });

  it("replaces Start with Retry + View last error for an errored tunnel", async () => {
    renderItem(ERROR_STATE);
    await flush();

    // Play/Start must be gone; Retry + View-last-error take its place.
    expect(container.querySelector('[data-testid="tunnel-start-tun-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="tunnel-stop-tun-1"]')).toBeNull();

    const retry = container.querySelector<HTMLButtonElement>('[data-testid="tunnel-retry-tun-1"]');
    const viewErr = container.querySelector<HTMLButtonElement>(
      '[data-testid="tunnel-view-error-tun-1"]'
    );
    expect(retry).not.toBeNull();
    expect(retry?.getAttribute("aria-label")).toBeTruthy();
    expect(viewErr).not.toBeNull();
    expect(viewErr?.getAttribute("aria-label")).toBeTruthy();
  });

  it("fires onStart when Retry is clicked (Error → Connecting via start_tunnel)", async () => {
    const onStart = vi.fn();
    renderItem(ERROR_STATE, { onStart });
    await flush();

    const retry = container.querySelector<HTMLButtonElement>('[data-testid="tunnel-retry-tun-1"]')!;
    act(() => {
      retry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onStart).toHaveBeenCalledWith("tun-1");
  });

  it("still shows Start (not Retry) for a disconnected tunnel", async () => {
    renderItem(undefined);
    await flush();

    expect(container.querySelector('[data-testid="tunnel-start-tun-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="tunnel-retry-tun-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="tunnel-view-error-tun-1"]')).toBeNull();
  });
});
