import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";

const toastError = vi.fn();

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: {
      error: (...args: unknown[]) => toastError(...args),
      success: vi.fn(),
      info: vi.fn(),
      loading: vi.fn(),
      dismiss: vi.fn(),
    },
  };
});

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));

import { EmbeddedServerItem } from "./EmbeddedServerItem";
import { TooltipProvider } from "@/components/ui";
import { EmbeddedServerConfig, ServerState } from "@/types/embeddedServer";

let container: HTMLDivElement;
let root: Root;

const config: EmbeddedServerConfig = {
  id: "srv-1",
  name: "My HTTP",
  serverType: "http",
  rootDirectory: "/tmp",
  bindHost: "127.0.0.1",
  port: 8080,
  autoStart: false,
  readOnly: false,
  directoryListing: true,
};

const runningState: ServerState = {
  serverId: "srv-1",
  status: "running",
  stats: { activeConnections: 0, totalConnections: 0, bytesSent: 0, bytesReceived: 0 },
};

const noop = () => {};

function baseProps(overrides: Partial<React.ComponentProps<typeof EmbeddedServerItem>> = {}) {
  return {
    config,
    state: undefined as ServerState | undefined,
    onStart: vi.fn(() => Promise.resolve()),
    onStop: vi.fn(() => Promise.resolve()),
    onEdit: noop,
    onDuplicate: noop,
    onDelete: noop,
    ...overrides,
  };
}

function render(ui: React.ReactElement) {
  act(() => {
    root.render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
  });
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** Flush pending microtasks (rejected/resolved promise callbacks). */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("EmbeddedServerItem", () => {
  beforeEach(() => {
    toastError.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("surfaces a toast.error when starting fails", async () => {
    const onStart = vi.fn(() => Promise.reject(new Error("Port 8080 already in use")));
    render(<EmbeddedServerItem {...baseProps({ onStart })} />);

    const startBtn = container.querySelector('[data-testid="server-start-srv-1"]')!;
    click(startBtn);
    await flush();

    expect(onStart).toHaveBeenCalledWith("srv-1");
    expect(toastError).toHaveBeenCalledTimes(1);
    const [title, opts] = toastError.mock.calls[0] as [
      string,
      { description?: string } | undefined,
    ];
    expect(title).toContain("My HTTP");
    expect(opts?.description).toContain("Port 8080 already in use");
  });

  it("disables the start button while the action is in flight", async () => {
    let resolveStart!: () => void;
    const onStart = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        })
    );
    render(<EmbeddedServerItem {...baseProps({ onStart })} />);

    const startBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="server-start-srv-1"]'
    )!;
    click(startBtn);

    expect(startBtn.disabled).toBe(true);

    await act(async () => {
      resolveStart();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="server-start-srv-1"]')!.disabled
    ).toBe(false);
  });

  it("drives the shared Button async lifecycle (aria-busy) while starting", async () => {
    // Regression for #1344: the pending state must come from the shared Button's
    // async lifecycle (onClick returns the promise), not a hand-rolled `busy`
    // flag. A hand-rolled flag never sets aria-busy on the pressed control.
    let resolveStart!: () => void;
    const onStart = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        })
    );
    render(<EmbeddedServerItem {...baseProps({ onStart })} />);

    const startBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="server-start-srv-1"]'
    )!;
    click(startBtn);

    expect(startBtn.getAttribute("aria-busy")).toBe("true");
    expect(startBtn.disabled).toBe(true);

    await act(async () => {
      resolveStart();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Returns to idle after the promise settles.
    expect(
      container
        .querySelector<HTMLButtonElement>('[data-testid="server-start-srv-1"]')!
        .getAttribute("aria-busy")
    ).toBeNull();
  });

  it("surfaces a toast.error when stopping fails", async () => {
    const onStop = vi.fn(() => Promise.reject("stop boom"));
    render(<EmbeddedServerItem {...baseProps({ onStop, state: runningState })} />);

    const stopBtn = container.querySelector('[data-testid="server-stop-srv-1"]')!;
    click(stopBtn);
    await flush();

    expect(onStop).toHaveBeenCalledWith("srv-1");
    expect(toastError).toHaveBeenCalledTimes(1);
    const [title] = toastError.mock.calls[0] as [string, unknown];
    expect(title).toContain("My HTTP");
  });
});
