import { describe, it, expect } from "vitest";
import { Terminal } from "@xterm/xterm";
import { bufferToLogicalLines } from "./terminalBuffer";

/** Write data into a headless xterm and return its active buffer + cols. */
async function makeBuffer(cols: number, data: string) {
  const term = new Terminal({ cols, rows: 6, allowProposedApi: true, scrollback: 1000 });
  await new Promise<void>((resolve) => term.write(data, () => resolve()));
  return { buffer: term.buffer.active, cols: term.cols };
}

describe("bufferToLogicalLines", () => {
  it("joins soft-wrapped rows back into one logical line (both modes)", async () => {
    const { buffer, cols } = await makeBuffer(10, "ABCDEFGHIJKLMNO\r\n");
    expect(bufferToLogicalLines(buffer, cols, false)).toBe("ABCDEFGHIJKLMNO\n");
    expect(bufferToLogicalLines(buffer, cols, true)).toBe("ABCDEFGHIJKLMNO\n");
  });

  it("preserves real newlines between short lines (both modes)", async () => {
    const { buffer, cols } = await makeBuffer(10, "hi\r\nthere\r\n");
    expect(bufferToLogicalLines(buffer, cols, false)).toBe("hi\nthere\n");
    expect(bufferToLogicalLines(buffer, cols, true)).toBe("hi\nthere\n");
  });

  it("does NOT join a full-width row with the next when full-width join is off", async () => {
    // "0123456789" exactly fills 10 cols, followed by a real newline then "NEXT".
    const { buffer, cols } = await makeBuffer(10, "0123456789\r\nNEXT\r\n");
    expect(bufferToLogicalLines(buffer, cols, false)).toBe("0123456789\nNEXT\n");
  });

  it("joins a full-width row with the next when full-width join is on", async () => {
    const { buffer, cols } = await makeBuffer(10, "0123456789\r\nNEXT\r\n");
    expect(bufferToLogicalLines(buffer, cols, true)).toBe("0123456789NEXT\n");
  });

  it("does not merge a short line that does not fill the width", async () => {
    const { buffer, cols } = await makeBuffer(10, "hi\r\nthere\r\n");
    expect(bufferToLogicalLines(buffer, cols, true)).toBe("hi\nthere\n");
  });

  it("preserves a deliberate blank line after a full-width row", async () => {
    const { buffer, cols } = await makeBuffer(10, "0123456789\r\n\r\nafter\r\n");
    expect(bufferToLogicalLines(buffer, cols, true)).toBe("0123456789\n\nafter\n");
  });

  it("chains multiple hard-wrapped full-width rows into one line", async () => {
    // Two full rows then a partial row, each separated by real newlines.
    const { buffer, cols } = await makeBuffer(10, "0123456789\r\nABCDEFGHIJ\r\ntail\r\n");
    expect(bufferToLogicalLines(buffer, cols, true)).toBe("0123456789ABCDEFGHIJtail\n");
  });
});
