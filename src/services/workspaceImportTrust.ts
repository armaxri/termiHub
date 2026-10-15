/**
 * Machine-local confirmation of imported workspace commands and inline
 * connection configs (#4434).
 *
 * An import (or a `--workspace-file`) moves every tab's `initialCommand` to
 * `pendingInitialCommand` and flags every `inlineConfig` with
 * `inlineConfigUnconfirmed` (see `src-tauri/src/workspace/import_trust.rs`).
 * Nothing pending is typed into a session and no flagged inline config
 * connects until the user confirms it on this machine. A confirmation adds a
 * key to `AppSettings.workspaceImportAllowlist`, which no workspace file can
 * write:
 *
 * - `cmd:<sha256>` of the command's exact text, and
 * - `conn:<sha256>` of the inline config's canonical JSON.
 *
 * Keying on the content means any change to a command or a connection config
 * needs a new confirmation. Locally created workspaces never carry the pending
 * fields, so this module leaves them untouched.
 */
import { getWorkspaceLeaves } from "@/utils/workspaceLayout";
import type {
  UntrustedImportedTab,
  WorkspaceLayoutNode,
  WorkspaceTabDef,
  WorkspaceTabGroupDef,
} from "@/types/workspace";

const COMMAND_KEY_PREFIX = "cmd:";
const CONNECTION_KEY_PREFIX = "conn:";

/** JSON with object keys sorted at every level, so equal content hashes equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The allowlist key for an imported command's exact text. */
export async function importedCommandKey(command: string): Promise<string> {
  return COMMAND_KEY_PREFIX + (await sha256Hex(command));
}

/** The allowlist key for an imported inline connection config. */
export async function importedConnectionKey(inlineConfig: unknown): Promise<string> {
  return CONNECTION_KEY_PREFIX + (await sha256Hex(canonicalJson(inlineConfig)));
}

/** Whether `key` has been confirmed on this machine. */
export function isImportConfirmed(allowlist: readonly string[] | undefined, key: string): boolean {
  return (allowlist ?? []).includes(key);
}

/** `allowlist` with `key` added (once). */
export function withImportConfirmed(
  allowlist: readonly string[] | undefined,
  key: string
): string[] {
  const current = allowlist ?? [];
  return current.includes(key) ? [...current] : [...current, key];
}

/** `allowlist` without any of `keys` (#4445). */
export function withImportsRevoked(
  allowlist: readonly string[] | undefined,
  keys: readonly string[]
): string[] {
  const revoked = new Set(keys);
  return (allowlist ?? []).filter((key) => !revoked.has(key));
}

/** Whether an allowlist key confirms a command or an inline connection config. */
export function importKeyKind(key: string): "command" | "connection" | "unknown" {
  if (key.startsWith(COMMAND_KEY_PREFIX)) return "command";
  if (key.startsWith(CONNECTION_KEY_PREFIX)) return "connection";
  return "unknown";
}

/** One held command or inline connection config of an imported workspace. */
export interface ImportedItem {
  /** Positional id (`<group>-<leaf>-<tab>-cmd|conn`), stable for one layout. */
  id: string;
  kind: "command" | "connection";
  /** `<tab title> (<group name>)`. */
  tabLabel: string;
  /** What runs or opens, shown verbatim. */
  text: string;
  /** Resolves to the allowlist key for this item. */
  key: () => Promise<string>;
}

/**
 * Every held item (a `pendingInitialCommand` or an `inlineConfigUnconfirmed`
 * inline config) in a workspace's tab groups, in layout order. Locally created
 * workspaces carry none, so this returns an empty list for them.
 */
export function collectImportedItems(groups: readonly WorkspaceTabGroupDef[]): ImportedItem[] {
  const items: ImportedItem[] = [];
  groups.forEach((group, g) => {
    getWorkspaceLeaves(group.layout).forEach((leaf, l) => {
      leaf.tabs.forEach((tab, t) => {
        const tabLabel = `${tab.title ?? "Tab"} (${group.name})`;
        const base = `${g}-${l}-${t}`;
        if (tab.inlineConfigUnconfirmed && tab.inlineConfig) {
          const inline = tab.inlineConfig;
          const summary = describeImportedConnection(inline);
          const parts = [summary.type, summary.target].filter(Boolean).join(" ");
          const runs = summary.embeddedCommand ? ` (runs "${summary.embeddedCommand}")` : "";
          items.push({
            id: `${base}-conn`,
            kind: "connection",
            tabLabel,
            text: parts + runs,
            key: () => importedConnectionKey(inline),
          });
        }
        if (tab.pendingInitialCommand) {
          const command = tab.pendingInitialCommand;
          items.push({
            id: `${base}-cmd`,
            kind: "command",
            tabLabel,
            text: command,
            key: () => importedCommandKey(command),
          });
        }
      });
    });
  });
  return items;
}

async function resolveTab(
  tab: WorkspaceTabDef,
  allowlist: readonly string[]
): Promise<WorkspaceTabDef> {
  let next = tab;
  const pending = tab.pendingInitialCommand;
  if (pending && isImportConfirmed(allowlist, await importedCommandKey(pending))) {
    const { pendingInitialCommand: _promoted, ...rest } = next;
    next = { ...rest, initialCommand: pending };
  }
  if (
    tab.inlineConfigUnconfirmed &&
    tab.inlineConfig &&
    isImportConfirmed(allowlist, await importedConnectionKey(tab.inlineConfig))
  ) {
    const { inlineConfigUnconfirmed: _confirmed, ...rest } = next;
    next = rest;
  }
  return next;
}

async function resolveLayout(
  node: WorkspaceLayoutNode,
  allowlist: readonly string[]
): Promise<WorkspaceLayoutNode> {
  if (node.type === "leaf") {
    return { ...node, tabs: await Promise.all(node.tabs.map((t) => resolveTab(t, allowlist))) };
  }
  return {
    ...node,
    children: await Promise.all(node.children.map((c) => resolveLayout(c, allowlist))),
  };
}

/**
 * Apply this machine's confirmations to a workspace's tab groups before they
 * are launched: a pending command the user confirmed becomes the tab's
 * `initialCommand`, and a confirmed inline config loses its unconfirmed flag.
 * Everything else stays pending. Returns new groups; the input is not mutated.
 */
export async function resolveImportTrust(
  groups: WorkspaceTabGroupDef[],
  allowlist: readonly string[] | undefined
): Promise<WorkspaceTabGroupDef[]> {
  const list = allowlist ?? [];
  return Promise.all(
    groups.map(async (g) => ({ ...g, layout: await resolveLayout(g.layout, list) }))
  );
}

/** Connection types that open a connection elsewhere rather than start a local program. */
const NON_SPAWNING_TYPES = new Set(["ssh", "telnet", "serial", "remote-session", "rdp", "vnc"]);

/** What an imported inline connection config would open, for the confirmation prompt. */
export interface ImportedConnectionSummary {
  /** The connection type (`local`, `ssh`, …), or `unknown`. */
  type: string;
  /** Where it connects: `user@host:port`, a shell, a distribution, a port or an image. */
  target?: string;
  /** A command embedded in the config (`config.initialCommand`), run after it starts. */
  embeddedCommand?: string;
  /** Whether opening it starts a program on this machine. */
  spawnsLocalProcess: boolean;
}

function readString(bag: Record<string, unknown>, key: string): string | undefined {
  const value = bag[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function describeTarget(type: string, bag: Record<string, unknown>): string | undefined {
  switch (type) {
    case "ssh":
    case "telnet": {
      const host = readString(bag, "host");
      if (!host) return undefined;
      const user = readString(bag, "username");
      const port = typeof bag["port"] === "number" ? `:${bag["port"]}` : "";
      return `${user ? `${user}@` : ""}${host}${port}`;
    }
    case "local": {
      const shell = readString(bag, "shell") ?? readString(bag, "shellType");
      return shell ? `shell ${shell}` : "default shell";
    }
    case "wsl": {
      const distribution = readString(bag, "distribution");
      return distribution ? `distribution ${distribution}` : undefined;
    }
    case "serial": {
      const port = readString(bag, "port");
      return port ? `port ${port}` : undefined;
    }
    case "docker": {
      const image = readString(bag, "image");
      if (image) return `image ${image}`;
      const container = readString(bag, "existingContainer");
      return container ? `container ${container}` : undefined;
    }
    default:
      return readString(bag, "host");
  }
}

/**
 * Summarize an inline connection config (`{ type, config }`) for display. Reads
 * only display fields, never secrets. Mirrors the backend's import notice
 * (`describe_inline_config` in `import_trust.rs`).
 */
export function describeImportedConnection(inlineConfig: unknown): ImportedConnectionSummary {
  const outer =
    inlineConfig !== null && typeof inlineConfig === "object"
      ? (inlineConfig as Record<string, unknown>)
      : {};
  const type = typeof outer["type"] === "string" && outer["type"] ? outer["type"] : "unknown";
  const inner = outer["config"];
  const bag = inner !== null && typeof inner === "object" ? (inner as Record<string, unknown>) : {};
  return {
    type,
    target: describeTarget(type, bag),
    embeddedCommand: readString(bag, "initialCommand"),
    spawnsLocalProcess: !NON_SPAWNING_TYPES.has(type),
  };
}

function describeUntrustedTab(tab: UntrustedImportedTab): string {
  const parts: string[] = [];
  if (tab.connectionType) {
    const target = tab.connectionTarget ? ` ${tab.connectionTarget}` : "";
    const local = tab.spawnsLocalProcess ? ", starts a local program" : "";
    parts.push(`opens ${tab.connectionType}${target}${local}`);
  }
  if (tab.embeddedCommand) parts.push(`its connection runs "${tab.embeddedCommand}"`);
  if (tab.command) parts.push(`runs "${tab.command}"`);
  const name = tab.tabTitle ? `"${tab.tabTitle}" in ${tab.workspaceName}` : tab.workspaceName;
  return `${name}: ${parts.join("; ")}`;
}

/**
 * The untrusted part of the workspace import notice (#4434), or `null` when no
 * imported tab carries a command or an inline connection config. Lists every
 * such tab with the real command text and connection, and says they stay held
 * until confirmed on this machine.
 */
export function formatUntrustedImportNotice(tabs: readonly UntrustedImportedTab[]): string | null {
  if (tabs.length === 0) return null;
  const label = `${tabs.length} imported tab${tabs.length === 1 ? "" : "s"}`;
  return (
    `${label} carry untrusted commands or connections. They will not run or connect until you ` +
    `confirm them on this machine (in the tab or the workspace editor). ` +
    `${tabs.map(describeUntrustedTab).join(". ")}.`
  );
}
