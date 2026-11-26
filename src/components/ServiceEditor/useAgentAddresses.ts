import { useEffect, useState } from "react";
import { listAgentAddresses } from "@/services/embeddedServerApi";
import type { RemoteAgentDefinition } from "@/types/connection";
import type { NetworkInterface } from "@/types/embeddedServer";
import { errorMessage } from "@/utils/errorMessage";
import { frontendWarn } from "@/utils/frontendLog";

/** What is known of an agent machine's addresses (#6086). */
export type AgentAddresses =
  | { known: true; addresses: NetworkInterface[] }
  /** Typed instead, and why: not connected, too old, or it did not answer. */
  | { known: false; why: "offline" | "old" | "failed" };

type Agent = Pick<RemoteAgentDefinition, "id" | "connectionState" | "capabilities">;

/**
 * The addresses of the machine of `agent` (#6086), asked once it is connected
 * and can say; `undefined` while asking or for this computer.
 */
export function useAgentAddresses(agent: Agent | undefined): AgentAddresses | undefined {
  const id = agent?.id;
  const connected = agent?.connectionState === "connected";
  // Unknown capabilities (not connected yet) are not "too old".
  const canList = agent?.capabilities ? agent.capabilities.hostAddresses === true : undefined;
  const [listed, setListed] = useState<{ id: string; result: AgentAddresses }>();

  useEffect(() => {
    if (!id || !connected || canList !== true) return;
    let current = true;
    listAgentAddresses(id).then(
      (reply) => {
        if (!current) return;
        const result: AgentAddresses = reply.supported
          ? { known: true, addresses: reply.addresses }
          : { known: false, why: "old" };
        setListed({ id, result });
      },
      (err: unknown) => {
        frontendWarn("services", `listing the addresses of ${id} failed: ${errorMessage(err)}`);
        if (current) setListed({ id, result: { known: false, why: "failed" } });
      }
    );
    return () => {
      current = false;
    };
  }, [id, connected, canList]);

  if (!id) return undefined;
  if (!connected) return { known: false, why: "offline" };
  if (canList === false) return { known: false, why: "old" };
  return listed?.id === id ? listed.result : undefined;
}
