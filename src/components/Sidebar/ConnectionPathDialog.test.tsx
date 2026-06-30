/**
 * Tests for the live per-hop status in the "Show Connection Path" popover (#962).
 *
 * Opening the dialog starts a probe (probeConnectionPath) and subscribes to
 * `jump-host-hop-status` / `jump-host-probe-complete` events; each node renders a
 * status (pending -> connecting -> connected/failed). Closing cancels the probe.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { SavedConnection } from "@/types/connection";
import type { HopStatusPayload, ProbeCompletePayload } from "@/services/events";

// Capture the event callbacks the dialog registers so tests can drive them.
let hopStatusCb: ((p: HopStatusPayload) => void) | null = null;
let probeCompleteCb: ((p: ProbeCompletePayload) => void) | null = null;
const probeConnectionPath = vi.fn((_id: string, _settings: Record<string, unknown>) =>
  Promise.resolve()
);
const cancelConnectionPathProbe = vi.fn((_id: string) => Promise.resolve(true));

vi.mock("@/services/api", () => ({
  probeConnectionPath: (id: string, settings: Record<string, unknown>) =>
    probeConnectionPath(id, settings),
  cancelConnectionPathProbe: (id: string) => cancelConnectionPathProbe(id),
}));

vi.mock("@/services/events", () => ({
  onJumpHostHopStatus: (cb: (p: HopStatusPayload) => void) => {
    hopStatusCb = cb;
    return Promise.resolve(() => {
      hopStatusCb = null;
    });
  },
  onJumpHostProbeComplete: (cb: (p: ProbeCompletePayload) => void) => {
    probeCompleteCb = cb;
    return Promise.resolve(() => {
      probeCompleteCb = null;
    });
  },
}));

import { ConnectionPathDialog } from "./ConnectionPathDialog";

/** SSH connection with a two-hop chain (edge -> bastion) reaching app-server. */
function twoHopConnection(): SavedConnection {
  return {
    id: "c1",
    name: "app-server",
    folderId: null,
    config: {
      type: "ssh",
      config: {
        host: "app-server",
        port: 22,
        username: "deploy",
        proxyJump: [
          { host: "edge", port: 22, username: "u", authMethod: "agent" },
          { host: "bastion", port: 22, username: "u", authMethod: "agent" },
        ],
      },
    },
  } as SavedConnection;
}

/** All path nodes excluding the local "You" origin, in render order. */
function pathNodes(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".connection-path-dialog__node")).slice(
    1
  );
}

describe("ConnectionPathDialog — live per-hop status", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    hopStatusCb = null;
    probeCompleteCb = null;
    probeConnectionPath.mockClear();
    cancelConnectionPathProbe.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function open() {
    act(() => {
      root.render(
        React.createElement(ConnectionPathDialog, {
          open: true,
          connection: twoHopConnection(),
          onClose: () => {},
        })
      );
    });
  }

  it("starts a probe when opened and renders all path nodes as pending", async () => {
    open();
    // The probe is kicked off (microtask).
    await act(async () => {});
    expect(probeConnectionPath).toHaveBeenCalledTimes(1);

    const nodes = pathNodes();
    // edge, bastion, app-server.
    expect(nodes).toHaveLength(3);
    expect(nodes.every((n) => n.getAttribute("data-status") === "pending")).toBe(true);
  });

  it("reflects connecting -> connected per node from hop-status events", async () => {
    open();
    await act(async () => {});
    expect(hopStatusCb).not.toBeNull();

    act(() => {
      hopStatusCb?.({
        probeId: probeConnectionPath.mock.calls[0][0],
        index: 0,
        total: 3,
        host: "edge",
        port: 22,
        status: "connecting",
        message: "",
      });
    });
    expect(pathNodes()[0].getAttribute("data-status")).toBe("connecting");

    act(() => {
      hopStatusCb?.({
        probeId: probeConnectionPath.mock.calls[0][0],
        index: 0,
        total: 3,
        host: "edge",
        port: 22,
        status: "connected",
        message: "",
      });
    });
    expect(pathNodes()[0].getAttribute("data-status")).toBe("connected");
  });

  it("marks the broken hop failed and leaves later nodes pending", async () => {
    open();
    await act(async () => {});

    const probeId = probeConnectionPath.mock.calls[0][0];
    act(() => {
      hopStatusCb?.({
        probeId,
        index: 0,
        total: 3,
        host: "edge",
        port: 22,
        status: "connected",
        message: "",
      });
      hopStatusCb?.({
        probeId,
        index: 1,
        total: 3,
        host: "bastion",
        port: 22,
        status: "failed",
        message: "Connection refused",
      });
    });

    const nodes = pathNodes();
    expect(nodes[0].getAttribute("data-status")).toBe("connected");
    expect(nodes[1].getAttribute("data-status")).toBe("failed");
    expect(nodes[2].getAttribute("data-status")).toBe("pending");
    // The failure reason is surfaced.
    expect(nodes[1].textContent).toContain("Connection refused");
  });

  it("cancels the probe when closed", async () => {
    open();
    await act(async () => {});
    const probeId = probeConnectionPath.mock.calls[0][0];

    act(() => {
      root.render(
        React.createElement(ConnectionPathDialog, {
          open: false,
          connection: twoHopConnection(),
          onClose: () => {},
        })
      );
    });
    await act(async () => {});

    expect(cancelConnectionPathProbe).toHaveBeenCalledWith(probeId);
  });
});
