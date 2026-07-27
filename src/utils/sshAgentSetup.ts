import { getPlatform } from "@/utils/platform";

type Platform = ReturnType<typeof getPlatform>;

/**
 * Copyable shell command that starts the local SSH agent so key auth can
 * succeed, tailored to the host OS.
 *
 * The remedy differs fundamentally by platform, so a single hardcoded command is
 * wrong on the others (#2088): Windows' `ssh-agent` is a disabled service that
 * must be enabled and started (elevated), whereas macOS/Linux have no such
 * service — the user starts an agent for the shell and adds keys. Showing the
 * Windows PowerShell `Set-Service ssh-agent` line on macOS/Linux is
 * non-actionable, so callers must branch on {@link getPlatform}.
 *
 * `ConnectionEditor`'s "Setup SSH Agent" button launches these same remedies in
 * a shell tab; this helper is the copyable-hint form shown on the connection
 * overlay. Keeping the wording here means the two surfaces can't silently drift.
 */
export function sshAgentStartCommand(platform: Platform = getPlatform()): string {
  if (platform === "windows") {
    return "Start-Process powershell -Verb RunAs -ArgumentList 'Set-Service ssh-agent -StartupType Manual; Start-Service ssh-agent'";
  }
  return 'eval "$(ssh-agent -s)" && ssh-add';
}
