import { describe, it, expect } from "vitest";
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import {
  britishSpelling,
  copyStyleRule,
  formatMessage,
  parseMessage,
  titleCaseWords,
} from "./eslint-copy-style.mjs";
import { pruneBaseline, toBaseline } from "./copy-style-baseline.mjs";

describe("titleCaseWords", () => {
  it("flags capitalized words after the first word", () => {
    expect(titleCaseWords("Save & Connect")).toEqual(["Connect"]);
    expect(titleCaseWords("Clear History")).toEqual(["History"]);
    expect(titleCaseWords("Read-Only Mode")).toEqual(["Only", "Mode"]);
  });

  it("allows sentence case, acronyms, mixed-case names and proper nouns", () => {
    expect(titleCaseWords("Allow experimental features")).toEqual([]);
    expect(titleCaseWords("Open SSH session in termiHub")).toEqual([]);
    expect(titleCaseWords("Use PowerShell on Windows or macOS")).toEqual([]);
    expect(titleCaseWords("Press Ctrl and Shift")).toEqual([]);
  });

  it("allows multi-word product names", () => {
    expect(titleCaseWords("Open folder in VS Code")).toEqual([]);
    expect(titleCaseWords("Open in VS Code Now")).toEqual(["Now"]);
  });

  it("restarts at a new sentence and skips quoted names", () => {
    expect(titleCaseWords("Saved. Reconnect to apply")).toEqual([]);
    expect(titleCaseWords("Error: Something failed")).toEqual([]);
    expect(titleCaseWords('Delete "My Server"')).toEqual([]);
  });
});

describe("britishSpelling", () => {
  it("finds British spellings and names the US form", () => {
    expect(britishSpelling("Transfer cancelled")?.us).toBe("canceled / canceling");
    expect(britishSpelling("Pick a colour")?.us).toBe("color");
    expect(britishSpelling("Initialise the store")?.us).toBe("-ize / -ization");
  });

  it("leaves US spelling and look-alikes alone", () => {
    expect(britishSpelling("Transfer canceled")).toBeNull();
    expect(britishSpelling("Pick a color")).toBeNull();
    expect(britishSpelling("Cancellation pending")).toBeNull();
    expect(britishSpelling("Raise the window, otherwise wise")).toBeNull();
  });
});

describe("message format", () => {
  it("round-trips the check and text, including quotes and dashes", () => {
    const text = 'Saved "a" — b';
    expect(parseMessage(formatMessage("sentence-case", text))).toEqual({
      check: "sentence-case",
      text,
    });
    expect(parseMessage("some other message")).toBeNull();
  });
});

describe("baseline tool", () => {
  it("counts violations per file, check and text", () => {
    expect(
      toBaseline([
        { file: "b.tsx", check: "discard", text: "Just close" },
        { file: "a.tsx", check: "sentence-case", text: "Save Now" },
        { file: "a.tsx", check: "sentence-case", text: "Save Now" },
      ])
    ).toEqual({
      "a.tsx": { "sentence-case": { "Save Now": 2 } },
      "b.tsx": { discard: { "Just close": 1 } },
    });
  });

  it("prunes fixed entries and never adds new ones", () => {
    const baseline = {
      "a.tsx": { "sentence-case": { "Save Now": 2, "Clear History": 1 } },
      "b.tsx": { discard: { "Just close": 1 } },
    };
    const current = {
      "a.tsx": { "sentence-case": { "Save Now": 1, "New Thing": 1 } },
      "b.tsx": { discard: { "Just close": 1 } },
    };
    const { pruned, stale } = pruneBaseline(baseline, current);
    expect(pruned).toEqual({
      "a.tsx": { "sentence-case": { "Save Now": 1 } },
      "b.tsx": { discard: { "Just close": 1 } },
    });
    expect(stale).toEqual([
      { file: "a.tsx", check: "sentence-case", text: "Save Now", count: 1 },
      { file: "a.tsx", check: "sentence-case", text: "Clear History", count: 1 },
    ]);
  });
});

describe("copy/copy-style on menu items (#5491)", () => {
  RuleTester.describe = describe;
  RuleTester.it = it;
  const tester = new RuleTester({
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  });
  const options = [{ baselinePath: null }];
  const sentenceCase = (text) => ({ message: formatMessage("sentence-case", text) });

  tester.run("copy-style", copyStyleRule, {
    valid: [
      { code: "<MenuItem><Icon /> Save to file</MenuItem>", options },
      { code: "<MenuItem>Open SSH session in termiHub</MenuItem>", options },
      { code: "<MenuItem>Open SFTP browser</MenuItem>", options },
      { code: "<MenuItem>Open in VS Code</MenuItem>", options },
      { code: '<MenuItem>{pinned ? "Unpin" : "Pin to top"}</MenuItem>', options },
      { code: "<ContextMenu.Item>Copy all</ContextMenu.Item>", options },
      // Text inside a nested component (a hint, a shortcut) is not the label.
      { code: "<MenuItem>Copy<Kbd>Ctrl Shift C</Kbd></MenuItem>", options },
      // Not a menu row: plain elements are only spell-checked.
      { code: "<div>Save to File</div>", options },
    ],
    invalid: [
      {
        code: "<MenuItem><Icon /> Save to File</MenuItem>",
        options,
        errors: [sentenceCase("Save to File")],
      },
      {
        code: "<MenuCheckboxItem>Horizontal Scrolling</MenuCheckboxItem>",
        options,
        errors: [sentenceCase("Horizontal Scrolling")],
      },
      {
        code: "<MenuSubTrigger>Move to Window</MenuSubTrigger>",
        options,
        errors: [sentenceCase("Move to Window")],
      },
      {
        code: "<RadixDropdownMenu.Item>Copy All</RadixDropdownMenu.Item>",
        options,
        errors: [sentenceCase("Copy All")],
      },
      {
        code: '<MenuItem>{pinned ? "Unpin" : "Pin to Top"}</MenuItem>',
        options,
        errors: [sentenceCase("Pin to Top")],
      },
      {
        code: "<MenuItem><span>Close Tab</span></MenuItem>",
        options,
        errors: [sentenceCase("Close Tab")],
      },
      {
        code: 'const items = [{ id: "clear", label: "Clear Terminal" }];',
        options,
        errors: [sentenceCase("Clear Terminal")],
      },
    ],
  });
});

describe("copy/copy-style on accessible names, tooltips and titles (#5493)", () => {
  RuleTester.describe = describe;
  RuleTester.it = it;
  const tester = new RuleTester({
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  });
  const options = [{ baselinePath: null }];
  const sentenceCase = (text) => ({ message: formatMessage("sentence-case", text) });

  tester.run("copy-style", copyStyleRule, {
    valid: [
      { code: '<button aria-label="Split terminal right" />', options },
      { code: '<Tooltip content="Match whole word"><b /></Tooltip>', options },
      { code: '<span title="Open SSH session in termiHub" />', options },
      { code: '<span title="Back to commands (Backspace)" />', options },
      { code: '<input aria-label="Require authentication (HTTP Basic Auth)" />', options },
      // A control the text refers to is quoted, like a user's name.
      { code: '<p title="Enter a URL and click “Start”." />', options },
      { code: 'const e = { title: "Authentication failed", message: "Bad Key" };', options },
      // `content` is only tooltip text on a Tooltip.
      { code: '<meta content="Not Copy At All" />', options },
    ],
    invalid: [
      {
        code: '<button aria-label="Split Terminal Right" />',
        options,
        errors: [sentenceCase("Split Terminal Right")],
      },
      {
        code: '<button aria-label={on ? "Stop Broadcast" : "Broadcast input"} />',
        options,
        errors: [sentenceCase("Stop Broadcast")],
      },
      {
        code: '<Tooltip content="Match Case"><b /></Tooltip>',
        options,
        errors: [sentenceCase("Match Case")],
      },
      {
        code: '<span title="Go Up" />',
        options,
        errors: [sentenceCase("Go Up")],
      },
      {
        code: '<Modal title="Unsaved Changes" />',
        options,
        errors: [sentenceCase("Unsaved Changes")],
      },
      {
        code: 'const e = { title: "Could Not Reach Host", message: "x" };',
        options,
        errors: [sentenceCase("Could Not Reach Host")],
      },
    ],
  });
});
