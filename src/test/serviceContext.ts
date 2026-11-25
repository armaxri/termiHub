import type { ServiceContext } from "@/utils/serviceModel";

/** No agents, no connections, no network: what a row needs when none matters. */
export const NO_CONTEXT: ServiceContext = { agents: [], connections: [] };
