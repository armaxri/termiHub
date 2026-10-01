import { describe, it, expect } from "vitest";
import { connectionTabContentType } from "./connectionTabContentType";

const base = { monitoring: false, fileBrowser: false, resize: false, persistent: false };

const TYPES = [
  { typeId: "vnc", capabilities: { ...base, terminal: false, graphical: true } },
  { typeId: "ftp", capabilities: { ...base, terminal: false, fileBrowser: true } },
  { typeId: "ssh", capabilities: { ...base, terminal: true, resize: true } },
  { typeId: "legacy", capabilities: { ...base } },
];

describe("connectionTabContentType", () => {
  it("maps a graphical type to a remote-desktop tab", () => {
    expect(connectionTabContentType(TYPES, "vnc")).toBe("remote-desktop");
  });

  it("maps a terminal-less type to a file-browser tab", () => {
    expect(connectionTabContentType(TYPES, "ftp")).toBe("file-browser");
  });

  it("leaves a terminal type on the terminal default", () => {
    expect(connectionTabContentType(TYPES, "ssh")).toBeUndefined();
  });

  it("treats an absent terminal flag as a terminal type", () => {
    expect(connectionTabContentType(TYPES, "legacy")).toBeUndefined();
  });

  it("treats an unknown type as a terminal type", () => {
    expect(connectionTabContentType(TYPES, "nope")).toBeUndefined();
  });
});
