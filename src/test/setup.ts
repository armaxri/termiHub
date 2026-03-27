import { vi } from "vitest";

// Mock monaco-editor so tests don't need a browser environment.
vi.mock("monaco-editor", () => ({
  editor: {
    setTheme: vi.fn(),
  },
  languages: {
    getLanguages: vi.fn(() => [
      { id: "plaintext", aliases: ["Plain Text"] },
      { id: "javascript", aliases: ["JavaScript"] },
      { id: "typescript", aliases: ["TypeScript"] },
      { id: "json", aliases: ["JSON"] },
      { id: "python", aliases: ["Python"] },
      { id: "shell", aliases: ["Shell Script"] },
      { id: "ini", aliases: ["Ini"] },
      { id: "yaml", aliases: ["YAML"] },
      { id: "xml", aliases: ["XML"] },
      { id: "dockerfile", aliases: ["Dockerfile"] },
      { id: "makefile", aliases: ["Makefile"] },
      { id: "cmake", aliases: ["CMake"] },
      { id: "toml", aliases: ["TOML"] },
      { id: "nginx", aliases: ["Nginx"] },
      { id: "nix", aliases: ["Nix"] },
      { id: "ruby", aliases: ["Ruby"] },
      { id: "java", aliases: ["Java"] },
      { id: "cpp", aliases: ["C++"] },
      { id: "rust", aliases: ["Rust"] },
      { id: "go", aliases: ["Go"] },
      { id: "html", aliases: ["HTML"] },
      { id: "css", aliases: ["CSS"] },
      { id: "hcl", aliases: ["HCL"] },
    ]),
    register: vi.fn(),
    setMonarchTokensProvider: vi.fn(),
    setLanguageConfiguration: vi.fn(),
  },
}));

// Mock shiki and @shikijs/monaco to avoid WASM loading in tests.
vi.mock("shiki", () => ({
  createHighlighter: vi.fn().mockResolvedValue({
    loadLanguage: vi.fn().mockResolvedValue(undefined),
  }),
  bundledLanguages: {
    astro: vi.fn(),
    svelte: vi.fn(),
    zig: vi.fn(),
  },
  bundledLanguagesInfo: [
    { id: "astro", name: "Astro" },
    { id: "svelte", name: "Svelte" },
    { id: "zig", name: "Zig" },
    { id: "cmake", name: "CMake" },
    { id: "toml", name: "TOML" },
    { id: "nginx", name: "Nginx" },
    { id: "nix", name: "Nix" },
    { id: "lua", name: "Lua" },
  ],
}));

vi.mock("@shikijs/monaco", () => ({
  shikiToMonaco: vi.fn(),
}));

// Mock Tauri core API to prevent import errors when modules load
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn().mockResolvedValue(""),
  writeText: vi.fn().mockResolvedValue(undefined),
}));
