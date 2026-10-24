import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INPUT_HOLD_MAX_MS,
  holdSessionInput,
  isSessionInputHeld,
  lastSessionInputAt,
  resetSessionInputGatesForTests,
  whenSessionInputOpen,
} from "./sessionInputGate";
import { frontendLog } from "@/utils/frontendLog";

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

/** A send that records its label when it runs. */
function recorder() {
  const sent: string[] = [];
  const send = (label: string) => () => {
    sent.push(label);
    return Promise.resolve(label);
  };
  return { sent, send };
}

beforeEach(() => {
  resetSessionInputGatesForTests();
  vi.mocked(frontendLog).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("session input gate (#4942)", () => {
  it("sends at once while the session is not held", async () => {
    const { sent, send } = recorder();
    await expect(whenSessionInputOpen("s1", send("a"))).resolves.toBe("a");
    expect(sent).toEqual(["a"]);
  });

  it("queues input while held and sends it in order on release", async () => {
    const { sent, send } = recorder();
    const release = holdSessionInput("s1", "resize");
    const done = Promise.all([
      whenSessionInputOpen("s1", send("a")),
      whenSessionInputOpen("s1", send("b")),
    ]);
    expect(sent).toEqual([]);
    expect(isSessionInputHeld("s1")).toBe(true);

    release();
    expect(sent).toEqual(["a", "b"]);
    await expect(done).resolves.toEqual(["a", "b"]);
    expect(isSessionInputHeld("s1")).toBe(false);
  });

  it("holds only the held session", () => {
    const { sent, send } = recorder();
    holdSessionInput("s1", "resize");
    void whenSessionInputOpen("s2", send("other"));
    expect(sent).toEqual(["other"]);
  });

  it("waits for every nested hold", () => {
    const { sent, send } = recorder();
    const show = holdSessionInput("s1", "show");
    const resize = holdSessionInput("s1", "resize");
    void whenSessionInputOpen("s1", send("a"));

    show();
    expect(sent).toEqual([]);
    resize();
    expect(sent).toEqual(["a"]);
  });

  it("treats a second release of the same hold as a no-op", () => {
    const { sent, send } = recorder();
    const first = holdSessionInput("s1", "show");
    const second = holdSessionInput("s1", "resize");
    void whenSessionInputOpen("s1", send("a"));

    first();
    first();
    expect(sent).toEqual([]);
    second();
    expect(sent).toEqual(["a"]);
  });

  it("queues input sent after a hold taken while draining behind that hold", () => {
    const { sent, send } = recorder();
    const release = holdSessionInput("s1", "show");
    let next: (() => void) | null = null;
    void whenSessionInputOpen("s1", () => {
      sent.push("a");
      next = holdSessionInput("s1", "resize");
      return Promise.resolve("a");
    });
    release();
    void whenSessionInputOpen("s1", send("b"));
    expect(sent).toEqual(["a"]);

    (next as unknown as () => void)();
    expect(sent).toEqual(["a", "b"]);
  });

  it("lifts a hold that is never released after its time bound, never dropping input", () => {
    vi.useFakeTimers();
    const { sent, send } = recorder();
    const release = holdSessionInput("s1", "resize");
    void whenSessionInputOpen("s1", send("a"));

    vi.advanceTimersByTime(INPUT_HOLD_MAX_MS - 1);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual(["a"]);
    expect(frontendLog).toHaveBeenCalledExactlyOnceWith(
      "terminal",
      expect.stringContaining("input hold (resize) lifted")
    );

    // The late release does not over-release a later hold.
    const later = holdSessionInput("s1", "show");
    release();
    void whenSessionInputOpen("s1", send("b"));
    expect(sent).toEqual(["a"]);
    later();
    expect(sent).toEqual(["a", "b"]);
  });

  it("passes a failed send's error to its caller", async () => {
    const release = holdSessionInput("s1", "resize");
    const failing = whenSessionInputOpen("s1", () => Promise.reject(new Error("closed")));
    release();
    await expect(failing).rejects.toThrow("closed");
  });

  it("records when input was sent, not when it was queued", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const release = holdSessionInput("s1", "resize");
    void whenSessionInputOpen("s1", () => Promise.resolve());
    expect(lastSessionInputAt("s1")).toBeUndefined();

    vi.setSystemTime(1200);
    release();
    expect(lastSessionInputAt("s1")).toBe(1200);
  });
});
