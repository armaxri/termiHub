/**
 * Middle truncation for tab titles (#5827). A tab strip that ellipsizes the
 * *end* of a title cuts exactly the part that tells two tabs apart: the
 * duplicate counter `name (2)` (#5667) and the unique tail of an id-like name
 * (`sys-pr-telnet-0d8db725`). The title is split into a `head` that may be
 * ellipsized and a `tail` that always stays visible, so a narrow tab reads
 * `sys-pr-tel…0d8db725 (2)` instead of `sys-pr-telnet-0d…`.
 */

import type { ConnectionConfig } from "@/types/terminal";
import { readConfigString } from "@/utils/connectionConfigFields";

/** How many characters of the base name stay visible at the end of a narrow tab. */
export const TAB_TITLE_TAIL_CHARS = 8;

/** A duplicate counter suffix such as ` (2)` (see `getTabDisplayTitle`). */
const COUNTER_SUFFIX = /\s\(\d+\)$/u;

export interface TabTitleParts {
  /** The leading part, ellipsized when the tab is too narrow. */
  head: string;
  /** The trailing part that is never truncated; empty for a short title. */
  tail: string;
}

/**
 * Split `title` into a truncatable head and an always-visible tail. The tail is
 * the last {@link TAB_TITLE_TAIL_CHARS} characters of the base name plus any
 * duplicate counter. A base name too short to be worth splitting keeps the
 * whole name in the head, but its counter still goes to the tail. Splits on
 * code points, so an emoji or surrogate pair is never cut in half.
 */
export function splitTabTitle(title: string): TabTitleParts {
  const counter = COUNTER_SUFFIX.exec(title)?.[0] ?? "";
  const base = counter ? title.slice(0, -counter.length) : title;
  const chars = Array.from(base);
  // Only split a base that leaves a meaningful head before the tail.
  if (chars.length <= TAB_TITLE_TAIL_CHARS * 2) {
    return { head: base, tail: counter };
  }
  const cut = chars.length - TAB_TITLE_TAIL_CHARS;
  return {
    head: chars.slice(0, cut).join(""),
    tail: chars.slice(cut).join("") + counter,
  };
}

/**
 * The serial port a tab is attached to (#5827), shown in the tab tooltip so a
 * truncated serial tab still names its port: a direct serial connection, or a
 * serial session on a remote agent. `undefined` for every other tab.
 */
export function tabSerialPort(config: ConnectionConfig | undefined | null): string | undefined {
  if (!config) return undefined;
  const serial =
    config.type === "serial" ||
    (config.type === "remote-session" && readConfigString(config, "sessionType") === "serial");
  if (!serial) return undefined;
  return readConfigString(config, "port")?.trim() || undefined;
}

/**
 * The tab's tooltip text: the full title, plus the serial port when the title
 * does not already name it (#5827).
 */
export function tabTooltipTitle(
  title: string,
  config: ConnectionConfig | undefined | null
): string {
  const port = tabSerialPort(config);
  return port && !title.includes(port) ? `${title} · ${port}` : title;
}
