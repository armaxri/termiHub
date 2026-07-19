/**
 * Terminal output syntax-highlighting engine.
 *
 * A `SyntaxHighlightingEngine` binds to an xterm.js `Terminal` and colorizes
 * plain (uncolored) output by overlaying native `foregroundColor` decorations
 * on matched cell ranges. It never overrides colors the remote server already
 * set via ANSI SGR: every candidate cell is checked with
 * `IBufferCell.isFgDefault()` and only default-foreground cells are recolored.
 *
 * This module is deliberately self-contained and unit-testable — it does not
 * touch the React terminal lifecycle. Wiring the engine into `Terminal.tsx`
 * (resolving effective config, reacting to settings changes) is a separate
 * concern (issue #1700).
 *
 * The matching logic (`compileRules`, `findMatches`) is exported as pure
 * functions so it can be tested without a terminal instance.
 *
 * See `docs/concepts/partial/terminal-syntax-highlighting.md`.
 */

import type { IBufferCell, IBufferLine, IDisposable, Terminal } from "@xterm/xterm";
import type { HighlightRule, HighlightStyle } from "../types/syntaxHighlighting";
import { frontendLog } from "../utils/frontendLog";

/** Lines longer than this (whole logical line) are skipped to avoid ReDoS/backtracking cost. */
export const MAX_LINE_LENGTH = 10_000;

/** Default number of logical lines scanned per frame before deferring the rest. */
export const DEFAULT_LINE_BUDGET = 200;

/** onWriteParsed events within the trailing second above this count enter the throttled state. */
const THROTTLE_WRITES_PER_SEC = 50;

/** Trailing window used to estimate write throughput. */
const THROUGHPUT_WINDOW_MS = 1_000;

/** A rule compiled into an executable matcher. */
export interface CompiledRule {
  /** The originating rule. */
  rule: HighlightRule;
  /** Global regex used to scan a line (always has the `g` flag). */
  regex: RegExp;
  /** Normalized `#RRGGBB` color. */
  color: string;
  /** Priority (lower wins). */
  priority: number;
  /** Position in the rule list (used as the final tie-breaker). */
  order: number;
}

/** A resolved, non-overlapping match on a logical line. */
export interface RuleMatch {
  /** Inclusive start column in the logical line. */
  start: number;
  /** Exclusive end column in the logical line. */
  end: number;
  /** The matched rule. */
  rule: HighlightRule;
  /** Normalized `#RRGGBB` color to apply. */
  color: string;
}

/** Options for {@link SyntaxHighlightingEngine}. */
export interface SyntaxHighlightingEngineOptions {
  /** Max logical lines scanned per frame (default {@link DEFAULT_LINE_BUDGET}). */
  lineBudget?: number;
  /** Max logical line length before skipping (default {@link MAX_LINE_LENGTH}). */
  maxLineLength?: number;
}

/** The subset of {@link HighlightStyle} the native color recolor cannot express. */
type TextStyle = Pick<HighlightStyle, "bold" | "italic" | "underline">;

/** Font attributes copied onto a styled overlay so its glyphs line up with the cells. */
export interface DecorationFont {
  fontFamily?: string;
  fontSize?: number;
  letterSpacing?: number;
}

/** Whether a rule asks for any attribute the native `foregroundColor` recolor cannot render. */
function hasTextStyle(style: TextStyle): boolean {
  return !!(style.bold || style.italic || style.underline);
}

/**
 * Fills a decoration's overlay element with the matched text and applies
 * bold/italic/underline.
 *
 * xterm's native `IDecorationOptions.foregroundColor` recolors the real buffer
 * cell, which is how the color path works — but it cannot express weight, slant
 * or underline. The decoration's `onRender` element is a separate, empty,
 * exactly-sized (`width` cells × cell height, correct `line-height`) overlay
 * `div.xterm-decoration`. Styling that *empty* div (the buggy approach shown in
 * the concept doc) has no glyph to act on, so nothing renders.
 *
 * Giving the overlay the matched text — in the rule color, with the terminal's
 * own font metrics so the monospace glyphs land exactly over the recolored
 * cells — is what makes the styles visible. Registered on the top layer, the
 * styled copy over-paints the (identically colored) real glyph, adding the
 * weight/slant/underline that the recolor alone cannot.
 */
export function styleDecorationElement(
  el: HTMLElement,
  text: string,
  color: string,
  style: TextStyle,
  font: DecorationFont = {}
): void {
  el.textContent = text;
  el.style.color = color;
  el.style.whiteSpace = "pre";
  el.style.overflow = "hidden";
  // The real text underneath owns selection and clicks; never intercept them.
  el.style.pointerEvents = "none";
  if (font.fontFamily) el.style.fontFamily = font.fontFamily;
  if (font.fontSize) el.style.fontSize = `${font.fontSize}px`;
  if (font.letterSpacing) el.style.letterSpacing = `${font.letterSpacing}px`;
  el.style.fontWeight = style.bold ? "bold" : "";
  el.style.fontStyle = style.italic ? "italic" : "";
  el.style.textDecoration = style.underline ? "underline" : "";
}

const HEX_FULL = /^#[0-9a-fA-F]{6}$/;
const HEX_SHORT = /^#[0-9a-fA-F]{3}$/;

/**
 * Normalizes a color string to the `#RRGGBB` form xterm.js decorations require.
 * Expands `#RGB` shorthand. Returns `null` for anything else (named colors,
 * `rgb()`, alpha hex, garbage) so callers can safely skip it.
 */
export function normalizeHexColor(color: string): string | null {
  const value = color.trim();
  if (HEX_FULL.test(value)) return value.toLowerCase();
  if (HEX_SHORT.test(value)) {
    const r = value[1];
    const g = value[2];
    const b = value[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return null;
}

/**
 * Compiles enabled rules into executable matchers. Rules that are disabled,
 * have an invalid regex, or resolve to an unusable color are dropped (with a
 * console warning for the latter two) so a single bad rule never breaks the
 * whole engine.
 */
export function compileRules(rules: readonly HighlightRule[]): CompiledRule[] {
  const compiled: CompiledRule[] = [];
  rules.forEach((rule, order) => {
    if (!rule.enabled) return;

    const color = normalizeHexColor(rule.style.color);
    if (!color) {
      frontendLog(
        "syntaxHighlighting",
        `rule "${rule.id}" has an unsupported color "${rule.style.color}"; skipping.`
      );
      return;
    }

    let source = rule.pattern;
    if (rule.wholeWord) source = `\\b(?:${source})\\b`;
    const flags = rule.caseSensitive === false ? "gi" : "g";

    let regex: RegExp;
    try {
      regex = new RegExp(source, flags);
    } catch (err) {
      frontendLog(
        "syntaxHighlighting",
        `rule "${rule.id}" has an invalid pattern; skipping. ${String(err)}`
      );
      return;
    }

    compiled.push({ rule, regex, color, priority: rule.priority, order });
  });
  return compiled;
}

interface Candidate extends RuleMatch {
  priority: number;
  order: number;
}

/**
 * Runs all compiled rules against `text` and resolves overlaps into a
 * non-overlapping, left-to-right ordered set of matches.
 *
 * Resolution order when two matches overlap:
 *   1. longest match wins,
 *   2. then lower priority number wins,
 *   3. then the earlier rule in the list wins,
 *   4. then the earlier start position wins.
 */
export function findMatches(text: string, compiled: readonly CompiledRule[]): RuleMatch[] {
  const candidates: Candidate[] = [];

  for (const c of compiled) {
    c.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = c.regex.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      // Guard against zero-width matches (would loop forever / decorate nothing).
      if (end <= start) {
        c.regex.lastIndex = start + 1;
        continue;
      }
      candidates.push({
        start,
        end,
        rule: c.rule,
        color: c.color,
        priority: c.priority,
        order: c.order,
      });
    }
  }

  // Strongest candidates first: longer, then higher priority, then earlier rule,
  // then earlier position.
  candidates.sort((a, b) => {
    const lenDiff = b.end - b.start - (a.end - a.start);
    if (lenDiff !== 0) return lenDiff;
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.order !== b.order) return a.order - b.order;
    return a.start - b.start;
  });

  const accepted: RuleMatch[] = [];
  for (const cand of candidates) {
    const overlaps = accepted.some((acc) => cand.start < acc.end && acc.start < cand.end);
    if (!overlaps) {
      accepted.push({ start: cand.start, end: cand.end, rule: cand.rule, color: cand.color });
    }
  }

  accepted.sort((a, b) => a.start - b.start);
  return accepted;
}

/**
 * Extracts the logical line that starts at absolute buffer row `startRow`,
 * joining soft-wrapped continuation rows. Returns `null` if there is no line or
 * `startRow` is itself a wrapped continuation (i.e. not a logical start).
 */
function readLogicalLine(
  buffer: Terminal["buffer"]["active"],
  startRow: number
): { text: string; rows: number[] } | null {
  const first = buffer.getLine(startRow);
  if (!first || first.isWrapped) return null;

  const rows = [startRow];
  let text = first.translateToString(false);

  for (let row = startRow + 1; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line || !line.isWrapped) break;
    rows.push(row);
    text += line.translateToString(false);
  }

  return { text, rows };
}

/** Walks up from `row` to the absolute index where its logical line begins. */
function logicalLineStart(buffer: Terminal["buffer"]["active"], row: number): number {
  let start = row;
  while (start > 0) {
    const line = buffer.getLine(start);
    if (!line || !line.isWrapped) break;
    start--;
  }
  return start;
}

/**
 * The engine. Instantiate once per terminal, then `enable(rules)`. Toggle with
 * `enable`/`disable`, swap rules with `updateRules`, and `dispose` on teardown.
 */
export class SyntaxHighlightingEngine {
  private readonly xterm: Terminal;
  private readonly lineBudget: number;
  private readonly maxLineLength: number;

  private compiled: CompiledRule[] = [];
  private enabled = false;

  /** Per-logical-line (keyed by absolute start row) disposables: markers + decorations. */
  private readonly lineDisposables = new Map<number, IDisposable[]>();
  /** onWriteParsed subscription. */
  private writeParsedSub: IDisposable | null = null;

  /** Highest absolute row we consider fully scanned (the cursor line is re-scannable). */
  private scannedThrough = -1;
  /** Logical-line start rows awaiting a scan. */
  private readonly dirtyQueue: number[] = [];
  private readonly dirtySet = new Set<number>();
  /** Timestamps of recent onWriteParsed events, for throughput estimation. */
  private writeTimes: number[] = [];
  /** Pending scheduled drain handle. */
  private drainScheduled = false;
  /** Last observed buffer length, to detect screen resets/clears. */
  private lastBufferLength = 0;

  constructor(xterm: Terminal, options: SyntaxHighlightingEngineOptions = {}) {
    this.xterm = xterm;
    this.lineBudget = options.lineBudget ?? DEFAULT_LINE_BUDGET;
    this.maxLineLength = options.maxLineLength ?? MAX_LINE_LENGTH;
  }

  /** Whether highlighting is currently active. */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Enables highlighting with the given rules: compiles them, registers the
   * write hook, and scans the current viewport so already-visible output gets
   * highlighted immediately.
   */
  enable(rules: readonly HighlightRule[]): void {
    if (this.enabled) {
      this.updateRules(rules);
      return;
    }
    this.enabled = true;
    this.compiled = compileRules(rules);
    this.lastBufferLength = this.xterm.buffer.active.length;
    this.writeParsedSub = this.xterm.onWriteParsed(() => this.onWriteParsed());
    this.rescanEverything();
  }

  /** Disables highlighting and removes every decoration and the write hook. */
  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.writeParsedSub?.dispose();
    this.writeParsedSub = null;
    this.clearAllDecorations();
    this.dirtyQueue.length = 0;
    this.dirtySet.clear();
    this.writeTimes = [];
    this.scannedThrough = -1;
    this.drainScheduled = false;
  }

  /** Recompiles rules and re-scans everything currently in the buffer. */
  updateRules(rules: readonly HighlightRule[]): void {
    this.compiled = compileRules(rules);
    if (!this.enabled) return;
    this.rescanEverything();
  }

  /**
   * Discards all decoration state and re-baselines scanning. Intended to be
   * called by the terminal wiring on a screen clear / reset (`\x1b[2J`,
   * `\x1b[3J`, `\x1bc`). Cheap to call spuriously.
   */
  clear(): void {
    this.clearAllDecorations();
    this.dirtyQueue.length = 0;
    this.dirtySet.clear();
    this.scannedThrough = -1;
    if (this.enabled) this.lastBufferLength = this.xterm.buffer.active.length;
  }

  /** Tears the engine down completely. After this the instance must not be reused. */
  dispose(): void {
    this.disable();
  }

  // --- internals ---------------------------------------------------------

  private onWriteParsed(): void {
    if (!this.enabled) return;

    const buffer = this.xterm.buffer.active;

    // Highlighting is meaningless on the alternate screen (vim/less/htop own
    // the colors there). Skip scanning while it is active.
    if (buffer.type === "alternate") {
      this.lastBufferLength = buffer.length;
      return;
    }

    // A shrinking buffer means a reset/clear happened; drop stale state.
    if (buffer.length < this.lastBufferLength) {
      this.clear();
    }
    this.lastBufferLength = buffer.length;

    this.recordWrite(now());
    this.enqueueDirtyLines(buffer);
    this.processQueue();
  }

  /** Enqueues logical-line starts for rows written since the last scan. */
  private enqueueDirtyLines(buffer: Terminal["buffer"]["active"]): void {
    const cursorAbs = buffer.baseY + buffer.cursorY;
    const from = Math.max(0, this.scannedThrough + 1);

    for (let row = from; row <= cursorAbs && row < buffer.length; row++) {
      const line = buffer.getLine(row);
      if (line && !line.isWrapped) this.markDirty(row);
    }

    // The cursor's own logical line is still being written; keep re-scanning it
    // (its start may be above `from` if it soft-wrapped).
    this.markDirty(logicalLineStart(buffer, cursorAbs));

    // Everything strictly above the cursor line is complete.
    this.scannedThrough = cursorAbs - 1;
  }

  private markDirty(startRow: number): void {
    if (this.dirtySet.has(startRow)) return;
    this.dirtySet.add(startRow);
    this.dirtyQueue.push(startRow);
  }

  /** Processes up to `lineBudget` queued lines; defers the rest to a drain. */
  private processQueue(): void {
    if (this.isThrottled()) {
      this.scheduleDrain();
      return;
    }

    let processed = 0;
    while (this.dirtyQueue.length > 0 && processed < this.lineBudget) {
      const startRow = this.dirtyQueue.shift() as number;
      this.dirtySet.delete(startRow);
      this.scanLine(startRow);
      processed++;
    }

    if (this.dirtyQueue.length > 0) this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    const run = (): void => {
      this.drainScheduled = false;
      if (!this.enabled) return;
      this.processQueue();
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(run);
    } else {
      queueMicrotask(run);
    }
  }

  private recordWrite(ts: number): void {
    this.writeTimes.push(ts);
    this.pruneWriteTimes(ts);
  }

  private pruneWriteTimes(ts: number): void {
    const cutoff = ts - THROUGHPUT_WINDOW_MS;
    while (this.writeTimes.length > 0 && this.writeTimes[0] < cutoff) {
      this.writeTimes.shift();
    }
  }

  private isThrottled(): boolean {
    this.pruneWriteTimes(now());
    return this.writeTimes.length >= THROTTLE_WRITES_PER_SEC;
  }

  /** Scans a single logical line and (re)applies its decorations. */
  private scanLine(startRow: number): void {
    const buffer = this.xterm.buffer.active;
    this.disposeLine(startRow);

    const logical = readLogicalLine(buffer, startRow);
    if (!logical) return;
    if (logical.text.length > this.maxLineLength) return;
    if (this.compiled.length === 0) return;

    const matches = findMatches(logical.text, this.compiled);
    if (matches.length === 0) return;

    const cols = this.xterm.cols;
    const cursorAbs = buffer.baseY + buffer.cursorY;
    const lineCache = new Map<number, IBufferLine | undefined>();
    const cellRef = buffer.getNullCell();
    const disposables: IDisposable[] = [];

    const getRowLine = (row: number): IBufferLine | undefined => {
      if (!lineCache.has(row)) lineCache.set(row, buffer.getLine(row));
      return lineCache.get(row);
    };

    for (const match of matches) {
      this.applyMatch(match, logical.rows, cols, cursorAbs, getRowLine, cellRef, disposables);
    }

    if (disposables.length > 0) this.lineDisposables.set(startRow, disposables);
  }

  /**
   * Applies one match, splitting it into contiguous runs of default-foreground
   * cells on a single physical row. ANSI-colored cells break a run so the
   * server's colors always win.
   */
  private applyMatch(
    match: RuleMatch,
    rows: number[],
    cols: number,
    cursorAbs: number,
    getRowLine: (row: number) => IBufferLine | undefined,
    cellRef: IBufferCell,
    out: IDisposable[]
  ): void {
    let runRow = -1;
    let runStartX = -1;
    let runWidth = 0;
    let runText = "";

    const flush = (): void => {
      if (runWidth <= 0) return;
      this.decorate(runRow, runStartX, runWidth, cursorAbs, match, runText, out);
      runWidth = 0;
      runText = "";
    };

    for (let col = match.start; col < match.end; col++) {
      const rowIndex = cols > 0 ? Math.floor(col / cols) : 0;
      const physRow = rows[rowIndex];
      const x = cols > 0 ? col % cols : col;

      const line = physRow === undefined ? undefined : getRowLine(physRow);
      const cell = line?.getCell(x, cellRef);
      const decorable = !!cell && cell.isFgDefault();
      // One char per decorable cell keeps the styled overlay's text aligned with
      // the cells it covers. Blank/trailing cells fall back to a space.
      const char = decorable && cell ? cell.getChars() || " " : "";

      const contiguous = decorable && physRow === runRow && x === runStartX + runWidth;
      if (contiguous) {
        runWidth++;
        runText += char;
      } else {
        flush();
        if (decorable) {
          runRow = physRow as number;
          runStartX = x;
          runWidth = 1;
          runText = char;
        } else {
          runWidth = 0;
          runText = "";
        }
      }
    }
    flush();
  }

  /**
   * Registers a marker + decoration for one run of cells. The native
   * `foregroundColor` recolors the real glyph (the color path). When the rule
   * also asks for bold/italic/underline — which the recolor cannot express —
   * the decoration renders on the top layer and its overlay element is filled
   * with the run's styled text on render (see {@link styleDecorationElement}).
   */
  private decorate(
    physRow: number,
    x: number,
    width: number,
    cursorAbs: number,
    match: RuleMatch,
    text: string,
    out: IDisposable[]
  ): void {
    const marker = this.xterm.registerMarker(physRow - cursorAbs);
    if (!marker) return;

    const style = match.rule.style;
    const styled = hasTextStyle(style);

    const decoration = this.xterm.registerDecoration({
      marker,
      x,
      width,
      foregroundColor: match.color,
      // Color-only runs render under the selection so selected text stays
      // legible. Styled runs put their glyphs in the overlay, which must sit
      // above the text layer to be seen, so they render on top.
      layer: styled ? "top" : "bottom",
    });

    // If the decoration could not be created (e.g. alt buffer raced in), drop
    // the orphan marker so it does not leak.
    if (!decoration) {
      marker.dispose();
      return;
    }

    out.push(decoration, marker);

    if (!styled) return;

    const font: DecorationFont = {
      fontFamily: this.xterm.options.fontFamily,
      fontSize: this.xterm.options.fontSize,
      letterSpacing: this.xterm.options.letterSpacing,
    };
    const sub = decoration.onRender((el) => {
      // Idempotent per element: xterm fires onRender every frame, so style each
      // (re)created overlay only once to avoid needless layout churn on scroll.
      if (el.dataset.thHighlightStyled === "1") return;
      styleDecorationElement(el, text, match.color, style, font);
      el.dataset.thHighlightStyled = "1";
    });
    out.push(sub);
  }

  /** Disposes and forgets a single logical line's decorations. */
  private disposeLine(startRow: number): void {
    const disposables = this.lineDisposables.get(startRow);
    if (!disposables) return;
    for (const d of disposables) d.dispose();
    this.lineDisposables.delete(startRow);
  }

  private clearAllDecorations(): void {
    for (const disposables of this.lineDisposables.values()) {
      for (const d of disposables) d.dispose();
    }
    this.lineDisposables.clear();
  }

  /** Re-baselines and scans every logical line currently in the buffer. */
  private rescanEverything(): void {
    this.clearAllDecorations();
    this.dirtyQueue.length = 0;
    this.dirtySet.clear();
    this.scannedThrough = -1;

    const buffer = this.xterm.buffer.active;
    if (buffer.type === "alternate") return;

    const cursorAbs = buffer.baseY + buffer.cursorY;
    for (let row = 0; row < buffer.length; row++) {
      const line = buffer.getLine(row);
      if (line && !line.isWrapped) this.markDirty(row);
    }
    this.scannedThrough = cursorAbs - 1;
    this.processQueue();
  }
}

/** Monotonic-ish timestamp; falls back to Date.now when performance is absent. */
function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/** Re-exported for callers that want the raw style shape. */
export type { HighlightStyle };
