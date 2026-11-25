/**
 * The address of a running service, as someone else can type it (#6028).
 *
 * What a row shows is reachable from where the user sits, or the row says on
 * which machine it opens. A wide bind (`0.0.0.0`) is never shown: nobody can
 * open it. It becomes the address of the machine that listens.
 */
import type { PortValue } from "@/types/tunnel";
import { isLoopbackBind } from "@/utils/tunnelHost";

/** The machine that listens. */
export type Listener =
  /** This computer; `network` is its address on the network, when known. */
  | { on: "here"; network?: string }
  /** Another one; `host` is how it is reached from here, when known. */
  | { on: "there"; name: string; host?: string };

export interface ServiceAddress {
  /** What Copy copies, and what the row shows. */
  copy: string;
  /** The machine it opens on, when that is not this computer or the network. */
  on?: string;
}

/** Bind addresses that mean every interface of the machine. */
const WIDE_BINDS = new Set(["0.0.0.0", "::", "[::]", "*"]);

/** Whether `bind` listens on every interface. */
export function isWideBind(bind: string): boolean {
  return WIDE_BINDS.has(bind.trim().toLowerCase());
}

/** `host:port`, with the brackets an IPv6 address needs. */
function hostPort(host: string, port: number): string {
  const bare = host.replace(/^\[|\]$/g, "");
  return bare.includes(":") ? `[${bare}]:${port}` : `${bare}:${port}`;
}

/**
 * The address of a service bound to `bind`:`port` on `listener`, or `undefined`
 * when there is nothing to type (no port yet). `scheme` is `"http://"` and the
 * like, empty for a plain port.
 */
export function serviceAddress(
  bind: string,
  port: PortValue,
  listener: Listener,
  scheme = ""
): ServiceAddress | undefined {
  if (typeof port !== "number" || port <= 0) return undefined;
  const at = (host: string, on?: string): ServiceAddress => {
    const copy = scheme + hostPort(host, port);
    return on ? { copy, on } : { copy };
  };
  const there = listener.on === "there" ? listener.name : undefined;
  // sshd and the backends read an empty bind as loopback.
  if (bind.trim() === "" || isLoopbackBind(bind)) return at("localhost", there);
  if (!isWideBind(bind)) return at(bind.trim());
  const reachable = listener.on === "here" ? listener.network : listener.host;
  return reachable ? at(reachable) : at("localhost", there);
}

/** Split a reported `host:port`; `undefined` when it is not one. */
export function splitHostPort(address: string): { host: string; port: number } | undefined {
  const at = address.lastIndexOf(":");
  const port = Number(address.slice(at + 1));
  if (at <= 0 || !Number.isInteger(port) || port <= 0) return undefined;
  return { host: address.slice(0, at), port };
}
