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

  it("hides all content when fileLanguageMappings not in visibleFields", () => {
    render({ visibleFields: new Set(["someOtherField"]) });
    // The inner content is conditionally rendered based on show()
    expect(query("file-type-pattern-input")).toBeNull();
    expect(query("file-type-add-btn")).toBeNull();
  });
});
