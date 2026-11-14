import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock sonner so tests exercise the wrapper's behavior, not real DOM toasts.
const loading = vi.fn((_message: unknown, _opts?: unknown) => "toast-id");
const success = vi.fn((_message: unknown, _opts?: unknown) => undefined);
const error = vi.fn((_message: unknown, _opts?: unknown) => undefined);
const info = vi.fn((_message: unknown, _opts?: unknown) => undefined);
const dismiss = vi.fn((_id?: unknown) => undefined);

vi.mock("sonner", () => ({
  toast: {
    loading: (message: unknown, opts?: unknown) =>
      opts === undefined ? loading(message) : loading(message, opts),
    success: (message: unknown, opts?: unknown) =>
      opts === undefined ? success(message) : success(message, opts),
    error: (message: unknown, opts?: unknown) =>
      opts === undefined ? error(message) : error(message, opts),
    info: (message: unknown, opts?: unknown) =>
      opts === undefined ? info(message) : info(message, opts),
    dismiss: (id?: unknown) => dismiss(id),
  },
}));

// Import after the mock is registered.
import { dismissModalStaleToasts, setTransientDeferred, toast } from "./toast";

describe("toast API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("success auto-dismisses (no forced Infinity duration)", () => {
    toast.success("Saved");
    expect(success).toHaveBeenCalledWith("Saved", expect.objectContaining({ duration: undefined }));
  });

  it("error persists until dismissed (Infinity duration by default)", () => {
    toast.error("Boom");
    expect(error).toHaveBeenCalledWith("Boom", expect.objectContaining({ duration: Infinity }));
  });

  it("passes a testId through so system tests can target a toast (#4010)", () => {
    toast.success("Ok", { testId: "spawn-toast-success" });
    toast.error("Bad", { testId: "spawn-toast-error" });
    toast.info("Fyi", { testId: "spawn-toast-missing" });
    expect(success).toHaveBeenCalledWith(
      "Ok",
      expect.objectContaining({ testId: "spawn-toast-success" })
    );
    expect(error).toHaveBeenCalledWith(
      "Bad",
      expect.objectContaining({ testId: "spawn-toast-error" })
    );
    expect(info).toHaveBeenCalledWith(
      "Fyi",
      expect.objectContaining({ testId: "spawn-toast-missing" })
    );
  });

  it("info passes through description", () => {
    toast.info("Heads up", { description: "details" });
    expect(info).toHaveBeenCalledWith(
      "Heads up",
      expect.objectContaining({ description: "details" })
    );
  });

  it("loading returns an id and persists", () => {
    const id = toast.loading("Working");
    expect(id).toBe("toast-id");
    expect(loading).toHaveBeenCalledWith(
      "Working",
      expect.objectContaining({ duration: Infinity })
    );
  });

  it("loading passes through an inline action (e.g. Cancel)", () => {
    const onClick = vi.fn();
    toast.loading("Working", { action: { label: "Cancel", onClick } });
    expect(loading).toHaveBeenCalledWith(
      "Working",
      expect.objectContaining({ action: { label: "Cancel", onClick } })
    );
  });

  it("tags an action's label with its testId so a system test can press it", () => {
    const onClick = vi.fn();
    toast.success("Deleted", { action: { label: "Undo", onClick, testId: "x-undo" } });
    const opts = success.mock.calls[0][1] as {
      action: { label: { props: Record<string, unknown> }; onClick: () => void };
    };
    expect(opts.action.label.props).toMatchObject({ "data-testid": "x-undo", children: "Undo" });
    opts.action.onClick();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("passes a cancel button through, tagged with its testId (#5753)", () => {
    const onClick = vi.fn();
    toast.info("Offer", {
      action: { label: "Install", onClick: vi.fn() },
      cancel: { label: "Not now", onClick, testId: "x-not-now" },
      duration: Infinity,
    });
    const opts = info.mock.calls[0][1] as {
      duration: number;
      cancel: { label: { props: Record<string, unknown> }; onClick: () => void };
    };
    expect(opts.duration).toBe(Infinity);
    expect(opts.cancel.label.props).toMatchObject({
      "data-testid": "x-not-now",
      children: "Not now",
    });
    opts.cancel.onClick();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("promise resolves the loading toast in place into success", async () => {
    const p = Promise.resolve("done");
    await toast.promise(p, { loading: "Load", success: "OK", error: "Err" });

    expect(loading).toHaveBeenCalledWith("Load");
    // success updates the SAME toast id (in place)
    expect(success).toHaveBeenCalledWith("OK", expect.objectContaining({ id: "toast-id" }));
    expect(error).not.toHaveBeenCalled();
  });

  it("promise resolves the loading toast in place into error on reject", async () => {
    const p = Promise.reject(new Error("nope"));
    await expect(
      toast.promise(p, { loading: "Load", success: "OK", error: "Failed" })
    ).rejects.toThrow("nope");

    expect(loading).toHaveBeenCalledWith("Load");
    expect(error).toHaveBeenCalledWith("Failed", { id: "toast-id", duration: Infinity });
    expect(success).not.toHaveBeenCalled();
  });

  it("promise success/error messages may derive from value/error", async () => {
    await toast.promise(Promise.resolve(3), {
      loading: "L",
      success: (v) => `got ${v}`,
      error: "e",
    });
    expect(success).toHaveBeenCalledWith("got 3", expect.objectContaining({ id: "toast-id" }));

    await toast
      .promise(Promise.reject(new Error("x")), {
        loading: "L",
        success: "s",
        error: (e) => `boom: ${(e as Error).message}`,
      })
      .catch(() => {});
    expect(error).toHaveBeenCalledWith("boom: x", { id: "toast-id", duration: Infinity });
  });

  describe("dismiss by id (#4812)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("repeats the dismiss after a pending mount so it cannot be lost", () => {
      vi.useFakeTimers();
      toast.dismiss("t1");
      expect(dismiss).toHaveBeenCalledTimes(1);
      expect(dismiss).toHaveBeenLastCalledWith("t1");

      vi.runAllTimers();
      expect(dismiss).toHaveBeenCalledTimes(2);
      expect(dismiss).toHaveBeenLastCalledWith("t1");
    });

    it("cancels the repeat when the id is reused for a new toast", () => {
      vi.useFakeTimers();
      toast.dismiss("t2");
      toast.error("Failed again", { id: "t2" });

      vi.runAllTimers();
      expect(dismiss).toHaveBeenCalledTimes(1);
    });

    it("dismiss-all passes straight through", () => {
      vi.useFakeTimers();
      toast.dismiss();
      vi.runAllTimers();
      expect(dismiss).toHaveBeenCalledTimes(1);
      expect(dismiss).toHaveBeenCalledWith(undefined);
    });
  });

  describe("dismissTransient (#5618)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("dismisses the success and info toasts still showing, not errors or loading", () => {
      vi.useFakeTimers();
      toast.dismiss(); // start from an empty tracking set
      vi.clearAllMocks();
      toast.success("Connected", { id: "ok" });
      toast.info("Heads up", { id: "note" });
      toast.error("Boom", { id: "bad" });
      toast.loading("Connecting…", { id: "busy" });

      toast.dismissTransient();
      const dismissed = dismiss.mock.calls.map((c) => c[0]);
      expect(dismissed).toEqual(expect.arrayContaining(["ok", "note"]));
      expect(dismissed).not.toContain("bad");
      expect(dismissed).not.toContain("busy");
    });

    it("forgets an id reused for an error and one already dismissed", () => {
      vi.useFakeTimers();
      toast.dismiss();
      vi.clearAllMocks();
      toast.success("Saved", { id: "reuse" });
      toast.error("Save failed", { id: "reuse" });
      toast.success("Copied", { id: "gone" });
      toast.dismiss("gone");
      vi.runAllTimers();
      vi.clearAllMocks();

      toast.dismissTransient();
      expect(dismiss).not.toHaveBeenCalled();
    });

    it("dismisses each toast once, then has nothing left", () => {
      vi.useFakeTimers();
      toast.dismiss();
      toast.success("Connected", { id: "once" });
      toast.dismissTransient();
      vi.runAllTimers();
      vi.clearAllMocks();
      toast.dismissTransient();
      expect(dismiss).not.toHaveBeenCalled();
    });
  });

  describe("deferral while docked over a tall dialog (#5715)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      toast.dismiss();
      vi.runAllTimers();
      vi.clearAllMocks();
    });

    afterEach(() => {
      setTransientDeferred(false);
      vi.useRealTimers();
    });

    it("queues success/info while deferring and shows them when it ends", () => {
      setTransientDeferred(true);
      const okId = toast.success("Ran workflow", { id: "ran" });
      const noteId = toast.info("Copied");
      expect(okId).toBe("ran");
      expect(typeof noteId).toBe("string");
      expect(success).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();

      vi.runAllTimers();
      setTransientDeferred(false);
      expect(success).toHaveBeenCalledWith("Ran workflow", expect.objectContaining({ id: "ran" }));
      expect(info).toHaveBeenCalledWith("Copied", expect.objectContaining({ id: noteId }));
    });

    it("keeps errors and loading toasts visible while deferring", () => {
      setTransientDeferred(true);
      toast.error("Save failed");
      toast.loading("Connecting…");
      expect(error).toHaveBeenCalledTimes(1);
      expect(loading).toHaveBeenCalledTimes(1);
    });

    it("takes down the success/info toasts on screen and shows them again later", () => {
      toast.success("Connected", { id: "up" });
      toast.error("Boom", { id: "err" });
      vi.clearAllMocks();

      setTransientDeferred(true);
      const dismissed = dismiss.mock.calls.map((c) => c[0]);
      expect(dismissed).toContain("up");
      expect(dismissed).not.toContain("err");

      vi.runAllTimers();
      vi.clearAllMocks();
      setTransientDeferred(false);
      expect(success).toHaveBeenCalledWith("Connected", expect.objectContaining({ id: "up" }));
      // The repeat dismiss scheduled when it was taken down is cancelled.
      vi.runAllTimers();
      expect(dismiss).not.toHaveBeenCalledWith("up");
    });

    it("does not bring back a toast that closed before the stack docked", () => {
      toast.success("Saved", { id: "closed" });
      const opts = success.mock.calls[0][1] as { onAutoClose: () => void };
      opts.onAutoClose();
      vi.clearAllMocks();

      setTransientDeferred(true);
      setTransientDeferred(false);
      expect(success).not.toHaveBeenCalled();
    });

    it("drops a deferred toast that is dismissed, replaced by an error, or modal-stale", () => {
      setTransientDeferred(true);
      toast.success("A", { id: "a" });
      toast.success("B", { id: "b" });
      toast.success("C", { id: "c", dismissOnModal: true });
      toast.success("D", { id: "d" });
      toast.dismiss("a");
      toast.error("B failed", { id: "b" });
      dismissModalStaleToasts();
      toast.dismissTransient();
      vi.runAllTimers();
      vi.clearAllMocks();

      setTransientDeferred(false);
      expect(success).not.toHaveBeenCalled();
    });

    it("drops only the named toasts, keeping the rest queued", () => {
      setTransientDeferred(true);
      toast.success("A", { id: "a" });
      toast.success("C", { id: "c", dismissOnModal: true });
      toast.dismiss("a");
      dismissModalStaleToasts();
      toast.success("E", { id: "e" });
      vi.runAllTimers();
      vi.clearAllMocks();

      setTransientDeferred(false);
      expect(success).toHaveBeenCalledTimes(1);
      expect(success).toHaveBeenCalledWith("E", expect.objectContaining({ id: "e" }));
    });

    it("resolves a promise's loading toast into a deferred success", async () => {
      setTransientDeferred(true);
      await toast.promise(Promise.resolve(1), { loading: "L", success: "Done", error: "E" });
      expect(success).not.toHaveBeenCalled();
      expect(dismiss).toHaveBeenCalledWith("toast-id");

      vi.runAllTimers();
      setTransientDeferred(false);
      expect(success).toHaveBeenCalledWith("Done", expect.objectContaining({ id: "toast-id" }));
    });
  });
});
