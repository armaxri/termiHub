/**
 * Plugin-provided connection types in the type picker (#2002).
 *
 * A plugin that registers a terminal backend (#1999) flows through the normal
 * connection-type registry, so the picker must list those types below the
 * built-ins under a puzzle-badged "Plugins" separator, render their config form
 * from the manifest-derived schema via the generic DynamicForm, and save a
 * ConnectionConfig carrying the plugin's type id and the form's settings.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { ConnectionEditor } from "./ConnectionEditor";
import { TooltipProvider } from "@/components/ui";
import type { ConnectionTypeInfo, SavedConnection } from "@/types/connection";

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
  displayName: "Local Shell",
  icon: "terminal",
  schema: { groups: [] },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: false },
};

/** A plugin-provided backend: puzzle icon + a one-field manifest-derived schema. */
const ACME_TYPE: ConnectionTypeInfo = {
  typeId: "acme-term",
  displayName: "Acme Terminal",
  icon: "puzzle",
  schema: {
    groups: [
      {
        key: "connection",
        label: "Connection",
        fields: [
          { key: "endpoint", label: "Endpoint", fieldType: { type: "text" }, required: false },
        ],
      },
    ],
  },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: false },
};

/** A second plugin backend whose display name was disambiguated by the backend. */
const ACME_TYPE_B: ConnectionTypeInfo = {
  ...ACME_TYPE,
  typeId: "acme-term-globex",
  displayName: "Acme Terminal (Globex)",
};

let container: HTMLDivElement;
let root: Root;

function renderNew() {
  const initial = useAppStore.getInitialState();
  useAppStore.setState({
    ...initial,
    connections: [],
    connectionTypes: [LOCAL_TYPE, ACME_TYPE, ACME_TYPE_B],
  });
  act(() => {
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

describe("ConnectionEditor — plugin connection types", () => {
  it("lists plugin types under a puzzle-badged Plugins separator, below the built-ins", () => {
    renderNew();
    const options = openTypeOptions();
    const values = options.map((o) => o.getAttribute("data-value"));

    // Built-in first, then the plugin backends.
    expect(values).toContain("local");
    expect(values).toContain("acme-term");
    expect(values.indexOf("local")).toBeLessThan(values.indexOf("acme-term"));

    // A "Plugins" group heading separates them.
    const groupLabel = document.querySelector(".ui-select__group-label");
    expect(groupLabel?.textContent).toBe("Plugins");
    expect(document.querySelector('[data-testid="connection-type-plugins-group"]')).not.toBeNull();

    // Only the plugin item carries the puzzle badge.
    const plugin = options.find((o) => o.getAttribute("data-value") === "acme-term");
    const builtin = options.find((o) => o.getAttribute("data-value") === "local");
    expect(plugin?.querySelector(".connection-editor__plugin-badge")).not.toBeNull();
    expect(builtin?.querySelector(".connection-editor__plugin-badge")).toBeNull();
    expect(plugin?.textContent).toContain("Acme Terminal");
  });

  it("renders two same-named plugin backends with distinct disambiguated labels", () => {
    renderNew();
    const options = openTypeOptions();
    const labels = options
      .filter((o) => o.getAttribute("data-value")?.startsWith("acme-term"))
      .map((o) => o.textContent);
    expect(labels).toContain("Acme Terminal");
    expect(labels).toContain("Acme Terminal (Globex)");
  });

  it("renders the plugin's schema-driven config form and saves its type id + settings", async () => {
    const existing: SavedConnection = {
      id: "conn-acme-1",
      name: "My Acme",
      config: { type: "acme-term", config: { endpoint: "wss://acme.example" } },
      folderId: null,
    };
    const updateConnection = vi.fn();
    const initial = useAppStore.getInitialState();
    useAppStore.setState({
      ...initial,
      connections: [existing],
      connectionTypes: [LOCAL_TYPE, ACME_TYPE],
      updateConnection,
    });
    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <ConnectionEditor
            tabId="tab-edit"
            meta={{ connectionId: "conn-acme-1", folderId: null }}
            isVisible={true}
          />
        </TooltipProvider>
      );
    });

    // The manifest-derived field renders via the generic DynamicForm — no
    // hardcoded plugin UI.
    const field = document.querySelector('[data-testid="field-endpoint"]');
    expect(field).not.toBeNull();

    // Saving keeps the plugin type id and forwards the settings JSON verbatim.
    const saveBtn = document.querySelector(
      '[data-testid="connection-editor-save"]'
    ) as HTMLElement | null;
    expect(saveBtn).not.toBeNull();
    await act(async () => {
      saveBtn!.click();
      await Promise.resolve();
    });

    expect(updateConnection).toHaveBeenCalledTimes(1);
    const saved = updateConnection.mock.calls[0][0] as SavedConnection;
    expect(saved.config.type).toBe("acme-term");
    expect(saved.config.config).toMatchObject({ endpoint: "wss://acme.example" });
  });
});
