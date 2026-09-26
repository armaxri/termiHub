/** Tests for the supported-platform presentation helpers (PLG-011, #3507). */
import { describe, it, expect } from "vitest";
import type { PluginManifest, TerminalBackendExtension } from "@/types/plugin";
import { platformLabel, pluginPlatformSupport } from "./pluginPlatforms";

function manifest(backend?: Partial<TerminalBackendExtension>): PluginManifest {
  return {
    id: "echo",
    name: "Echo",
    version: "1.0.0",
    author: "a",
    description: "d",
    license: "MIT",
    apiVersion: "1.0",
    platforms: ["macos"],
    permissions: [],
    extensions: backend
      ? {
          terminalBackend: {
            connectionType: "echo",
            displayName: "Echo",
            configSchema: {},
            ...backend,
          },
        }
      : { theme: { themes: [] } },
  };
}

describe("platformLabel", () => {
  it.each([
    ["aarch64-apple-darwin", "macOS (Apple Silicon)"],
    ["x86_64-apple-darwin", "macOS (Intel)"],
    ["x86_64-pc-windows-msvc", "Windows x64"],
    ["aarch64-pc-windows-msvc", "Windows ARM64"],
    ["x86_64-pc-windows-gnu", "Windows x64 (GNU)"],
    ["x86_64-unknown-linux-gnu", "Linux x64"],
    ["aarch64-unknown-linux-gnu", "Linux ARM64"],
    ["x86_64-unknown-linux-musl", "Linux x64 (musl)"],
  ])("names %s as %s", (triple, label) => {
    expect(platformLabel(triple)).toBe(label);
  });

  it.each([
    "riscv64gc-unknown-linux-gnu",
    "x86_64-unknown-freebsd",
    "armv7-unknown-linux-gnueabihf",
    "wasm32",
  ])("returns unknown triple %s raw", (triple) => {
    expect(platformLabel(triple)).toBe(triple);
  });
});

describe("pluginPlatformSupport", () => {
  it("is null for a plugin without native code", () => {
    expect(pluginPlatformSupport(manifest(), "aarch64-apple-darwin")).toBeNull();
  });

  it("is legacy for a native package without a libraries map", () => {
    expect(pluginPlatformSupport(manifest({}), "aarch64-apple-darwin")).toEqual({
      kind: "legacy",
    });
  });

  it("is legacy for an empty libraries map", () => {
    expect(pluginPlatformSupport(manifest({ libraries: {} }), null)).toEqual({ kind: "legacy" });
  });

  it("lists every platform sorted by friendly name with the host marked", () => {
    const support = pluginPlatformSupport(
      manifest({
        libraries: {
          "x86_64-pc-windows-msvc": "a",
          "aarch64-apple-darwin": "b",
          "x86_64-unknown-linux-gnu": "c",
          "x86_64-apple-darwin": "d",
        },
      }),
      "x86_64-apple-darwin"
    );
    expect(support).toEqual({
      kind: "multi",
      entries: [
        { triple: "x86_64-unknown-linux-gnu", label: "Linux x64", isCurrent: false },
        { triple: "aarch64-apple-darwin", label: "macOS (Apple Silicon)", isCurrent: false },
        { triple: "x86_64-apple-darwin", label: "macOS (Intel)", isCurrent: true },
        { triple: "x86_64-pc-windows-msvc", label: "Windows x64", isCurrent: false },
      ],
    });
  });

  it("marks nothing current when the host platform is unknown or absent", () => {
    const support = pluginPlatformSupport(
      manifest({ libraries: { "x86_64-unknown-linux-gnu": "c" } }),
      null
    );
    expect(support?.kind === "multi" && support.entries.some((e) => e.isCurrent)).toBe(false);
  });
});
