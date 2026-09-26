/**
 * Supported-platform presentation for multi-platform native plugin packages
 * (PLG-011, #3507).
 *
 * A native package's `extensions.terminalBackend.libraries` maps Rust target
 * triples to in-package library paths. These pure helpers turn that map into
 * friendly, sorted rows ("macOS (Apple Silicon)", "Windows x64", …) with this
 * computer's entry marked, for the install dialog and the plugin detail panel.
 */
import type { PluginManifest } from "@/types/plugin";

/** Friendly architecture names, keyed by the triple's first component. */
const ARCH_LABELS: Record<string, string> = {
  x86_64: "x64",
  aarch64: "ARM64",
};

/**
 * Friendly name for a Rust target triple, e.g. `aarch64-apple-darwin` →
 * "macOS (Apple Silicon)". Only the common desktop targets are named; any other
 * triple is returned unchanged so nothing is hidden or guessed.
 */
export function platformLabel(triple: string): string {
  const parts = triple.split("-");
  const arch = ARCH_LABELS[parts[0]];
  if (!arch || parts.length < 3) return triple;
  const rest = parts.slice(1).join("-");

  if (rest === "apple-darwin") {
    return arch === "ARM64" ? "macOS (Apple Silicon)" : "macOS (Intel)";
  }
  if (rest === "pc-windows-msvc") return `Windows ${arch}`;
  if (rest === "pc-windows-gnu" || rest === "pc-windows-gnullvm") return `Windows ${arch} (GNU)`;
  if (rest === "unknown-linux-gnu") return `Linux ${arch}`;
  if (rest === "unknown-linux-musl") return `Linux ${arch} (musl)`;
  return triple;
}

/** One supported platform of a multi-platform package. */
export interface PluginPlatformEntry {
  /** The Rust target triple (manifest `libraries` key). */
  triple: string;
  /** Friendly name from {@link platformLabel}. */
  label: string;
  /** Whether this is the computer termiHub is running on. */
  isCurrent: boolean;
}

/**
 * A native package's platform support:
 * - `multi` — a multi-platform package; `entries` lists every shipped platform.
 * - `legacy` — a single-platform package without a `libraries` map (built for
 *   one platform, not declared by triple).
 */
export type PluginPlatformSupport =
  | { kind: "multi"; entries: PluginPlatformEntry[] }
  | { kind: "legacy" };

/**
 * The platform support of `manifest`'s native backend, or `null` when the
 * plugin has no native code (JS/theme plugins run everywhere). `hostPlatform`
 * is this computer's target triple (null while unknown); its entry is marked
 * {@link PluginPlatformEntry.isCurrent}. Entries are sorted by friendly name.
 */
export function pluginPlatformSupport(
  manifest: PluginManifest,
  hostPlatform: string | null
): PluginPlatformSupport | null {
  const backend = manifest.extensions.terminalBackend;
  if (!backend) return null;
  const triples = Object.keys(backend.libraries ?? {});
  if (triples.length === 0) return { kind: "legacy" };
  const entries = triples
    .map((triple) => ({ triple, label: platformLabel(triple), isCurrent: triple === hostPlatform }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.triple.localeCompare(b.triple));
  return { kind: "multi", entries };
}
