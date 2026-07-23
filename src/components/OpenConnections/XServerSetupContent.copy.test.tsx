/**
 * Clipboard-feedback test for the X server "setup failed" install command (#1819).
 *
 * When X-server provisioning fails with a missing dependency, the dialog shows
 * the install command the user is expected to run. It used to be display-only;
 * this pins that a dedicated copy button writes the command to the clipboard and
 * confirms with a success toast, and that the command lives in a copyable
 * (selectable) element.
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

import { XServerSetupContent } from "./XServerSetupContent";
import type { XServerError } from "@/types/xserver";

let container: HTMLDivElement;
let root: Root;

const command = "brew install --cask xquartz";

function renderError(error: XServerError) {
  act(() => {
    root.render(
      React.createElement(XServerSetupContent, {
        open: true,
        onOpenChange: () => {},
        testIdPrefix: "x-server-setup",
        phase: "error",
        progress: null,
        error,
        consent: React.createElement("div", null, "consent copy"),
        onEnable: () => {},
        onNotNow: () => {},
        onRetry: () => {},
        onInstallDependency: () => Promise.resolve(),
        onGuideTerminalInstall: () => Promise.resolve(),
        onClose: () => {},
      })
    );
  });
}

function query(testId: string): Element | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("XServerSetupContent — copy install command (#1819)", () => {
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

  it("copies the install command and confirms with a success toast", async () => {
    renderError({
      kind: "dependencyMissing",
      message: "XQuartz is not installed",
      dependency: "XQuartz",
      installCommand: command,
    });

    const copyButton = query("x-server-setup-copy-command") as HTMLButtonElement | null;
    expect(copyButton).not.toBeNull();

    act(() => copyButton!.click());
    await flush();

    expect(writeText).toHaveBeenCalledWith(command);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("renders the command in a selectable element and offers no copy button without a command", () => {
    renderError({
      kind: "dependencyMissing",
      message: "XQuartz is not installed",
      dependency: "XQuartz",
      installCommand: command,
    });
    const commandEl = document.querySelector<HTMLElement>(".x-server-setup__command");
    expect(commandEl).not.toBeNull();
    expect(commandEl?.textContent).toBe(command);

    // A dependency error without a command shows neither the block nor the button.
    renderError({
      kind: "dependencyMissing",
      message: "Something failed",
      dependency: "XQuartz",
    });
    expect(query("x-server-setup-copy-command")).toBeNull();
  });
});
