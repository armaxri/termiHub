/**
 * The connection-type picker shows the same per-type glyph as the sidebar and
 * tabs (#5622), so SSH, serial and local shell are distinguishable at a glance.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { flushAsync } from "@/test/flushAsync";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { ConnectionEditor } from "./ConnectionEditor";
import { TooltipProvider } from "@/components/ui";
import type { ConnectionTypeInfo } from "@/types/connection";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const mockedInvoke = vi.mocked(invoke);

const LOCAL_TYPE: ConnectionTypeInfo = {
  typeId: "local",
  displayName: "Local shell",
  icon: "terminal",
  schema: { groups: [] },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: false },
};

const SSH_TYPE: ConnectionTypeInfo = { ...LOCAL_TYPE, typeId: "ssh", displayName: "SSH" };
const SERIAL_TYPE: ConnectionTypeInfo = { ...LOCAL_TYPE, typeId: "serial", displayName: "Serial" };

let container: HTMLDivElement;
let root: Root;

async function renderNew() {
  const initial = useAppStore.getInitialState();
  useAppStore.setState({
    ...initial,
    connectionTypes: [LOCAL_TYPE, SSH_TYPE, SERIAL_TYPE],
  });
  seedConnectionsRegion({ connections: [] });
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <ConnectionEditor
          tabId="tab-1"
          meta={{ connectionId: "new", folderId: null }}
          isVisible={true}
        />
      </TooltipProvider>
    );
  });
  await flushAsync();
}

/** Open the Radix type-select and return its rendered option elements. */
function openTypeOptions(): HTMLElement[] {
  const trigger = document.querySelector(
    '[data-testid="connection-editor-type-select"]'
  ) as HTMLElement | null;
  if (!trigger) throw new Error("type select trigger not found");
  for (let i = 0; i < 3 && document.querySelectorAll(".ui-select__item").length === 0; i++) {
    act(() => {
      trigger.focus();
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
      );
    });
  }
  return Array.from(document.querySelectorAll<HTMLElement>(".ui-select__item"));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockedInvoke.mockImplementation(() => Promise.resolve(false));
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

setupConnectionsRegion();

describe("ConnectionEditor — type picker glyphs (#5622)", () => {
  it("shows each built-in type with its own connection-type glyph", async () => {
    await renderNew();
    const options = openTypeOptions();
    const iconOf = (value: string) =>
      options
        .find((o) => o.getAttribute("data-value") === value)
        ?.querySelector("svg[data-icon]")
        ?.getAttribute("data-icon");

    expect(iconOf("local")).toBe("terminal");
    expect(iconOf("ssh")).toBe("key-round");
    expect(iconOf("serial")).toBe("cable");
  });
});
