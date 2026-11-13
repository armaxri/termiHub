import { AlertTriangle, MonitorCog, MonitorX } from "lucide-react";
import { Chip } from "@/components/ui";
import type { X11ForwardingMode } from "@/types/generated/X11ForwardingMode";
import type { X11ForwardingReason } from "@/types/generated/X11ForwardingReason";

/** What the chip shows for one {@link X11ForwardingMode}. */
interface X11ModeCopy {
  label: string;
  hint: string;
  tone: "ok" | "fallback" | "failed";
}

/**
 * The chip label and its hover/focus hint for each mode (#5586). The label
 * stays short so the row does not grow; the hint says why and what to do.
 */
export function x11ModeCopy(mode: X11ForwardingMode): X11ModeCopy {
  switch (mode) {
    case "serverForwarded":
      return {
        label: "X11",
        hint: "X11 forwarding: the SSH server sets DISPLAY. Nothing is typed into the shell.",
        tone: "ok",
      };
    case "fallbackRefused":
      return {
        label: "X11 fallback",
        hint:
          "The server refused X11 forwarding (X11Forwarding no), so DISPLAY is set by a " +
          "hidden setup typed into the shell. Set X11Forwarding yes in the server's " +
          "sshd_config to let the server forward X11.",
        tone: "fallback",
      };
    case "fallbackNoReply":
      return {
        label: "X11 fallback",
        hint:
          "The server did not answer the X11 forwarding request, so DISPLAY is set by a " +
          "hidden setup typed into the shell.",
        tone: "fallback",
      };
    case "failed":
      return {
        label: "X11 failed",
        hint:
          "X11 forwarding could not be set up, so this session runs without it. Start a " +
          "local X server (XQuartz on macOS) and reconnect. With untrusted X11 forwarding " +
          "on, the local X server also needs the SECURITY extension and xauth (XQuartz and " +
          "VcXsrv lack it): turn the option off to forward with full access.",
        tone: "failed",
      };
  }
}

/** Why X11 is not active (or fell back), and the one-line fix (#5601). */
interface X11ReasonCopy {
  why: string;
  fix: string;
}

/**
 * The exact reason the backend reported for a session whose X11 forwarding is
 * not active or fell back (#5601), with a one-line fix. Fixed copy per reason:
 * the backend sends no free text, so nothing here can leak a path or cookie.
 */
export function x11ReasonCopy(reason: X11ForwardingReason): X11ReasonCopy {
  switch (reason) {
    case "noLocalXServer":
      return {
        why: "X11 forwarding is off: no local X server was found.",
        fix: "Start a local X server (XQuartz on macOS, VcXsrv on Windows) and reconnect.",
      };
    case "serverRefused":
      return {
        why:
          "The server refused X11 forwarding (X11Forwarding no), so DISPLAY is set by a " +
          "hidden setup typed into the shell.",
        fix: "Set X11Forwarding yes in the server's sshd_config to let the server forward X11.",
      };
    case "serverNoReply":
      return {
        why:
          "The server did not answer the X11 forwarding request, so DISPLAY is set by a " +
          "hidden setup typed into the shell.",
        fix: "Check the server's sshd log for the X11 request, then reconnect.",
      };
    case "untrustedNoSecurityExtension":
      return {
        why:
          "X11 forwarding is off: untrusted X11 forwarding needs the SECURITY extension, " +
          "which the local X server lacks (as with XQuartz and VcXsrv).",
        fix: "Turn off Untrusted X11 forwarding in the connection settings to forward with full access.",
      };
    case "untrustedXauthMissing":
      return {
        why: "X11 forwarding is off: untrusted X11 forwarding needs xauth, which is not installed here.",
        fix: "Install xauth (it comes with XQuartz on macOS), or turn off Untrusted X11 forwarding.",
      };
    case "untrustedXauthFailed":
      return {
        why: "X11 forwarding is off: xauth could not create an untrusted cookie for the local display.",
        fix: "Check that the local X server is running, or turn off Untrusted X11 forwarding.",
      };
    case "fallbackFailed":
      return {
        why:
          "X11 forwarding is off: the server did not accept X11 forwarding and the typed " +
          "fallback could not start.",
        fix: "Set X11Forwarding yes in the server's sshd_config and reconnect.",
      };
  }
}

/** The chip's tooltip: the exact reason when known, else the mode's hint. */
export function x11ChipHint(mode: X11ForwardingMode, reason?: X11ForwardingReason): string {
  if (!reason || mode === "serverForwarded") return x11ModeCopy(mode).hint;
  const copy = x11ReasonCopy(reason);
  return `${copy.why} ${copy.fix}`;
}

const ICONS = {
  ok: <MonitorCog size={12} />,
  fallback: <AlertTriangle size={12} />,
  failed: <MonitorX size={12} />,
} as const;

/** Props for {@link X11ForwardingChip}. */
export interface X11ForwardingChipProps {
  /** The session's X11 forwarding mode. */
  mode: X11ForwardingMode;
  /** Why X11 is not active or fell back (#5601), when the backend knows. */
  reason?: X11ForwardingReason;
  /** Test hook on the chip. */
  "data-testid"?: string;
}

/**
 * A small chip on an SSH session's Open Connections row saying how its X11
 * forwarding runs (#5586): forwarded by the server, the typed fallback, or
 * failed. The why (the exact reason when known, #5601) and the fix are in its
 * tooltip, so the row stays quiet.
 */
export function X11ForwardingChip({ mode, reason, "data-testid": testId }: X11ForwardingChipProps) {
  const copy = x11ModeCopy(mode);
  return (
    <span className={`oc-x11 oc-x11--${copy.tone}`} data-x11-mode={mode} data-x11-reason={reason}>
      <Chip
        label={copy.label}
        icon={ICONS[copy.tone]}
        tooltip={x11ChipHint(mode, reason)}
        data-testid={testId}
      />
    </span>
  );
}
