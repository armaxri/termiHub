/**
 * OSC 133 semantic-prompt ("command mark") tracking for a terminal (#3415,
 * audit finding PROD-059).
 *
 * Shells with termiHub's shell integration (and shells/prompts that support it
 * natively, e.g. fish 4+, starship, VS Code's integration scripts) bracket every
 * prompt and command with FinalTerm / OSC 133 marks:
 *
 * | Mark          | Meaning                                  |
 * | ------------- | ---------------------------------------- |
 * | `133;A`       | prompt starts                            |
 * | `133;B`       | prompt ends — the user's input starts    |
 * | `133;C`       | command line accepted — output starts    |
 * | `133;D[;n]`   | command finished with exit code `n`      |
 *
 * {@link CommandMarkTracker} turns that stream into a list of commands whose
 * positions are held by xterm **markers**, so they move with the buffer and are
 * disposed by xterm itself when scrollback trimming drops their line (records
 * whose prompt marker is gone are pruned). The tracker is deliberately
 * forgiving: any mark may be missing, duplicated or out of order (fish 4 plus
 * an injected hook, a shell without `C`, an empty Enter, Ctrl+C at the prompt)
 * and it never throws — the worst case is a command without an exit-status
 * decoration. When the shell emits no OSC 133 at all the tracker stays empty
 * and every action is a no-op, so terminal behaviour is unchanged.
 */
import type { IDecoration, IDisposable, IMarker, Terminal } from "@xterm/xterm";

/** The OSC identifier xterm hands the payload for. */
export const OSC_133 = 133;

/** Kinds of OSC 133 marks the tracker acts on. */
export type Osc133Kind = "A" | "B" | "C" | "D";

/** A parsed OSC 133 sequence. */
export interface Osc133Event {
  kind: Osc133Kind;
  /** Exit code carried by a `D` mark; `undefined` when absent or malformed. */
  exitCode?: number;
}

/**
 * Parse the payload of an OSC 133 sequence (everything after `133;`).
 *
 * Accepts the bare marks (`A`, `B`, `C`, `D`), a `D` with an exit code
 * (`D;0`, `D;130`) and the key=value options newer emitters append
 * (`A;click_events=1`, `C;cmdline_url=…`, `D;0;aid=…`). Returns `null` for any
 * other kind (`P` properties, `L`, unknown/empty payloads), which callers
 * simply ignore.
 */
export function parseOsc133(data: string): Osc133Event | null {
  const parts = data.split(";");
  const kind = parts[0];
  if (kind !== "A" && kind !== "B" && kind !== "C" && kind !== "D") return null;
  if (kind !== "D") return { kind };
  const raw = parts[1]?.trim();
  if (raw !== undefined && /^-?\d+$/.test(raw)) {
    return { kind, exitCode: Number.parseInt(raw, 10) };
  }
  return { kind };
}

/** Lifecycle of a tracked command. */
export type CommandState = "prompt" | "input" | "running" | "finished";

/** A position in the buffer anchored by an xterm marker. */
interface AnchoredPosition {
  marker: IMarker;
  col: number;
}

/** One prompt / command tracked from OSC 133 marks. */
interface CommandRecord {
  /** Line of the prompt (`A`), or where the first mark of this command landed. */
  prompt: IMarker;
  /** Where the user's input starts (`B`). */
  input?: AnchoredPosition;
  /** Where the command's output starts (`C`). */
  output?: AnchoredPosition;
  /** Where the command finished (`D`) — the output ends just before it. */
  end?: AnchoredPosition;
  /** Exit code from `D`; `undefined` when unknown. */
  exitCode?: number;
  state: CommandState;
  /** Success/failure gutter decoration, when rendered. */
  decoration?: IDecoration;
}

/** A read-only view of a tracked command, for tests and diagnostics. */
export interface CommandSummary {
  promptLine: number;
  state: CommandState;
  exitCode?: number;
  /** `[startLine, endLine]` of the command's output, or `null` when none. */
  outputLines: [number, number] | null;
}

/** An inclusive buffer range: `(startCol, startLine)` to `(endCol, endLine)`, endCol exclusive. */
export interface BufferRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

/**
 * The subset of the xterm `Terminal` API the tracker uses — narrow so tests can
 * pass either a real xterm or a small fake.
 */
export type CommandMarkTerminal = Pick<
  Terminal,
  | "registerMarker"
  | "registerDecoration"
  | "buffer"
  | "cols"
  | "scrollToLine"
  | "scrollToBottom"
  | "select"
>;

/** CSS class names used for decorations (styled in Terminal.css). */
export const COMMAND_MARK_CLASS = "terminal-command-mark";
export const COMMAND_MARK_SUCCESS_CLASS = "terminal-command-mark--success";
export const COMMAND_MARK_FAILURE_CLASS = "terminal-command-mark--failure";
export const PROMPT_FLASH_CLASS = "terminal-prompt-flash";

/** How long the jump-to-prompt highlight stays visible. */
export const PROMPT_FLASH_MS = 800;

/** Options for {@link CommandMarkTracker}. */
export interface CommandMarkTrackerOptions {
  /** Whether the success/failure gutter decoration is rendered (default true). */
  decorations?: boolean;
}

/** Tracks OSC 133 command marks for one terminal. See the module docs. */
export class CommandMarkTracker implements IDisposable {
  private readonly term: CommandMarkTerminal;
  private records: CommandRecord[] = [];
  private decorationsEnabled: boolean;
  /** Prompt last jumped to, and the viewport position that jump produced. */
  private nav: { marker: IMarker; viewportY: number } | null = null;
  private flash: { decoration: IDecoration; timer: ReturnType<typeof setTimeout> } | null = null;
  private disposed = false;

  constructor(term: CommandMarkTerminal, options: CommandMarkTrackerOptions = {}) {
    this.term = term;
    this.decorationsEnabled = options.decorations ?? true;
  }

  /**
   * OSC 133 handler — register with `xterm.parser.registerOscHandler(133, …)`.
   * Always returns `true` (the sequence is consumed; xterm has no default
   * handling for it). Never throws.
   */
  readonly handleOsc = (data: string): boolean => {
    try {
      const event = parseOsc133(data);
      if (event) this.apply(event);
    } catch {
      // A malformed mark must never break terminal output.
    }
    return true;
  };

  /** Whether any prompt has been marked (i.e. the shell emits OSC 133). */
  hasMarks(): boolean {
    this.prune();
    return this.records.length > 0;
  }

  /** Snapshot of the tracked commands, oldest first. */
  getCommands(): CommandSummary[] {
    this.prune();
    return this.records.map((r) => {
      const range = this.outputRange(r);
      return {
        promptLine: r.prompt.line,
        state: r.state,
        exitCode: r.exitCode,
        outputLines: range ? [range.startLine, range.endLine] : null,
      };
    });
  }

  /** Turn the success/failure gutter decoration on or off (applies retroactively). */
  setDecorationsEnabled(enabled: boolean): void {
    if (this.decorationsEnabled === enabled) return;
    this.decorationsEnabled = enabled;
    for (const record of this.records) {
      if (enabled) this.decorate(record);
      else this.undecorate(record);
    }
  }

  /**
   * Scroll to the prompt above the current reference point (the prompt last
   * jumped to, else the top of a scrolled-up viewport, else the active prompt)
   * and briefly highlight it. Returns `false` when there is no earlier prompt.
   */
  jumpToPreviousPrompt(): boolean {
    this.prune();
    const prompts = this.promptMarkers();
    if (prompts.length === 0) return false;
    const buffer = this.term.buffer.active;
    let reference: number;
    if (this.navIsCurrent()) {
      reference = this.nav!.marker.line;
    } else if (buffer.viewportY < buffer.baseY) {
      reference = buffer.viewportY;
    } else {
      // Pinned to the bottom: when idle at a prompt, "previous" means the one
      // before it; while a command runs, its own prompt is the first stop.
      const last = this.records[this.records.length - 1];
      const idle = last.state === "prompt" || last.state === "input";
      reference = idle ? last.prompt.line : Number.POSITIVE_INFINITY;
    }
    let target: IMarker | undefined;
    for (const marker of prompts) {
      if (marker.line < reference) target = marker;
      else break;
    }
    if (!target) return false;
    this.scrollToPrompt(target);
    return true;
  }

  /**
   * Scroll to the prompt below the current reference point and highlight it;
   * past the last prompt, scroll to the bottom. Returns `false` when already at
   * the bottom with nothing to navigate to.
   */
  jumpToNextPrompt(): boolean {
    this.prune();
    const prompts = this.promptMarkers();
    if (prompts.length === 0) return false;
    const buffer = this.term.buffer.active;
    let reference: number;
    if (this.navIsCurrent()) {
      reference = this.nav!.marker.line;
    } else if (buffer.viewportY < buffer.baseY) {
      reference = buffer.viewportY;
    } else {
      return false;
    }
    const target = prompts.find((marker) => marker.line > reference);
    if (target) {
      this.scrollToPrompt(target);
    } else {
      this.nav = null;
      this.term.scrollToBottom();
    }
    return true;
  }

  /**
   * Buffer range of the most recent finished command's output, or `null` when
   * no command with output has finished (or its output scrolled out).
   */
  lastCommandOutputRange(): BufferRange | null {
    this.prune();
    for (let i = this.records.length - 1; i >= 0; i--) {
      const record = this.records[i];
      if (record.state !== "finished" || !record.output || !record.end) continue;
      return this.outputRange(record);
    }
    return null;
  }

  /** Select the last command's output in the terminal. Returns `false` when there is none. */
  selectLastCommandOutput(): boolean {
    const range = this.lastCommandOutputRange();
    if (!range) return false;
    const { startLine, startCol, endLine, endCol } = range;
    const length = (endLine - startLine) * this.term.cols + (endCol - startCol);
    if (length <= 0) return false;
    this.term.select(startCol, startLine, length);
    this.term.scrollToLine(startLine);
    return true;
  }

  /**
   * Text of the last command's output (soft-wrapped rows rejoined, trailing
   * whitespace trimmed per line), or `null` when there is none.
   */
  getLastCommandOutput(): string | null {
    const range = this.lastCommandOutputRange();
    if (!range) return null;
    return this.readRange(range);
  }

  /** Dispose every marker and decoration the tracker owns. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearFlash();
    for (const record of this.records) this.disposeRecord(record);
    this.records = [];
    this.nav = null;
  }

  // ---------------------------------------------------------------------------
  // Mark handling
  // ---------------------------------------------------------------------------

  private apply(event: Osc133Event): void {
    if (this.disposed) return;
    // Full-screen apps own the alternate buffer; marks there are meaningless
    // (and markers would be registered on the wrong buffer).
    if (this.term.buffer.active.type === "alternate") return;
    this.prune();
    switch (event.kind) {
      case "A":
        this.onPromptStart();
        break;
      case "B":
        this.onInputStart();
        break;
      case "C":
        this.onOutputStart();
        break;
      case "D":
        this.onCommandFinished(event.exitCode);
        break;
    }
  }

  private current(): CommandRecord | undefined {
    return this.records[this.records.length - 1];
  }

  private onPromptStart(): void {
    const current = this.current();
    const line = this.cursorLine();
    if (current) {
      // A repeated A on the same prompt line (a redraw, or a shell that emits
      // its own marks alongside an injected hook) is the same prompt.
      if (current.state === "prompt" && current.prompt.line === line) return;
      // A new prompt while a command is still "running" means its D was lost:
      // close it with an unknown exit status (no decoration).
      if (current.state === "running") this.finish(current, undefined);
    }
    this.startRecord();
  }

  private onInputStart(): void {
    let current = this.current();
    if (current?.state === "input") return;
    if (!current || current.state === "running" || current.state === "finished") {
      if (current?.state === "running") this.finish(current, undefined);
      current = this.startRecord();
    }
    if (!current) return;
    const position = this.anchorAtCursor();
    if (!position) return;
    current.input = position;
    current.state = "input";
  }

  private onOutputStart(): void {
    let current = this.current();
    if (current?.state === "running") return;
    if (!current || current.state === "finished") current = this.startRecord();
    if (!current) return;
    const position = this.anchorAtCursor();
    if (!position) return;
    current.output = position;
    current.state = "running";
  }

  private onCommandFinished(exitCode: number | undefined): void {
    const current = this.current();
    // No command in flight (first prompt, empty Enter, duplicate D): ignore.
    if (!current || current.state === "prompt" || current.state === "finished") return;
    if (current.state === "input") {
      // The shell marked the input (B) but never the output (C). Fall back to
      // "output starts on the line after the input" — but only when a command
      // was actually typed; an empty Enter is not a command.
      if (!current.input || this.inputText(current.input).trim() === "") return;
      const fallback = this.anchorAtLine(current.input.marker.line + 1);
      if (!fallback) return;
      current.output = fallback;
    }
    this.finish(current, exitCode);
  }

  private finish(record: CommandRecord, exitCode: number | undefined): void {
    const end = this.anchorAtCursor();
    if (end) record.end = end;
    record.exitCode = exitCode;
    record.state = "finished";
    this.decorate(record);
  }

  private startRecord(): CommandRecord | undefined {
    const marker = this.term.registerMarker(0);
    if (!marker) return undefined;
    const record: CommandRecord = { prompt: marker, state: "prompt" };
    this.records.push(record);
    return record;
  }

  // ---------------------------------------------------------------------------
  // Buffer helpers
  // ---------------------------------------------------------------------------

  private cursorLine(): number {
    const buffer = this.term.buffer.active;
    return buffer.baseY + buffer.cursorY;
  }

  private anchorAtCursor(): AnchoredPosition | undefined {
    const marker = this.term.registerMarker(0);
    if (!marker) return undefined;
    return { marker, col: this.term.buffer.active.cursorX };
  }

  /** Anchor column 0 of `line`, clamped to the cursor line (markers cannot sit below it). */
  private anchorAtLine(line: number): AnchoredPosition | undefined {
    const offset = Math.min(line, this.cursorLine()) - this.cursorLine();
    const marker = this.term.registerMarker(offset);
    if (!marker) return undefined;
    return { marker, col: 0 };
  }

  private inputText(input: AnchoredPosition): string {
    const line = this.term.buffer.active.getLine(input.marker.line);
    return line ? line.translateToString(true, input.col) : "";
  }

  private outputRange(record: CommandRecord): BufferRange | null {
    if (!record.output || !record.end) return null;
    if (record.output.marker.isDisposed || record.end.marker.isDisposed) return null;
    const startLine = record.output.marker.line;
    const startCol = record.output.col;
    let endLine = record.end.marker.line;
    let endCol = record.end.col;
    if (endCol === 0) {
      // D landed at the start of a line: the output ended on the line above.
      endLine -= 1;
      endCol = this.term.cols;
    }
    if (endLine < startLine || (endLine === startLine && endCol <= startCol)) return null;
    return { startLine, startCol, endLine, endCol };
  }

  private readRange(range: BufferRange): string {
    const buffer = this.term.buffer.active;
    let text = "";
    for (let y = range.startLine; y <= range.endLine; y++) {
      const line = buffer.getLine(y);
      if (!line) break;
      const start = y === range.startLine ? range.startCol : 0;
      const end = y === range.endLine ? range.endCol : undefined;
      const continues = y < range.endLine && buffer.getLine(y + 1)?.isWrapped === true;
      text += line.translateToString(!continues, start, end);
      if (y < range.endLine && !continues) text += "\n";
    }
    return text;
  }

  private promptMarkers(): IMarker[] {
    return this.records.map((r) => r.prompt).filter((m) => !m.isDisposed);
  }

  // ---------------------------------------------------------------------------
  // Navigation + decorations
  // ---------------------------------------------------------------------------

  private navIsCurrent(): boolean {
    return (
      this.nav !== null &&
      !this.nav.marker.isDisposed &&
      this.term.buffer.active.viewportY === this.nav.viewportY
    );
  }

  private scrollToPrompt(marker: IMarker): void {
    this.term.scrollToLine(marker.line);
    this.nav = { marker, viewportY: this.term.buffer.active.viewportY };
    this.flashPrompt(marker);
  }

  /** Briefly highlight a prompt row so the jump target is obvious even without scrolling. */
  private flashPrompt(marker: IMarker): void {
    this.clearFlash();
    const decoration = this.term.registerDecoration({ marker, width: this.term.cols });
    if (!decoration) return;
    decoration.onRender((el) => el.classList.add(PROMPT_FLASH_CLASS));
    const timer = setTimeout(() => this.clearFlash(), PROMPT_FLASH_MS);
    this.flash = { decoration, timer };
  }

  private clearFlash(): void {
    if (!this.flash) return;
    clearTimeout(this.flash.timer);
    this.flash.decoration.dispose();
    this.flash = null;
  }

  private decorate(record: CommandRecord): void {
    if (!this.decorationsEnabled || record.decoration) return;
    if (record.state !== "finished" || record.exitCode === undefined) return;
    if (record.prompt.isDisposed) return;
    const decoration = this.term.registerDecoration({ marker: record.prompt });
    if (!decoration) return;
    const failed = record.exitCode !== 0;
    const title = failed ? `Command failed (exit code ${record.exitCode})` : "Command succeeded";
    decoration.onRender((el) => {
      el.classList.add(COMMAND_MARK_CLASS);
      el.classList.toggle(COMMAND_MARK_SUCCESS_CLASS, !failed);
      el.classList.toggle(COMMAND_MARK_FAILURE_CLASS, failed);
      el.title = title;
    });
    record.decoration = decoration;
  }

  private undecorate(record: CommandRecord): void {
    record.decoration?.dispose();
    record.decoration = undefined;
  }

  /** Drop records whose prompt line was trimmed out of the scrollback (or cleared). */
  private prune(): void {
    if (this.records.length === 0) return;
    const kept: CommandRecord[] = [];
    for (const record of this.records) {
      if (record.prompt.isDisposed) this.disposeRecord(record);
      else kept.push(record);
    }
    this.records = kept;
  }

  private disposeRecord(record: CommandRecord): void {
    this.undecorate(record);
    record.prompt.dispose();
    record.input?.marker.dispose();
    record.output?.marker.dispose();
    record.end?.marker.dispose();
  }
}

// -----------------------------------------------------------------------------
// Per-tab registry — lets the command bridge / palette reach a tab's tracker.
// -----------------------------------------------------------------------------

const trackers = new Map<string, CommandMarkTracker>();

/**
 * Register the tracker for a terminal tab. Returns an unregister function that
 * only removes the entry if it still points at this tracker (a remount may have
 * replaced it already).
 */
export function registerCommandMarkTracker(tabId: string, tracker: CommandMarkTracker): () => void {
  trackers.set(tabId, tracker);
  return () => {
    if (trackers.get(tabId) === tracker) trackers.delete(tabId);
  };
}

/** The tracker for a terminal tab, if one is mounted. */
export function getCommandMarkTracker(tabId: string): CommandMarkTracker | undefined {
  return trackers.get(tabId);
}

/** Keybinding actions driven by command marks. */
export const COMMAND_MARK_ACTIONS: ReadonlySet<string> = new Set([
  "jump-prev-prompt",
  "jump-next-prompt",
  "select-last-command-output",
  "copy-last-command-output",
]);
