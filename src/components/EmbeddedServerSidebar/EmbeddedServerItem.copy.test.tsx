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

const writeText = vi.fn(() => Promise.resolve());
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (...args: unknown[]) => writeText(...args),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));

import { EmbeddedServerItem } from "./EmbeddedServerItem";
import { TooltipProvider } from "@/components/ui";
import { EmbeddedServerConfig } from "@/types/embeddedServer";

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

function baseProps() {
  return {
    config,
    state: undefined,
    onStart: vi.fn(() => Promise.resolve()),
    onStop: vi.fn(() => Promise.resolve()),
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

describe("EmbeddedServerItem — copy URL feedback (#1342)", () => {
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

  it("confirms with a success toast after copying the URL", async () => {
    render(<EmbeddedServerItem {...baseProps()} />);

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

    expect(writeText).toHaveBeenCalledWith("http://127.0.0.1:8080");
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });
});
