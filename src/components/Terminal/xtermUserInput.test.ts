import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal as XTerm } from "@xterm/xterm";
import { trackUserInput } from "./xtermUserInput";

vi.unmock("@xterm/xterm");

let xterm: XTerm;
afterEach(() => xterm.dispose());

/** What `onData` carries, with the tracker's verdict. */
function listen(): Array<[string, boolean]> {
  const tracker = trackUserInput(xterm);
  expect(tracker.known).toBe(true);
  const seen: Array<[string, boolean]> = [];
  xterm.onData((data) => seen.push([data, tracker.take()]));
  return seen;
}
const write = (data: string) => new Promise<void>((done) => xterm.write(data, done));

describe("trackUserInput (a real xterm)", () => {
  it("tells typed keys from the terminal's own replies", async () => {
    xterm = new XTerm({ allowProposedApi: true });
    const seen = listen();
    xterm.input("l", true);
    // Device attributes and a cursor position report.
    await write("\x1b[c\x1b[6n");
    xterm.input("s", true);
    expect(seen.map(([, user]) => user)).toEqual([true, false, false, true]);
    expect(seen[1][0].startsWith("\x1b[?")).toBe(true);
  });

  it("counts everything as the user's when the private event is gone", () => {
    xterm = new XTerm();
    const tracker = trackUserInput({} as XTerm);
    expect(tracker.known).toBe(false);
    expect([tracker.take(), tracker.take()]).toEqual([true, true]);
    tracker.dispose();
  });
});
