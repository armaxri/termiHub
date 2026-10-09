/**
 * Tunnel-type selector semantics (UISF2-002 / UI2-006): the Local/Remote/Dynamic
 * choice is the shared ui/RadioGroup card variant, so it is a radiogroup named
 * by its visible "Tunnel Type" label, exposes aria-checked, and supports Radix
 * arrow-key roving selection.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { flushAsync } from "@/test/flushAsync";
import { useAppStore } from "@/store/appStore";
import { seedLayoutState } from "@/test/layoutState";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { TunnelEditor } from "./TunnelEditor";
import { checkA11y } from "@/test/axe";
import { pressRadioArrow } from "@/test/radioKeyboard";
import { TooltipProvider } from "@/components/ui";
import type { SavedConnection } from "@/types/connection";
import type { TunnelConfig } from "@/types/tunnel";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const TAB_ID = "tab-tun-form";
const PANEL_ID = "panel-tun-form";

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
let saveTunnel: (config: TunnelConfig) => Promise<void>;

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

function q(testid: string): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-testid="${testid}"]`)!;
}

/** Set a value on a React-controlled input and fire the native input event. */
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

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

setupConnectionsRegion();

describe("TunnelEditor — tunnel type selector (UISF2-002)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    saveTunnel = vi.fn(() => Promise.resolve());
    seedConnectionsRegion({ connections: [SSH_CONN] });
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      tunnels: [],
      saveTunnel,
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

  it("is a radiogroup named by the visible Tunnel Type label", async () => {
    await render();
    const group = q("tunnel-editor-type-selector");
    expect(group.getAttribute("role")).toBe("radiogroup");
    const labelId = group.getAttribute("aria-labelledby") as string;
    expect(document.getElementById(labelId)?.textContent).toBe("Tunnel Type");
    expect(q("tunnel-type-local").getAttribute("role")).toBe("radio");
    expect(q("tunnel-type-local").getAttribute("type")).toBe("button");
    expect(q("tunnel-type-local").getAttribute("aria-checked")).toBe("true");
    expect(q("tunnel-type-remote").getAttribute("aria-checked")).toBe("false");
    expect(q("tunnel-type-dynamic").getAttribute("aria-checked")).toBe("false");
  });

  it("reflects a click in aria-checked", async () => {
    await render();
    click(q("tunnel-type-dynamic"));
    expect(q("tunnel-type-dynamic").getAttribute("aria-checked")).toBe("true");
    expect(q("tunnel-type-local").getAttribute("aria-checked")).toBe("false");
  });

  it("selects the next type with ArrowRight and saves it", async () => {
    await render();
    setValue(q("tunnel-editor-name") as HTMLInputElement, "Reverse");
    const local = q("tunnel-type-local");
    act(() => local.focus());
    await pressRadioArrow(local, "ArrowRight");
    expect(document.activeElement).toBe(q("tunnel-type-remote"));
    expect(q("tunnel-type-remote").getAttribute("aria-checked")).toBe("true");
    click(q("tunnel-editor-save"));
    await flush();
    const saved = vi.mocked(saveTunnel).mock.calls[0][0];
    expect(saved.tunnelType.type).toBe("remote");
  });

  it("has no a11y violations", async () => {
    await render();
    expect(await checkA11y(q("tunnel-editor-type-selector").parentElement!)).toHaveNoViolations();
  });
});
