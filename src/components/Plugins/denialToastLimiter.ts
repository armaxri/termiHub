/**
 * Rate limiting and copy for the plugin-denial toasts (#4188, concept
 * `plugin-os-sandbox.html`, "Copy and placement rules"): when the host refuses
 * a plugin request, the user sees **at most one toast per plugin per 30 s**;
 * later denials in the window fold into "and N more". Every denial is already
 * logged by the host under the `plugin` log target (the Log Viewer entry).
 *
 * Pure and clock-injected, so the whole policy is unit-tested without timers.
 */

import type { PluginDenial, PluginSandboxView } from "@/store/pluginSandboxBridge";

/** The per-plugin toast window. */
export const DENIAL_TOAST_WINDOW_MS = 30_000;

/** One toast to show. */
export interface DenialToast {
  pluginId: string;
  title: string;
  description: string;
}

/** How many denials an entry stands for (`count` folds identical ones). */
function weight(denial: PluginDenial): number {
  return Math.max(1, denial.count ?? 1);
}

/**
 * Whether a denial raises a toast. Only **bridge** denials do: kernel-level
 * (`syscall`) denials are logged only (concept "Copy and placement rules",
 * #4247) and stay visible in the Settings → Plugins details list.
 */
export function isToastable(denial: PluginDenial): boolean {
  return denial.reason !== "syscall";
}

/** One short line for the Settings → Plugins details list. */
export function denialDetail(denial: PluginDenial): string {
  const times = weight(denial) > 1 ? ` (×${weight(denial)})` : "";
  if (denial.reason === "syscall") {
    return `Blocked system call: ${denial.operation}${times}`;
  }
  if (denial.reason === "resourceLimit") {
    return `Limit reached: ${denial.operation}${times}`;
  }
  const target = denial.target ? ` ${denial.target}` : "";
  return `Blocked ${denial.operation}${target}${times}`;
}

/** The plain-language sentence for one denial. */
export function describeDenial(pluginName: string, denial: PluginDenial): string {
  const who = `"${pluginName}"`;
  const target = denial.target;
  if (denial.reason === "syscall") {
    const times = weight(denial) > 1 ? ` (×${weight(denial)})` : "";
    return `${who}: blocked system call: ${denial.operation}${times}.`;
  }
  if (denial.reason === "resourceLimit") {
    return `${who} reached its limit of open connections or pending requests.`;
  }
  if (denial.operation === "open_connection") {
    return `${who} tried to connect to ${target} but does not have the network permission.`;
  }
  if (["read_file", "write_file", "stat", "list_dir"].includes(denial.operation)) {
    return `${who} tried to access ${target}, which is outside the folders it may use.`;
  }
  return `${who} was refused ${denial.operation}${target ? ` on ${target}` : ""}.`;
}

interface PluginWindow {
  /** When the last toast for this plugin was shown. */
  shownAt: number;
  /** Denials folded since then, not yet reported. */
  pending: number;
}

/**
 * Turns successive `plugin-sandbox` views into rate-limited toasts.
 *
 * The first view only sets the baseline (denials from before the UI subscribed
 * are not replayed); a plugin that appears later starts from nothing.
 */
export class DenialToastLimiter {
  private initialized = false;
  private readonly lastSeen = new Map<string, number>();
  private readonly windows = new Map<string, PluginWindow>();

  constructor(private readonly windowMs = DENIAL_TOAST_WINDOW_MS) {}

  /**
   * Process a new view at `now`; returns the toasts to show. `nameOf` maps a
   * plugin id to its display name.
   */
  observe(view: PluginSandboxView, now: number, nameOf: (id: string) => string): DenialToast[] {
    const toasts: DenialToast[] = [];
    for (const [pluginId, status] of Object.entries(view.plugins)) {
      const seen = this.lastSeen.get(pluginId) ?? (this.initialized ? -1 : undefined);
      const latest = status.denials.reduce((max, d) => Math.max(max, d.atMs), seen ?? -1);
      this.lastSeen.set(pluginId, latest);
      if (seen === undefined) continue; // baseline of the first view
      const fresh = status.denials.filter((d) => d.atMs > seen && isToastable(d));
      if (fresh.length === 0) continue;
      const total = fresh.reduce((sum, d) => sum + weight(d), 0);
      const window = this.windows.get(pluginId);
      if (window && now - window.shownAt < this.windowMs) {
        window.pending += total;
        continue;
      }
      const folded = total - 1 + (window?.pending ?? 0);
      this.windows.set(pluginId, { shownAt: now, pending: 0 });
      toasts.push(this.toast(pluginId, nameOf(pluginId), fresh[fresh.length - 1], folded));
    }
    this.initialized = true;
    return toasts;
  }

  /**
   * Report the denials folded into windows that have now closed (so a burst
   * that ends inside a window is still surfaced once). Returns the toasts.
   */
  flush(now: number, nameOf: (id: string) => string): DenialToast[] {
    const toasts: DenialToast[] = [];
    for (const [pluginId, window] of this.windows) {
      if (window.pending === 0 || now - window.shownAt < this.windowMs) continue;
      const n = window.pending;
      this.windows.set(pluginId, { shownAt: now, pending: 0 });
      toasts.push({
        pluginId,
        title: "Blocked plugin requests",
        description: `termiHub blocked ${n} more ${n === 1 ? "request" : "requests"} from "${nameOf(pluginId)}". Details are in the Log Viewer.`,
      });
    }
    return toasts;
  }

  /** When the next open window with folded denials closes, if any. */
  nextFlushAt(): number | undefined {
    let next: number | undefined;
    for (const window of this.windows.values()) {
      if (window.pending === 0) continue;
      const at = window.shownAt + this.windowMs;
      next = next === undefined ? at : Math.min(next, at);
    }
    return next;
  }

  private toast(pluginId: string, name: string, denial: PluginDenial, folded: number): DenialToast {
    const more = folded > 0 ? ` (and ${folded} more)` : "";
    return {
      pluginId,
      title: "Blocked a plugin request",
      description: `${describeDenial(name, denial)}${more} Details are in the Log Viewer.`,
    };
  }
}
