import type { ConnectionTypeInfo } from "@/types/connection";
import type { TabContentType } from "@/types/terminal";

/**
 * The tab content a connection of `typeId` opens into, decided from the
 * registry capabilities — never a per-type hardcode (#1680 / #1335):
 *
 * - a graphical remote-desktop type (`capabilities.graphical === true`, e.g.
 *   VNC/RDP) opens a canvas tab routed through the GraphicalSessionManager;
 * - a terminal-less type (`capabilities.terminal === false`, e.g. FTP) opens a
 *   browser-only tab (no xterm, no PTY);
 * - anything else — including an unknown type or an absent flag — returns
 *   `undefined`, so `addTab` keeps its terminal default.
 *
 * Every surface that opens a connection must route through this, so a VNC
 * connection opened from the editor's Save & Connect gets the same canvas tab
 * as one opened from the sidebar (#4017).
 */
export function connectionTabContentType(
  types: readonly Pick<ConnectionTypeInfo, "typeId" | "capabilities">[],
  typeId: string
): Extract<TabContentType, "remote-desktop" | "file-browser"> | undefined {
  const caps = types.find((ct) => ct.typeId === typeId)?.capabilities;
  if (caps?.graphical === true) return "remote-desktop";
  if (caps?.terminal === false) return "file-browser";
  return undefined;
}
