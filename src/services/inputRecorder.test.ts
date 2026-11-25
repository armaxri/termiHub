import { describe, expect, it } from "vitest";
import { InputRecorder, recordedParts, withoutSecrets } from "./inputRecorder";

/** A recorder on a clock and a screen the test sets. */
function setup() {
  const at = { time: 0, screen: "$ " };
  const recorder = new InputRecorder(() => at.time);
  /** Type a chunk `after` ms later; `echo` is what it puts on the screen. */
  const type = (data: string, after = 0, echo: string | null = data) => {
    at.time += after;
    recorder.push(data, () => at.screen);
    if (echo !== null) at.screen += echo;
  };
  return { at, recorder, type };
}

describe("InputRecorder", () => {
  it("keeps every byte, with the time between chunks", () => {
    const { recorder, type } = setup();
    for (const [data, after] of [
      ["l", 5],
      ["\x1b[A", 120.4],
      ["\x03", 0],
      ["grüße 🚀", 10],
      ["\x1b[200~two\r\nlines\x1b[201~", 7000],
      ["\x00\x7f", 1],
    ] as const) {
      type(data, after);
    }
    expect(recorder.finish()).toEqual({
      chunks: [
        { data: "l", delayMs: 0 },
        { data: "\x1b[A", delayMs: 120 },
        { data: "\x03", delayMs: 0 },
        { data: "grüße 🚀", delayMs: 10 },
        { data: "\x1b[200~two\r\nlines\x1b[201~", delayMs: 7000 },
        { data: "\x00\x7f", delayMs: 1 },
      ],
      secrets: [],
      durationMs: 7131,
    });
    expect(recorder.keys).toBe(6);
  });

  it("keeps a paste's place while its text is being read", () => {
    const { at, recorder, type } = setup();
    type("a");
    at.time = 100;
    const paste = recorder.reserve();
    type("b", 50);
    paste.fill("PASTED");
    paste.fill("again");
    expect(recorder.finish().chunks).toEqual([
      { data: "a", delayMs: 0 },
      { data: "PASTED", delayMs: 100 },
      { data: "b", delayMs: 50 },
    ]);
  });

  it("leaves out a paste that was given up or is still pending", () => {
    const { recorder, type } = setup();
    recorder.reserve().cancel();
    recorder.reserve();
    type("a", 5);
    expect(recorder.keys).toBe(1);
    expect(recorder.finish().chunks).toEqual([{ data: "a", delayMs: 0 }]);
  });
});

describe("what is typed at a password prompt", () => {
  const sudo = (type: ReturnType<typeof setup>["type"], at: { screen: string }) => {
    type("sudo -v\r", 0, null);
    at.screen = "[sudo] password for arne: ";
    for (const key of "hunter2") type(key, 100, null);
    type("\r", 100, null);
    at.screen = "$ ";
    type("ls\r", 200);
  };

  it("is flagged with its Enter, and named by its prompt", () => {
    const { at, recorder, type } = setup();
    sudo(type, at);
    const { secrets, chunks } = recorder.finish();
    expect(secrets).toEqual([{ start: 1, end: 9, prompt: "[sudo] password for arne:" }]);
    expect(
      chunks
        .slice(1, 9)
        .map((c) => c.data)
        .join("")
    ).toBe("hunter2\r");
  });

  it("is left out, and the place is known", () => {
    const { at, recorder, type } = setup();
    sudo(type, at);
    const recorded = recorder.finish();
    expect(recordedParts(recorded)).toEqual([
      { kind: "keys", chunks: [{ data: "sudo -v\r", delayMs: 0 }] },
      { kind: "left-out" },
      { kind: "keys", chunks: [{ data: "ls\r", delayMs: 0 }] },
    ]);
    expect(withoutSecrets(recorded).map((c) => c.data)).toEqual(["sudo -v\r", "ls\r"]);
  });

  it("is kept apart while something waits for it, whatever the screen shows (#6025)", () => {
    const { at, recorder } = setup();
    at.screen = "Deploy hunter2";
    const read = () => at.screen;
    recorder.push("hunter2", read, "Deploy");
    expect(recorder.finish().secrets).toEqual([{ start: 0, end: 1, prompt: "Deploy" }]);
    recorder.reserve(read, "Deploy").fill("pasted");
    // The wait is over without an Enter: what follows is not part of it.
    at.screen = "$ ";
    recorder.push("x", read);
    expect(recorder.finish().secrets).toEqual([{ start: 0, end: 2, prompt: "Deploy" }]);
  });

  it("is flagged when the prompt masks it", () => {
    const { at, recorder, type } = setup();
    at.screen = "PIN: ";
    for (const key of "12\r") type(key, 10, key === "\r" ? null : "*");
    expect(recorder.finish().secrets).toEqual([{ start: 0, end: 3, prompt: "PIN:" }]);
  });

  it("is flagged when it is pasted", () => {
    const { at, recorder, type } = setup();
    at.screen = "Password: ";
    const paste = recorder.reserve(() => at.screen);
    paste.fill("hunter2");
    type("\r", 10, null);
    expect(recorder.finish().secrets).toEqual([{ start: 0, end: 2, prompt: "Password:" }]);
  });

  it("is flagged per prompt, and ends at Ctrl+C", () => {
    const { at, recorder, type } = setup();
    at.screen = "Password: ";
    type("a", 0, null);
    type("\x03", 0, null);
    expect(recorder.atPrompt).toBe(false);
    at.screen = "Password: ";
    type("b", 0, null);
    expect(recorder.atPrompt).toBe(true);
    type("\r", 0, null);
    expect(recorder.finish().secrets.map(({ start, end }) => [start, end])).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });

  it("is not flagged when it is echoed: that was no password prompt", () => {
    const { at, recorder, type } = setup();
    at.screen = "$ grep password: ";
    for (const key of "file\r") type(key, 10);
    expect(recorder.finish().secrets).toEqual([]);
    expect(recorder.atPrompt).toBe(false);
  });

  it("is unflagged at the end when one key only was echoed", () => {
    const { at, recorder, type } = setup();
    at.screen = "$ echo Password: ";
    type("x", 10);
    expect(recorder.finish().secrets).toEqual([]);
  });

  it("stays hidden when other output moves the prompt while it is answered", () => {
    const recorder = new InputRecorder(() => 0);
    recorder.push("p", () => "Password: ");
    recorder.push("w", () => "[1]+  Done   sleep 1");
    recorder.push("\r", () => "");
    expect(recorder.finish().secrets).toEqual([{ start: 0, end: 3, prompt: "Password:" }]);
  });

  it("never gets in the way of typing when the screen cannot be read", () => {
    const recorder = new InputRecorder(() => 0);
    const broken = () => {
      throw new Error("disposed");
    };
    recorder.push("a", broken);
    recorder.push("b", broken);
    expect(recorder.finish().chunks.map((c) => c.data)).toEqual(["a", "b"]);
  });

  it("is not looked for without a screen to read", () => {
    const recorder = new InputRecorder(() => 0);
    recorder.push("a");
    expect(recorder.finish().secrets).toEqual([]);
  });
});
