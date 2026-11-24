/**
 * Which footer action is primary in the tunnel editor (#5810).
 *
 * Maintainer decision: a new tunnel is saved to be used, so "Save and start" is
 * the primary (filled) action; editing an existing tunnel keeps "Save" primary.
 * The primary sits on the right of the footer (copy style guide), and Enter from
 * a single-line field runs it — through the same invalid-form guard as a click.
 * Mirrors the connection editor's Save and connect (#5755).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { flushAsync } from "@/test/flushAsync";
import { useAppStore } from "@/store/appStore";
import { seedLayoutState } from "@/test/layoutState";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { TunnelEditor } from "./TunnelEditor";
import { TooltipProvider } from "@/components/ui";
import type { SavedConnection } from "@/types/connection";
import type { TunnelConfig } from "@/types/tunnel";

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  loading: vi.fn(() => "toast-id"),
  dismiss: vi.fn(),
}));

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return { ...actual, toast: toastMock };
});

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const TAB_ID = "tab-tun-primary";
const PANEL_ID = "panel-tun-primary";

const SSH_CONN: SavedConnection = {
  id: "ssh-1",
  name: "My SSH",
  config: { type: "ssh", config: { host: "h", username: "u" } },
  folderId: null,
};

const EXISTING: TunnelConfig = {
  id: "tun-existing",
  name: "Dev DB",
  sshConnectionId: SSH_CONN.id,
  tunnelType: {
    type: "local",
    config: { localHost: "127.0.0.1", localPort: 5432, remoteHost: "localhost", remotePort: 5432 },
  },
  autoStart: false,
  reconnectOnDisconnect: false,
};

const ROOT_PANEL = {
  type: "leaf",
  id: PANEL_ID,
  tabs: [{ id: TAB_ID }],
  activeTabId: TAB_ID,
};

let container: HTMLDivElement;
let root: Root;

async function render(tunnelId: string | null) {
  await act(async () => {
    root.render(
      <TooltipProvider>
        <TunnelEditor tabId={TAB_ID} meta={{ tunnelId }} isVisible={true} />
      </TooltipProvider>
    );
  });
  await flushAsync();
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

function q(testId: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
}

function isPrimary(btn: HTMLElement | null): boolean {
  return !!btn?.classList.contains("ui-btn--primary");
}

function footer(): Element {
  return q("tunnel-editor-cancel")!.parentElement!;
}

/** The primary buttons in the footer, in DOM order. */
function primaryButtons(): string[] {
  return Array.from(footer().querySelectorAll("button.ui-btn--primary")).map(
    (b) => b.getAttribute("data-testid") ?? ""
  );
}

/** The footer button that is rendered last (the right-most one). */
function lastFooterButton(): string | null {
  const buttons = footer().querySelectorAll(":scope > button");
  return buttons[buttons.length - 1]?.getAttribute("data-testid") ?? null;
}

function nameInput(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('[data-testid="tunnel-editor-name"]')!;
}

/** Set a value on a React-controlled <input> and fire the native input event. */
function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pressEnter(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    );
  });
  await flush();
  await flushAsync();
}

setupConnectionsRegion();

describe("TunnelEditor — primary footer action (#5810)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    seedConnectionsRegion({ connections: [SSH_CONN] });
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      tunnels: [EXISTING],
      saveTunnel: vi.fn(() => Promise.resolve()),
      startTunnel: vi.fn(() => Promise.resolve()),
      closeTab: vi.fn(),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seedLayoutState({ rootPanel: ROOT_PANEL as any });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  describe("which button is primary", () => {
    it("a new tunnel makes Save and start primary, on the right", async () => {
      await render(null);
      expect(isPrimary(q("tunnel-editor-save-start"))).toBe(true);
      expect(isPrimary(q("tunnel-editor-save"))).toBe(false);
      expect(primaryButtons()).toEqual(["tunnel-editor-save-start"]);
      expect(lastFooterButton()).toBe("tunnel-editor-save-start");
    });

    it("editing a tunnel keeps Save primary, on the right", async () => {
      await render(EXISTING.id);
      expect(isPrimary(q("tunnel-editor-save"))).toBe(true);
      expect(isPrimary(q("tunnel-editor-save-start"))).toBe(false);
      expect(primaryButtons()).toEqual(["tunnel-editor-save"]);
      expect(lastFooterButton()).toBe("tunnel-editor-save");
    });
  });

  describe("Enter runs the primary action", () => {
    it("on a new tunnel, Enter saves and starts it", async () => {
      await render(null);
      setValue(nameInput(), "Fresh tunnel");
      await flush();
      await pressEnter(nameInput());

      const { saveTunnel, startTunnel } = useAppStore.getState();
      expect(saveTunnel).toHaveBeenCalledTimes(1);
      expect(startTunnel).toHaveBeenCalledTimes(1);
      const saved = vi.mocked(saveTunnel).mock.calls[0][0];
      expect(startTunnel).toHaveBeenCalledWith(saved.id);
      // Save and start leaves the feedback to startTunnel: no "Saved" toast.
      expect(toastMock.success).not.toHaveBeenCalled();
    });

    it("on an existing tunnel, Enter saves without starting", async () => {
      await render(EXISTING.id);
      setValue(nameInput(), "Dev DB 2");
      await flush();
      await pressEnter(nameInput());

      const { saveTunnel, startTunnel } = useAppStore.getState();
      expect(saveTunnel).toHaveBeenCalledTimes(1);
      expect(startTunnel).not.toHaveBeenCalled();
      expect(toastMock.success).not.toHaveBeenCalled();
    });

    it("on a new tunnel with an invalid form, Enter neither saves nor starts", async () => {
      await render(null);
      // Blank name: the form is invalid, so the primary action is gated.
      await pressEnter(nameInput());

      const { saveTunnel, startTunnel } = useAppStore.getState();
      expect(saveTunnel).not.toHaveBeenCalled();
      expect(startTunnel).not.toHaveBeenCalled();
    });

    it("a failed save from Enter does not start the tunnel", async () => {
      useAppStore.setState({ saveTunnel: vi.fn(() => Promise.reject(new Error("disk full"))) });
      await render(null);
      setValue(nameInput(), "Fresh tunnel");
      await flush();
      await pressEnter(nameInput());

      expect(useAppStore.getState().saveTunnel).toHaveBeenCalledTimes(1);
      expect(useAppStore.getState().startTunnel).not.toHaveBeenCalled();
      // The tab stays open so the user can retry.
      expect(useAppStore.getState().closeTab).not.toHaveBeenCalled();
    });
  });
});
