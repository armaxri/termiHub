import { describe, it, expect } from "vitest";
import * as monaco from "monaco-editor";
import { BUILTIN_LANGUAGE_IDS } from "./monacoCustomLanguages";

// Guard against MOCK-007 drift.
//
// The global test setup (`src/test/setup.ts`) mocks
// `monaco.languages.getLanguages()` with a hard-coded language list that other
// suites — notably `monacoLanguages.test.ts` (the language picker) — assert
// against. If a built-in custom language is added to / removed from the real
// registration (`monacoCustomLanguages.ts`) but the setup mock is not updated,
// those suites keep passing against a stale list and the drift goes uncaught.
//
// This test ties the setup mock back to the real source of truth
// (`BUILTIN_LANGUAGE_IDS`), so such drift fails loudly here. It deliberately does
// NOT install a local `monaco-editor` mock (unlike `monacoCustomLanguages.test.ts`,
// which uses its own recording stub), so it exercises the global setup mock.
describe("test setup monaco mock stays in sync with the real built-in languages", () => {
  it("lists every termiHub built-in custom language in the mocked getLanguages()", () => {
    const mockedIds = new Set(monaco.languages.getLanguages().map((l) => l.id));
    const missing = BUILTIN_LANGUAGE_IDS.filter((id) => !mockedIds.has(id));
    expect(missing).toEqual([]);
  });
});
