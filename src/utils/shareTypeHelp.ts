/**
 * What the three kinds of file server are for, in plain words (#6028, #6036):
 * the sibling of `tunnelTypeHelp.ts`, with the same shape, for the sidebar row,
 * its tooltip and the editor.
 */
import { t, tf } from "@/i18n/catalog";
import type { ServerType } from "@/types/embeddedServer";
import { PROTOCOL_LABELS } from "@/types/embeddedServer";
import { THIS_COMPUTER } from "@/types/tunnel";
import type { HostChoice } from "@/utils/hostChoice";
import { tunnelHostMachine } from "@/utils/tunnelHost";

/** The file server kinds in the order every surface lists them. */
export const SHARE_TYPE_KINDS: readonly ServerType[] = ["http", "ftp", "tftp"];

/** The explanation of one kind of file server. */
export interface ShareTypeHelp {
  /** `Web server`, `FTP server` or `TFTP server`. */
  label: string;
  /** The protocol: `HTTP`, `FTP` or `TFTP`. */
  protocol: string;
  /** A short phrase for a card or a list line; no full stop. */
  summary: string;
  /** What it is for, how it works, an everyday example. */
  lines: readonly [lead: string, how: string, example: string];
}

const TEXT = {
  http: {
    label: "share.type.http.label",
    summary: "share.type.http.summary",
    lead: "share.type.http.lead",
    how: "share.type.http.how",
    example: "share.type.http.example",
  },
  ftp: {
    label: "share.type.ftp.label",
    summary: "share.type.ftp.summary",
    lead: "share.type.ftp.lead",
    how: "share.type.ftp.how",
    example: "share.type.ftp.example",
  },
  tftp: {
    label: "share.type.tftp.label",
    summary: "share.type.tftp.summary",
    lead: "share.type.tftp.lead",
    how: "share.type.tftp.how",
    example: "share.type.tftp.example",
  },
} as const;

/**
 * Explain `kind` for a server that runs on `host`. `agentName` is the resolved
 * name of an agent host, falling back to its raw id.
 */
export function shareTypeHelp(
  kind: ServerType,
  host: HostChoice = THIS_COMPUTER,
  agentName?: string
): ShareTypeHelp {
  const text = TEXT[kind];
  return {
    label: t(text.label),
    protocol: PROTOCOL_LABELS[kind],
    summary: t(text.summary),
    lines: [
      t(text.lead),
      tf(text.how, { machine: tunnelHostMachine(host, agentName) }),
      t(text.example),
    ],
  };
}
