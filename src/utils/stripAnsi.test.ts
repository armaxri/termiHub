import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnsiStreamStripper, stripAnsi } from "./stripAnsi";

/** Real bash/zsh OSC 133 transcripts (see commandMarks.real-shell.test.ts). */
const FIXTURE_DIR = join(process.cwd(), "src/test/fixtures/osc133");

function transcript(shell: "bash" | "zsh"): string {
  const raw = readFileSync(join(FIXTURE_DIR, `${shell}.json`), "utf8");
  return (JSON.parse(raw) as { transcript: string }).transcript;
}

/** The transcript up to and including the first prompt-end (OSC 133;B) mark. */
function firstPrompt(text: string): string {
  const end = "\u001b]133;B\u0007";
  return text.slice(0, text.indexOf(end) + end.length);
}

/** Leftover control bytes or OSC payloads that must never survive stripping. */
function expectClean(text: string): void {
  expect(text).not.toContain("\u001b");
  expect(text).not.toContain("\u0007");
  expect(text).not.toContain("\u009b");
  expect(text).not.toContain("]133;");
  expect(text).not.toContain("]7;");
}

describe("stripAnsi", () => {
  it("removes colour codes so patterns match visible text", () => {
    expect(stripAnsi("\u001b[31mERROR\u001b[0m: disk")).toBe("ERROR: disk");
  });

  it("removes OSC window titles and OSC 133 marks (BEL and ST terminated)", () => {
    expect(stripAnsi("\u001b]0;arne@box: ~\u0007arne@box:~$ \u001b]133;B\u0007")).toBe(
      "arne@box:~$ "
    );
    expect(stripAnsi("\u001b]2;title\u001b\\ok")).toBe("ok");
  });

  it("removes OSC 8 hyperlinks but keeps the link text", () => {
    expect(stripAnsi("\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007")).toBe("link");
  });

  it("removes colon-form SGR and ~-terminated CSI (bracketed paste)", () => {
    expect(stripAnsi("\u001b[38:2:255:0:0mred\u001b[0m")).toBe("red");
    expect(stripAnsi("\u001b[200~paste\u001b[201~")).toBe("paste");
  });

  it.each(["bash", "zsh"] as const)("leaves no escape residue in the %s transcript", (shell) => {
    expectClean(stripAnsi(transcript(shell)));
  });

  it("lets a $-anchored prompt pattern match the bash prompt", () => {
    expect(stripAnsi(firstPrompt(transcript("bash")))).toMatch(/\$ $/);
  });

  it("lets a %-anchored prompt pattern match the zsh prompt", () => {
    expect(stripAnsi(firstPrompt(transcript("zsh")))).toMatch(/% $/);
  });
});

describe("AnsiStreamStripper", () => {
  /** Feed `chunks` through one stripper and join the visible output. */
  function streamed(chunks: string[]): string {
    const stripper = new AnsiStreamStripper();
    return chunks.map((c) => stripper.push(c)).join("");
  }

  it("strips an OSC sequence split across two chunks", () => {
    expect(streamed(["user$ \u001b]133;", "B\u0007"])).toBe("user$ ");
  });

  it("strips a CSI sequence split right after the ESC byte", () => {
    expect(streamed(["ok\u001b", "[0mdone"])).toBe("okdone");
  });

  it("strips an OSC whose ESC \\ terminator is split", () => {
    expect(streamed(["a\u001b]0;title\u001b", "\\b"])).toBe("ab");
  });

  it("emits the visible text before a held incomplete escape immediately", () => {
    const stripper = new AnsiStreamStripper();
    expect(stripper.push("ready \u001b]133;")).toBe("ready ");
  });

  it.each(["bash", "zsh"] as const)(
    "leaves no residue when the %s transcript arrives in every two-chunk split",
    (shell) => {
      const text = transcript(shell);
      const whole = stripAnsi(text);
      for (let i = 1; i < text.length; i++) {
        const out = streamed([text.slice(0, i), text.slice(i)]);
        expectClean(out);
        expect(out).toBe(whole);
      }
    }
  );

  it("leaves no residue when the bash transcript arrives one character at a time", () => {
    const text = transcript("bash");
    expect(streamed([...text])).toBe(stripAnsi(text));
  });

  it("gives up holding a runaway unterminated sequence after the carry limit", () => {
    const stripper = new AnsiStreamStripper();
    const out = stripper.push("\u001b]0;" + "x".repeat(AnsiStreamStripper.MAX_CARRY_CHARS + 10));
    expect(out.length).toBeGreaterThan(0);
  });
});
