/**
 * Machine-local confirmation of what a saved connection runs by itself (#6065).
 *
 * A saved connection can be opened without anyone asking for it: the last session
 * or a workspace reopens it, a schedule connects it. What it then does by itself
 * (where it connects, which program it starts here, a command it types, a
 * forwarded agent or display) may have been changed elsewhere: a restored backup,
 * an import, or a connection file another machine syncs. Such a change runs only
 * once it was confirmed on this machine.
 *
 * A confirmation is a `saved:<sha256>` key of the connection's runnable part in
 * `AppSettings.workspaceImportAllowlist`, which no restore, import or connection
 * file can write (#4434, #6071). The connections this machine had when this
 * started are confirmed once (`saved-baseline:1`); saving a connection in the
 * editor confirms it; so does the user's own Confirm.
 */
import { saveSettings } from "@/services/storage";
import { currentConnectionsView } from "@/store/connectionsBridge";
import { currentSettingsView, mirrorSettingsIntent } from "@/store/settingsBridge";
import type { SavedConnection } from "@/types/connection";
import type { ConnectionConfig } from "@/types/terminal";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";
import { canonicalJson } from "./workspaceImportTrust";

const KEY_PREFIX = "saved:";
/** Set once the connections this machine had were confirmed. */
export const SAVED_CONNECTION_BASELINE = "saved-baseline:1";

/** The settings that decide what a connection does by itself, wherever its type has them. */
const RUNNABLE_FIELDS = [
  "host",
  "port",
  "username",
  "shell",
  "shellType",
  "distribution",
  "image",
  "existingContainer",
  "composeService",
  "containerMode",
  "runtime",
  "volumes",
  "env",
  "envVars",
  "environment",
  "initialCommand",
  "onReconnectCommand",
  "forwardAgent",
  "enableX11Forwarding",
  "x11Untrusted",
  "proxyJump",
] as const;

/** Connection types that open a connection elsewhere rather than start a program here. */
const REMOTE_TYPES = new Set(["ssh", "telnet", "serial", "remote-session", "rdp", "vnc"]);

function settingsOf(config: ConnectionConfig): Record<string, unknown> {
  const bag = (config as { config?: unknown }).config;
  return bag !== null && typeof bag === "object" ? (bag as Record<string, unknown>) : {};
}

/** The runnable part of `config`: its type and the {@link RUNNABLE_FIELDS} it sets. */
function runnable(config: ConnectionConfig): unknown {
  const bag = settingsOf(config);
  const picked: Record<string, unknown> = {};
  for (const field of RUNNABLE_FIELDS) {
    const value = bag[field];
    if (value !== undefined && value !== null && value !== "" && value !== false) {
      picked[field] = value;
    }
  }
  return { type: config.type, ...picked };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Runnable parts already found confirmed in this window: no hashing again. */
const confirmedHere = new Set<string>();

/** The key that confirms what `config` runs by itself. */
export async function savedConnectionKey(config: ConnectionConfig): Promise<string> {
  return KEY_PREFIX + (await sha256Hex(canonicalJson(runnable(config))));
}

/** What opening a connection with `config` does by itself, one line each, for the user. */
export function whatRunsByItself(config: ConnectionConfig): string[] {
  const bag = settingsOf(config);
  const text = (key: string) => {
    const value = bag[key];
    return typeof value === "string" && value.trim() !== "" ? value : null;
  };
  const lines: string[] = [];
  if (!REMOTE_TYPES.has(config.type)) {
    const program = text("shell") ?? text("shellType") ?? text("image") ?? config.type;
    lines.push(`Starts ${program} on this computer`);
  }
  const initial = text("initialCommand");
  if (initial) lines.push(`Runs “${initial}” once connected`);
  const reconnect = text("onReconnectCommand");
  if (reconnect) lines.push(`Runs “${reconnect}” after each reconnect`);
  if (bag["forwardAgent"] === true) lines.push("Forwards your SSH agent to the host");
  if (bag["enableX11Forwarding"] === true) lines.push("Lets the host open windows here (X11)");
  return lines;
}

/** Keys written here and not yet seen back in the settings region. */
const written = new Set<string>();

function confirmedKeys(): Set<string> {
  return new Set([...(currentSettingsView().workspaceImportAllowlist ?? []), ...written]);
}

/** Add `keys` to this machine's confirmations. */
async function addConfirmed(keys: string[]): Promise<void> {
  const known = confirmedKeys();
  const fresh = keys.filter((key) => !known.has(key));
  if (fresh.length === 0) return;
  fresh.forEach((key) => written.add(key));
  const settings = currentSettingsView();
  const next = {
    ...settings,
    workspaceImportAllowlist: [...(settings.workspaceImportAllowlist ?? []), ...fresh],
  };
  // As `updateSettings` writes it, without its side effects: only the list changes.
  // Not written, it holds for this window still, and is asked again after a restart.
  try {
    await saveSettings(next);
    mirrorSettingsIntent("settings.replace", { settings: next });
  } catch (err) {
    frontendLog("connection_trust", `keeping a confirmation failed: ${errorMessage(err)}`);
  }
}

let baseline: Promise<void> | null = null;

/**
 * Confirm the connections this machine has, once: everything it had before this
 * check existed keeps working as it did.
 */
export function ensureSavedConnectionBaseline(): Promise<void> {
  if (confirmedKeys().has(SAVED_CONNECTION_BASELINE)) return Promise.resolve();
  baseline ??= (async () => {
    try {
      const keys = await Promise.all(
        currentConnectionsView().connections.map((c) => savedConnectionKey(c.config))
      );
      await addConfirmed([...keys, SAVED_CONNECTION_BASELINE]);
    } catch (err) {
      frontendLog(
        "connection_trust",
        `confirming the existing connections failed: ${errorMessage(err)}`
      );
    } finally {
      baseline = null;
    }
  })();
  return baseline;
}

/** Every connection counts as confirmed (tests of other things than this). */
let trustAll = false;

/**
 * Let every saved connection count as confirmed, for tests of the connect flow
 * that are not about this check.
 *
 * @internal Test-only hook; no production code calls it.
 */
export function __trustAllSavedConnectionsForTest(on: boolean): void {
  trustAll = on;
}

/** Whether what `connection` runs by itself is confirmed on this machine. */
export async function isSavedConnectionConfirmed(connection: SavedConnection): Promise<boolean> {
  if (confirmedWithoutWaiting(connection)) return true;
  await ensureSavedConnectionBaseline();
  const confirmed = confirmedKeys().has(await savedConnectionKey(connection.config));
  if (confirmed) confirmedHere.add(canonicalJson(runnable(connection.config)));
  return confirmed;
}

/**
 * Whether `connection` is known to be confirmed without asking the settings: so a
 * connect of a known one stays as quick as before. `false` means "not known yet".
 */
export function confirmedWithoutWaiting(connection: SavedConnection): boolean {
  return trustAll || confirmedHere.has(canonicalJson(runnable(connection.config)));
}

/**
 * Whether the saved connection with this id, among `connections`, is not confirmed
 * here; for {@link import("./workspaceImportTrust").resolveImportTrust}.
 */
export function unconfirmedConnectionCheck(
  connections: readonly SavedConnection[]
): (connectionRef: string) => Promise<boolean> {
  return async (ref) => {
    const connection = connections.find((c) => c.id === ref);
    return connection !== undefined && !(await isSavedConnectionConfirmed(connection));
  };
}

/** The user confirmed `config` here: saved it in the editor, or said so. */
export async function confirmSavedConnection(config: ConnectionConfig): Promise<void> {
  await ensureSavedConnectionBaseline();
  await addConfirmed([await savedConnectionKey(config)]);
  confirmedHere.add(canonicalJson(runnable(config)));
}

/**
 * The user saved a connection in the editor: what it runs is theirs (#6065). The
 * stored version is confirmed once the save landed, as the backend keeps it.
 */
export async function confirmOnceSaved(
  persistedId: Promise<string | null>,
  config: ConnectionConfig
): Promise<void> {
  try {
    const id = await persistedId;
    if (id === null) return;
    const stored = currentConnectionsView().connections.find((c) => c.id === id);
    await confirmSavedConnection(stored?.config ?? config);
  } catch (err) {
    frontendLog("connection_trust", `confirming a saved connection failed: ${errorMessage(err)}`);
  }
}

/** Forget what was written in this window (tests). */
export function resetSavedConnectionTrustForTest(): void {
  written.clear();
  confirmedHere.clear();
  baseline = null;
}
