import { setupSettingsRegionMirror } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TooltipProvider } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { FileTypeSettings } from "./FileTypeSettings";
import { KeyPathInput } from "./KeyPathInput";
import { SerialPortSettings } from "./SerialPortSettings";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(() => Promise.resolve(null)),
}));

let container: HTMLDivElement;
let root: Root;

function renderNode(node: React.ReactNode) {
  act(() => {
    root.render(<TooltipProvider delayDuration={0}>{node}</TooltipProvider>);
  });
}

function btn(testId: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
}

/**
 * Pins the Tooltip-primitive adoption on the interactive icon-only controls in
 * `src/components/Settings/`: each converted control keeps its `data-testid`,
 * exposes an `aria-label` (a tooltip is not an accessible name), no longer sets a
 * bare `title=`, and gets `aria-describedby` wired by Radix on focus.
 */
setupSettingsRegionMirror();

describe("Settings icon controls tooltip adoption", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  describe("FileTypeSettings remove/copy icon buttons", () => {
    function renderWithMapping() {
      act(() => {
        useAppStore.setState({
          settings: {
            ...useAppStore.getState().settings,
            fileLanguageMappings: { Jenkinsfile: "groovy" },
          },
        });
      });
      renderNode(<FileTypeSettings />);
    }

    it("gives the remove-mapping button an aria-label and no bare title", () => {
      renderWithMapping();
      const remove = btn("file-type-remove-Jenkinsfile");
      expect(remove, "remove button should render").toBeTruthy();
      expect(remove?.getAttribute("aria-label")).toBe("Remove mapping for Jenkinsfile");
      expect(remove?.hasAttribute("title")).toBe(false);
    });

    it("gives the copy-override button an aria-label and no bare title", () => {
      renderWithMapping();
      // Built-in reference rows expose the copy-into-add-form icon control.
      const copy = container.querySelector<HTMLButtonElement>('[data-testid^="file-type-copy-"]');
      expect(copy, "a copy button should render").toBeTruthy();
      expect(copy?.getAttribute("aria-label")).toMatch(/^Copy /);
      expect(copy?.hasAttribute("title")).toBe(false);
    });

    it("wires aria-describedby on focus of the remove button", () => {
      renderWithMapping();
      const remove = btn("file-type-remove-Jenkinsfile") as HTMLButtonElement;
      act(() => {
        remove.focus();
        remove.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
      });
      expect(remove.getAttribute("aria-describedby")).toBeTruthy();
    });
  });

  describe("KeyPathInput browse icon button", () => {
    function renderInput() {
      renderNode(<KeyPathInput value="" onChange={() => {}} testIdPrefix="field-keyPath" />);
    }

    it("gives the browse button an aria-label and no bare title", () => {
      renderInput();
      const browse = btn("field-keyPath-key-path-browse");
      expect(browse, "browse button should render").toBeTruthy();
      expect(browse?.getAttribute("aria-label")).toBe("Browse");
      expect(browse?.hasAttribute("title")).toBe(false);
    });

    it("wires aria-describedby on focus of the browse button", () => {
      renderInput();
      const browse = btn("field-keyPath-key-path-browse") as HTMLButtonElement;
      act(() => {
        browse.focus();
        browse.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
      });
      expect(browse.getAttribute("aria-describedby")).toBeTruthy();
    });
  });

  describe("SerialPortSettings remove-custom-prefix icon button", () => {
    function renderWithCustomPrefix() {
      act(() => {
        useAppStore.setState({
          settings: {
            ...useAppStore.getState().settings,
            serialPortScanPrefixes: [{ prefix: "ttyXYZ", enabled: true, builtIn: false }],
          },
        });
      });
      renderNode(<SerialPortSettings />);
    }

    function removeButton(): HTMLButtonElement | null {
      // Migrated to the shared Button primitive (issue #1358); locate it by its
      // accessible name rather than the retired bespoke class.
      return container.querySelector<HTMLButtonElement>('[aria-label="Remove custom prefix"]');
    }

    it("gives the remove-prefix button an aria-label and no bare title", () => {
      renderWithCustomPrefix();
      const remove = removeButton();
      expect(remove, "remove-prefix button should render").toBeTruthy();
      expect(remove?.getAttribute("aria-label")).toBe("Remove custom prefix");
      expect(remove?.hasAttribute("title")).toBe(false);
    });

    it("wires aria-describedby on focus of the remove-prefix button", () => {
      renderWithCustomPrefix();
      const remove = removeButton() as HTMLButtonElement;
      act(() => {
        remove.focus();
        remove.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
      });
      expect(remove.getAttribute("aria-describedby")).toBeTruthy();
    });
  });
});
