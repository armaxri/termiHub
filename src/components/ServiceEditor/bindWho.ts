/** Who can open a port, in words instead of as a bind address (#6028). */
import type { NetworkInterface } from "@/types/embeddedServer";
import { isPrivateBind, isWideBind } from "@/utils/serviceAddress";

/** The machine that opens it, everyone who reaches that, or who reaches one address. */
export type Who = "here" | "network" | "address";

/** What `bind` means; nothing while nobody was chosen. */
export function whoOf(bind: string): Who | undefined {
  if (bind.trim() === "") return undefined;
  if (isPrivateBind(bind)) return "here";
  return isWideBind(bind) ? "network" : "address";
}

/** The addresses of this computer that others may reach. */
export function ownAddresses(
  interfaces: readonly NetworkInterface[],
  current: string
): { value: string; label: string }[] {
  const choices = interfaces
    .filter(({ addr }) => whoOf(addr) === "address")
    .map(({ name, addr }) => ({ value: addr, label: `${addr} (${name})` }));
  // A saved one that is not there now stays what it is.
  if (whoOf(current) === "address" && choices.every(({ value }) => value !== current)) {
    choices.push({ value: current, label: current });
  }
  return choices;
}
