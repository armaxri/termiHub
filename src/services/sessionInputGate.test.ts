import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INPUT_HOLD_MAX_MS,
  holdSessionInput,
  isSessionInputHeld,
  lastSessionInputAt,
  reserveSessionInputSlot,
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

/** Let queued promise callbacks run (send chaining is promise-based). */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe("session input slots (#5026)", () => {
  it("keeps input sent after a reservation behind the slot until it is filled", async () => {
    const { sent, send } = recorder();
    const slot = reserveSessionInputSlot("s1", "paste");
    void whenSessionInputOpen("s1", send("after"));
    await flush();
    expect(sent).toEqual([]);
    expect(isSessionInputHeld("s1")).toBe(true);

    await slot.fill(() => whenSessionInputOpen("s1", send("paste")));
    await flush();
    expect(sent).toEqual(["paste", "after"]);
    expect(isSessionInputHeld("s1")).toBe(false);
  });

  it("does not delay input sent before the reservation", async () => {
    const { sent, send } = recorder();
    void whenSessionInputOpen("s1", send("before"));
    const slot = reserveSessionInputSlot("s1", "paste");
    await flush();
    expect(sent).toEqual(["before"]);
    slot.cancel();
  });

  it("fills the slot in its place among input held by a resize", async () => {
    const { sent, send } = recorder();
    const release = holdSessionInput("s1", "resize");
    void whenSessionInputOpen("s1", send("a"));
    const slot = reserveSessionInputSlot("s1", "paste");
    void whenSessionInputOpen("s1", send("b"));

    void slot.fill(() => whenSessionInputOpen("s1", send("paste")));
    await flush();
    expect(sent).toEqual([]);

    release();
    await flush();
    expect(sent).toEqual(["a", "paste", "b"]);
  });

  it("releases the slot on cancel and sends the input queued behind it", async () => {
    const { sent, send } = recorder();
    const slot = reserveSessionInputSlot("s1", "paste");
    void whenSessionInputOpen("s1", send("x"));
    void whenSessionInputOpen("s1", send("y"));
    slot.cancel();
    slot.cancel();
    await flush();
    expect(sent).toEqual(["x", "y"]);
    expect(isSessionInputHeld("s1")).toBe(false);
  });

  it("lifts a slot that is never filled after its bound, and a late fill still sends", async () => {
    vi.useFakeTimers();
    const { sent, send } = recorder();
    const slot = reserveSessionInputSlot("s1", "paste");
    void whenSessionInputOpen("s1", send("key"));

    vi.advanceTimersByTime(INPUT_HOLD_MAX_MS - 1);
    await flush();
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    await flush();
    expect(sent).toEqual(["key"]);
    expect(frontendLog).toHaveBeenCalledWith(
      "terminal",
      expect.stringContaining("input slot (paste) lifted")
    );

    await slot.fill(() => whenSessionInputOpen("s1", send("late")));
    await flush();
    expect(sent).toEqual(["key", "late"]);
  });

  it("extend restarts the bound (a paste waiting on its confirmation)", async () => {
    vi.useFakeTimers();
    const { sent, send } = recorder();
    const slot = reserveSessionInputSlot("s1", "paste");
    void whenSessionInputOpen("s1", send("key"));
    slot.extend(10 * INPUT_HOLD_MAX_MS);

    vi.advanceTimersByTime(5 * INPUT_HOLD_MAX_MS);
    await flush();
    expect(sent).toEqual([]);

    void slot.fill(() => whenSessionInputOpen("s1", send("paste")));
    await flush();
    expect(sent).toEqual(["paste", "key"]);
  });

  it("keeps several sends of one fill together, in order, in the slot", async () => {
    const { sent, send } = recorder();
    const slot = reserveSessionInputSlot("s1", "paste");
    void whenSessionInputOpen("s1", send("key"));
    void slot.fill(() =>
      Promise.all([whenSessionInputOpen("s1", send("p1")), whenSessionInputOpen("s1", send("p2"))])
    );
    await flush();
    expect(sent).toEqual(["p1", "p2", "key"]);
  });

  it("does not let a fill for one session take another session's slot", async () => {
    const { sent, send } = recorder();
    const s1 = reserveSessionInputSlot("s1", "paste");
    const s2 = reserveSessionInputSlot("s2", "paste");
    void whenSessionInputOpen("s2", send("s2-key"));
    void s1.fill(() => whenSessionInputOpen("s2", send("s2-other")));
    await flush();
    expect(sent).toEqual([]);
    s2.cancel();
    await flush();
    expect(sent).toEqual(["s2-key", "s2-other"]);
  });
});
