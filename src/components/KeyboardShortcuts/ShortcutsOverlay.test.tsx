import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { useAppStore } from "@/store/appStore";
import { RELEASE_CHORD_ACTION, clearOverrides, setOverride } from "@/services/keybindings";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

let container: HTMLDivElement;
let root: Root;

describe("ShortcutsOverlay", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders nothing when closed", () => {
    act(() => {
      root.render(<ShortcutsOverlay open={false} onOpenChange={vi.fn()} />);
    });
    expect(document.querySelector('[data-testid="shortcuts-overlay"]')).toBeNull();
  });

  it("renders the overlay when open", () => {
    act(() => {
      root.render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />);
    });
    const overlay = document.querySelector('[data-testid="shortcuts-overlay"]');
    expect(overlay).not.toBeNull();
  });

  it("renders through the shared Modal primitive", () => {
    act(() => {
      root.render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />);
    });
    // The shell comes from the Modal primitive (.ui-modal), not a bespoke overlay.
    const modal = document.querySelector('.ui-modal[data-testid="shortcuts-overlay"]');
    expect(modal).not.toBeNull();
    expect(modal?.querySelector(".ui-modal__title")?.textContent).toBe("Keyboard Shortcuts");
  });

  it("shows the title", () => {
    act(() => {
      root.render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />);
    });
    expect(document.querySelector(".ui-modal__title")?.textContent).toBe("Keyboard Shortcuts");
  });

  it("renders the search input", () => {
    act(() => {
      root.render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />);
    });
    expect(document.querySelector('[data-testid="shortcuts-overlay-search"]')).not.toBeNull();
  });

  it("shows binding rows for known actions", () => {
    act(() => {
      root.render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />);
    });
    const content = document.querySelector('[data-testid="shortcuts-overlay"]')?.textContent ?? "";
    expect(content).toContain("Toggle Sidebar");
    expect(content).toContain("Close Tab");
    expect(content).toContain("Copy Selection");
    expect(content).toContain("Paste");
  });

  it("shows a single Shortcut column instead of per-platform columns (#4711)", () => {
    act(() => {
      root.render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />);
    });
    const headerTexts = Array.from(document.querySelectorAll(".shortcuts-overlay__table th")).map(
      (h) => h.textContent
    );
    expect(headerTexts).toEqual(["Action", "Shortcut"]);
    expect(document.body.textContent).not.toContain("Win / Linux");
    expect(document.body.textContent).not.toContain("macOS");
  });

  it("shows category group labels", () => {
    act(() => {
      root.render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />);
    });
    const labels = document.querySelectorAll(".shortcuts-overlay__group-label");
    const texts = Array.from(labels).map((l) => l.textContent);
    expect(texts).toContain("General");
    expect(texts).toContain("Clipboard");
    expect(texts).toContain("Terminal");
  });

  it("shows a scope hint for each action's row", () => {
    act(() => {
      root.render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />);
    });
    const hints = Array.from(document.querySelectorAll(".shortcuts-overlay__scope")).map(
      (el) => el.textContent
    );
    // A global action, the terminal-scoped find, and an editor-delegated clipboard action.
    expect(hints).toContain("All tabs");
    expect(hints).toContain("Terminal tabs");
    expect(hints).toContain("Yields to editors & inputs");
  });

  it("labels Find in Terminal as a terminal-scoped action", () => {
    act(() => {
      root.render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />);
    });
    const row = document.querySelector('[data-testid="shortcut-row-find-in-terminal"]');
    expect(row?.querySelector(".shortcuts-overlay__scope")?.textContent).toBe("Terminal tabs");
  });

  it("renders an 'Edit shortcuts' action that links to the editor", () => {
    act(() => {
      root.render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />);
    });
    const edit = document.querySelector('[data-testid="shortcuts-overlay-edit"]');
    expect(edit).not.toBeNull();
    expect(edit?.textContent).toContain("Edit shortcuts");
  });

  it("deep-links to the Keyboard settings category and closes the overlay on Edit", () => {
    const openSettingsTab = vi.fn();
    useAppStore.setState({ openSettingsTab });
    const onOpenChange = vi.fn();
    act(() => {
      root.render(<ShortcutsOverlay open={true} onOpenChange={onOpenChange} />);
    });

    const edit = document.querySelector('[data-testid="shortcuts-overlay-edit"]') as HTMLElement;
    act(() => {
      edit.click();
    });

    expect(openSettingsTab).toHaveBeenCalledWith({ category: "keyboard" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("calls onOpenChange when close button is clicked", () => {
    const onOpenChange = vi.fn();
    act(() => {
      root.render(<ShortcutsOverlay open={true} onOpenChange={onOpenChange} />);
    });
    const closeBtn = document.querySelector('[data-testid="modal-close"]') as HTMLElement;
    act(() => {
      closeBtn.click();
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  describe.each([
    {
      platform: "macOS",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15",
      sidebar: "Cmd+B",
      newTabGroup: "Cmd+Shift+T",
      primary: "Cmd",
    },
    {
      platform: "Windows",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      sidebar: "Ctrl+Shift+B",
      newTabGroup: "Ctrl+Shift+T",
      primary: "Ctrl",
    },
    {
      platform: "Linux",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
      sidebar: "Ctrl+Shift+B",
      newTabGroup: "Ctrl+Shift+T",
      primary: "Ctrl",
    },
  ])("on $platform (#4711)", ({ userAgent, sidebar, newTabGroup, primary }) => {
    beforeEach(() => {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
    });
    afterEach(() => {
      vi.restoreAllMocks();
      clearOverrides();
    });

    function cells(action: string): string[] {
      return Array.from(
        document.querySelectorAll(`[data-testid="shortcut-row-${action}"] td`),
        (td) => td.textContent ?? ""
      );
    }

    it("renders one binding column with the platform's bindings, letters upper-cased", () => {
      act(() => {
        root.render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />);
      });
      const row = document.querySelector('[data-testid="shortcut-row-toggle-sidebar"]');
      expect(row?.querySelectorAll("td")).toHaveLength(2);
      expect(row?.querySelectorAll("kbd")).toHaveLength(1);
      expect(cells("toggle-sidebar")[1]).toBe(sidebar);
      expect(cells("new-tab-group")[1]).toBe(newTabGroup);
      expect(cells("toggle-sidebar")[1].startsWith(primary)).toBe(true);
    });

    it("shows a user override in place of the platform default", () => {
      setOverride("toggle-sidebar", { key: "j", ctrl: true, alt: true });
      act(() => {
        root.render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />);
      });
      expect(cells("toggle-sidebar")[1]).toBe("Ctrl+Alt+J");
    });

    it("lists the remote-desktop release chord (#4524)", () => {
      act(() => {
        root.render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />);
      });
      const kbds = Array.from(
        document.querySelectorAll(`[data-testid="shortcut-row-${RELEASE_CHORD_ACTION}"] kbd`),
        (k) => k.textContent
      );
      expect(kbds).toEqual(["Ctrl+Shift+Alt"]);
    });
  });

  describe("remote-desktop release chord (#4524)", () => {
    afterEach(() => clearOverrides());

    function row(): HTMLElement | null {
      return document.querySelector(`[data-testid="shortcut-row-${RELEASE_CHORD_ACTION}"]`);
    }

    it("lists the release chord under Remote Desktop with its default", () => {
      act(() => {
        root.render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />);
      });
      expect(document.body.textContent).toContain("Remote Desktop");
      const r = row();
      expect(r?.textContent).toContain("Release Remote Desktop Keyboard");
      expect(r?.textContent).toContain("Focused remote desktop");
      const keys = Array.from(r?.querySelectorAll("kbd") ?? []).map((k) => k.textContent);
      expect(keys).toEqual(["Ctrl+Shift+Alt"]);
    });

    it("shows a rebound chord for the current platform", () => {
      setOverride(RELEASE_CHORD_ACTION, { key: "", ctrl: true, alt: true });
      act(() => {
        root.render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />);
      });
      const keys = Array.from(row()?.querySelectorAll("kbd") ?? []).map((k) => k.textContent);
      expect(keys).toEqual(["Ctrl+Alt"]);
    });
  });

  describe("landmark focus cycling (#4773)", () => {
    afterEach(() => clearOverrides());

    function kbds(action: string): (string | null)[] {
      return Array.from(
        document.querySelectorAll(`[data-testid="shortcut-row-${action}"] kbd`),
        (k) => k.textContent
      );
    }

    it("lists the F6 / Shift+F6 region shortcuts", () => {
      act(() => {
        root.render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />);
      });
      const next = document.querySelector('[data-testid="shortcut-row-focus-next-region"]');
      const prev = document.querySelector('[data-testid="shortcut-row-focus-prev-region"]');
      expect(next?.textContent).toContain("Focus Next Region");
      expect(prev?.textContent).toContain("Focus Previous Region");
      expect(kbds("focus-next-region")).toEqual(["F6"]);
      expect(kbds("focus-prev-region")).toEqual(["Shift+F6"]);
    });

    it("shows a user override instead of the default", () => {
      setOverride("focus-next-region", { key: "F7" });
      act(() => {
        root.render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />);
      });
      expect(kbds("focus-next-region")).toEqual(["F7"]);
    });
  });
});
