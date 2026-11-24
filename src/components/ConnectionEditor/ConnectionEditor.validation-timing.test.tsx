import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { resetRuntimeCache } from "@/hooks/useAvailableRuntimes";
import { ConnectionEditor } from "./ConnectionEditor";
import { TooltipProvider } from "@/components/ui";
import type { ConnectionTypeInfo } from "@/types/connection";

// ---------------------------------------------------------------------------
// Validation timing (#5909): a field's error shows only after the user edited
// it and left it, or for every field once they try to save. A brand-new
// connection opens without any red "… is required." message, while Save stays
// gated (aria-disabled) and activating it reveals every reason and focuses
// the first invalid field.
// ---------------------------------------------------------------------------

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

/** Local type with no required config fields — Save gates on the name alone. */
const LOCAL_TYPE: ConnectionTypeInfo = {
  typeId: "local",
  displayName: "Local shell",
  icon: "local",
  schema: {
    groups: [
      {
        key: "general",
        label: "General",
        fields: [{ key: "shell", label: "Shell", fieldType: { type: "text" }, required: false }],
      },
    ],
  },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: false },
};

/** SSH type with two required fields, so a pristine form is invalid. */
const SSH_TYPE: ConnectionTypeInfo = {
  typeId: "ssh",
  displayName: "SSH",
  icon: "ssh",
  schema: {
    groups: [
      {
        key: "conn",
        label: "Connection",
        fields: [
          { key: "host", label: "Host", fieldType: { type: "text" }, required: true },
          { key: "username", label: "Username", fieldType: { type: "text" }, required: true },
        ],
      },
    ],
  },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: false },
};

let container: HTMLDivElement;
let root: Root;

function q(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function nameInput(): HTMLInputElement {
  return q("connection-editor-name-input") as HTMLInputElement;
}

function setInput(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderEditor(
  connectionId: string,
  extraMeta: Record<string, unknown> = {},
  tabId = "tab-tl-1"
): void {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <ConnectionEditor
          tabId={tabId}
          meta={{ connectionId, folderId: null, ...extraMeta }}
          isVisible={true}
        />
      </TooltipProvider>
    );
  });
}

/** Open the Radix type-select and return its rendered option elements. */
function openTypeOptions(): HTMLElement[] {
  const trigger = q("connection-editor-type-select");
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

setupSettingsRegion();
setupConnectionsRegion();
setupAgentsRegion();

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  resetRuntimeCache();
  useAppStore.setState({
    ...useAppStore.getInitialState(),
    connectionTypes: [LOCAL_TYPE, SSH_TYPE],
    credentialStoreStatus: { mode: "none", status: "unlocked" },
  });
  seedConnectionsRegion({ connections: [] });
  mockedInvoke.mockImplementation((cmd) => {
    if (cmd === "check_docker_available") return Promise.resolve(false);
    if (cmd === "check_podman_available") return Promise.resolve(false);
    if (cmd === "resolve_credential") return Promise.resolve(null);
    return Promise.resolve(undefined);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

/** Wait out the requestAnimationFrame the focus-first-invalid step defers to. */
async function settleFrame(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

/** Every inline validation message currently shown in the editor. */
function shownErrors(): string[] {
  return Array.from(container.querySelectorAll('[role="alert"]')).map((e) => e.textContent ?? "");
}

function input(testId: string): HTMLInputElement {
  return q(testId) as HTMLInputElement;
}

function leave(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

/** Open a new editor and switch it to the SSH type the way a user does. */
async function openNewSsh(): Promise<void> {
  renderEditor("new");
  await flush();
  // Name is autofocused; the user's first move is usually the Type select.
  act(() => nameInput().focus());
  const ssh = openTypeOptions().find((o) => o.getAttribute("data-value") === "ssh");
  if (!ssh) throw new Error("ssh option not found");
  act(() => ssh.click());
  await flush();
  expect(q("field-host")).not.toBeNull();
}

describe("ConnectionEditor validation timing (#5909)", () => {
  it("opens a new connection without any error", async () => {
    renderEditor("new");
    await flush();
    expect(shownErrors()).toEqual([]);
  });

  it("shows no error after picking a type while Name had focus", async () => {
    await openNewSsh();
    act(() => nameInput().blur());
    leave(nameInput());
    await flush();
    expect(shownErrors()).toEqual([]);
    expect(q("connection-editor-save")?.getAttribute("aria-disabled")).toBe("true");
  });

  it("shows a field's error only once the edited field is left", async () => {
    await openNewSsh();
    const host = input("field-host");
    setInput(host, "h");
    setInput(host, "");
    await flush();
    expect(q("field-host-error")).toBeNull();

    leave(host);
    await flush();
    expect(q("field-host-error")?.textContent).toBeTruthy();
    // Only the field the user worked on: Name and Username stay quiet.
    expect(q("connection-editor-name-error")).toBeNull();
    expect(q("field-username-error")).toBeNull();

    // Once shown, fixing the value clears it at once.
    setInput(host, "example.com");
    await flush();
    expect(q("field-host-error")).toBeNull();
  });

  it("reveals every error on Save and focuses the first invalid field (Name)", async () => {
    await openNewSsh();
    act(() => (q("connection-editor-save") as HTMLButtonElement).click());
    await flush();
    await settleFrame();
    expect(q("connection-editor-name-error")?.textContent).toBe("Name is required.");
    expect(q("field-host-error")).not.toBeNull();
    expect(q("field-username-error")).not.toBeNull();
    expect(document.activeElement).toBe(nameInput());
  });

  it("focuses the first invalid connection field when the name is valid", async () => {
    await openNewSsh();
    setInput(nameInput(), "Prod");
    await flush();
    act(() => (q("connection-editor-save-connect") as HTMLButtonElement).click());
    await flush();
    await settleFrame();
    expect(q("connection-editor-name-error")).toBeNull();
    expect(q("field-host-error")).not.toBeNull();
    expect(q("field-username-error")).not.toBeNull();
    expect(document.activeElement).toBe(input("field-host"));
  });

  it("holds a new type's errors back again after a failed save", async () => {
    await openNewSsh();
    setInput(nameInput(), "Prod");
    act(() => (q("connection-editor-save") as HTMLButtonElement).click());
    await flush();
    await settleFrame();
    expect(q("field-host-error")).not.toBeNull();

    const local = openTypeOptions().find((o) => o.getAttribute("data-value") === "local");
    act(() => local!.click());
    await flush();
    const ssh = openTypeOptions().find((o) => o.getAttribute("data-value") === "ssh");
    act(() => ssh!.click());
    await flush();
    expect(q("field-host")).not.toBeNull();
    expect(shownErrors()).toEqual([]);
  });
});
