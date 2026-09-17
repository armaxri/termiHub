import { describe, it, expect, beforeEach, vi } from "vitest";

// This suite drives the real registration logic in `monacoCustomLanguages.ts`
// against LOCAL recording stubs for `monaco-editor`, `shiki`, and
// `@shikijs/monaco`. The global `src/test/setup.ts` mocks would let the module
// import, but they discard the calls; here we record every `register` /
// `setLanguageConfiguration` / `setTheme` / `loadLanguage` / `shikiToMonaco`
// call so the tokenizer/language-registration branches (otherwise ~2% covered)
// actually execute and can be asserted (audit finding TFE-009).

const rec = vi.hoisted(() => ({
  registeredLanguages: [] as {
    id: string;
    aliases?: string[];
    extensions?: string[];
    filenames?: string[];
  }[],
  languageConfigs: {} as Record<string, unknown>,
  setThemeCalls: [] as string[],
  shikiToMonacoCalls: 0,
  createdHighlighters: [] as {
    opts: { themes: string[]; langs: string[] };
    loadLanguage: ReturnType<typeof vi.fn>;
    getLoadedLanguages: ReturnType<typeof vi.fn>;
  }[],
  loadedNames: [] as string[],
}));

vi.mock("monaco-editor", () => ({
  editor: {
    setTheme: vi.fn((theme: string) => {
      rec.setThemeCalls.push(theme);
    }),
  },
  languages: {
    register: vi.fn((def: { id: string }) => {
      rec.registeredLanguages.push(def);
    }),
    setLanguageConfiguration: vi.fn((id: string, cfg: unknown) => {
      rec.languageConfigs[id] = cfg;
    }),
    // Reflect what has been registered so the module's "already registered?"
    // guard behaves like the real Monaco.
    getLanguages: vi.fn(() => rec.registeredLanguages.map((l) => ({ id: l.id }))),
  },
}));

vi.mock("shiki", () => ({
  createHighlighter: vi.fn(async (opts: { themes: string[]; langs: string[] }) => {
    const hl = {
      opts,
      loadLanguage: vi.fn(async () => {}),
      getLoadedLanguages: vi.fn(() => rec.loadedNames),
    };
    rec.createdHighlighters.push(hl);
    return hl;
  }),
  bundledLanguages: {
    svelte: vi.fn(),
    astro: vi.fn(),
    zig: vi.fn(),
  },
  bundledLanguagesInfo: [
    { id: "svelte", name: "Svelte", aliases: ["svelte"] },
    { id: "astro", name: "Astro" },
    // note: "zig" deliberately omitted so the "no info → alias [id]" branch runs.
  ],
}));

vi.mock("@shikijs/monaco", () => ({
  shikiToMonaco: vi.fn(() => {
    rec.shikiToMonacoCalls += 1;
  }),
}));

function findLang(id: string) {
  return rec.registeredLanguages.find((l) => l.id === id);
}

/** Re-import the module fresh so its memoised init/highlighter state is reset. */
async function freshModule() {
  vi.resetModules();
  rec.registeredLanguages.length = 0;
  for (const k of Object.keys(rec.languageConfigs)) delete rec.languageConfigs[k];
  rec.setThemeCalls.length = 0;
  rec.shikiToMonacoCalls = 0;
  rec.createdHighlighters.length = 0;
  rec.loadedNames.length = 0;
  return import("./monacoCustomLanguages");
}

describe("getMonacoTheme", () => {
  it("maps the light app theme to the light Shiki theme", async () => {
    const { getMonacoTheme, MONACO_LIGHT_THEME } = await freshModule();
    expect(getMonacoTheme("light")).toBe(MONACO_LIGHT_THEME);
  });

  it("maps the dark app theme to the dark Shiki theme", async () => {
    const { getMonacoTheme, MONACO_DARK_THEME } = await freshModule();
    expect(getMonacoTheme("dark")).toBe(MONACO_DARK_THEME);
  });

  it("falls back to the dark theme for an unknown app theme id", async () => {
    const { getMonacoTheme, MONACO_DARK_THEME } = await freshModule();
    expect(getMonacoTheme("neon")).toBe(MONACO_DARK_THEME);
  });
});

describe("registerCustomMonacoLanguages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the four built-in languages with their editor configurations", async () => {
    const { registerCustomMonacoLanguages } = await freshModule();
    await registerCustomMonacoLanguages();

    for (const id of ["cmake", "toml", "nginx", "nix"]) {
      expect(findLang(id)).toBeDefined();
      expect(rec.languageConfigs[id]).toBeDefined();
    }

    // cmake registration details.
    expect(findLang("cmake")).toMatchObject({
      id: "cmake",
      aliases: ["CMake", "cmake"],
      extensions: [".cmake"],
      filenames: ["CMakeLists.txt"],
    });
    // nginx is filename-matched (no extension), toml/nix are extension-matched.
    expect(findLang("nginx")).toMatchObject({ filenames: ["nginx.conf"] });
    expect(findLang("toml")).toMatchObject({ extensions: [".toml"] });
    expect(findLang("nix")).toMatchObject({ extensions: [".nix"] });

    // A configuration carries comment + bracket rules.
    expect(rec.languageConfigs.cmake).toMatchObject({ comments: { lineComment: "#" } });
    expect(rec.languageConfigs.nix).toMatchObject({
      comments: { lineComment: "#", blockComment: ["/*", "*/"] },
    });
  });

  it("creates one Shiki highlighter with both themes and the built-in grammar set", async () => {
    const { registerCustomMonacoLanguages, MONACO_DARK_THEME, MONACO_LIGHT_THEME } =
      await freshModule();
    await registerCustomMonacoLanguages();

    expect(rec.createdHighlighters).toHaveLength(1);
    const opts = rec.createdHighlighters[0].opts;
    expect(opts.themes).toEqual([MONACO_DARK_THEME, MONACO_LIGHT_THEME]);
    // nginx depends on lua for embedded Lua blocks — it must be loaded too.
    expect(opts.langs).toEqual(expect.arrayContaining(["cmake", "toml", "nginx", "nix", "lua"]));
  });

  it("wires the Shiki tokenizers into Monaco and applies the current theme", async () => {
    const { registerCustomMonacoLanguages } = await freshModule();
    await registerCustomMonacoLanguages();
    expect(rec.shikiToMonacoCalls).toBeGreaterThanOrEqual(1);
    expect(rec.setThemeCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("is idempotent — repeated calls do not re-register or re-create the highlighter", async () => {
    const { registerCustomMonacoLanguages } = await freshModule();
    const p1 = registerCustomMonacoLanguages();
    const p2 = registerCustomMonacoLanguages();
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);
    expect(rec.createdHighlighters).toHaveLength(1);
    // Exactly one registration of each built-in.
    expect(rec.registeredLanguages.filter((l) => l.id === "cmake")).toHaveLength(1);
  });

  it("exposes the built-in package ids via getLoadedLanguagePackageIds", async () => {
    const { registerCustomMonacoLanguages, getLoadedLanguagePackageIds } = await freshModule();
    await registerCustomMonacoLanguages();
    const ids = getLoadedLanguagePackageIds();
    for (const id of ["cmake", "toml", "nginx", "nix", "lua"]) {
      expect(ids.has(id)).toBe(true);
    }
  });
});

describe("registerAdditionalLanguagePackages", () => {
  it("registers and loads a new bundled language using its package info aliases", async () => {
    const { registerAdditionalLanguagePackages, getLoadedLanguagePackageIds } = await freshModule();
    await registerAdditionalLanguagePackages(["svelte"]);

    const svelte = findLang("svelte");
    expect(svelte).toBeDefined();
    // info present → aliases = [name, ...info.aliases]
    expect(svelte?.aliases).toEqual(["Svelte", "svelte"]);
    expect(getLoadedLanguagePackageIds().has("svelte")).toBe(true);

    // The grammar was loaded into the existing highlighter and re-wired.
    const hl = rec.createdHighlighters[0];
    expect(hl.loadLanguage).toHaveBeenCalled();
  });

  it("falls back to [id] aliases when no package info exists for the language", async () => {
    const { registerAdditionalLanguagePackages } = await freshModule();
    await registerAdditionalLanguagePackages(["zig"]);
    expect(findLang("zig")?.aliases).toEqual(["zig"]);
  });

  it("skips ids that are already loaded or not in the bundle (no new registration)", async () => {
    const { registerCustomMonacoLanguages, registerAdditionalLanguagePackages } =
      await freshModule();
    await registerCustomMonacoLanguages();
    const before = rec.registeredLanguages.length;
    // "cmake" is already loaded (built-in); "does-not-exist" is not in bundledLanguages.
    await registerAdditionalLanguagePackages(["cmake", "does-not-exist"]);
    expect(rec.registeredLanguages.length).toBe(before);
  });
});

describe("registerCustomGrammars", () => {
  const BASE_GRAMMAR = {
    scopeName: "source.mylang",
    patterns: [],
  };

  it("registers a custom grammar, derives extensions, and loads it via Shiki", async () => {
    const { registerCustomGrammars, getLoadedLanguagePackageIds } = await freshModule();
    await registerCustomGrammars([
      {
        id: "mylang",
        name: "My Language",
        grammar: { ...BASE_GRAMMAR, fileTypes: ["ml", ".mli"] },
      },
    ]);

    const lang = findLang("mylang");
    expect(lang).toBeDefined();
    // Extensions: always `.${id}`, plus fileTypes normalised to a leading dot, deduped.
    expect(lang?.extensions).toEqual([".mylang", ".ml", ".mli"]);
    // Monaco is registered with [name, id] aliases.
    expect(lang?.aliases).toEqual(["My Language", "mylang"]);
    expect(getLoadedLanguagePackageIds().has("mylang")).toBe(true);

    // The Shiki registration bridges the id into aliases when id !== name.
    const registration = rec.createdHighlighters[0].loadLanguage.mock.calls[0][0] as {
      name: string;
      aliases: string[];
    };
    expect(registration.name).toBe("My Language");
    expect(registration.aliases).toEqual(["mylang"]);
  });

  it("omits the id alias when id === name and defaults extensions to [.id]", async () => {
    const { registerCustomGrammars } = await freshModule();
    await registerCustomGrammars([
      { id: "s16", name: "s16", grammar: { ...BASE_GRAMMAR } }, // no fileTypes
    ]);
    const lang = findLang("s16");
    expect(lang?.extensions).toEqual([".s16"]);
    // id === name → the Shiki registration carries no bridged id alias.
    const registration = rec.createdHighlighters[0].loadLanguage.mock.calls[0][0] as {
      aliases: string[];
    };
    expect(registration.aliases).toEqual([]);
  });

  it("merges the grammar's own declared aliases into the Shiki registration", async () => {
    const { registerCustomGrammars } = await freshModule();
    await registerCustomGrammars([
      {
        id: "acme",
        name: "Acme",
        grammar: { ...BASE_GRAMMAR, aliases: ["acme-lang", "acme2"] },
      },
    ]);
    const registration = rec.createdHighlighters[0].loadLanguage.mock.calls[0][0] as {
      aliases: string[];
    };
    // extraAlias ("acme", since id !== name) + the grammar's own aliases, deduped.
    expect(registration.aliases).toEqual(["acme", "acme-lang", "acme2"]);
  });

  it("does nothing for grammars whose id is already loaded", async () => {
    const { registerCustomGrammars } = await freshModule();
    await registerCustomGrammars([{ id: "dup", name: "Dup", grammar: { ...BASE_GRAMMAR } }]);
    const countAfterFirst = rec.registeredLanguages.length;
    // Second call with the same id is a no-op.
    await registerCustomGrammars([{ id: "dup", name: "Dup", grammar: { ...BASE_GRAMMAR } }]);
    expect(rec.registeredLanguages.length).toBe(countAfterFirst);
  });

  it("throws and does not mark the language loaded when Shiki fails to load the grammar", async () => {
    const { registerCustomMonacoLanguages, registerCustomGrammars, getLoadedLanguagePackageIds } =
      await freshModule();
    await registerCustomMonacoLanguages();
    rec.createdHighlighters[0].loadLanguage.mockRejectedValueOnce(new Error("bad grammar"));

    await expect(
      registerCustomGrammars([{ id: "broken", name: "Broken", grammar: { ...BASE_GRAMMAR } }])
    ).rejects.toThrow(/Failed to load grammar for "Broken" \(broken\)/);

    expect(getLoadedLanguagePackageIds().has("broken")).toBe(false);
  });
});
