import { describe, it, expect, beforeEach, vi } from "vitest";

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
import { toast } from "./toast";

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

  it("promise resolves the loading toast in place into success", async () => {
    const p = Promise.resolve("done");
    await toast.promise(p, { loading: "Load", success: "OK", error: "Err" });

    expect(loading).toHaveBeenCalledWith("Load");
    // success updates the SAME toast id (in place)
    expect(success).toHaveBeenCalledWith("OK", { id: "toast-id" });
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
    expect(success).toHaveBeenCalledWith("got 3", { id: "toast-id" });

    await toast
      .promise(Promise.reject(new Error("x")), {
        loading: "L",
        success: "s",
        error: (e) => `boom: ${(e as Error).message}`,
      })
      .catch(() => {});
    expect(error).toHaveBeenCalledWith("boom: x", { id: "toast-id", duration: Infinity });
  });
});
