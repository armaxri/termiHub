/**
 * The input recorder (#5818, slice 8): collects what the user sends to one
 * terminal, byte for byte with the time between chunks, in the order it reaches
 * the session, and flags what was typed at a password prompt. Holds no store
 * state, so a keystroke copies nothing.
 */
import type { TypeKeysChunk } from "@/types/generated/TypeKeysChunk";
import { isPasswordPrompt } from "./passwordPrompt";

/** Chunks `start`..`end` (exclusive) were typed at the password prompt `prompt`. */
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

/** Reads the text in front of the terminal's cursor. */
export type ReadPrompt = () => string;

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
}

interface OpenRun {
  prompt: string;
  /** Set apart whatever the screen shows (#6025): it is never dropped as an echo. */
  kept?: boolean;
}

/** The screen must never get in the way of typing: what cannot be read is no prompt. */
function readSafely(readPrompt: ReadPrompt): string {
  try {
    return readPrompt();
  } catch {
    return "";
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
  private readonly entries: Entry[] = [];
  private open: OpenRun | null = null;
  private readPrompt: ReadPrompt | null = null;
  private count = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

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
  push(data: string, readPrompt?: ReadPrompt, apart?: string): void {
    const secret = this.judge(readPrompt, apart);
    this.entries.push({ data, at: this.now(), secret });
    this.count += 1;
    if (ENDS_ANSWER.test(data)) this.open = null;
  }

  /** Keep the place of a paste until its text is known. */
  reserve(readPrompt?: ReadPrompt, apart?: string): RecordingSlot {
    const entry: Entry = { data: null, at: this.now(), secret: this.judge(readPrompt, apart) };
    this.entries.push(entry);
    let open = true;
    return {
      fill: (data) => {
        if (!open) return;
        open = false;
        entry.data = data;
        this.count += 1;
        if (ENDS_ANSWER.test(data)) this.open = null;
      },
      cancel: () => {
        open = false;
      },
    };
  }

  /** The recording so far. A pending paste is not part of it. */
  finish(): Recorded {
    this.dropEchoedRun();
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
    return { chunks, secrets, durationMs };
  }

  /** The run the next chunk belongs to, if it is typed at a password prompt. */
  private judge(readPrompt: ReadPrompt | undefined, apart?: string): OpenRun | null {
    this.readPrompt = readPrompt ?? null;
    if (apart !== undefined) {
      if (!this.open?.kept) this.open = { prompt: apart, kept: true };
      return this.open;
    }
    this.dropEchoedRun();
    // The wait it was typed for is over.
    if (this.open?.kept) this.open = null;
    if (!this.open && readPrompt) {
      const before = readSafely(readPrompt);
      if (isPasswordPrompt(before)) this.open = { prompt: before };
    }
    return this.open;
  }

  /** Keys that show up behind the "prompt" were echoed: it was no password. */
  private dropEchoedRun(): void {
    const { open, readPrompt } = this;
    if (!open || open.kept || !readPrompt || !showsEcho(open.prompt, readSafely(readPrompt)))
      return;
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
