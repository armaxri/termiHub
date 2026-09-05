/**
 * Preview / confirm dialog for "Chain a hop to this computer" (#2597). It must
 * spell out all three companion endpoints, the derived SSH-via, and the explicit
 * "second linked tunnel" note before anything is created — the concept's core
 * "never silent" requirement — and block Create & link when no SSH connection can
 * reach the agent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TunnelChainPreviewDialog } from "./TunnelChainPreviewDialog";

let container: HTMLDivElement;
let root: Root;

const BASE = {
  open: true,
  onOpenChange: () => {},
  port: 5432 as number | "",
  agentName: "build-box",
  companionListen: "127.0.0.1:5432",
  companionForwards: "127.0.0.1:5432",
  sshOptions: [{ value: "conn-agent", label: "build-box ssh" }],
  sshConnectionId: "conn-agent",
  onSshConnectionChange: () => {},
  startNow: true,
  onStartNowChange: () => {},
  onConfirm: () => {},
};

function render(props: Partial<React.ComponentProps<typeof TunnelChainPreviewDialog>> = {}): void {
  act(() => {
    root.render(<TunnelChainPreviewDialog {...BASE} {...props} />);
  });
}

/** Radix Dialog portals to document.body, so query the whole document. */
function q(sel: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(sel);
}

describe("TunnelChainPreviewDialog (#2597)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("spells out the three companion endpoints and the linked-tunnel note", () => {
    render();
    const endpoints = q('[data-testid="tunnel-chain-endpoints"]');
    expect(endpoints?.textContent).toContain("Companion listens");
    expect(endpoints?.textContent).toContain("127.0.0.1:5432");
    expect(endpoints?.textContent).toContain("Via the agent");
    expect(endpoints?.textContent).toContain("Forwards to the parent");
    expect(q('[data-testid="tunnel-chain-note"]')?.textContent).toContain("second linked tunnel");
  });

  it("enables Create & link when an SSH-via is selected", () => {
    render();
    const confirm = q('[data-testid="tunnel-chain-confirm"]') as HTMLButtonElement | null;
    expect(confirm?.disabled).toBe(false);
  });

  it("disables Create & link when no saved SSH connection reaches the agent", () => {
    render({ sshOptions: [], sshConnectionId: "" });
    const confirm = q('[data-testid="tunnel-chain-confirm"]') as HTMLButtonElement | null;
    expect(confirm?.disabled).toBe(true);
  });

  it("fires onConfirm when Create & link is clicked", () => {
    const onConfirm = vi.fn();
    render({ onConfirm });
    act(() => {
      (q('[data-testid="tunnel-chain-confirm"]') as HTMLButtonElement).click();
    });
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
