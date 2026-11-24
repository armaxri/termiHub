import {
  Cable,
  Route,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  TerminalSquare,
} from "lucide-react";
import { useAppStore, getActiveTab } from "@/store/appStore";
import { serialStatusChip, telnetStatusChip } from "@/utils/sessionStatusChips";
import { sshSecurityChip, type SshTrustLevel } from "@/utils/sshSecurityChip";
import { localShellChip } from "@/utils/localShellChip";
import {
  DropdownMenuContent,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  MenuItem,
  MenuLabel,
  MenuSeparator,
} from "@/components/ui";
import { t } from "@/i18n/catalog";
import { UnencryptedBadge } from "@/components/UnencryptedBadge";
import { useTabSshHostKeyTrust } from "@/store/sshHostKeyTrustBridge";

/** The chip icon per trust level: a check once the key is remembered. */
const TRUST_ICON: Record<SshTrustLevel, typeof ShieldCheck> = {
  trusted: ShieldCheck,
  once: ShieldAlert,
  pending: Shield,
};

/**
 * The SSH chip for the active tab (#5628): `SSH: user@host:port` on every SSH
 * tab, with ` via hop:port` when it jumps. A shield shows the host key's trust
 * and that the session is encrypted (#5839); clicking opens a popover with the
 * host, encryption, sign-in method and host key, plus a link to manage
 * trusted keys. The tooltip (#5669) stays for hover. Hidden for non-SSH tabs.
 */
export function SshStatus() {
  const config = useAppStore((s) => getActiveTab(s)?.config ?? undefined);
  const tabId = useAppStore((s) => getActiveTab(s)?.id);
  const openSettingsTab = useAppStore((s) => s.openSettingsTab);
  const hostKeys = useTabSshHostKeyTrust(tabId);
  const chip = sshSecurityChip(config, hostKeys);
  if (!chip) return null;
  const TrustIcon = TRUST_ICON[chip.trust];
  return (
    <DropdownMenuRoot>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="status-bar__item status-bar__item--interactive status-bar__item--with-icon"
          data-testid="status-bar-ssh"
          data-trust={chip.trust}
          aria-label={chip.ariaLabel}
          title={chip.tooltip}
        >
          <Route size={13} aria-hidden />
          SSH: {chip.label}
          <TrustIcon
            size={13}
            aria-hidden
            className={`status-bar__ssh-trust status-bar__ssh-trust--${chip.trust}`}
            data-testid="status-bar-ssh-trust"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={4}
        width="wide"
        data-testid="status-bar-ssh-details"
      >
        <MenuLabel>{t("statusBar.ssh.title")}</MenuLabel>
        <dl className="status-bar__ssh-details">
          {chip.rows.map((row) => (
            <div key={row.id} className="status-bar__ssh-row">
              <dt>{row.label}</dt>
              <dd data-testid={`status-bar-ssh-details-${row.id}`}>{row.value}</dd>
            </div>
          ))}
        </dl>
        <MenuSeparator />
        <MenuItem
          icon={<ShieldCheck size={14} aria-hidden />}
          onSelect={() => openSettingsTab({ category: "security" })}
          data-testid="status-bar-ssh-manage-trust"
        >
          {t("statusBar.ssh.manageTrust")}
        </MenuItem>
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}

/**
 * The local-shell chip for the active tab (#5839): the shell's name, so the
 * bar is not empty in a local session. Hidden for remote and non-terminal tabs.
 */
export function LocalShellStatus() {
  const config = useAppStore((s) => getActiveTab(s)?.config ?? undefined);
  const contentType = useAppStore((s) => getActiveTab(s)?.contentType);
  const chip = localShellChip(config, contentType);
  if (!chip) return null;
  return (
    <span
      className="status-bar__item status-bar__item--with-icon"
      data-testid="status-bar-local-shell"
      title={chip.tooltip}
    >
      <Terminal size={13} aria-hidden />
      {chip.label}
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
