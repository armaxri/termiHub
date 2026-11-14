import { Cable, Route, TerminalSquare } from "lucide-react";
import { useAppStore, getActiveTab } from "@/store/appStore";
import { serialStatusChip, sshStatusChip, telnetStatusChip } from "@/utils/sessionStatusChips";
import { UnencryptedBadge } from "@/components/UnencryptedBadge";
import { useTabSshHostKeyTrust } from "@/store/sshHostKeyTrustBridge";

/**
 * The SSH chip for the active tab (#5628): `SSH: user@host:port` on every SSH
 * tab, with ` via hop:port` when it jumps, and the auth method and the host
 * key's trust state (#5669) in the tooltip. Hidden for non-SSH tabs.
 */
export function SshStatus() {
  const config = useAppStore((s) => getActiveTab(s)?.config ?? undefined);
  const tabId = useAppStore((s) => getActiveTab(s)?.id);
  const hostKeys = useTabSshHostKeyTrust(tabId);
  const chip = sshStatusChip(config, hostKeys);
  if (!chip) return null;
  return (
    <span className="status-bar__item" data-testid="status-bar-ssh" title={chip.tooltip}>
      <Route size={13} />
      SSH: {chip.label}
    </span>
  );
}

/**
 * The serial chip for the active tab (#5628): `<port> · 9600 8N1`, the key
 * facts for serial work. Hidden for non-serial tabs.
 */
export function SerialStatus() {
  const config = useAppStore((s) => getActiveTab(s)?.config ?? undefined);
  const chip = serialStatusChip(config);
  if (!chip) return null;
  return (
    <span className="status-bar__item" data-testid="status-bar-serial" title={chip.tooltip}>
      <Cable size={13} />
      {chip.label}
    </span>
  );
}

/**
 * The telnet chip for the active tab (#5749): `Telnet: host:port` with the
 * "Unencrypted" badge, since telnet sends everything in clear text. Hidden for
 * non-telnet tabs.
 */
export function TelnetStatus() {
  const config = useAppStore((s) => getActiveTab(s)?.config ?? undefined);
  const chip = telnetStatusChip(config);
  if (!chip) return null;
  return (
    <span
      className="status-bar__item status-bar__item--with-icon"
      data-testid="status-bar-telnet"
      title={chip.tooltip}
    >
      <TerminalSquare size={13} aria-hidden />
      {chip.label}
      <UnencryptedBadge data-testid="status-bar-telnet-unencrypted" />
    </span>
  );
}
