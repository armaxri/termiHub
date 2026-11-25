/**
 * Tunnel-type selector semantics (UISF2-002 / UI2-006): the Local/Remote/Dynamic
 * choice is the shared ui/RadioGroup card variant, so it is a radiogroup named
 * by its visible "Tunnel type" label, exposes aria-checked, and supports Radix
 * arrow-key roving selection.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { flushAsync } from "@/test/flushAsync";
import { useAppStore } from "@/store/appStore";
import { seedLayoutState } from "@/test/layoutState";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { TunnelEditor } from "./TunnelEditor";
import { checkA11y } from "@/test/axe";
import { getByRole } from "@/test/accessibleRoles";
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

async function render(tunnelId: string | null = null) {
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <TunnelEditor tabId={TAB_ID} meta={{ tunnelId }} isVisible={true} />
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

/** Move the pointer onto an element as Radix's tooltip sees it. */
async function hover(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

/** The open help tooltip of a card (portalled to the body). */
function help(testid: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testid}-help"]`);
}

/** The text a screen reader gets as the element's description. */
function description(el: HTMLElement): string {
  return (el.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((ref) => document.getElementById(ref)?.textContent)
    .join(" ");
}

setupConnectionsRegion();
setupAgentsRegion();

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

  it("is a radiogroup named by the visible Tunnel type label", async () => {
    await render();
    const group = q("tunnel-editor-type-selector");
    expect(group.getAttribute("role")).toBe("radiogroup");
    const labelId = group.getAttribute("aria-labelledby") as string;
    expect(document.getElementById(labelId)?.textContent).toBe("Tunnel type");
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

  it("names every control and leaves no orphan <label> (UISF2-010, #4351)", async () => {
    await render();
    expect(getByRole("radiogroup", "Tunnel type", container)).toBe(
      q("tunnel-editor-type-selector")
    );
    const orphans = Array.from(container.querySelectorAll("label"))
      .filter((label) => label.control === null)
      .map((label) => label.outerHTML);
    expect(orphans).toEqual([]);
  });

  it("has no a11y violations", async () => {
    await render();
    expect(await checkA11y(q("tunnel-editor-type-selector").parentElement!)).toHaveNoViolations();
  });

  it("says on each card what the type does, with its ssh flag (#6027)", async () => {
    await render();
    expect(q("tunnel-type-local").textContent).toBe(
      "LocalReach something on the SSH server's side ssh -L"
    );
    expect(q("tunnel-type-remote").textContent).toBe(
      "RemoteLet the SSH server reach something here ssh -R"
    );
    expect(q("tunnel-type-dynamic").textContent).toBe(
      "DynamicSOCKS5 proxy through the SSH server ssh -D"
    );
    // The name a screen reader announces stays the plain type.
    expect(getByRole("radio", "Remote", container)).toBe(q("tunnel-type-remote"));
  });

  it("explains a type on hover while another one is selected (#6027)", async () => {
    await render();
    expect(help("tunnel-type-remote")).toBeNull();
    await hover(q("tunnel-type-remote"));
    const text = help("tunnel-type-remote")?.textContent;
    expect(text).toContain("Opens a port on the SSH server");
    expect(text).toContain("a host and port this computer can reach");
    expect(q("tunnel-type-local").getAttribute("aria-checked")).toBe("true");
    expect(q("tunnel-type-local").getAttribute("data-state")).toBe("checked");
  });

  it("explains the selected type on keyboard focus and to screen readers (#6027)", async () => {
    await render();
    expect(description(q("tunnel-type-local"))).toContain("Opens a port on this computer");
    act(() => q("tunnel-type-local").focus());
    expect(help("tunnel-type-local")?.textContent).toContain(
      "Use something on the SSH server's side as if it ran here."
    );
  });

  it("explains the types for the agent that hosts the tunnel (#6027)", async () => {
    seedAgentsRegion({
      remoteAgents: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: "agent-1", name: "build-box", config: { host: "bb" } } as any,
      ],
    });
    useAppStore.setState({
      tunnels: [
        {
          id: "tun-agent",
          name: "Agent tunnel",
          sshConnectionId: "ssh-1",
          host: { kind: "agent", agentId: "agent-1" },
          autoStart: false,
          reconnectOnDisconnect: false,
          tunnelType: {
            type: "local",
            config: { localHost: "127.0.0.1", localPort: 1, remoteHost: "db", remotePort: 2 },
          },
        },
      ],
    });
    await render("tun-agent");
    for (const type of ["local", "remote", "dynamic"]) {
      const text = description(q(`tunnel-type-${type}`));
      expect(text).toContain("agent build-box");
      expect(text).not.toContain("this computer");
    }
    expect(q("tunnel-type-remote").textContent).toContain("on agent build-box's side");
    expect(q("tunnel-diagram").textContent).toContain("Agent build-box");
    await hover(q("tunnel-type-dynamic"));
    expect(help("tunnel-type-dynamic")?.textContent).toContain(
      "Opens a SOCKS5 proxy on agent build-box."
    );
  });
});
