import { availableMonitors, primaryMonitor } from "@tauri-apps/api/window";
import type { MonitorRect } from "@/types/remoteDesktop";

/**
 * Multi-monitor remote-desktop sessions (#3696, audit PROD-018).
 *
 * UX: a multi-monitor session renders in **one tab** as the combined desktop
 * (the remote framebuffer is the bounding box of every monitor). The toolbar's
 * viewport selector shows either **all monitors** or **one monitor's region**,
 * scaled to the tab. The connection editor's "Monitors" row picks the layout:
 * single (default), all local displays, or a custom count of side-by-side
 * monitors. This module holds the pure layout math plus the one read of the
 * local display geometry (Tauri monitor API).
 */

/** The connection editor's monitor mode (mirrors Rust `MonitorMode`). */
export type MonitorMode = "single" | "all" | "custom";

/** Most monitors a layout may carry (mirrors Rust `MAX_MONITORS`). */
export const MAX_MONITORS = 16;

/** Default count for the custom mode (mirrors Rust `DEFAULT_CUSTOM_MONITOR_COUNT`). */
const DEFAULT_CUSTOM_COUNT = 2;

/** Per-monitor size used when the local primary display is unknown. */
const FALLBACK_MONITOR = { width: 1920, height: 1080 };

/** A local display in physical pixels, as the Tauri monitor API reports it. */
export interface LocalDisplay {
  /** Left edge in the virtual screen, physical pixels. */
  x: number;
  /** Top edge in the virtual screen, physical pixels. */
  y: number;
  /** Width in physical pixels. */
  width: number;
  /** Height in physical pixels. */
  height: number;
  /** Physical → logical pixel factor (2 on a Retina display). */
  scaleFactor: number;
}

/** A rectangle within the combined framebuffer. */
export interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The monitor mode a connection's settings select. Anything unknown —
 * including a connection saved before #3696 — is single.
 */
export function monitorModeOf(settings: Record<string, unknown>): MonitorMode {
  const mode = typeof settings.monitors === "string" ? settings.monitors.trim().toLowerCase() : "";
  return mode === "all" || mode === "custom" ? mode : "single";
}

/** Whether the settings ask for more than one monitor. */
export function isMultiMonitor(settings: Record<string, unknown>): boolean {
  return monitorModeOf(settings) !== "single";
}

/** The custom-mode monitor count, clamped to 2..16. */
export function customMonitorCount(settings: Record<string, unknown>): number {
  const raw = Number(settings.monitorCount);
  const count = Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_CUSTOM_COUNT;
  return Math.min(MAX_MONITORS, Math.max(2, count));
}

function logical(d: LocalDisplay): Viewport {
  const scale = d.scaleFactor > 0 ? d.scaleFactor : 1;
  return {
    x: Math.round(d.x / scale),
    y: Math.round(d.y / scale),
    width: Math.round(d.width / scale),
    height: Math.round(d.height / scale),
  };
}

/**
 * One remote monitor per local display, in logical pixels so the remote
 * renders at the size the user sees (scale 100). The `primary` display (matched
 * by position) becomes the remote primary. The backend re-lays overlapping
 * rects (mixed-DPI displays) and moves the primary to the origin.
 */
export function layoutFromLocalDisplays(
  displays: LocalDisplay[],
  primary: LocalDisplay | null
): MonitorRect[] {
  return displays.slice(0, MAX_MONITORS).map((d) => ({
    ...logical(d),
    primary: primary !== null && d.x === primary.x && d.y === primary.y,
    scale: 100,
  }));
}

/** `count` monitors of `width x height` in one row, the first primary. */
export function customLayout(count: number, width: number, height: number): MonitorRect[] {
  return Array.from({ length: Math.min(count, MAX_MONITORS) }, (_, i) => ({
    x: i * width,
    y: 0,
    width,
    height,
    primary: i === 0,
    scale: 100,
  }));
}

/** Read the local displays and the primary one; empty when unavailable. */
export async function readLocalDisplays(): Promise<{
  displays: LocalDisplay[];
  primary: LocalDisplay | null;
}> {
  const toDisplay = (m: {
    position: { x: number; y: number };
    size: { width: number; height: number };
    scaleFactor: number;
  }): LocalDisplay => ({
    x: m.position.x,
    y: m.position.y,
    width: m.size.width,
    height: m.size.height,
    scaleFactor: m.scaleFactor,
  });
  try {
    const [all, primary] = await Promise.all([availableMonitors(), primaryMonitor()]);
    return {
      displays: all.map(toDisplay),
      primary: primary ? toDisplay(primary) : null,
    };
  } catch {
    return { displays: [], primary: null };
  }
}

/**
 * The concrete layout to stamp into the connect settings (`monitorLayout`), or
 * `null` for a single-monitor connection. "All" mirrors the local displays;
 * "custom" repeats the local primary display's logical size.
 */
export async function connectMonitorLayout(
  settings: Record<string, unknown>
): Promise<MonitorRect[] | null> {
  const mode = monitorModeOf(settings);
  if (mode === "single") return null;
  const { displays, primary } = await readLocalDisplays();
  if (mode === "all") return layoutFromLocalDisplays(displays, primary);
  const size = primary ? logical(primary) : FALLBACK_MONITOR;
  return customLayout(customMonitorCount(settings), size.width, size.height);
}

/** Whether two layouts are the same monitors in the same order. */
export function sameLayout(a: MonitorRect[], b: MonitorRect[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (m, i) =>
        m.x === b[i].x &&
        m.y === b[i].y &&
        m.width === b[i].width &&
        m.height === b[i].height &&
        m.primary === b[i].primary
    )
  );
}

/**
 * The per-monitor viewports the toolbar offers: the reported monitors that lie
 * fully inside the current `fbWidth x fbHeight` framebuffer. A server that
 * ignored the layout (one wide monitor) leaves fewer than two — then there is
 * nothing to select and the result is empty.
 */
export function viewportsFor(
  monitors: MonitorRect[],
  fbWidth: number,
  fbHeight: number
): MonitorRect[] {
  const inside = monitors.filter(
    (m) =>
      m.x >= 0 &&
      m.y >= 0 &&
      m.width > 0 &&
      m.height > 0 &&
      m.x + m.width <= fbWidth &&
      m.y + m.height <= fbHeight
  );
  return inside.length >= 2 ? inside : [];
}

/** Toolbar label for monitor `index` (0-based). */
export function monitorLabel(monitor: MonitorRect, index: number): string {
  const primary = monitor.primary ? ", primary" : "";
  return `Monitor ${index + 1} (${monitor.width}×${monitor.height}${primary})`;
}
