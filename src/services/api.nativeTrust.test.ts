/**
 * The native trust acknowledgement wrapper sends the binding the trust surface
 * rendered, and refusals because that binding changed are recognisable (#4419).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

import { acknowledgeNativePlugin, isTrustBindingRefusal } from "./api";

describe("native trust acknowledgement (#4419)", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    mockedInvoke.mockResolvedValue({});
  });

  it("sends the rendered binding with the acceptances", async () => {
    const binding = { librarySha256: "sha256:aa", accessDigest: "access-v1:sha256:bb" };
    await acknowledgeNativePlugin("echo", binding, { acceptReducedIsolation: true });
    expect(mockedInvoke).toHaveBeenCalledWith("acknowledge_native_plugin", {
      id: "echo",
      binding,
      acceptUnverifiedToolchain: false,
      acceptReducedIsolation: true,
    });
  });

  it("sends an explicit null when there is no binding, which the host refuses", async () => {
    await acknowledgeNativePlugin("echo", undefined);
    expect(mockedInvoke).toHaveBeenCalledWith("acknowledge_native_plugin", {
      id: "echo",
      binding: null,
      acceptUnverifiedToolchain: false,
      acceptReducedIsolation: false,
    });
  });

  it("recognises only binding refusals", () => {
    expect(isTrustBindingRefusal({ code: "binding_changed", message: "m" })).toBe(true);
    expect(isTrustBindingRefusal({ code: "binding_missing", message: "m" })).toBe(true);
    expect(isTrustBindingRefusal({ code: "failed", message: "m" })).toBe(false);
    expect(isTrustBindingRefusal("binding_changed")).toBe(false);
    expect(isTrustBindingRefusal(null)).toBe(false);
    expect(isTrustBindingRefusal(new Error("x"))).toBe(false);
  });
});
