/**
 * Clipboard-feedback test for embedded-server "Copy URL" (#1342).
 *
 * Copying the server URL used to write to the clipboard silently. This pins
 * that a successful copy confirms with a success toast.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";

const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: {
      success: (...args: unknown[]) => toastSuccess(...args),
      error: (...args: unknown[]) => toastError(...args),
      info: vi.fn(),
      loading: vi.fn(),
      dismiss: vi.fn(),
    },
  };
});

const writeText = vi.fn((_text?: string) => Promise.resolve());
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (text: string) => writeText(text),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));

import { EmbeddedServerItem } from "./EmbeddedServerItem";
import { NO_CONTEXT } from "@/test/serviceContext";
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

const RUNNING: ServerState = {
  serverId: "srv-1",
  status: "running",
  stats: { activeConnections: 0, totalConnections: 0, bytesSent: 0, bytesReceived: 0 },
};

function baseProps() {
  return {
    config,
    state: undefined,
    onStart: vi.fn(() => Promise.resolve()),
    onStop: vi.fn(() => Promise.resolve()),
    onRestart: vi.fn(() => Promise.resolve()),
    context: NO_CONTEXT,
    onEdit: () => {},
    onDuplicate: () => {},
    onDelete: () => {},
  };
}

function render(ui: React.ReactElement) {
  act(() => {
    root.render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("EmbeddedServerItem — copy address feedback (#1342)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("confirms with a success toast after copying the address from the menu", async () => {
    render(<EmbeddedServerItem {...baseProps()} state={RUNNING} />);

    // Open the context menu and invoke Copy URL. The item is easiest to reach
    // by calling the context-menu item directly via its testid; open the menu
    // by dispatching a contextmenu event on the row.
    const row = container.querySelector('[data-testid="server-item-srv-1"]')!;
    act(() => {
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    await flush();

    const copyItem = document.querySelector<HTMLElement>('[data-testid="ctx-copy-url-srv-1"]');
    expect(copyItem).not.toBeNull();
    act(() => {
      copyItem!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(writeText).toHaveBeenCalledWith("http://localhost:8080");
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("the row's Copy copies the same, and its button is the feedback (#5859)", async () => {
    render(<EmbeddedServerItem {...baseProps()} state={RUNNING} />);
    const copy = container.querySelector<HTMLElement>('[data-testid="server-copy-address-srv-1"]');
    expect(copy?.getAttribute("aria-label")).toBe("Copy address");
    act(() => copy!.click());
    await flush();
    expect(writeText).toHaveBeenCalledWith("http://localhost:8080");
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("there is no address to copy while it does not run", async () => {
    render(<EmbeddedServerItem {...baseProps()} />);
    const row = container.querySelector('[data-testid="server-item-srv-1"]')!;
    act(() => {
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(document.querySelector('[data-testid="ctx-edit-srv-1"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="ctx-copy-url-srv-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="server-address-srv-1"]')).toBeNull();
  });
});
