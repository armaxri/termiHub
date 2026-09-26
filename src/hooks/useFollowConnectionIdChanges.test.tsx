import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushAsync } from "@/test/flushAsync";
import {
  installConnectionIdChangesHarness,
  type ConnectionIdChangesHarness,
} from "@/test/connectionIdChangesHarness";
import type { ConnectionIdChange } from "@/types/connection";
import { remapConnectionIdList, type ConnectionIdRemap } from "@/utils/connectionIdChanges";
import {
  useConnectionIdChanges,
  useFollowConnectionIdChanges,
} from "./useFollowConnectionIdChanges";

let events: ConnectionIdChangesHarness;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  events = installConnectionIdChangesHarness();
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

/** Render a draft that follows id changes; returns a getter for its latest value. */
async function renderDraft(initial: string[], enabled = true): Promise<() => string[]> {
  let latest = initial;
  function Probe() {
    const [draft, setDraft] = useState(initial);
    useFollowConnectionIdChanges(setDraft, remapConnectionIdList, enabled);
    latest = draft;
    return null;
  }
  act(() => root.render(<Probe />));
  await flushAsync();
  return () => latest;
}

describe("useFollowConnectionIdChanges", () => {
  it("remaps the draft when a batch arrives", async () => {
    const draft = await renderDraft(["Work/a", "other"]);
    expect(events.listenerCount()).toBe(1);

    events.emit([{ oldId: "Work/a", newId: "Job/a" }]);

    expect(draft()).toEqual(["Job/a", "other"]);
  });

  it("applies a batch simultaneously (swap and chain)", async () => {
    const draft = await renderDraft(["a", "b", "x", "y"]);

    events.emit([
      { oldId: "a", newId: "b" },
      { oldId: "b", newId: "c" },
      { oldId: "x", newId: "y" },
      { oldId: "y", newId: "x" },
    ]);

    expect(draft()).toEqual(["b", "c", "y", "x"]);
  });

  it("keeps the draft's identity when nothing in it changed", async () => {
    const draft = await renderDraft(["keep"]);
    const before = draft();

    events.emit([{ oldId: "unrelated", newId: "moved" }]);

    expect(draft()).toBe(before);
  });

  it("does not subscribe while disabled", async () => {
    const draft = await renderDraft(["a"], false);

    events.emit([{ oldId: "a", newId: "b" }]);

    expect(events.listenerCount()).toBe(0);
    expect(draft()).toEqual(["a"]);
  });

  it("unsubscribes on unmount", async () => {
    await renderDraft(["a"]);
    expect(events.listenerCount()).toBe(1);

    act(() => root.unmount());
    root = createRoot(container);

    expect(events.listenerCount()).toBe(0);
  });
});

describe("useConnectionIdChanges", () => {
  type Callback = (remap: ConnectionIdRemap, changes: ConnectionIdChange[]) => void;

  function Probe({ cb }: { cb: Callback }) {
    useConnectionIdChanges(cb);
    return null;
  }

  it("calls the latest callback with the batch's remapper", async () => {
    const first = vi.fn<Callback>();
    const second = vi.fn<Callback>();
    act(() => root.render(<Probe cb={first} />));
    await flushAsync();
    act(() => root.render(<Probe cb={second} />));

    const changes = [{ oldId: "a", newId: "b" }];
    events.emit(changes);

    expect(events.listenerCount()).toBe(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    const [remap, received] = second.mock.calls[0];
    expect(remap("a")).toBe("b");
    expect(remap("z")).toBe("z");
    expect(received).toEqual(changes);
  });

  it("ignores an empty batch", async () => {
    const cb = vi.fn<Callback>();
    act(() => root.render(<Probe cb={cb} />));
    await flushAsync();

    events.emit([]);

    expect(cb).not.toHaveBeenCalled();
  });
});
