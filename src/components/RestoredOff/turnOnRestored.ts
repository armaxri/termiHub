import { useAppStore } from "@/store/appStore";
import type { RestoredStart } from "@/types/backup";

/** Turn on what a restore left switched off, after the user read it (#6056). */
export async function turnOnRestored(entry: RestoredStart): Promise<void> {
  const state = useAppStore.getState();
  const on = Object.fromEntries(entry.switches.map((s) => [s, true]));
  switch (entry.section) {
    case "schedules":
      // The dialog named its hosts and steps: this is the confirmation.
      await state.setScheduleEnabled(entry.id, true, true);
      return;
    case "automations":
      return state.setWorkflowTriggersEnabled(entry.id, true);
    case "tunnels": {
      const tunnel = state.tunnels.find((t) => t.id === entry.id);
      if (!tunnel) throw new Error("the tunnel was not found.");
      return state.saveTunnel({ ...tunnel, ...on });
    }
    case "embeddedServers": {
      const server = state.embeddedServers.find((s) => s.id === entry.id);
      if (!server) throw new Error("the file server was not found.");
      return state.saveEmbeddedServer({ ...server, ...on });
    }
    default:
      throw new Error("it cannot be turned on from here.");
  }
}
