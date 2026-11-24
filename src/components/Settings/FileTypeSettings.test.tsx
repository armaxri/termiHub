import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { currentSettingsView } from "@/store/settingsBridge";
import { TooltipProvider } from "@/components/ui";
import { FileTypeSettings, filterBuiltInRows, mappingLanguageOptions } from "./FileTypeSettings";
import { BUILT_IN_FILENAME_MAPPINGS, BUILT_IN_EXTENSION_MAPPINGS } from "@/utils/languageMapping";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const mockedInvoke = vi.mocked(invoke);

let container: HTMLDivElement;
let root: Root;

async function render(props: { visibleFields?: Set<string> } = {}) {
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <FileTypeSettings {...props} />
      </TooltipProvider>
    );
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

function setInput(testId: string, value: string) {
  const input = query(testId) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function keyDown(testId: string, init: KeyboardEventInit) {
  const input = query(testId) as HTMLInputElement;
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
}

/** Open the language picker and choose `id` from its list (#5841). */
function pickLanguage(id: string) {
  openLanguagePicker();
  const option = document.querySelector<HTMLElement>(
    `[data-testid="file-type-language-option-${id}"]`
  );
  if (!option) throw new Error(`no language option ${id}`);
  act(() => {
    option.click();
  });
}

function openLanguagePicker() {
  keyDown("file-type-language-select", { key: "Enter" });
}

function languageValue(): string | null {
  return query("file-type-language-select")?.getAttribute("data-value") ?? null;
}

/** Unfold the built-in mappings (collapsed by default since #5841). */
function expandBuiltIns() {
  click("file-type-builtin-disclosure");
}

setupSettingsRegion();

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

  it("renders the settings panel", async () => {
    await render();
    expect(query("settings-editor")).not.toBeNull();
  });

  it("shows empty state when no custom mappings are configured", async () => {
    await render();
    expect(container.textContent).toContain("No custom mappings configured.");
  });

  it("shows add inputs and button", async () => {
    await render();
    expect(query("file-type-pattern-input")).not.toBeNull();
    expect(query("file-type-language-select")).not.toBeNull();
    expect(query("file-type-add-btn")).not.toBeNull();
  });

  it("renders the pattern via ui/Input and the language as a select-skinned picker", async () => {
    await render();
    const pattern = query("file-type-pattern-input") as HTMLInputElement;
    const language = query("file-type-language-select") as HTMLButtonElement;
    expect(pattern.tagName).toBe("INPUT");
    expect(pattern.classList.contains("ui-input")).toBe(true);
    expect(pattern.classList.contains("settings-panel__create-input")).toBe(true);
    // No free-text language field any more (#5841).
    expect(language.tagName).toBe("BUTTON");
    expect(language.classList.contains("ui-select__trigger")).toBe(true);
    expect(query("file-type-language-input")).toBeNull();
    expect(container.querySelector("datalist")).toBeNull();
  });

  it("add button is disabled when inputs are empty", async () => {
    await render();
    const btn = query("file-type-add-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("displays existing custom mappings from settings", async () => {
    seedSettings({ fileLanguageMappings: { Jenkinsfile: "groovy", ".conf": "nginx" } });
    await render();

    expect(container.textContent).toContain("Jenkinsfile");
    expect(container.textContent).toContain("groovy");
    expect(container.textContent).toContain(".conf");
    expect(container.textContent).toContain("nginx");
  });

  it("shows remove button for each custom mapping", async () => {
    seedSettings({ fileLanguageMappings: { Jenkinsfile: "groovy" } });
    await render();

    expect(query("file-type-remove-Jenkinsfile")).not.toBeNull();
  });

  it("renders remove buttons as shared ghost Button primitives (not the bespoke shell)", async () => {
    seedSettings({ fileLanguageMappings: { Jenkinsfile: "groovy" } });
    await render();

    const btn = query("file-type-remove-Jenkinsfile") as HTMLButtonElement;
    expect(btn.classList.contains("ui-btn")).toBe(true);
    expect(btn.classList.contains("ui-btn--ghost")).toBe(true);
    expect(btn.classList.contains("settings-panel__file-remove")).toBe(false);
  });

  it("renders built-in copy buttons as shared ghost Button primitives (not the bespoke shell)", async () => {
    await render();
    expandBuiltIns();

    const btn = query("file-type-copy-Dockerfile") as HTMLButtonElement;
    expect(btn.classList.contains("ui-btn")).toBe(true);
    expect(btn.classList.contains("ui-btn--ghost")).toBe(true);
    expect(btn.classList.contains("settings-panel__file-remove")).toBe(false);
  });

  it("removes a custom mapping when trash button is clicked", async () => {
    seedSettings({ fileLanguageMappings: { Jenkinsfile: "groovy" } });
    await render();

    click("file-type-remove-Jenkinsfile");
    await act(async () => {});
    await render();

    const settings = currentSettingsView();
    expect(settings.fileLanguageMappings).toBeUndefined();
    // The remove button for Jenkinsfile should be gone (no custom mapping)
    expect(query("file-type-remove-Jenkinsfile")).toBeNull();
  });

  it("shows Reset all button when custom mappings exist", async () => {
    seedSettings({ fileLanguageMappings: { Jenkinsfile: "groovy" } });
    await render();

    const resetBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Reset all")
    );
    expect(resetBtn).not.toBeUndefined();
  });

  it("reset all asks first, with a summary, and removes all custom mappings on confirm (#5375)", async () => {
    seedSettings({ fileLanguageMappings: { Jenkinsfile: "groovy", ".conf": "nginx" } });
    await render();

    click("file-type-reset-all");
    // Nothing changes until the user confirms.
    expect(currentSettingsView().fileLanguageMappings).toEqual({
      Jenkinsfile: "groovy",
      ".conf": "nginx",
    });
    expect(
      document.querySelector('[data-testid="confirm-file-type-reset-dialog"]')?.textContent
    ).toContain("2 custom mappings will be removed.");

    act(() => {
      document
        .querySelector<HTMLElement>('[data-testid="confirm-file-type-reset-confirm"]')!
        .click();
    });
    await act(async () => {});
    await render();

    const settings = currentSettingsView();
    expect(settings.fileLanguageMappings).toBeUndefined();
  });

  it("cancelling reset all keeps every custom mapping (#5375)", async () => {
    seedSettings({ fileLanguageMappings: { Jenkinsfile: "groovy" } });
    await render();

    click("file-type-reset-all");
    act(() => {
      document
        .querySelector<HTMLElement>('[data-testid="confirm-file-type-reset-cancel"]')!
        .click();
    });
    await act(async () => {});

    expect(currentSettingsView().fileLanguageMappings).toEqual({ Jenkinsfile: "groovy" });
    expect(document.querySelector('[data-testid="confirm-file-type-reset-dialog"]')).toBeNull();
    expect(query("file-type-remove-Jenkinsfile")).not.toBeNull();
  });

  it("shows the built-in mappings section", async () => {
    await render();
    expandBuiltIns();
    expect(container.textContent).toContain("Built-in mappings");
    expect(container.textContent).toContain("Dockerfile");
    expect(container.textContent).toContain("dockerfile");
  });

  it("built-in defaults are sorted alphabetically (leading dot ignored)", async () => {
    await render();
    expandBuiltIns();
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

  it("built-in defaults show .gitignore with correct leading dot", async () => {
    await render();
    expandBuiltIns();
    expect(container.textContent).toContain(".gitignore");
  });

  it("built-in defaults show CMakeLists.txt mapped to cmake", async () => {
    await render();
    expandBuiltIns();
    const text = container.textContent ?? "";
    const cmakeIdx = text.indexOf("CMakeLists.txt");
    expect(cmakeIdx).toBeGreaterThan(-1);
    // "cmake" should appear after CMakeLists.txt in the rendered output
    expect(text.slice(cmakeIdx).indexOf("cmake")).toBeGreaterThan(-1);
  });

  it("the language picker lists the editor's languages", async () => {
    await render();
    openLanguagePicker();
    const options = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="file-type-language-option-"]')
    ).map((o) => o.getAttribute("data-testid")!.replace("file-type-language-option-", ""));
    expect(options).toContain("javascript");
    expect(options).toContain("dockerfile");
    expect(options).toContain("cmake");
  });

  it("built-in rows have a copy button", async () => {
    await render();
    expandBuiltIns();
    expect(query("file-type-copy-Dockerfile")).not.toBeNull();
    expect(query("file-type-copy-.gitignore")).not.toBeNull();
  });

  it("clicking a built-in copy button pre-fills the add form", async () => {
    await render();
    expandBuiltIns();
    click("file-type-copy-Dockerfile");
    const patternInput = query("file-type-pattern-input") as HTMLInputElement;
    expect(patternInput.value).toBe("Dockerfile");
    expect(languageValue()).toBe("dockerfile");
  });

  it("shows overridden badge on a built-in row when it has a custom mapping", async () => {
    seedSettings({ fileLanguageMappings: { Dockerfile: "groovy" } });
    await render();
    expandBuiltIns();
    expect(query("file-type-overridden-badge-Dockerfile")).not.toBeNull();
    // A non-overridden row should not have the badge
    expect(query("file-type-overridden-badge-Makefile")).toBeNull();
  });

  it("shows a custom mapping's language as secondary text, not disabled grey (#5722)", async () => {
    seedSettings({ fileLanguageMappings: { "main.tf": "hcl" } });
    await render();
    const row = query("file-type-custom-row-main.tf");
    const language = query("file-type-custom-language-main.tf");
    expect(row?.contains(language)).toBe(true);
    expect(language?.textContent).toBe("→ hcl");
    expect(language?.className).toContain("file-type-settings__custom-language");
    expect(language?.className).not.toContain("--disabled");
  });

  describe("built-in defaults table (#5713)", () => {
    const builtInCount =
      Object.keys(BUILT_IN_FILENAME_MAPPINGS).length +
      Object.keys(BUILT_IN_EXTENSION_MAPPINGS).length;

    it("renders the built-in defaults as a table with Pattern and Language columns", async () => {
      await render();
      expandBuiltIns();
      const table = query("file-type-builtin-table");
      expect(table?.tagName).toBe("TABLE");
      const headers = Array.from(table!.querySelectorAll("thead th")).map((th) =>
        th.textContent?.trim()
      );
      expect(headers.slice(0, 2)).toEqual(["Pattern", "Language"]);
      expect(headers).toHaveLength(3);
      // The action column header has an accessible name even though it is visually hidden.
      expect(headers[2]).toBe("Actions");
    });

    it("renders one row per built-in mapping, each with pattern, language and action cells", async () => {
      await render();
      expandBuiltIns();
      const rows = container.querySelectorAll('[data-testid="file-type-builtin-table"] tbody tr');
      expect(rows).toHaveLength(builtInCount);
      for (const row of Array.from(rows)) {
        expect(row.querySelectorAll("td")).toHaveLength(3);
      }
      expect(query("file-type-builtin-row-Dockerfile")?.tagName).toBe("TR");
    });

    it("shows the mapped language as plain readable text, not disabled grey", async () => {
      await render();
      expandBuiltIns();
      const pattern = query("file-type-builtin-pattern-.babelrc");
      const language = query("file-type-builtin-language-.babelrc");
      expect(pattern?.textContent).toBe(".babelrc");
      expect(language?.textContent).toBe("json");
      expect(language?.className).toContain("file-type-settings__language");
      expect(language?.className).not.toContain("--disabled");
    });

    it("marks an overridden built-in row and keeps its badge inside the table", async () => {
      seedSettings({ fileLanguageMappings: { Dockerfile: "groovy" } });
      await render();
      expandBuiltIns();
      const row = query("file-type-builtin-row-Dockerfile");
      expect(row?.getAttribute("data-overridden")).toBe("true");
      expect(row?.contains(query("file-type-overridden-badge-Dockerfile"))).toBe(true);
      expect(query("file-type-builtin-row-Makefile")?.hasAttribute("data-overridden")).toBe(false);
    });

    it("keeps the copy action inside its row", async () => {
      await render();
      expandBuiltIns();
      const row = query("file-type-builtin-row-Dockerfile");
      expect(row?.contains(query("file-type-copy-Dockerfile"))).toBe(true);
    });
  });

  it("hides all content when fileLanguageMappings not in visibleFields", async () => {
    await render({ visibleFields: new Set(["someOtherField"]) });
    // The inner content is conditionally rendered based on show()
    expect(query("file-type-pattern-input")).toBeNull();
    expect(query("file-type-add-btn")).toBeNull();
  });

  describe("adding a mapping (#5304)", () => {
    it("rejects an empty language on Enter with its message and persists nothing", async () => {
      const updateSpy = vi.fn(useAppStore.getState().updateSettings);
      useAppStore.setState({ updateSettings: updateSpy });
      await render();

      setInput("file-type-pattern-input", "Jenkinsfile");
      keyDown("file-type-pattern-input", { key: "Enter" });

      expect(query("file-type-add-error")?.textContent).toBe("Choose a language.");
      expect(updateSpy).not.toHaveBeenCalled();
      expect((query("file-type-add-btn") as HTMLButtonElement).disabled).toBe(true);
    });

    it("rejects an empty pattern on Enter with its message", async () => {
      const updateSpy = vi.fn(useAppStore.getState().updateSettings);
      useAppStore.setState({ updateSettings: updateSpy });
      await render();

      pickLanguage("java");
      keyDown("file-type-pattern-input", { key: "Enter" });

      expect(query("file-type-add-error")?.textContent).toBe("Pattern is required.");
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it("rejects a pattern with invalid characters with its message", async () => {
      const updateSpy = vi.fn(useAppStore.getState().updateSettings);
      useAppStore.setState({ updateSettings: updateSpy });
      await render();

      setInput("file-type-pattern-input", "foo bar/*");
      pickLanguage("java");
      click("file-type-add-btn");

      expect(query("file-type-add-error")?.textContent).toBe(
        "Pattern may only contain letters, digits, dots, dashes, underscores, and +."
      );
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it("clears the validation error as soon as the user edits an input", async () => {
      await render();
      setInput("file-type-pattern-input", "bad pattern");
      pickLanguage("java");
      click("file-type-add-btn");
      expect(query("file-type-add-error")).not.toBeNull();

      setInput("file-type-pattern-input", "Jenkinsfile");
      expect(query("file-type-add-error")).toBeNull();
    });

    it("a valid add calls updateSettings, persists the mapping and resets the form", async () => {
      seedSettings({ fileLanguageMappings: { ".conf": "nginx" } });
      const realUpdate = useAppStore.getState().updateSettings;
      const updateSpy = vi.fn(realUpdate);
      useAppStore.setState({ updateSettings: updateSpy });
      await render();

      setInput("file-type-pattern-input", "  Jenkinsfile ");
      pickLanguage("java");
      click("file-type-add-btn");
      await act(async () => {});
      await render();

      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(updateSpy.mock.calls[0][0].fileLanguageMappings).toEqual({
        ".conf": "nginx",
        Jenkinsfile: "java",
      });
      expect(currentSettingsView().fileLanguageMappings).toEqual({
        ".conf": "nginx",
        Jenkinsfile: "java",
      });
      expect(query("file-type-remove-Jenkinsfile")).not.toBeNull();
      expect((query("file-type-pattern-input") as HTMLInputElement).value).toBe("");
      expect(languageValue()).toBe("");
      expect(query("file-type-add-error")).toBeNull();
    });

    it("Enter on the pattern input submits a valid mapping", async () => {
      await render();
      setInput("file-type-pattern-input", ".tf");
      pickLanguage("hcl");
      keyDown("file-type-pattern-input", { key: "Enter" });
      await act(async () => {});
      await render();

      expect(currentSettingsView().fileLanguageMappings).toEqual({ ".tf": "hcl" });
    });

    it("re-adding an existing pattern replaces its language instead of duplicating the row", async () => {
      seedSettings({ fileLanguageMappings: { Jenkinsfile: "groovy" } });
      await render();

      setInput("file-type-pattern-input", "Jenkinsfile");
      pickLanguage("shell");
      click("file-type-add-btn");
      await act(async () => {});
      await render();

      expect(currentSettingsView().fileLanguageMappings).toEqual({ Jenkinsfile: "shell" });
      expect(
        container.querySelectorAll('[data-testid="file-type-remove-Jenkinsfile"]')
      ).toHaveLength(1);
    });

    it.each([
      ["isComposing", { key: "Enter", isComposing: true }],
      ["keyCode 229", { key: "Enter", keyCode: 229 }],
    ])("ignores Enter during IME composition (%s) on the pattern input", async (_label, init) => {
      const updateSpy = vi.fn(useAppStore.getState().updateSettings);
      useAppStore.setState({ updateSettings: updateSpy });
      await render();

      setInput("file-type-pattern-input", "Jenkinsfile");
      pickLanguage("java");
      keyDown("file-type-pattern-input", init);

      expect(updateSpy).not.toHaveBeenCalled();
      // The form keeps the half-typed values; nothing was submitted or cleared.
      expect((query("file-type-pattern-input") as HTMLInputElement).value).toBe("Jenkinsfile");
      expect(languageValue()).toBe("java");
      expect(query("file-type-add-error")).toBeNull();
    });

    it("ignores non-Enter keys", async () => {
      const updateSpy = vi.fn(useAppStore.getState().updateSettings);
      useAppStore.setState({ updateSettings: updateSpy });
      await render();
      setInput("file-type-pattern-input", "Jenkinsfile");
      pickLanguage("java");
      keyDown("file-type-pattern-input", { key: "a" });
      expect(updateSpy).not.toHaveBeenCalled();
    });
  });
  describe("built-in mappings disclosure (#5841)", () => {
    const builtInCount =
      Object.keys(BUILT_IN_FILENAME_MAPPINGS).length +
      Object.keys(BUILT_IN_EXTENSION_MAPPINGS).length;

    it("keeps the built-in table folded away behind a counted disclosure", async () => {
      await render();
      const disclosure = query("file-type-builtin-disclosure") as HTMLButtonElement;
      expect(disclosure.getAttribute("aria-expanded")).toBe("false");
      expect(disclosure.textContent).toBe(`Show built-in mappings (${builtInCount})`);
      expect(query("file-type-builtin-table")).toBeNull();
      expect(query("file-type-builtin-filter")).toBeNull();
    });

    it("puts the user's mappings above the built-in section", async () => {
      seedSettings({ fileLanguageMappings: { Jenkinsfile: "java" } });
      await render();
      const custom = query("file-type-custom-row-Jenkinsfile")!;
      const builtIn = query("file-type-builtin-section")!;
      expect(custom.compareDocumentPosition(builtIn) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      );
    });

    it("expands to the table and a filter, and folds back", async () => {
      await render();
      expandBuiltIns();
      const disclosure = query("file-type-builtin-disclosure") as HTMLButtonElement;
      expect(disclosure.getAttribute("aria-expanded")).toBe("true");
      expect(disclosure.textContent).toBe("Hide built-in mappings");
      const controls = disclosure.getAttribute("aria-controls")!;
      expect(document.getElementById(controls)?.contains(query("file-type-builtin-table"))).toBe(
        true
      );
      expect(query("file-type-builtin-filter")).not.toBeNull();

      expandBuiltIns();
      expect(query("file-type-builtin-table")).toBeNull();
    });

    it("filters rows by pattern", async () => {
      await render();
      expandBuiltIns();
      setInput("file-type-builtin-filter", "docker");
      const rows = Array.from(
        container.querySelectorAll('[data-testid="file-type-builtin-table"] tbody tr')
      ).map((r) => r.getAttribute("data-testid"));
      expect(rows).toContain("file-type-builtin-row-Dockerfile");
      expect(rows).toContain("file-type-builtin-row-.dockerignore");
      expect(rows).not.toContain("file-type-builtin-row-Makefile");
    });

    it("filters rows by language", async () => {
      await render();
      expandBuiltIns();
      setInput("file-type-builtin-filter", "cmake");
      expect(query("file-type-builtin-row-CMakeLists.txt")).not.toBeNull();
      expect(query("file-type-builtin-row-.cmake")).not.toBeNull();
      expect(query("file-type-builtin-row-Dockerfile")).toBeNull();
    });

    it("shows a no-match state for a filter that matches nothing", async () => {
      await render();
      expandBuiltIns();
      setInput("file-type-builtin-filter", "zzz-nothing");
      expect(query("file-type-builtin-table")).toBeNull();
      expect(query("file-type-builtin-no-match")?.textContent).toContain(
        "No built-in mapping matches this filter."
      );
    });
  });

  describe("language picker (#5841)", () => {
    it("shows a placeholder until a language is chosen, then its name", async () => {
      await render();
      const trigger = query("file-type-language-select")!;
      expect(trigger.textContent).toBe("Language");
      expect(trigger.hasAttribute("data-placeholder")).toBe(true);
      pickLanguage("javascript");
      expect(languageValue()).toBe("javascript");
      expect(trigger.textContent).toBe("JavaScript");
      expect(trigger.hasAttribute("data-placeholder")).toBe(false);
    });

    it("narrows the list as the user types in its search box", async () => {
      await render();
      openLanguagePicker();
      const search = document.querySelector<HTMLInputElement>(
        '[data-testid="file-type-language-search"]'
      )!;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      act(() => {
        setter.call(search, "dockerf");
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const options = document.querySelectorAll('[data-testid^="file-type-language-option-"]');
      expect(Array.from(options).map((o) => o.getAttribute("data-testid"))).toEqual([
        "file-type-language-option-dockerfile",
      ]);

      act(() => {
        search.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
        );
      });
      expect(languageValue()).toBe("dockerfile");
    });

    it("offers every language a built-in mapping uses", async () => {
      await render();
      openLanguagePicker();
      for (const language of new Set(Object.values(BUILT_IN_EXTENSION_MAPPINGS))) {
        expect(
          document.querySelector(`[data-testid="file-type-language-option-${language}"]`),
          language
        ).not.toBeNull();
      }
    });

    it("flags a stored mapping whose language the editor does not know", async () => {
      seedSettings({ fileLanguageMappings: { Jenkinsfile: "groovvy", ".tf": "hcl" } });
      await render();
      expect(query("file-type-unknown-language-Jenkinsfile")?.textContent).toBe("unknown language");
      expect(query("file-type-unknown-language-.tf")).toBeNull();
    });

    it("says 'language', not 'Monaco language ID'", async () => {
      await render();
      expect(container.textContent).not.toMatch(/monaco/i);
      expect(container.textContent).not.toMatch(/language id/i);
    });
  });
});

describe("filterBuiltInRows", () => {
  const rows = [
    { pattern: "Dockerfile", language: "dockerfile", kind: "filename" as const },
    { pattern: ".zsh", language: "shell", kind: "extension" as const },
  ];

  it("keeps every row for an empty query", () => {
    expect(filterBuiltInRows(rows, "  ")).toEqual(rows);
  });

  it("matches the pattern or the language, ignoring case", () => {
    expect(filterBuiltInRows(rows, "DOCKER").map((r) => r.pattern)).toEqual(["Dockerfile"]);
    expect(filterBuiltInRows(rows, "shell").map((r) => r.pattern)).toEqual([".zsh"]);
  });
});

describe("mappingLanguageOptions", () => {
  it("adds built-in languages the editor has not registered, sorted by name", () => {
    const options = mappingLanguageOptions([{ id: "javascript", name: "JavaScript" }]);
    const ids = options.map((o) => o.id);
    expect(ids).toContain("javascript");
    expect(ids).toContain("dockerfile");
    expect(new Set(ids).size).toBe(ids.length);
    const names = options.map((o) => o.name);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });
});
