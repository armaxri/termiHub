import { describe, it, expect } from "vitest";
import type { LogEntry } from "@/types/terminal";
import { formatLogTime } from "@/utils/formatters";
import { displayTimestamp, entryTimeMs, exportTimestamp, mergeChronological } from "./logTime";

function entry(message: string, timestampMs?: number, timestamp?: string): LogEntry {
  return {
    timestamp: timestamp ?? (timestampMs === undefined ? "" : new Date(timestampMs).toISOString()),
    level: "INFO",
    target: "t",
    message,
    ...(timestampMs === undefined ? {} : { timestampMs }),
  };
}

const T0 = Date.UTC(2026, 9, 10, 8, 0, 0, 0);

describe("entryTimeMs (#4536)", () => {
  it("prefers timestampMs", () => {
    expect(entryTimeMs(entry("a", T0 + 5, "2000-01-01T00:00:00.000Z"))).toBe(T0 + 5);
  });

  it("falls back to an ISO-8601 timestamp string", () => {
    expect(entryTimeMs(entry("a", undefined, new Date(T0).toISOString()))).toBe(T0);
  });

  it("is undefined for a legacy backend HH:MM:SS.mmm string", () => {
    expect(entryTimeMs(entry("a", undefined, "12:34:56.789"))).toBeUndefined();
  });
});

describe("Log Viewer timestamp format (#4536)", () => {
  it("displays frontend- and backend-shaped entries identically", () => {
    const frontend: LogEntry = {
      timestamp: new Date(T0 + 123).toISOString(),
      timestampMs: T0 + 123,
      level: "WARN",
      target: "frontend::probe",
      message: "f",
    };
    const backend: LogEntry = {
      timestamp: "2026-10-10T08:00:00.123Z",
      timestampMs: T0 + 123,
      level: "WARN",
      target: "termihub::ssh",
      message: "b",
    };
    expect(displayTimestamp(frontend)).toBe(displayTimestamp(backend));
    expect(displayTimestamp(frontend)).toBe(formatLogTime(T0 + 123));
    // 24-hour HH:MM:SS plus milliseconds.
    expect(displayTimestamp(frontend)).toMatch(/\d{2}\D\d{2}\D\d{2}\D123$/);
  });

  it("shows a legacy timestamp string verbatim when no time can be derived", () => {
    expect(displayTimestamp(entry("a", undefined, "12:34:56.789"))).toBe("12:34:56.789");
  });

  it("exports ISO-8601 UTC", () => {
    expect(exportTimestamp(entry("a", T0 + 7))).toBe("2026-10-10T08:00:00.007Z");
    expect(exportTimestamp(entry("a", undefined, "2026-09-25T06:00:00Z"))).toBe(
      "2026-09-25T06:00:00.000Z"
    );
    expect(exportTimestamp(entry("a", undefined, "12:34:56.789"))).toBe("12:34:56.789");
  });
});

describe("mergeChronological (#4536)", () => {
  const messages = (list: LogEntry[]) => list.map((e) => e.message);

  it("interleaves two chronological lists by time", () => {
    const backend = [entry("b1", T0 + 10), entry("b2", T0 + 30), entry("b3", T0 + 50)];
    const frontend = [entry("f1", T0 + 5), entry("f2", T0 + 40), entry("f3", T0 + 60)];
    expect(messages(mergeChronological(backend, frontend))).toEqual([
      "f1",
      "b1",
      "b2",
      "f2",
      "b3",
      "f3",
    ]);
  });

  it("puts the first list first on a tie", () => {
    expect(messages(mergeChronological([entry("b", T0)], [entry("f", T0)]))).toEqual(["b", "f"]);
  });

  it("handles empty sides", () => {
    const list = [entry("a", T0), entry("b", T0 + 1)];
    expect(mergeChronological([], list)).toEqual(list);
    expect(mergeChronological(list, [])).toEqual(list);
  });

  it("keeps an untimed entry in place in its own list", () => {
    const backend = [entry("b1", T0 + 10), entry("legacy", undefined, "12:00:00.000")];
    const frontend = [entry("f1", T0 + 5), entry("f2", T0 + 20)];
    const merged = messages(mergeChronological(backend, frontend));
    expect(merged).toHaveLength(4);
    expect(merged.indexOf("b1")).toBeLessThan(merged.indexOf("legacy"));
    expect(merged.indexOf("f1")).toBeLessThan(merged.indexOf("f2"));
    expect(merged.indexOf("f1")).toBeLessThan(merged.indexOf("b1"));
  });
});
