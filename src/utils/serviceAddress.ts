/**
 * The address of a running service, as someone else can type it, and who that
 * may be (#6028, #6063).
 *
 * What a row shows is reachable from where the user sits, or the row says on
 * which machine it opens. A wide bind (`0.0.0.0`) is never shown: nobody can
 * open it. It becomes the address of the machine that listens; when nobody knows
 * that one there is nothing to copy, rather than a localhost that is wrong for
 * everyone else.
 */
import { t, tf } from "@/i18n/catalog";
import type { PortValue } from "@/types/tunnel";
import { isLoopbackBind } from "@/utils/tunnelHost";

/** The machine that listens. */
export type Listener =
  /** This computer; `network` is its address on the network, when known. */
  | { on: "here"; network?: string }
  /**
   * Another one; `host` is how it is reached from here, when known. `shown` when
   * the row names it anyway, as the machine the service runs on.
   */
  | { on: "there"; name: string; host?: string; shown?: boolean };

export interface ServiceAddress {
  /** What Copy copies, and what the row shows; none while nobody knows it. */
  copy?: string;
  /** The machine it opens on, when that is not this computer or the network. */
  on?: string;
  /** Whether others than the machine that listens reach it. */
  open: boolean;
  /** Who reaches it, in words. */
  reach: string;
}

/** Bind addresses that mean every interface of the machine. */
const WIDE_BINDS = new Set(["0.0.0.0", "::", "[::]", "*"]);

/** Whether `bind` listens on every interface. */
export function isWideBind(bind: string): boolean {
  return WIDE_BINDS.has(bind.trim().toLowerCase());
}

/** Whether only the machine itself reaches `bind`. */
function isPrivateBind(bind: string): boolean {
  // sshd and the backends read an empty bind as loopback.
  return bind.trim() === "" || isLoopbackBind(bind) || /^127\./.test(bind.trim());
}

/** `host:port`, with the brackets an IPv6 address needs. */
function hostPort(host: string, port: number): string {
  const bare = host.replace(/^\[|\]$/g, "");
  return bare.includes(":") ? `[${bare}]:${port}` : `${bare}:${port}`;
}

/** Who reaches what `listener` keeps to itself, or opens. */
function reachOf(listener: Listener, open: boolean): string {
  if (listener.on === "here") {
    return t(open ? "service.reach.network" : "service.reach.here");
  }
  if (listener.shown) {
    return t(open ? "service.reach.anyoneThere" : "service.reach.onlyThere");
  }
  return tf(open ? "service.reach.anyoneOn" : "service.reach.onlyOn", { machine: listener.name });
}

/** What to say of an open listener whose address nobody knows. */
function unknownReach(listener: Listener, port: number): string {
  if (listener.on === "here") return tf("service.reach.networkUnknown", { port: String(port) });
  return listener.shown
    ? tf("service.reach.thereUnknown", { port: String(port) })
    : tf("service.reach.onUnknown", { machine: listener.name, port: String(port) });
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
  const at = (host: string) => scheme + hostPort(host, port);
  if (isPrivateBind(bind)) {
    const on = listener.on === "there" ? { on: listener.name } : {};
    const own = /^127\./.test(bind.trim()) && bind.trim() !== "127.0.0.1";
    const copy = at(own ? bind.trim() : "localhost");
    return { copy, ...on, open: false, reach: reachOf(listener, false) };
  }
  const known = listener.on === "here" ? listener.network : listener.host;
  const host = isWideBind(bind) ? known : bind.trim();
  return host
    ? { copy: at(host), open: true, reach: reachOf(listener, true) }
    : { open: true, reach: unknownReach(listener, port) };
}

/** Split a reported `host:port`; `undefined` when it is not one. */
export function splitHostPort(address: string): { host: string; port: number } | undefined {
  const at = address.lastIndexOf(":");
  const port = Number(address.slice(at + 1));
  if (at <= 0 || !Number.isInteger(port) || port <= 0) return undefined;
  return { host: address.slice(0, at), port };
}
