/**
 * Connection editor layout (#5835) and the inline test result's lifetime (#5879).
 *
 * - Type comes first: it decides every field below it.
 * - "Fill from ~/.ssh/config…" is a compact link beside the Host label, not a
 *   block above the form.
 * - The footer has one layout in create and edit: Test (ghost) with its result
 *   on the left; Cancel and the saves on the right, primary right-most (#5755).
 * - A type without a terminal has no Terminal page.
 * - The inline test result only describes the settings currently in the form.
 */
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { flushAsync } from "@/test/flushAsync";
import { useAppStore } from "@/store/appStore";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { resetRuntimeCache } from "@/hooks/useAvailableRuntimes";
import { ConnectionEditor } from "./ConnectionEditor";
import { TooltipProvider } from "@/components/ui";
import type { ConnectionEditorMeta } from "@/types/terminal";
import type { ConnectionTypeInfo, SavedConnection } from "@/types/connection";

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: {
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      loading: vi.fn(),
      dismiss: vi.fn(),
    },
  };
});

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

const HOST_PORT = {
  groups: [
    {
      key: "connection",
      label: "Connection",
      fields: [
        { key: "host", label: "Host", fieldType: { type: "text" as const }, required: false },
        { key: "port", label: "Port", fieldType: { type: "port" as const }, required: false },
      ],
    },
  ],
};

const CAPS = { monitoring: false, fileBrowser: false, resize: true, persistent: false };

const LOCAL_TYPE: ConnectionTypeInfo = {
  typeId: "local",
  displayName: "Local",
  icon: "local",
  schema: HOST_PORT,
  capabilities: CAPS,
};
const SSH_TYPE: ConnectionTypeInfo = { ...LOCAL_TYPE, typeId: "ssh", displayName: "SSH" };
/** A terminal-less type, like VNC / RDP. */
const VNC_TYPE: ConnectionTypeInfo = {
  ...LOCAL_TYPE,
  typeId: "vnc",
  displayName: "VNC",
  capabilities: { ...CAPS, graphical: true, terminal: false },
};

const EXISTING_SSH: SavedConnection = {
  id: "web",
  name: "web",
  config: { type: "ssh", config: { host: "web.example.com", port: 22 } },
  folderId: null,
};
const EXISTING_VNC: SavedConnection = {
  id: "desk",
  name: "desk",
  config: { type: "vnc", config: { host: "desk.example.com", port: 5900 } },
  folderId: null,
};

setupSettingsRegion();
setupConnectionsRegion();
setupAgentsRegion();

let container: HTMLDivElement;
let root: Root;

async function render(meta: ConnectionEditorMeta) {
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <ConnectionEditor tabId="tab-layout" meta={meta} isVisible={true} />
      </TooltipProvider>
    );
  });
  await flushAsync();
}

function q(testId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function precedes(a: Element, b: Element): boolean {
  return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flushAsync();
}

/** The footer's buttons in DOM (= visual) order. */
function footerOrder(): string[] {
  return Array.from(q("connection-editor-actions")!.querySelectorAll("button")).map(
    (b) => b.getAttribute("data-testid") ?? ""
  );
}

function navLabels(): string[] {
  return Array.from(container.querySelectorAll(".connection-editor__body nav button, [role=tab]"))
    .map((b) => b.textContent?.trim() ?? "")
    .filter(Boolean);
}

describe("ConnectionEditor layout (#5835)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetRuntimeCache();
    mockedInvoke.mockReset();
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "save_connection") return Promise.resolve("persisted-id");
      if (cmd === "test_connection") return Promise.resolve(undefined);
      if (cmd === "load_connections_and_folders")
        return Promise.resolve({ connections: [EXISTING_SSH, EXISTING_VNC], folders: [] });
      return Promise.resolve(null);
    });
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [LOCAL_TYPE, SSH_TYPE, VNC_TYPE],
      credentialStoreStatus: { mode: "none", status: "unlocked" },
    });
    seedConnectionsRegion({ connections: [EXISTING_SSH, EXISTING_VNC] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("puts Type before Name", async () => {
    await render({ connectionId: "new", folderId: null });
    const type = q("connection-editor-type-select")!;
    const name = q("connection-editor-name-input")!;
    expect(precedes(type, name)).toBe(true);
  });

  it("puts Fill from ~/.ssh/config beside the Host label, not above the form", async () => {
    await render({ connectionId: EXISTING_SSH.id, folderId: null });
    const link = q("ssh-config-import-connection-open")!;
    expect(link).not.toBeNull();
    expect(q("dynamic-field-host")!.contains(link)).toBe(true);
    expect(q("ssh-config-import-section")).toBeNull();
    expect(link.textContent).toBe("Fill from ~/.ssh/config…");
  });

  it("keeps the footer order in create and edit: Test left, primary right-most", async () => {
    await render({ connectionId: "new", folderId: null });
    const created = footerOrder();
    expect(created).toEqual([
      "connection-editor-test",
      "connection-editor-cancel",
      "connection-editor-save",
      "connection-editor-save-connect",
    ]);
    expect(q("connection-editor-test")!.classList.contains("ui-btn--ghost")).toBe(true);
    act(() => root.unmount());
    root = createRoot(container);

    await render({ connectionId: EXISTING_SSH.id, folderId: null });
    expect(footerOrder()).toEqual([
      "connection-editor-test",
      "connection-editor-cancel",
      "connection-editor-save-connect",
      "connection-editor-save",
    ]);
  });

  it("keeps Test and its result in the footer's left group", async () => {
    await render({ connectionId: "new", folderId: null });
    const left = container.querySelector(".connection-editor__actions-test")!;
    expect(left.contains(q("connection-editor-test"))).toBe(true);
    expect(left.contains(q("connection-editor-test-result"))).toBe(true);
    expect(left.contains(q("connection-editor-cancel"))).toBe(false);
  });

  it("hides the Terminal page for a type without a terminal", async () => {
    await render({ connectionId: EXISTING_VNC.id, folderId: null });
    expect(navLabels()).toContain("Appearance");
    expect(navLabels()).not.toContain("Terminal");
    act(() => root.unmount());
    root = createRoot(container);

    await render({ connectionId: EXISTING_SSH.id, folderId: null });
    expect(navLabels()).toContain("Terminal");
  });
});

describe("ConnectionEditor inline test result (#5879)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetRuntimeCache();
    mockedInvoke.mockReset();
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "load_connections_and_folders")
        return Promise.resolve({ connections: [EXISTING_SSH], folders: [] });
      return Promise.resolve(undefined);
    });
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [LOCAL_TYPE, SSH_TYPE],
      credentialStoreStatus: { mode: "none", status: "unlocked" },
    });
    seedConnectionsRegion({ connections: [EXISTING_SSH] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function runTest() {
    await render({ connectionId: "new", folderId: null });
    setValue(q("connection-editor-name-input") as HTMLInputElement, "lab");
    setValue(q("field-host") as HTMLInputElement, "lab.example.com");
    await flushAsync();
    await click(q("connection-editor-test")!);
    expect(q("connection-editor-test-result")!.textContent).toContain("Reached lab");
    expect(q("connection-editor-test")!.getAttribute("data-test-outcome")).toBe("success");
  }

  it("clears the result when the host changes after a test", async () => {
    await runTest();
    setValue(q("field-host") as HTMLInputElement, "other.example.com");
    await flushAsync();
    expect(q("connection-editor-test-result")!.textContent).toBe("");
    expect(q("connection-editor-test")!.getAttribute("data-test-outcome")).toBeNull();
  });

  it("keeps the result while only the name changes", async () => {
    await runTest();
    setValue(q("connection-editor-name-input") as HTMLInputElement, "lab box");
    await flushAsync();
    expect(q("connection-editor-test-result")!.textContent).toContain("Reached lab");
  });
});
