import { describe, expect, it } from "vitest";
import { recordedTime, recordingName, uniqueName } from "./recordingText";

const chunks = (...data: string[]) => data.map((d) => ({ data: d, delayMs: 0 }));

describe("recordingText", () => {
  it.each([
    [0, "0.0 s"],
    [3240, "3.2 s"],
    [65_000, "1 min 5 s"],
  ])("tells %d ms as %s", (ms, text) => expect(recordedTime(ms)).toBe(text));

  it("numbers a name that is taken", () => {
    expect(uniqueName("ls", [])).toBe("ls");
    expect(uniqueName("ls", ["ls"])).toBe("ls 2");
    expect(uniqueName("ls", ["ls", "ls 2"])).toBe("ls 3");
  });

  it.each<[string, string[], string]>([
    ["the first typed line", ["git", " pull", "\r", "make\r"], "git pull"],
    ["the first line with something in it", ["\r", "  ", "\r", "make\r"], "make"],
    ["the terminal when only keys were pressed", ["\x1b[A", "\r"], "Recording in prod-web"],
    ["what is left after corrections", ["gti", "\x7f\x7f\x7f", "git status\r"], "git status"],
    ["a paste without its markers", ["\x1b[200~make all\r\x1b[201~"], "make all"],
    ["the terminal when nothing is left", [], "Recording in prod-web"],
  ])("names a recording after %s", (_case, data, name) => {
    expect(recordingName(chunks(...data), "prod-web", [])).toBe(name);
  });

  it("keeps a long first line short", () => {
    expect(recordingName(chunks("x".repeat(200)), "t", []).length).toBe(40);
  });
});
