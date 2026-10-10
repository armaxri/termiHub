/**
 * Split resize-handle DOM contract (#3693).
 *
 * react-resizable-panels renders a Separator's `data-testid` from its `id`, so a
 * `data-testid` prop alone never reaches the DOM. The system harness drags the
 * handle by `split-view-resize-handle-<panelId>` (the panel after it), and the
 * split-border CSS keys off the separator's `aria-orientation`; this pins both
 * by mounting the real App shell over a seeded two-panel split.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { seedLayoutState } from "@/test/layoutState";
import type { LeafPanel, SplitContainer } from "@/types/terminal";
import App from "@/App";

// The global `invoke` stub (src/test/setup.ts) resolves `undefined`, but the
// backend's session-ownership map is never undefined: stub it as the real
// empty map so `refreshSessionOwners` sees a faithful value (#4520).
vi.mock("@/services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api")>()),
  listSessionOwners: vi.fn(() => Promise.resolve({})),
}));

/** A leaf holding one Settings tab — an all-empty layout renders the empty-window
 * state instead of the split, and Settings needs no session. */
function leaf(id: string): LeafPanel {
  const tabId = `${id}-tab`;
  return {
    type: "leaf",
    id,
    tabs: [
      {
        id: tabId,
        sessionId: null,
        title: "Settings",
        connectionType: "local",
        contentType: "settings",
        config: { type: "local", config: { shell: "zsh" } },
        panelId: id,
        isActive: true,
      },
    ],
    activeTabId: tabId,
  };
}

function seedSplit(direction: "horizontal" | "vertical"): SplitContainer {
  const root: SplitContainer = {
    type: "split",
    id: "split-root",
    direction,
    children: [leaf("leaf-first"), leaf("leaf-second")],
  };
  seedLayoutState({ rootPanel: root, activePanelId: "leaf-first" });
  return root;
}

describe("split resize handle (#3693)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      loadFromBackend: async () => {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each([
    ["horizontal", "vertical"],
    ["vertical", "horizontal"],
  ] as const)(
    "a %s split renders one handle with a stable test id (aria-orientation %s)",
    async (direction, ariaOrientation) => {
      seedSplit(direction);
      await act(async () => {
        root.render(<App />);
      });

      const handles = container.querySelectorAll(".split-view__resize-handle");
      expect(handles).toHaveLength(1);
      const handle = handles[0];
      expect(handle.getAttribute("data-testid")).toBe("split-view-resize-handle-leaf-second");
      expect(handle.getAttribute("aria-orientation")).toBe(ariaOrientation);
    }
  );

  // react-resizable-panels owns the split separator's keyboard handling
  // (arrows resize by 5%); jsdom has no layout to resize, so this pins the
  // semantics it needs, and the sidebar handles' own arrow tests cover resizing.
  it("is a focusable separator exposing its value (#4329)", async () => {
    seedSplit("horizontal");
    await act(async () => {
      root.render(<App />);
    });
    const handle = container.querySelector<HTMLElement>(".split-view__resize-handle")!;
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("tabindex")).toBe("0");
    expect(Number.isFinite(Number(handle.getAttribute("aria-valuenow")))).toBe(true);
    act(() => handle.focus());
    expect(document.activeElement).toBe(handle);
  });

  it("the app's sidebar handle is a keyboard separator too (#4329)", async () => {
    seedSplit("horizontal");
    await act(async () => {
      root.render(<App />);
    });
    const handle = container.querySelector<HTMLElement>('[data-testid="sidebar-resize-handle"]');
    expect(handle?.getAttribute("role")).toBe("separator");
    expect(handle?.getAttribute("tabindex")).toBe("0");
  });
});
