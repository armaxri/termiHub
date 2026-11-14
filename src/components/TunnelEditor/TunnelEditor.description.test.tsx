/**
 * The tunnel editor's optional description (#5770): one line, at most 80
 * characters, normalised on save; blank saves none (absent = no description).
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

const TAB_ID = "tab-tun-desc";
const PANEL_ID = "panel-tun-desc";

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

describe("TunnelEditor — description (#5770)", () => {
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

  const descriptionInput = () =>
    container.querySelector<HTMLInputElement>('[data-testid="tunnel-editor-description"]')!;

  it("offers a one-line description of at most 80 characters", async () => {
    await render();
    expect(descriptionInput().getAttribute("maxlength")).toBe("80");
  });

  it("saves the description normalised to one line", async () => {
    await render();
    setValue(nameInput(), "Dev DB");
    setValue(descriptionInput(), "  Reaches   the dev DB ");
    click(saveButton());
    await flush();
    const saved = vi.mocked(useAppStore.getState().saveTunnel).mock.calls[0][0];
    expect(saved.description).toBe("Reaches the dev DB");
  });

  it("saves no description when it is left blank", async () => {
    await render();
    setValue(nameInput(), "Dev DB");
    click(saveButton());
    await flush();
    const saved = vi.mocked(useAppStore.getState().saveTunnel).mock.calls[0][0];
    expect(saved.description).toBeUndefined();
  });
});
