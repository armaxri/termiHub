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

  it("shows both Win/Linux and macOS column headers", () => {
    act(() => {
      root.render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />);
    });
    const headers = document.querySelectorAll(".shortcuts-overlay__table th");
    const headerTexts = Array.from(headers).map((h) => h.textContent);
    expect(headerTexts).toContain("Win / Linux");
    expect(headerTexts).toContain("macOS");
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

  it("renders letter keys upper-case in both platform columns (#4598)", () => {
    act(() => {
      root.render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />);
    });
    const cells = (action: string) =>
      Array.from(document.querySelectorAll(`[data-testid="shortcut-row-${action}"] td`)).map(
        (td) => td.textContent
      );
    expect(cells("toggle-sidebar")[1]).toContain("Ctrl+Shift+B");
    expect(cells("toggle-sidebar")[2]).toContain("Cmd+B");
    expect(cells("new-tab-group")[2]).toContain("Cmd+Shift+T");
  });

  describe("remote-desktop release chord (#4524)", () => {
    afterEach(() => clearOverrides());

    function row(): HTMLElement | null {
      return document.querySelector(`[data-testid="shortcut-row-${RELEASE_CHORD_ACTION}"]`);
    }

    it("lists the release chord under Remote Desktop with its default in both columns", () => {
      act(() => {
        root.render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />);
      });
      expect(document.body.textContent).toContain("Remote Desktop");
      const r = row();
      expect(r?.textContent).toContain("Release Remote Desktop Keyboard");
      expect(r?.textContent).toContain("Focused remote desktop");
      const keys = Array.from(r?.querySelectorAll("kbd") ?? []).map((k) => k.textContent);
      expect(keys).toEqual(["Ctrl+Shift+Alt", "Ctrl+Shift+Alt"]);
    });

    it("shows a rebound chord for the current platform", () => {
      setOverride(RELEASE_CHORD_ACTION, { key: "", ctrl: true, alt: true });
      act(() => {
        root.render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />);
      });
      const keys = Array.from(row()?.querySelectorAll("kbd") ?? []).map((k) => k.textContent);
      expect(keys).toContain("Ctrl+Alt");
    });
  });
});
