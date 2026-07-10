import type { ShellEntry, ShellIntegrationSettings } from "@/types/connection";

/**
 * Factory for a fresh {@link ShellIntegrationSettings} value. Mirrors the Rust
 * `ShellIntegrationSettings::default()` (see
 * `src-tauri/src/connection/shell_integration.rs`) so the frontend fallback used
 * when `settings.shellIntegration` is absent matches what the backend persists.
 */
export function defaultShellIntegrationSettings(): ShellIntegrationSettings {
  return {
    entries: [],
    fallback: "picker",
    openInNewWindow: false,
    registered: false,
    linuxFileManagers: { nautilus: false, kde: false, thunar: false },
    firstLaunchBannerDismissed: false,
  };
}

/**
 * Build a new quick-access entry with sensible defaults (folders-only, always
 * visible, shows the session picker until a connection is chosen).
 */
export function createEntry(): ShellEntry {
  return {
    id: generateEntryId(),
    name: "Open in termiHub",
    connectionId: undefined,
    visibility: "always",
    showFor: { folders: true, files: false, folderBackground: false },
  };
}

/** Generate a stable, collision-resistant id for a new entry. */
export function generateEntryId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return `entry-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Append an entry to the end of the list, returning a new array. */
export function addEntry(entries: ShellEntry[], entry: ShellEntry): ShellEntry[] {
  return [...entries, entry];
}

/** Replace the entry with a matching id, returning a new array. */
export function updateEntry(entries: ShellEntry[], entry: ShellEntry): ShellEntry[] {
  return entries.map((e) => (e.id === entry.id ? entry : e));
}

/** Remove the entry with the given id, returning a new array. */
export function removeEntry(entries: ShellEntry[], id: string): ShellEntry[] {
  return entries.filter((e) => e.id !== id);
}

/**
 * Move the entry at `fromIndex` to `toIndex`, returning a new array. Out-of-range
 * indices yield the original order (defensive; the caller resolves indices from
 * the current list).
 */
export function reorderEntries(
  entries: ShellEntry[],
  fromIndex: number,
  toIndex: number
): ShellEntry[] {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= entries.length ||
    toIndex >= entries.length ||
    fromIndex === toIndex
  ) {
    return entries;
  }
  const next = [...entries];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}
