import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: {
      error: vi.fn(),
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

function renderItem(overrides: Partial<React.ComponentProps<typeof EmbeddedServerItem>> = {}) {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <EmbeddedServerItem {...baseProps(overrides)} />
      </TooltipProvider>
    );
  });
}

// The icon-only action buttons whose bare title= should now be a Tooltip +
// aria-label. testid → expected accessible name / render state.
const CONVERTED_ACTIONS: Array<{ testid: string; label: string; running: boolean }> = [
  { testid: "server-start-srv-1", label: "Start", running: false },
  { testid: "server-stop-srv-1", label: "Stop", running: true },
  { testid: "server-edit-srv-1", label: "Edit", running: false },
  { testid: "server-duplicate-srv-1", label: "Duplicate", running: false },
  { testid: "server-delete-srv-1", label: "Delete", running: false },
];

describe("EmbeddedServerItem tooltip adoption", () => {
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

  for (const { testid, label, running } of CONVERTED_ACTIONS) {
    it(`gives the ${label} button an aria-label and no bare title`, () => {
      renderItem({ state: running ? runningState : undefined });
      const btn = container.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`);
      expect(btn, `${testid} should render`).toBeTruthy();
      expect(btn?.getAttribute("aria-label")).toBe(label);
      // The bare title= has been replaced by the Tooltip primitive.
      expect(btn?.hasAttribute("title")).toBe(false);
    });
  }

  it("wires aria-describedby on focus of an action button", () => {
    renderItem();
    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="server-start-srv-1"]'
    ) as HTMLButtonElement;
    act(() => {
      btn.focus();
      btn.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    });
    // Radix associates the visible tooltip with its trigger for screen readers.
    expect(btn.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("preserves the data-testid on every converted control", () => {
    renderItem({ state: runningState });
    for (const { testid } of CONVERTED_ACTIONS.filter((a) => a.running)) {
      expect(container.querySelector(`[data-testid="${testid}"]`)).toBeTruthy();
    }
  });
});
