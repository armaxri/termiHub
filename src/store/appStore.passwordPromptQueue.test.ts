import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(),
}));

import { useAppStore } from "./appStore";
import { isPasswordPromptAbort } from "./slices/passwordPromptSlice";

/**
 * Concurrent password prompts (#4312, FES2-001): requestPassword queues its
 * requests FIFO and shows one at a time, so a second prompt can never orphan
 * the first one's promise. Every request settles exactly once, with its own
 * answer and its own "Save password" choice.
 */

/** Track whether a promise has settled, without awaiting it. */
function track<T>(p: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  p.then(
    (value) => {
      state.settled = true;
      state.value = value;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    }
  );
  return state;
}

/** Let pending promise callbacks run. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("appStore password prompt queue (#4312)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("queues a second prompt behind the first instead of replacing it", () => {
    const store = useAppStore.getState();
    void store.requestPassword("first.example", "alice");
    void store.requestPassword("second.example", "bob", "", "key_passphrase");

    const s = useAppStore.getState();
    expect(s.passwordPromptQueue).toHaveLength(2);
    expect(s.passwordPromptOpen).toBe(true);
    expect(s.passwordPromptHost).toBe("first.example");
    expect(s.passwordPromptUsername).toBe("alice");
    expect(s.passwordPromptKind).toBe("password");
  });

  it("resolves two concurrent prompts with their own values, in order", async () => {
    const store = useAppStore.getState();
    const first = store.requestPassword("first.example", "alice");
    const second = store.requestPassword("second.example", "bob");
    const order: string[] = [];
    void first.then(() => order.push("first"));
    void second.then(() => order.push("second"));

    useAppStore.getState().submitPassword("pw-1");
    // The second prompt is now shown.
    expect(useAppStore.getState().passwordPromptHost).toBe("second.example");
    expect(useAppStore.getState().passwordPromptOpen).toBe(true);
    useAppStore.getState().submitPassword("pw-2");

    await expect(first).resolves.toBe("pw-1");
    await expect(second).resolves.toBe("pw-2");
    expect(order).toEqual(["first", "second"]);
    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
    expect(useAppStore.getState().passwordPromptQueue).toHaveLength(0);
  });

  it("cancelling the first prompt does not affect the second", async () => {
    const store = useAppStore.getState();
    const first = track(store.requestPassword("first.example", "alice"));
    const second = track(store.requestPassword("second.example", "bob"));

    useAppStore.getState().dismissPasswordPrompt();
    await flush();
    expect(first.settled).toBe(true);
    expect(first.value).toBeNull();
    expect(second.settled).toBe(false);
    expect(useAppStore.getState().passwordPromptHost).toBe("second.example");

    useAppStore.getState().submitPassword("pw-2");
    await flush();
    expect(second.value).toBe("pw-2");
  });

  it("reports each request's own Save choice when it settles", async () => {
    const store = useAppStore.getState();
    const first = store.requestPassword("first.example", "alice");
    const second = store.requestPassword("second.example", "bob");
    const saves: boolean[] = [];
    // Callers read the flag right after their await, as the connect flows do.
    void first.then(() => saves.push(useAppStore.getState().passwordPromptShouldSave));
    void second.then(() => saves.push(useAppStore.getState().passwordPromptShouldSave));

    useAppStore.getState().submitPassword("pw-1", true);
    await flush();
    useAppStore.getState().submitPassword("pw-2", false);
    await flush();

    expect(saves).toEqual([true, false]);
  });

  it("applies each request's own allowSave and label", () => {
    const store = useAppStore.getState();
    void store.requestPassword("first.example", "alice", "", "password", {
      allowSave: false,
      label: "Prod DB",
    });
    void store.requestPassword("second.example", "bob", "", "password", { label: "Jump host" });

    expect(useAppStore.getState().passwordPromptAllowSave).toBe(false);
    expect(useAppStore.getState().passwordPromptLabel).toBe("Prod DB");
    useAppStore.getState().submitPassword("x", true);
    // The first prompt's opt-out never reports a save.
    expect(useAppStore.getState().passwordPromptShouldSave).toBe(false);
    expect(useAppStore.getState().passwordPromptAllowSave).toBe(true);
    expect(useAppStore.getState().passwordPromptLabel).toBe("Jump host");
  });

  it("removes and rejects a queued request whose owner aborts", async () => {
    const store = useAppStore.getState();
    const controller = new AbortController();
    const first = track(store.requestPassword("first.example", "alice"));
    const secondPromise = store.requestPassword("second.example", "bob", "", "password", {
      signal: controller.signal,
    });
    const second = track(secondPromise);
    const third = track(store.requestPassword("third.example", "carol"));

    controller.abort();
    await flush();

    expect(second.settled).toBe(true);
    expect(isPasswordPromptAbort(second.error)).toBe(true);
    await expect(secondPromise).rejects.toSatisfy(isPasswordPromptAbort);
    expect(useAppStore.getState().passwordPromptQueue.map((r) => r.host)).toEqual([
      "first.example",
      "third.example",
    ]);
    // The prompt on screen is untouched.
    expect(useAppStore.getState().passwordPromptHost).toBe("first.example");
    expect(first.settled).toBe(false);

    useAppStore.getState().submitPassword("pw-1");
    useAppStore.getState().submitPassword("pw-3");
    await flush();
    expect(first.value).toBe("pw-1");
    expect(third.value).toBe("pw-3");
  });

  it("aborting the prompt on screen advances to the next one", async () => {
    const store = useAppStore.getState();
    const controller = new AbortController();
    const first = track(
      store.requestPassword("first.example", "alice", "", "password", {
        signal: controller.signal,
      })
    );
    const second = track(store.requestPassword("second.example", "bob"));

    controller.abort();
    await flush();
    expect(isPasswordPromptAbort(first.error)).toBe(true);
    expect(useAppStore.getState().passwordPromptHost).toBe("second.example");

    useAppStore.getState().submitPassword("pw-2");
    await flush();
    expect(second.value).toBe("pw-2");
  });

  it("rejects immediately, without queueing, when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const p = useAppStore.getState().requestPassword("h", "u", "", "password", {
      signal: controller.signal,
    });
    await expect(p).rejects.toSatisfy(isPasswordPromptAbort);
    expect(useAppStore.getState().passwordPromptQueue).toHaveLength(0);
    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
  });

  it("settles each request exactly once: an abort after submit is a no-op", async () => {
    const controller = new AbortController();
    const p = useAppStore.getState().requestPassword("h", "u", "", "password", {
      signal: controller.signal,
    });
    useAppStore.getState().submitPassword("pw");
    controller.abort();
    await expect(p).resolves.toBe("pw");
  });

  it("leaves no orphaned promise across a mixed burst of requests", async () => {
    const store = useAppStore.getState();
    const controllers = Array.from({ length: 6 }, () => new AbortController());
    const tracked = controllers.map((c, i) =>
      track(store.requestPassword(`host-${i}`, "u", "", "password", { signal: c.signal }))
    );

    controllers[3].abort();
    useAppStore.getState().submitPassword("a");
    useAppStore.getState().dismissPasswordPrompt();
    controllers[5].abort();
    // Remaining queue: host-2, host-4.
    useAppStore.getState().submitPassword("c");
    useAppStore.getState().dismissPasswordPrompt();
    await flush();

    expect(tracked.every((t) => t.settled)).toBe(true);
    expect(tracked.map((t) => (t.error ? "aborted" : t.value))).toEqual([
      "a",
      null,
      "c",
      "aborted",
      null,
      "aborted",
    ]);
    expect(useAppStore.getState().passwordPromptQueue).toHaveLength(0);
    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
  });
});
