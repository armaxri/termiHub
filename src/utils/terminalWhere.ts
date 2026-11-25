import type { TerminalTab } from "@/types/terminal";
import { readConfigNumber, readConfigString } from "@/utils/connectionConfigFields";

/** The parts of a terminal tab {@link terminalWhere} reads. */
export type TerminalWhereTab = Pick<TerminalTab, "connectionType" | "config">;

/**
 * The machine a terminal types into, so a title like "bash 2" can be told apart
 * (A-035): `arne@web-1`, `10.0.0.2:23`, `/dev/ttyUSB0`, else the connection's kind;
 * "this computer" for a local shell. A **pure** helper.
 */
export function terminalWhere(tab: TerminalWhereTab): string {
  if (tab.connectionType === "local") return "this computer";
  const host = readConfigString(tab.config, "host")?.trim();
  if (host) {
    const user = readConfigString(tab.config, "username")?.trim();
    const port = readConfigNumber(tab.config, "port");
    const usual = tab.connectionType === "ssh" ? 22 : undefined;
    return `${user ? `${user}@` : ""}${host}${port && port !== usual ? `:${port}` : ""}`;
  }
  return readConfigString(tab.config, "port")?.trim() || tab.connectionType;
}
