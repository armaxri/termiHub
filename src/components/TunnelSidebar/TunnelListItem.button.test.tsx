/**
 * Verifies the tunnel list-item action row is composed from the shared `Button`
 * primitive (issue #1259, follow-up to #1240) rather than bespoke
 * `.tunnel-item__action` buttons.
 *
 * Every action button must carry the `ui-btn` primitive classes (ghost variant),
 * and the async actions (Start / Stop / Retry) must drive the Button's async
 * lifecycle — a pending spinner state while the underlying promise is in flight,
 * returning to idle once it resolves. The stable `data-testid`s survive.
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

const noop = () => {};

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

interface Handlers {
  onStart?: (id: string) => void | Promise<void>;
  onStop?: (id: string) => void | Promise<void>;
}

function renderItem(state: TunnelState | undefined, handlers: Handlers = {}): void {
  act(() => {
    root.render(
      withTooltip(
        <TunnelListItem
          tunnel={TUNNEL}
          state={state}
          connections={[] as SavedConnection[]}
          onStart={handlers.onStart ?? noop}
          onStop={handlers.onStop ?? noop}
          onEdit={noop}
          onDuplicate={noop}
          onDelete={noop}
        />
      )
    );
  });
}

function click(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("TunnelListItem — shared Button primitive (#1259)", () => {
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

  it("renders every action as a shared ghost Button primitive", async () => {
    renderItem(undefined);
    await flush();

    const ids = [
      "tunnel-start-tun-1",
      "tunnel-edit-tun-1",
      "tunnel-duplicate-tun-1",
      "tunnel-delete-tun-1",
    ];
    for (const id of ids) {
      const btn = container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
      expect(btn, id).not.toBeNull();
      expect(btn?.classList.contains("ui-btn"), id).toBe(true);
      expect(btn?.classList.contains("ui-btn--ghost"), id).toBe(true);
    }
  });

  it("drives the Button async lifecycle on Start: pending while in flight, then idle", async () => {
    let resolveStart!: () => void;
    const onStart = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        })
    );
    renderItem(undefined, { onStart });
    await flush();

    const start = container.querySelector<HTMLButtonElement>('[data-testid="tunnel-start-tun-1"]')!;
    click(start);
    await flush();

    // In flight → pending state (disabled + spinner class).
    expect(onStart).toHaveBeenCalledWith("tun-1");
    expect(start.classList.contains("ui-btn--pending")).toBe(true);
    expect(start.disabled).toBe(true);

    await act(async () => {
      resolveStart();
      await Promise.resolve();
    });

    // Resolved → no longer pending.
    expect(start.classList.contains("ui-btn--pending")).toBe(false);
  });

  it("drives the Button async lifecycle on Stop when the tunnel is active", async () => {
    let resolveStop!: () => void;
    const onStop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStop = resolve;
        })
    );
    renderItem({ tunnelId: "tun-1", status: "connected" } as TunnelState, { onStop });
    await flush();

    const stop = container.querySelector<HTMLButtonElement>('[data-testid="tunnel-stop-tun-1"]')!;
    click(stop);
    await flush();

    expect(onStop).toHaveBeenCalledWith("tun-1");
    expect(stop.classList.contains("ui-btn--pending")).toBe(true);

    await act(async () => {
      resolveStop();
      await Promise.resolve();
    });

    expect(stop.classList.contains("ui-btn--pending")).toBe(false);
  });

  it("drives the Button async lifecycle on Retry when the tunnel is in error", async () => {
    let resolveRetry!: () => void;
    const onStart = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRetry = resolve;
        })
    );
    renderItem({ tunnelId: "tun-1", status: "error", error: "boom" } as TunnelState, { onStart });
    await flush();

    const retry = container.querySelector<HTMLButtonElement>('[data-testid="tunnel-retry-tun-1"]')!;
    expect(retry.classList.contains("ui-btn")).toBe(true);
    click(retry);
    await flush();

    expect(onStart).toHaveBeenCalledWith("tun-1");
    expect(retry.classList.contains("ui-btn--pending")).toBe(true);

    await act(async () => {
      resolveRetry();
      await Promise.resolve();
    });

    expect(retry.classList.contains("ui-btn--pending")).toBe(false);
  });
});
