import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useAppStore } from "@/store/appStore";
import { CustomGrammarsSettings } from "./CustomGrammarsSettings";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/utils/monacoCustomLanguages", () => ({
  registerCustomMonacoLanguages: vi.fn().mockResolvedValue(undefined),
  registerCustomGrammars: vi.fn().mockResolvedValue(undefined),
}));

const mockedOpen = vi.mocked(open);
const mockedReadTextFile = vi.mocked(readTextFile);

const VALID_GRAMMAR = JSON.stringify({
  name: "My Language",
  scopeName: "source.my-language",
  patterns: [],
});

let container: HTMLDivElement;
let root: Root;

function render(props: { visibleFields?: Set<string> } = {}) {
  act(() => {
    root.render(<CustomGrammarsSettings {...props} />);
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

describe("CustomGrammarsSettings", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    mockedOpen.mockReset();
    mockedReadTextFile.mockReset();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders the settings panel", () => {
    render();
    expect(query("custom-grammars-settings")).not.toBeNull();
  });

  it("shows empty state when no grammars are imported", () => {
    render();
    expect(container.textContent).toContain("No custom grammars imported.");
  });

  it("shows import button", () => {
    render();
    expect(query("custom-grammar-import-btn")).not.toBeNull();
  });

  it("shows draft form after selecting a valid grammar file", async () => {
    mockedOpen.mockResolvedValue("/path/to/my-lang.tmLanguage.json");
    mockedReadTextFile.mockResolvedValue(VALID_GRAMMAR);

    render();
    click("custom-grammar-import-btn");
    await act(async () => {});
    render();

    expect(query("custom-grammar-draft")).not.toBeNull();
    expect((query("custom-grammar-id-input") as HTMLInputElement).value).toBe("my-language");
    expect((query("custom-grammar-name-input") as HTMLInputElement).value).toBe("My Language");
  });

  it("shows error for invalid JSON file", async () => {
    mockedOpen.mockResolvedValue("/path/to/bad.json");
    mockedReadTextFile.mockResolvedValue("not json {{{");

    render();
    click("custom-grammar-import-btn");
    await act(async () => {});
    render();

    expect(query("custom-grammar-import-error")).not.toBeNull();
    expect(container.textContent).toContain("not valid JSON");
  });

  it("shows error when scopeName is missing", async () => {
    mockedOpen.mockResolvedValue("/path/to/bad.json");
    mockedReadTextFile.mockResolvedValue(JSON.stringify({ name: "Bad", patterns: [] }));

    render();
    click("custom-grammar-import-btn");
    await act(async () => {});
    render();

    expect(query("custom-grammar-import-error")).not.toBeNull();
    expect(container.textContent).toContain("scopeName");
  });

  it("saves grammar on confirm and calls registerCustomGrammars", async () => {
    const { registerCustomGrammars } = await import("@/utils/monacoCustomLanguages");
    mockedOpen.mockResolvedValue("/path/to/my-lang.tmLanguage.json");
    mockedReadTextFile.mockResolvedValue(VALID_GRAMMAR);

    render();
    click("custom-grammar-import-btn");
    await act(async () => {});
    render();

    click("custom-grammar-confirm-btn");
    await act(async () => {});
    render();

    const settings = useAppStore.getState().settings;
    expect(settings.customLanguageGrammars).toHaveLength(1);
    expect(settings.customLanguageGrammars![0].id).toBe("my-language");
    expect(settings.customLanguageGrammars![0].name).toBe("My Language");
    expect(registerCustomGrammars).toHaveBeenCalledWith([
      expect.objectContaining({ id: "my-language" }),
    ]);
  });

  it("cancels import without saving", async () => {
    mockedOpen.mockResolvedValue("/path/to/my-lang.tmLanguage.json");
    mockedReadTextFile.mockResolvedValue(VALID_GRAMMAR);

    render();
    click("custom-grammar-import-btn");
    await act(async () => {});
    render();

    click("custom-grammar-cancel-btn");
    render();

    expect(query("custom-grammar-draft")).toBeNull();
    const settings = useAppStore.getState().settings;
    expect(settings.customLanguageGrammars ?? []).toHaveLength(0);
  });

  it("shows existing grammars with remove button", () => {
    act(() => {
      useAppStore.setState({
        settings: {
          ...useAppStore.getState().settings,
          customLanguageGrammars: [
            { id: "my-lang", name: "My Lang", grammar: { scopeName: "source.my" } },
          ],
        },
      });
    });
    render();

    expect(container.textContent).toContain("my-lang");
    expect(container.textContent).toContain("My Lang");
    expect(query("custom-grammar-remove-my-lang")).not.toBeNull();
  });

  it("removes a grammar when trash button is clicked", async () => {
    act(() => {
      useAppStore.setState({
        settings: {
          ...useAppStore.getState().settings,
          customLanguageGrammars: [
            { id: "my-lang", name: "My Lang", grammar: { scopeName: "source.my" } },
          ],
        },
      });
    });
    render();

    click("custom-grammar-remove-my-lang");
    await act(async () => {});
    render();

    const settings = useAppStore.getState().settings;
    expect(settings.customLanguageGrammars ?? []).toHaveLength(0);
    expect(container.textContent).toContain("No custom grammars imported.");
  });

  it("hides content when customLanguageGrammars not in visibleFields", () => {
    render({ visibleFields: new Set(["someOtherField"]) });
    expect(container.textContent).not.toContain("Custom Language Grammars");
  });

  it("shows content when customLanguageGrammars is in visibleFields", () => {
    render({ visibleFields: new Set(["customLanguageGrammars"]) });
    expect(container.textContent).toContain("Custom Language Grammars");
  });

  it("does not open dialog when import is cancelled", async () => {
    mockedOpen.mockResolvedValue(null);

    render();
    click("custom-grammar-import-btn");
    await act(async () => {});
    render();

    expect(query("custom-grammar-draft")).toBeNull();
    expect(mockedReadTextFile).not.toHaveBeenCalled();
  });
});
