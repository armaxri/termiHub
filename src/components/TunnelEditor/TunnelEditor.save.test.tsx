/**
 * Save-feedback tests for the TunnelEditor (UX-022): a plain Save now confirms
 * with a success toast (matching Duplicate/Delete/Start) instead of only closing
 * the tab, and Save is disabled while the name is blank rather than silently
 * persisting the tunnel as "Untitled Tunnel". Save & Start defers its feedback to
 * `startTunnel`, so it must NOT also raise the "Saved tunnel" toast.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { seedLayoutState } from "@/test/layoutState";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { TunnelEditor } from "./TunnelEditor";
import { TooltipProvider } from "@/components/ui";
import type { SavedConnection } from "@/types/connection";

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(() => "toast-id"),
}));

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return { ...actual, toast: toastMock };
});

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const TAB_ID = "tab-tun-save";
const PANEL_ID = "panel-tun-save";

const SSH_CONN: SavedConnection = {
  id: "ssh-1",
  name: "My SSH",
  config: { type: "ssh", config: { host: "h", username: "u" } },
  folderId: null,
};

const ROOT_PANEL = {
  type: "leaf",
  id: PANEL_ID,
  tabs: [{ id: TAB_ID }],
  activeTabId: TAB_ID,
};

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root.render(
      <TooltipProvider>
        <TunnelEditor tabId={TAB_ID} meta={{ tunnelId: null }} isVisible={true} />
      </TooltipProvider>
    );
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function nameInput(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('[data-testid="tunnel-editor-name"]')!;
}
function saveButton(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[data-testid="tunnel-editor-save"]')!;
}
function saveStartButton(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[data-testid="tunnel-editor-save-start"]')!;
}

/** Set a value on a React-controlled <input> and fire the native input event. */
function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

setupConnectionsRegion();

describe("TunnelEditor — save feedback (UX-022)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    seedConnectionsRegion({ connections: [SSH_CONN] });
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      tunnels: [],
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

  it("disables both save actions while the name is blank", () => {
    render();
    expect(saveButton().disabled).toBe(true);
    expect(saveStartButton().disabled).toBe(true);
  });

  it("enables Save once a non-blank name is entered", () => {
    render();
    setValue(nameInput(), "Dev DB");
    expect(saveButton().disabled).toBe(false);
    expect(saveStartButton().disabled).toBe(false);
  });

  it("keeps Save disabled for a whitespace-only name", () => {
    render();
    setValue(nameInput(), "   ");
    expect(saveButton().disabled).toBe(true);
  });

  it("confirms a plain Save with a success toast and does not start", async () => {
    render();
    setValue(nameInput(), "Dev DB");
    click(saveButton());
    await flush();
    expect(useAppStore.getState().saveTunnel).toHaveBeenCalledTimes(1);
    expect(toastMock.success).toHaveBeenCalledWith('Saved tunnel "Dev DB"');
    expect(useAppStore.getState().startTunnel).not.toHaveBeenCalled();
  });

  it("does not raise the 'Saved tunnel' toast on Save & Start (start owns feedback)", async () => {
    render();
    setValue(nameInput(), "Dev DB");
    click(saveStartButton());
    await flush();
    expect(useAppStore.getState().saveTunnel).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().startTunnel).toHaveBeenCalledWith(expect.any(String));
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});
