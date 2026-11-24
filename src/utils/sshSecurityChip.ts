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
import type { SshNegotiatedAlgorithms } from "@/types/generated/SshNegotiatedAlgorithms";
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
  id:
    | "endpoint"
    | "encryption"
    | "integrity"
    | "keyExchange"
    | "auth"
    | "hostKey"
    | "hostKeyAlgorithm";
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

/**
 * An SSH algorithm's name in plain words (#5896): the wire name without its
 * vendor suffix, so `chacha20-poly1305@openssh.com` reads `chacha20-poly1305`.
 */
export function plainAlgorithmName(name: string): string {
  const trimmed = name.trim();
  return trimmed.replace(/@[a-z0-9.-]+$/iu, "") || trimmed;
}

/** A row naming one negotiated algorithm, the full wire name on hover when shortened. */
function algorithmRow(id: SshDetailRow["id"], label: string, name: string): SshDetailRow {
  const value = plainAlgorithmName(name);
  return value === name.trim() ? { id, label, value } : { id, label, value, title: name.trim() };
}

/**
 * The encryption rows of the popover: the negotiated cipher, the integrity
 * MAC (only when the cipher is not AEAD) and the key exchange (#5896); just
 * "Encrypted (SSH)" while the algorithms are unknown (still connecting, or an
 * agent too old to report them).
 */
function encryptionRows(algorithms: SshNegotiatedAlgorithms | null | undefined): SshDetailRow[] {
  const label = t("statusBar.ssh.row.encryption");
  if (!algorithms) {
    return [{ id: "encryption", label, value: t("statusBar.ssh.encrypted") }];
  }
  const rows = [algorithmRow("encryption", label, algorithms.cipher)];
  if (algorithms.mac) {
    rows.push(algorithmRow("integrity", t("statusBar.ssh.row.integrity"), algorithms.mac));
  }
  rows.push(algorithmRow("keyExchange", t("statusBar.ssh.row.keyExchange"), algorithms.kex));
  return rows;
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
  /** The session is down (#5955): the chip greys and says so. */
  down: boolean;
}

/** The trust level of the target's accepted host key, `pending` when none. */
export function sshTrustLevel(event: SshHostKeyTrustedEvent | undefined): SshTrustLevel {
  return event ? TRUST_LEVEL[event.trust] : "pending";
}

/**
 * The SSH chip with its security facts for an SSH config, the host keys the
 * tab's connect accepted and, once known, the algorithms the session
 * negotiated (#5896). Returns `null` for non-SSH configs or one without a
 * host (as {@link sshStatusChip}). The algorithms only add popover rows; the
 * chip itself never names them.
 */
export function sshSecurityChip(
  config: ConnectionConfig | undefined | null,
  hostKeys: readonly SshHostKeyTrustedEvent[] = [],
  /** The tab's session is down (ended, failed or reconnecting, #5955). */
  down = false,
  /** The session's negotiated algorithms, once asked (#5896). */
  algorithms?: SshNegotiatedAlgorithms | null
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
    ...encryptionRows(algorithms),
    authRow(fields.authMethod, fields.keyPath),
    { id: "hostKey", label: t("statusBar.ssh.row.hostKey"), value: hostKeyValue },
  ];
  if (algorithms) {
    rows.push(
      algorithmRow("hostKeyAlgorithm", t("statusBar.ssh.row.hostKeyAlgorithm"), algorithms.hostKey)
    );
  }
  const ariaLabel = tf("statusBar.ssh.ariaLabel", { label: chip.label, trust: trustLabel });
  // A down session is not a live secure one (#5955): the chip says so first.
  const downNote = t("statusBar.ssh.down");
  return {
    label: chip.label,
    tooltip: down ? `${downNote}\n${chip.tooltip}` : chip.tooltip,
    trust,
    trustLabel,
    ariaLabel: down ? `${downNote}. ${ariaLabel}` : ariaLabel,
    rows,
    down,
  };
}
