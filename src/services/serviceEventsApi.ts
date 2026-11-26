/** What happened to a service (#6028, slice 9). */
import { invoke } from "@tauri-apps/api/core";
import type { ServiceEvent } from "@/types/generated/ServiceEvent";

/** The events of a tunnel or a file server since termiHub started, the oldest first. */
export async function getServiceEvents(serviceId: string): Promise<ServiceEvent[]> {
  return await invoke<ServiceEvent[]>("get_service_events", { serviceId });
}
