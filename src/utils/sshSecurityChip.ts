/**
 * The security facts behind the status-bar SSH chip (#5839): whether the
 * target's host key is trusted, that the session is encrypted, and the rows
 * of the chip's details popover. Before this the facts lived only in the
 * chip's tooltip, so trust was discoverable by hovering alone (R-089, R-112)
 * and "encrypted" could not be told apart from "unknown" (R-103).
 *
 * Pure so the wording is unit-tested; `SshStatus` only renders it.
 */

import type { ConnectionConfig } from "@/types/terminal";
import type { SshHostKeyTrustedEvent } from "@/types/generated/SshHostKeyTrustedEvent";
import type { SshHostKeyTrust } from "@/types/generated/SshHostKeyTrust";
import { isSshConnectionConfig } from "@/utils/typedConnectionConfig";
import { authDescription, sshStatusChip, TRUST_WORDING } from "@/utils/sessionStatusChips";
import { t, tf } from "@/i18n/catalog";

/**
 * How far the target's host key is trusted:
 * - `trusted`: termiHub or `~/.ssh/known_hosts` remembers it;
 * - `once`: accepted for this session only;
 * - `pending`: no connect has reported the key yet (still connecting).
 */
export type SshTrustLevel = "trusted" | "once" | "pending";

const TRUST_LEVEL: Record<SshHostKeyTrust, SshTrustLevel> = {
  knownHosts: "trusted",
  remembered: "trusted",
  firstSeenRemembered: "trusted",
  changedReplaced: "trusted",
  firstSeenOnce: "once",
  changedOnce: "once",
};

/** One labelled row of the SSH details popover. */
export interface SshDetailRow {
  /** Stable key, also the row's test id suffix. */
  id: "endpoint" | "encryption" | "auth" | "hostKey";
  label: string;
  value: string;
  /** Hover text with the full detail when `value` is shortened (the key's full path). */
  title?: string;
}

/**
 * The file name of a key path (#5956): the popover is narrow, and a full
 * absolute path wrapped over several lines buried the file users recognise.
 * Splits on both separators so a Windows path reads right too.
 */
export function keyFileName(keyPath: string): string {
  const trimmed = keyPath.trim().replace(/[\\/]+$/u, "");
  return trimmed.split(/[\\/]/u).pop() || trimmed;
}

/** The "Signed in with" row: a key shows its file name, the full path on hover. */
function authRow(method: string | undefined, keyPath: string | undefined): SshDetailRow {
  const label = t("statusBar.ssh.row.auth");
  const path = keyPath?.trim();
  if (method === "key" && path) {
    return { id: "auth", label, value: `key ${keyFileName(path)}`, title: path };
  }
  return { id: "auth", label, value: authDescription(method, keyPath) };
}

/** The SSH chip plus its trust cue and details popover. */
export interface SshSecurityChip {
  /** `user@host:port` (with ` via …` when it jumps), as in the chip. */
  label: string;
  /** The tooltip of the chip (kept for hover and the product-run harness). */
  tooltip: string;
  trust: SshTrustLevel;
  /** Short trust word shown in the chip's accessible name and the popover. */
  trustLabel: string;
  /** Accessible name of the chip button: label, encryption, trust, action. */
  ariaLabel: string;
  rows: SshDetailRow[];
}

/** The trust level of the target's accepted host key, `pending` when none. */
export function sshTrustLevel(event: SshHostKeyTrustedEvent | undefined): SshTrustLevel {
  return event ? TRUST_LEVEL[event.trust] : "pending";
}

/**
 * The SSH chip with its security facts for an SSH config and the host keys the
 * tab's connect accepted. Returns `null` for non-SSH configs or one without a
 * host (as {@link sshStatusChip}).
 */
export function sshSecurityChip(
  config: ConnectionConfig | undefined | null,
  hostKeys: readonly SshHostKeyTrustedEvent[] = []
): SshSecurityChip | null {
  const chip = sshStatusChip(config, hostKeys);
  if (!chip || !isSshConnectionConfig(config)) return null;
  const fields = config.config;
  const host = fields.host?.trim() ?? "";
  // Same port reading as `sshStatusChip` (numeric strings accepted, 22 default).
  const rawPort = Number(fields.port);
  const port = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 22;
  // A jump chain also reports each hop's key; only the target's is shown.
  const targetKey = hostKeys.find((k) => k.host.trim() === host && k.port === port);
  const trust = sshTrustLevel(targetKey);
  const trustLabel = t(`statusBar.ssh.trust.${trust}`);
  const hostKeyValue = targetKey
    ? `${TRUST_WORDING[targetKey.trust]} · ${targetKey.key_type} ${targetKey.fingerprint}`
    : t("statusBar.ssh.hostKey.pending");
  const rows: SshDetailRow[] = [
    { id: "endpoint", label: t("statusBar.ssh.row.endpoint"), value: chip.label },
    {
      id: "encryption",
      label: t("statusBar.ssh.row.encryption"),
      value: t("statusBar.ssh.encrypted"),
    },
    authRow(fields.authMethod, fields.keyPath),
    { id: "hostKey", label: t("statusBar.ssh.row.hostKey"), value: hostKeyValue },
  ];
  return {
    label: chip.label,
    tooltip: chip.tooltip,
    trust,
    trustLabel,
    ariaLabel: tf("statusBar.ssh.ariaLabel", { label: chip.label, trust: trustLabel }),
    rows,
  };
}
