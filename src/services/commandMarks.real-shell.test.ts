/**
 * OSC 133 command marks from REAL shells (#3415, #4013).
 *
 * `commandMarks.test.ts` drives the tracker with hand-written mark sequences.
 * This suite replays byte streams captured from a real bash and zsh running
 * termiHub's shell integration in a real PTY (`seq 3`, then `false`) through the
 * real xterm parser — so everything the shells add around the marks (zsh's
 * line-editor redraw, its PROMPT_SP `%` padding between the output and `D`,
 * bracketed-paste toggles, OSC 7) is part of what is tested.
 *
 * The transcripts under `src/test/fixtures/osc133/` are written by the Rust
 * real-shell test (`core/src/backends/local_shell_osc133_tests.rs`), which also
 * checks the live shells still emit them. Regenerate with:
 *
 *     TERMIHUB_OSC133_TRANSCRIPT_DIR=$PWD/src/test/fixtures/osc133 \
 *       cargo test -p termihub-core --features local-shell --lib osc133_tests
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Terminal as XTerm } from "@xterm/xterm";
import { CommandMarkTracker, OSC_133 } from "./commandMarks";

interface Transcript {
  shell: string;
  cols: number;
  transcript: string;
}

const FIXTURE_DIR = join(process.cwd(), "src/test/fixtures/osc133");
const SHELLS = ["bash", "zsh"] as const;
const PROMPT_START = "\x1b]133;A\x07";
const SEQ_FINISHED = "\x1b]133;D;0\x07";

function loadTranscript(shell: string): Transcript {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${shell}.json`), "utf8")) as Transcript;
}

function write(term: XTerm, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, () => resolve()));
}

/** The transcript up to and including the prompt that follows `seq 3`. */
function throughSeq(text: string): string {
  const done = text.indexOf(SEQ_FINISHED);
  expect(done).toBeGreaterThan(0);
  const nextPrompt = text.indexOf(PROMPT_START, done);
  expect(nextPrompt).toBeGreaterThan(done);
  return text.slice(0, nextPrompt + PROMPT_START.length);
}

describe.each(SHELLS)("real %s transcript (OSC 133)", (shell) => {
  const fixture = loadTranscript(shell);
  let term: XTerm;
  let tracker: CommandMarkTracker;
  let host: HTMLDivElement;

  function mount(): void {
    term = new XTerm({ cols: fixture.cols, rows: 24, scrollback: 1000, allowProposedApi: true });
    host = document.createElement("div");
    document.body.appendChild(host);
    term.open(host);
    tracker = new CommandMarkTracker(term);
    term.parser.registerOscHandler(OSC_133, tracker.handleOsc);
  }

  afterEach(() => {
    tracker.dispose();
    term.dispose();
    host.remove();
  });

  it("records both commands with their real exit codes", async () => {
    mount();
    await write(term, fixture.transcript);
    expect(tracker.hasMarks()).toBe(true);
    const finished = tracker.getCommands().filter((c) => c.state === "finished");
    expect(finished.map((c) => c.exitCode)).toEqual([0, 1]);
    // The prompt after `false` is the live one, waiting for input.
    expect(tracker.getCommands().at(-1)?.state).not.toBe("finished");
  });

  it("copies exactly the seq output as the last command output", async () => {
    mount();
    await write(term, throughSeq(fixture.transcript));
    expect(tracker.getLastCommandOutput()).toBe("1\n2\n3");
  });

  it("has no output to copy after a command that printed nothing", async () => {
    mount();
    await write(term, fixture.transcript);
    // `false` finished last and printed nothing (zsh's PROMPT_SP padding is
    // not output), so there is nothing to copy.
    expect(tracker.getLastCommandOutput()).toBeNull();
  });
});
