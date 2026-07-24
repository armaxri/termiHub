import { parseHostPort } from "@/utils/parseHostPort";
import type { ConnectionConfig } from "@/types/terminal";

export interface QuickConnectTarget {
  username?: string;
  host: string;
  port: number;
}

/**
 * Parse a quick-connect string into an SSH target.
 *
 * Grammar: `[user "@"] host [":" port]`. When the user is omitted the caller's
 * `defaultUser` is used; when the port is omitted 22 is assumed. Returns `null`
 * when the input has no host part.
 */
export function parseQuickConnect(
  input: string,
  defaultUser?: string
): QuickConnectTarget | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let userPart: string | undefined;
  let rest = trimmed;

  const atIndex = trimmed.indexOf("@");
  if (atIndex >= 0) {
    userPart = trimmed.slice(0, atIndex).trim();
    rest = trimmed.slice(atIndex + 1).trim();
  }

  if (!rest) return null;

  const { host, port } = parseHostPort(rest);
  if (!host) return null;

  const username = userPart || defaultUser?.trim() || undefined;
  return { username, host, port: port ?? 22 };
}

/** Build an SSH {@link ConnectionConfig} from a parsed quick-connect target. */
export function quickConnectConfig(target: QuickConnectTarget): ConnectionConfig {
  const config: Record<string, unknown> = {
    host: target.host,
    port: target.port,
  };
  if (target.username) config.username = target.username;
  return { type: "ssh", config };
}
