/**
 * Connect-time schema field secrets (#4429).
 *
 * Since #4289 a saved connection's schema secrets other than `password` — the
 * VNC SSH-tunnel `sshPassword`, a plugin's password field, an inline jump-host
 * hop's password — live in the credential store (its `field_secrets` entry),
 * never in the settings the frontend loads. Before a connect (or the editor's
 * Test) this module fills in the ones the connect needs:
 *
 * 1. Decide which are **needed** from the schema ({@link neededFieldSecrets}):
 *    a visible, empty secret field that is required or whose group selects
 *    password authentication, and each inline hop with password auth.
 * 2. With a saved connection and a credential store, pass the unlock gate
 *    (#1144) and take the stored values.
 * 3. Prompt for the rest through the shared password prompt. Its Save box
 *    writes the `field_secrets` entry — never offered with credential storage
 *    "none" (the value is used for this connect only) or without a saved id.
 *
 * Unattended (a scheduled run, #3527) nothing is asked: a locked store or a
 * missing secret is refused with a reason. Secrets go only into the returned
 * in-memory settings; they are never logged.
 */
import { resolveFieldSecrets as fetchStoredFieldSecrets, storeFieldSecrets } from "@/services/api";
import type { FieldSecrets } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import type { PasswordPromptKind, PasswordPromptOptions } from "@/store/slices/passwordPromptSlice";
import type { SettingsField, SettingsSchema } from "@/types/schema";
import {
  credentialStoreNeedsUnlock,
  ensureCredentialStoreUnlocked,
} from "@/utils/ensureCredentialStoreUnlocked";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";
import { isFieldVisible } from "@/utils/schemaDefaults";

/** The settings key whose secret has its own credential entries and prompt. */
const PASSWORD_KEY = "password";
/** Settings keys holding a jump-host chain. */
const HOP_LIST_KEYS = ["proxyJump", "jumpHosts"] as const;

/** A secret a connect needs. */
export type FieldSecretSlot =
  | { kind: "field"; key: string; label: string }
  | { kind: "hop"; id: string; host: string; username: string };

/** The store's promise-based prompt (`useAppStore().requestPassword`). */
export type RequestPassword = (
  host: string,
  username: string,
  notice?: string,
  kind?: PasswordPromptKind,
  options?: PasswordPromptOptions
) => Promise<string | null>;

export interface ResolveFieldSecretsOptions {
  /** The connection type's schema (`undefined` when unknown: hops only). */
  schema: SettingsSchema | undefined;
  /** The settings to connect with. Never mutated. */
  settings: Record<string, unknown>;
  /** The saved connection's id, or `null` for an unsaved one (no stored secrets). */
  connectionId: string | null;
  /** The saved connection's external file (#3591), else `null`. */
  sourceFile?: string | null;
  requestPassword: RequestPassword;
  /** Whether the prompt may offer its Save box (default `true`; Test passes `false`). */
  allowSave?: boolean;
  /** Never ask anything; refuse instead (#3527). */
  unattended?: boolean;
}

/** Outcome of {@link resolveFieldSecrets}. */
export type FieldSecretsResult =
  | { status: "resolved"; settings: Record<string, unknown> }
  /** The user dismissed the unlock dialog or a prompt; `reason` is user-facing. */
  | { status: "canceled"; reason: string }
  /** Unattended only: the connect would have needed the user. */
  | { status: "refused"; reason: string };

function isEmpty(value: unknown): boolean {
  return typeof value !== "string" || value.length === 0;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

/** The identity of an inline hop, `user@host:port`; `null` for a reference or no host. */
export function hopIdentity(hop: Record<string, unknown>): string | null {
  if (!isEmpty(hop.connectionId)) return null;
  const host = readString(hop, "host");
  if (!host) return null;
  const port = typeof hop.port === "number" ? hop.port : 22;
  return `${readString(hop, "username")}@${host}:${port}`;
}

/** The inline hops of the jump-host chains in `settings`. */
function inlineHops(settings: Record<string, unknown>): Record<string, unknown>[] {
  return HOP_LIST_KEYS.flatMap((key) => {
    const list = settings[key];
    return Array.isArray(list)
      ? list.filter((h): h is Record<string, unknown> => typeof h === "object" && h !== null)
      : [];
  });
}

/** Schema secret fields other than `password`. */
function secretFields(schema: SettingsSchema | undefined): {
  field: SettingsField;
  group: SettingsField[];
}[] {
  return (schema?.groups ?? []).flatMap((group) =>
    group.fields
      .filter((f) => f.fieldType.type === "password" && f.key !== PASSWORD_KEY)
      .map((field) => ({ field, group: group.fields }))
  );
}

/** Whether a select in `group` (other than `field`) picks password authentication. */
function groupSelectsPasswordAuth(
  group: SettingsField[],
  field: SettingsField,
  settings: Record<string, unknown>
): boolean {
  return group.some(
    (f) => f !== field && f.fieldType.type === "select" && settings[f.key] === PASSWORD_KEY
  );
}

/**
 * The schema field secrets and inline hop passwords a connect with `settings`
 * needs but does not carry: a visible, empty secret field that is required or
 * whose group selects password authentication, and each inline hop with
 * password auth and no password.
 */
export function neededFieldSecrets(
  schema: SettingsSchema | undefined,
  settings: Record<string, unknown>
): FieldSecretSlot[] {
  const fields: FieldSecretSlot[] = secretFields(schema)
    .filter(({ field }) => isFieldVisible(field, settings) && isEmpty(settings[field.key]))
    .filter(
      ({ field, group }) => field.required || groupSelectsPasswordAuth(group, field, settings)
    )
    .map(({ field }) => ({ kind: "field", key: field.key, label: field.label }));
  const hops: FieldSecretSlot[] = inlineHops(settings).flatMap((hop) => {
    const id = hopIdentity(hop);
    if (!id || hop.authMethod !== PASSWORD_KEY || !isEmpty(hop.password)) return [];
    return [
      { kind: "hop", id, host: readString(hop, "host"), username: readString(hop, "username") },
    ];
  });
  return [...fields, ...hops];
}

/**
 * Whether saving `settings` writes a schema field secret to the credential
 * store (a typed non-`password` secret or inline hop password) — so a save
 * must pass the unlock gate first.
 */
export function hasFieldSecretsToSave(
  schema: SettingsSchema | undefined,
  settings: Record<string, unknown>
): boolean {
  return (
    secretFields(schema).some(({ field }) => !isEmpty(settings[field.key])) ||
    inlineHops(settings).some((hop) => !isEmpty(hop.password))
  );
}

/** Put `secrets` into a copy of `settings` where `needed` slots are empty. */
function splice(settings: Record<string, unknown>, secrets: FieldSecrets): Record<string, unknown> {
  const next: Record<string, unknown> = { ...settings };
  for (const [key, value] of Object.entries(secrets.fields ?? {})) {
    if (isEmpty(next[key])) next[key] = value;
  }
  const hopSecrets = secrets.hops ?? {};
  for (const key of HOP_LIST_KEYS) {
    const list = next[key];
    if (!Array.isArray(list)) continue;
    next[key] = list.map((hop: unknown) => {
      if (typeof hop !== "object" || hop === null) return hop;
      const record = hop as Record<string, unknown>;
      const id = hopIdentity(record);
      const secret = id ? hopSecrets[id] : undefined;
      return secret && isEmpty(record.password) ? { ...record, password: secret } : record;
    });
  }
  return next;
}

function slotLabel(slot: FieldSecretSlot): string {
  return slot.kind === "field" ? slot.label : `Jump host password (${slot.host})`;
}

/** Ask for one missing secret; `null` when dismissed. */
async function promptFor(
  slot: FieldSecretSlot,
  settings: Record<string, unknown>,
  requestPassword: RequestPassword,
  allowSave: boolean
): Promise<string | null> {
  const host =
    slot.kind === "hop"
      ? slot.host
      : readString(settings, "sshHost") || readString(settings, "host");
  const username =
    slot.kind === "hop"
      ? slot.username
      : readString(settings, "sshUsername") || readString(settings, "username");
  const notice = `Enter the ${slotLabel(slot)} for this connection.`;
  return await requestPassword(host, username, notice, "password", { allowSave });
}

/** Take the stored field secrets, behind the unlock gate. */
async function takeStored(
  opts: ResolveFieldSecretsOptions,
  connectionId: string
): Promise<FieldSecrets | FieldSecretsResult> {
  const gate = { authMethod: "", fieldSecrets: true };
  if (opts.unattended && credentialStoreNeedsUnlock(gate)) {
    return { status: "refused", reason: "The credential store is locked." };
  }
  if (!(await ensureCredentialStoreUnlocked(gate))) {
    return {
      status: "canceled",
      reason: "Connect canceled — the credential store stayed locked.",
    };
  }
  return (
    (await fetchStoredFieldSecrets(connectionId, opts.sourceFile ?? null).catch(() => null)) ?? {}
  );
}

/** Fill in the schema field secrets a connect needs; see the module docs. */
export async function resolveFieldSecrets(
  opts: ResolveFieldSecretsOptions
): Promise<FieldSecretsResult> {
  let settings = opts.settings;
  if (neededFieldSecrets(opts.schema, settings).length === 0) {
    return { status: "resolved", settings };
  }
  const mode = useAppStore.getState().credentialStoreStatus?.mode;
  const usesStore = opts.connectionId !== null && mode !== "none";
  if (usesStore && opts.connectionId !== null) {
    const stored = await takeStored(opts, opts.connectionId);
    if ("status" in stored) return stored;
    settings = splice(settings, stored);
  }

  const missing = neededFieldSecrets(opts.schema, settings);
  if (missing.length > 0 && opts.unattended) {
    return { status: "refused", reason: `No saved ${slotLabel(missing[0])}.` };
  }
  const allowSave = usesStore && (opts.allowSave ?? true);
  const entered: Required<FieldSecrets> = { fields: {}, hops: {} };
  const toSave: Required<FieldSecrets> = { fields: {}, hops: {} };
  for (const slot of missing) {
    const value = await promptFor(slot, settings, opts.requestPassword, allowSave);
    if (value === null) {
      return { status: "canceled", reason: `Connect canceled — ${slotLabel(slot)} is required.` };
    }
    const target = slot.kind === "field" ? "fields" : "hops";
    const slotKey = slot.kind === "field" ? slot.key : slot.id;
    entered[target][slotKey] = value;
    if (allowSave && useAppStore.getState().passwordPromptShouldSave) {
      toSave[target][slotKey] = value;
    }
  }
  settings = splice(settings, entered);
  await saveEntered(opts, toSave);
  return { status: "resolved", settings };
}

/** Persist the prompted secrets whose Save box was checked. */
async function saveEntered(
  opts: ResolveFieldSecretsOptions,
  toSave: Required<FieldSecrets>
): Promise<void> {
  const secrets: FieldSecrets = {};
  if (Object.keys(toSave.fields).length > 0) secrets.fields = toSave.fields;
  if (Object.keys(toSave.hops).length > 0) secrets.hops = toSave.hops;
  if (opts.connectionId === null || (!secrets.fields && !secrets.hops)) return;
  await storeFieldSecrets(opts.connectionId, secrets, opts.sourceFile ?? null).catch((err) =>
    frontendLog("field_secrets", `Failed to store field secrets: ${errorMessage(err)}`)
  );
}
