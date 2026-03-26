import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { FileTypeSettings } from "./FileTypeSettings";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const mockedInvoke = vi.mocked(invoke);

let container: HTMLDivElement;
let root: Root;

function render(props: { visibleFields?: Set<string> } = {}) {
  act(() => {
    root.render(<FileTypeSettings {...props} />);
  });
}

function query(testId: string): Element | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function click(testId: string) {
  act(() => {
    (container.querySelector(`[data-testid="${testId}"]`) as HTMLElement).click();
  });
}

describe("FileTypeSettings", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());

    mockedInvoke.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders the settings panel", () => {
    render();
    expect(query("settings-editor")).not.toBeNull();
  });

  it("shows empty state when no custom mappings are configured", () => {
    render();
    expect(container.textContent).toContain("No custom mappings configured.");
  });

  it("shows add inputs and button", () => {
    render();
    expect(query("file-type-pattern-input")).not.toBeNull();
    expect(query("file-type-language-input")).not.toBeNull();
    expect(query("file-type-add-btn")).not.toBeNull();
  });

  it("add button is disabled when inputs are empty", () => {
    render();
    const btn = query("file-type-add-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("displays existing custom mappings from settings", () => {
    act(() => {
      useAppStore.setState({
        settings: {
          ...useAppStore.getState().settings,
          fileLanguageMappings: { Jenkinsfile: "groovy", ".conf": "nginx" },
        },
      });
    });
    render();

    expect(container.textContent).toContain("Jenkinsfile");
    expect(container.textContent).toContain("groovy");
    expect(container.textContent).toContain(".conf");
    expect(container.textContent).toContain("nginx");
  });

  it("shows remove button for each custom mapping", () => {
    act(() => {
      useAppStore.setState({
        settings: {
          ...useAppStore.getState().settings,
          fileLanguageMappings: { Jenkinsfile: "groovy" },
        },
      });
    });
    render();

    expect(query("file-type-remove-Jenkinsfile")).not.toBeNull();
  });

  it("removes a custom mapping when trash button is clicked", async () => {
    act(() => {
      useAppStore.setState({
        settings: {
          ...useAppStore.getState().settings,
          fileLanguageMappings: { Jenkinsfile: "groovy" },
        },
      });
    });
    render();

    click("file-type-remove-Jenkinsfile");
    await act(async () => {});
    render();

    const settings = useAppStore.getState().settings;
    expect(settings.fileLanguageMappings).toBeUndefined();
    // The remove button for Jenkinsfile should be gone (no custom mapping)
    expect(query("file-type-remove-Jenkinsfile")).toBeNull();
  });

  it("shows Reset All button when custom mappings exist", () => {
    act(() => {
      useAppStore.setState({
        settings: {
          ...useAppStore.getState().settings,
          fileLanguageMappings: { Jenkinsfile: "groovy" },
        },
      });
    });
    render();

    const resetBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Reset All")
    );
    expect(resetBtn).not.toBeUndefined();
  });

  it("reset all button removes all custom mappings", async () => {
    act(() => {
      useAppStore.setState({
        settings: {
          ...useAppStore.getState().settings,
          fileLanguageMappings: { Jenkinsfile: "groovy", ".conf": "nginx" },
        },
      });
    });
    render();

    const resetBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Reset All")
    ) as HTMLButtonElement;
    act(() => {
      resetBtn.click();
    });
    await act(async () => {});
    render();

    const settings = useAppStore.getState().settings;
    expect(settings.fileLanguageMappings).toBeUndefined();
  });

  it("shows the built-in defaults reference section", () => {
    render();
    expect(container.textContent).toContain("Built-in Defaults");
    expect(container.textContent).toContain("Dockerfile");
    expect(container.textContent).toContain("dockerfile");
  });

  it("built-in defaults are sorted alphabetically (leading dot ignored)", () => {
    render();
    const items = Array.from(
      container.querySelectorAll(
        ".settings-panel__file-list li .settings-panel__file-path:first-child"
      )
    ).map((el) => el.textContent ?? "");
    // Find a window of adjacent items and verify ordering
    const builtInItems = items.filter((t) => t.length > 0);
    for (let i = 1; i < builtInItems.length; i++) {
      const a = builtInItems[i - 1].replace(/^\./, "").toLowerCase();
      const b = builtInItems[i].replace(/^\./, "").toLowerCase();
      expect(a.localeCompare(b)).toBeLessThanOrEqual(0);
    }
  });

  it("built-in defaults show .gitignore with correct leading dot", () => {
    render();
    expect(container.textContent).toContain(".gitignore");
  });

  it("built-in defaults show CMakeLists.txt mapped to cmake", () => {
    render();
    const text = container.textContent ?? "";
    const cmakeIdx = text.indexOf("CMakeLists.txt");
    expect(cmakeIdx).toBeGreaterThan(-1);
    // "cmake" should appear after CMakeLists.txt in the rendered output
    expect(text.slice(cmakeIdx).indexOf("cmake")).toBeGreaterThan(-1);
  });

  it("language input has a datalist with Monaco language IDs", () => {
    render();
    const input = query("file-type-language-input") as HTMLInputElement;
    expect(input.getAttribute("list")).toBe("file-type-language-list");
    const datalist = container.querySelector("#file-type-language-list");
    expect(datalist).not.toBeNull();
    const options = Array.from(datalist!.querySelectorAll("option")).map((o) => o.value);
    expect(options).toContain("javascript");
    expect(options).toContain("dockerfile");
    expect(options).toContain("cmake");
  });

  it("built-in rows have a copy button", () => {
    render();
    expect(query("file-type-copy-Dockerfile")).not.toBeNull();
    expect(query("file-type-copy-.gitignore")).not.toBeNull();
  });

  it("clicking a built-in copy button pre-fills the add form", () => {
    render();
    click("file-type-copy-Dockerfile");
    const patternInput = query("file-type-pattern-input") as HTMLInputElement;
    const languageInput = query("file-type-language-input") as HTMLInputElement;
    expect(patternInput.value).toBe("Dockerfile");
    expect(languageInput.value).toBe("dockerfile");
  });

  it("shows overridden badge on a built-in row when it has a custom mapping", () => {
    act(() => {
      useAppStore.setState({
        settings: {
          ...useAppStore.getState().settings,
          fileLanguageMappings: { Dockerfile: "groovy" },
        },
      });
    });
    render();
    expect(query("file-type-overridden-badge-Dockerfile")).not.toBeNull();
    // A non-overridden row should not have the badge
    expect(query("file-type-overridden-badge-Makefile")).toBeNull();
  });

  it("hides all content when fileLanguageMappings not in visibleFields", () => {
    render({ visibleFields: new Set(["someOtherField"]) });
    // The inner content is conditionally rendered based on show()
    expect(query("file-type-pattern-input")).toBeNull();
    expect(query("file-type-add-btn")).toBeNull();
  });
});
