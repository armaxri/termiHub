/** What to say before deleting a service, the same for both kinds (#6068, #6076). */
import { t, tf } from "@/i18n/catalog";
import { isServiceActive, type ServiceState } from "@/utils/serviceState";

/** What deleting does to a service in `state` with `open` connections. */
export function serviceDeleteEffect(state: ServiceState, open: number): string {
  if (state === "notReachable") return t("service.delete.notReachable");
  if (!isServiceActive(state)) return t("service.delete.idle");
  if (open === 0) return t("service.delete.running");
  return open === 1
    ? t("service.delete.running.one")
    : tf("service.delete.running.more", { count: String(open) });
}
