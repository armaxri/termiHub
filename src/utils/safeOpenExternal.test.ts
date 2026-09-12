import { describe, it, expect, vi, beforeEach } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isAllowedExternalUrl, safeOpenExternal, openMonacoLink } from "./safeOpenExternal";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

const mockedOpenUrl = vi.mocked(openUrl);

const ALLOWED = [
  "https://example.com/release",
  "http://example.com/path?x=1#frag",
  "mailto:hello@example.com",
];

const REJECTED = [
  "file:///etc/passwd",
  "javascript:alert(1)",
  "vscode://open?file=/x",
  "custom-scheme://do-a-thing",
  "not a url",
  "",
  "//example.com",
  "  ",
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isAllowedExternalUrl", () => {
  it.each(ALLOWED)("allows %s", (url) => {
    expect(isAllowedExternalUrl(url)).toBe(true);
  });

  it.each(REJECTED)("rejects %s", (url) => {
    expect(isAllowedExternalUrl(url)).toBe(false);
  });
});

describe("safeOpenExternal", () => {
  it.each(ALLOWED)("opens allowed URL %s via the OS opener", async (url) => {
    await expect(safeOpenExternal(url)).resolves.toBe(true);
    expect(mockedOpenUrl).toHaveBeenCalledWith(url);
  });

  it.each(REJECTED)("never calls the OS opener for rejected URL %s", async (url) => {
    await expect(safeOpenExternal(url)).resolves.toBe(false);
    expect(mockedOpenUrl).not.toHaveBeenCalled();
  });
});

describe("openMonacoLink", () => {
  it("reports handled and opens an allowed link", async () => {
    const result = openMonacoLink({ toString: () => "https://example.com/docs" });
    expect(result).toBe(true);
    await Promise.resolve();
    expect(mockedOpenUrl).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("reports handled but never opens a disallowed link", async () => {
    const result = openMonacoLink({ toString: () => "javascript:alert(1)" });
    // Returning true stops Monaco falling back to its default opener.
    expect(result).toBe(true);
    await Promise.resolve();
    expect(mockedOpenUrl).not.toHaveBeenCalled();
  });
});
