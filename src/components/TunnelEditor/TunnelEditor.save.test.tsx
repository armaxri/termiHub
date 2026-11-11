/**
 * Save-feedback tests for the TunnelEditor (UX-022): a plain Save now confirms
 * with a success toast (matching Duplicate/Delete/Start) instead of only closing
 * the tab, and Save is blocked while the name is blank rather than silently
 * persisting the tunnel as "Untitled Tunnel". Save & Start defers its feedback to
 * `startTunnel`, so it must NOT also raise the "Saved tunnel" toast.
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

async function render() {
  await act(async () => {
    root.render(
      <TooltipProvider>
        <TunnelEditor tabId={TAB_ID} meta={{ tunnelId: null }} isVisible={true} />
      </TooltipProvider>
    );
  });
  await flushAsync();
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

  it("marks both save actions aria-disabled while the name is blank", async () => {
    await render();
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
    expect(saveStartButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("enables Save once a non-blank name is entered", async () => {
    await render();
    setValue(nameInput(), "Dev DB");
    expect(saveButton().getAttribute("aria-disabled")).toBe("false");
    expect(saveStartButton().getAttribute("aria-disabled")).toBe("false");
  });

  it("keeps Save aria-disabled for a whitespace-only name", async () => {
    await render();
    setValue(nameInput(), "   ");
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("confirms a plain Save with a success toast and does not start", async () => {
    await render();
    setValue(nameInput(), "Dev DB");
    click(saveButton());
    await flush();
    expect(useAppStore.getState().saveTunnel).toHaveBeenCalledTimes(1);
    expect(toastMock.success).toHaveBeenCalledWith('Saved tunnel "Dev DB"');
    expect(useAppStore.getState().startTunnel).not.toHaveBeenCalled();
  });

  it("does not raise the 'Saved tunnel' toast on Save & Start (start owns feedback)", async () => {
    await render();
    setValue(nameInput(), "Dev DB");
    click(saveStartButton());
    await flush();
    expect(useAppStore.getState().saveTunnel).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().startTunnel).toHaveBeenCalledWith(expect.any(String));
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("shows 'Name is required.' on the Name field while it is blank (UISF2-003)", async () => {
    await render();
    const nameError = () => document.getElementById(`tunnel-name-${TAB_ID}-error`);
    expect(nameError()?.textContent).toBe("Name is required.");
    expect(nameInput().getAttribute("aria-invalid")).toBe("true");
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");

    setValue(nameInput(), "Dev DB");
    expect(nameError()).toBeNull();
    expect(saveButton().getAttribute("aria-disabled")).toBe("false");
  });

  it("shows the SSH-connection error when there is no SSH connection to pick", async () => {
    seedConnectionsRegion({ connections: [] });
    await render();
    setValue(nameInput(), "Dev DB");
    const sshField = container.querySelector('[data-testid="tunnel-editor-ssh-connection-field"]');
    expect(sshField?.textContent).toContain("An SSH connection is required.");
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
  });
  // #5284: Save is aria-disabled, not disabled, so it stays keyboard-reachable;
  // activating it while invalid saves nothing and focuses the first invalid field.
  it("keeps Save focusable while invalid and focuses the blank name on activation", async () => {
    await render();
    const save = saveButton();
    expect(save.disabled).toBe(false);
    act(() => save.focus());
    expect(document.activeElement).toBe(save);

    click(save);
    await flush();
    expect(useAppStore.getState().saveTunnel).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(nameInput());
  });

  it("does not save on Save & Start while invalid and focuses the first invalid field", async () => {
    await render();
    act(() => saveStartButton().focus());
    click(saveStartButton());
    await flush();
    expect(useAppStore.getState().saveTunnel).not.toHaveBeenCalled();
    expect(useAppStore.getState().startTunnel).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(nameInput());
  });

  it("focuses the SSH connection picker when it is the first invalid field", async () => {
    seedConnectionsRegion({ connections: [] });
    await render();
    setValue(nameInput(), "Dev DB");
    click(saveButton());
    await flush();
    expect(useAppStore.getState().saveTunnel).not.toHaveBeenCalled();
    const ssh = container.querySelector('[data-testid="tunnel-editor-ssh-connection"]');
    expect(document.activeElement).toBe(ssh);
  });

  it("focuses a blank port, with its inline reason, when the name is valid", async () => {
    await render();
    setValue(nameInput(), "Dev DB");
    const remotePort = container.querySelector<HTMLInputElement>(
      '[data-testid="tunnel-editor-remote-port"]'
    )!;
    setValue(remotePort, "");
    expect(remotePort.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(`${remotePort.id}-error`)?.textContent).toBeTruthy();

    // Enter from another single-line field goes through the same guard.
    const localHost = container.querySelector<HTMLInputElement>(`#tunnel-local-host-${TAB_ID}`)!;
    act(() => localHost.focus());
    act(() => {
      localHost.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
      );
    });
    await flush();
    expect(useAppStore.getState().saveTunnel).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(remotePort);
  });
});
