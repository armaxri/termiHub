/**
 * The input recorder (#5818, slice 8): collects what the user sends to one
 * terminal, byte for byte with the time between chunks, in the order it reaches
 * the session, and flags what was typed at a password prompt. Holds no store
 * state, so a keystroke copies nothing.
 */
import type { TypeKeysChunk } from "@/types/generated/TypeKeysChunk";
import { isSecretPrompt, type PromptReader } from "./passwordPrompt";

/**
 * Chunks `start`..`end` (exclusive) were typed at the password prompt `prompt`, or
 * where it is not known whether one showed (`""`).
 */
export interface SecretRun {
  start: number;
  end: number;
  prompt: string;
}

/** A finished recording. */
export interface Recorded {
  chunks: TypeKeysChunk[];
  secrets: SecretRun[];
  durationMs: number;
}

/** The place of a paste whose text is still being read. */
export interface RecordingSlot {
  fill: (data: string) => void;
  cancel: () => void;
}

/** Ends what is typed at a prompt: Enter, Ctrl+C, Ctrl+D. */
// eslint-disable-next-line no-control-regex -- the control keys themselves
const ENDS_ANSWER = /[\r\n\x03\x04]/;
/** What a prompt that masks shows for each key. */
const MASK = /^[*•●]*$/;

interface Entry {
  /** `null` while a paste is pending, and for one that was given up. */
  data: string | null;
  at: number;
  /** The password prompt it was typed at. */
  secret: OpenRun | null;
  /** What it was typed at is known, or asked ({@link InputRecorder.drain}). */
  judged: boolean;
}

/** A chunk whose prompt is being read: what has arrived may not show yet (#6070). */
interface Asked {
  entry: Entry;
  readPrompt?: PromptReader;
  apart?: string;
  /** The text it was typed behind; `null` when that cannot be told. */
  before: string | null;
  /** Whether the program read it with its echo off, where the PTY says (#6014). */
  hidden?: boolean | null;
  /** Whether `before` is the answer. */
  known: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** How long a chunk waits for what it was typed at, before it counts as not known. */
export const PROMPT_READ_LIMIT_MS = 5000;

interface OpenRun {
  prompt: string;
  /** Set apart whatever the screen shows (#6025): it is never dropped as an echo. */
  kept?: boolean;
}

/** The screen must never get in the way of typing: what cannot be read is not known. */
function readSafely(
  readPrompt: PromptReader,
  then: (before: string | null, hidden?: boolean | null) => void
): void {
  try {
    readPrompt(then);
  } catch {
    then(null);
  }
}

/**
 * Whether `now` shows typed text behind `prompt`. A line that other output has
 * replaced says nothing about an echo, so it does not count as one.
 */
function showsEcho(prompt: string, now: string): boolean {
  return now.startsWith(prompt) && !MASK.test(now.slice(prompt.length).trim());
}

/** Records one terminal's input. `now` is a monotonic clock in milliseconds. */
export class InputRecorder {
  private entries: Entry[] = [];
  private open: OpenRun | null = null;
  private readPrompt: PromptReader | null = null;
  private count = 0;
  /** Chunks that wait to be judged, in the order they were typed. */
  private readonly asked: Asked[] = [];
  /** What cannot be told, as one run while nothing else comes between. */
  private unknown: OpenRun | null = null;

  /** `onJudged` is called when a chunk was judged later than it was typed. */
  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly onJudged: () => void = () => {}
  ) {}

  /** How many chunks (keys and pastes) were recorded. */
  get keys(): number {
    return this.count;
  }

  /** Whether the user is typing at a password prompt right now. */
  get atPrompt(): boolean {
    return this.open !== null;
  }

  /**
   * Record a chunk the session was sent. `apart` names why it is set apart like
   * a password although no prompt shows: an automation waits for it (#6025).
   */
  push(data: string, readPrompt?: PromptReader, apart?: string): void {
    this.count += 1;
    this.ask({ data, at: this.now(), secret: null, judged: false }, readPrompt, apart);
  }

  /** Keep the place of a paste until its text is known. */
  reserve(readPrompt?: PromptReader, apart?: string): RecordingSlot {
    const entry: Entry = { data: null, at: this.now(), secret: null, judged: false };
    this.ask(entry, readPrompt, apart);
    let open = true;
    return {
      fill: (data) => {
        if (!open) return;
        open = false;
        entry.data = data;
        this.count += 1;
        if (entry.judged && ENDS_ANSWER.test(data)) this.open = null;
      },
      cancel: () => {
        open = false;
      },
    };
  }

  /** The recording so far. A pending paste is not part of it. */
  finish(): Recorded {
    for (const asked of this.asked) asked.known = true;
    this.drain();
    const { readPrompt } = this;
    // An answer that comes later finds nothing to change.
    if (readPrompt) readSafely(readPrompt, (before) => before && this.dropEchoedRun(before));
    const kept = this.entries.filter((e): e is Entry & { data: string } => e.data !== null);
    const chunks = kept.map(({ data, at }, i) => ({
      data,
      delayMs: i === 0 ? 0 : Math.max(0, Math.round(at - kept[i - 1].at)),
    }));
    const secrets: SecretRun[] = [];
    let run: OpenRun | null = null;
    kept.forEach(({ secret }, i) => {
      if (secret && secret === run) secrets[secrets.length - 1].end = i + 1;
      else if (secret) secrets.push({ start: i, end: i + 1, prompt: secret.prompt.trim() });
      run = secret;
    });
    const durationMs = kept.length > 0 ? Math.round(kept[kept.length - 1].at - kept[0].at) : 0;
    this.dispose();
    return { chunks, secrets, durationMs };
  }

  /** Forget everything: keys typed at a prompt must not stay in memory. */
  dispose(): void {
    for (const { timer } of this.asked.splice(0)) clearTimeout(timer);
    this.entries = [];
    this.open = null;
    this.unknown = null;
    this.readPrompt = null;
  }

  /** Record `entry`, and find out what it was typed at. */
  private ask(entry: Entry, readPrompt?: PromptReader, apart?: string): void {
    this.entries.push(entry);
    const asked: Asked = { entry, readPrompt, apart, before: null, known: false };
    this.asked.push(asked);
    let typing = true;
    const know = (before: string | null, hidden?: boolean | null) => {
      const index = this.asked.indexOf(asked);
      if (index < 0) return;
      asked.before = before;
      asked.hidden = hidden;
      asked.known = true;
      // Answers come in order: those before this one are lost.
      if (before !== null && readPrompt) {
        for (const lost of this.asked.slice(0, index)) lost.known = true;
      }
      this.drain();
      if (!typing) this.onJudged();
    };
    if (apart !== undefined || !readPrompt) know(null);
    else readSafely(readPrompt, know);
    typing = false;
    if (!asked.known) asked.timer = setTimeout(() => know(null), PROMPT_READ_LIMIT_MS);
  }

  /** Judge what is known, in the order it was typed. */
  private drain(): void {
    while (this.asked[0]?.known) {
      const { entry, readPrompt, apart, before, hidden, timer } = this.asked.shift()!;
      clearTimeout(timer);
      this.readPrompt = readPrompt ?? null;
      entry.secret = this.judge(before, apart, readPrompt !== undefined, hidden);
      entry.judged = true;
      if (entry.data !== null && ENDS_ANSWER.test(entry.data)) this.open = null;
    }
  }

  /** The run the next chunk belongs to, if it is typed at a password prompt. */
  private judge(
    before: string | null,
    apart: string | undefined,
    read: boolean,
    hidden?: boolean | null
  ): OpenRun | null {
    if (apart !== undefined) {
      if (!this.open?.kept) this.open = { prompt: apart, kept: true };
      return this.open;
    }
    // Echo off on the PTY: nothing is echoed, so nothing to drop it for (#6014).
    if (before !== null && hidden !== true) this.dropEchoedRun(before);
    // The wait it was typed for is over.
    if (this.open?.kept) this.open = null;
    if (!this.open && before !== null && isSecretPrompt(before, hidden)) {
      this.open = { prompt: before };
    }
    // Not known whether a password was asked for: kept apart, and the user decides. In a
    // run of its own, which a prompt that turns out to be none does not take along.
    const unknown = read && before === null;
    this.unknown = unknown ? (this.unknown ?? { prompt: "" }) : null;
    return this.unknown ?? this.open;
  }

  /** Keys that show up behind the "prompt" were echoed: it was no password. */
  private dropEchoedRun(before: string): void {
    const { open } = this;
    if (!open || open.kept || !showsEcho(open.prompt, before)) return;
    for (const entry of this.entries) if (entry.secret === open) entry.secret = null;
    this.open = null;
  }
}

/** A part of a recording: keys to type, or a place where something was left out. */
export type RecordedPart = { kind: "keys"; chunks: TypeKeysChunk[] } | { kind: "left-out" };

/**
 * The recording as the parts it consists of. What was typed at password prompts
 * is left out, and a part of its own says where: the replay waits there for the
 * user (#6025). The keys after it are typed at once when the user continues.
 */
export function recordedParts({
  chunks,
  secrets,
}: Pick<Recorded, "chunks" | "secrets">): RecordedPart[] {
  const parts: RecordedPart[] = [];
  chunks.forEach((chunk, i) => {
    const last = parts[parts.length - 1];
    if (secrets.some((run) => i >= run.start && i < run.end)) {
      // A second try at the prompt, or the next prompt, is the same wait.
      if (last?.kind !== "left-out") parts.push({ kind: "left-out" });
    } else if (last?.kind === "keys") {
      last.chunks.push(chunk);
    } else {
      parts.push({ kind: "keys", chunks: [{ ...chunk, delayMs: 0 }] });
    }
  });
  return parts;
}

/** The chunks without what was typed at password prompts. */
export function withoutSecrets(recorded: Pick<Recorded, "chunks" | "secrets">): TypeKeysChunk[] {
  return recordedParts(recorded).flatMap((part) => (part.kind === "keys" ? part.chunks : []));
}
