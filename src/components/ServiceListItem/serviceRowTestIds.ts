/**
 * The test ids of a service row, per kind. Literal, so the test-id catalog sees
 * every family; both kinds keep the ids they had before they shared a row.
 */
import type { ServiceActionId, ServiceKind } from "@/utils/serviceModel";

export interface ServiceRowTestIds {
  rowTestId: string;
  nameTestId: string;
  statusTestId: string;
  descriptionTestId: string;
  tooltipTestId: string;
  primaryTestId: string;
  kindTestId: string;
  addressTestId: string;
  reasonTestId: string;
  nextStepTestId: string;
  /** Buttons on the row. */
  actionTestIds: Record<ServiceActionId, string>;
  /** Items of the context menu. */
  menuTestIds: Record<ServiceActionId, string>;
}

function tunnelTestIds(id: string): ServiceRowTestIds {
  return {
    rowTestId: `tunnel-item-${id}`,
    nameTestId: `tunnel-name-${id}`,
    statusTestId: `tunnel-status-${id}`,
    descriptionTestId: `tunnel-description-${id}`,
    tooltipTestId: `tunnel-tooltip-${id}`,
    primaryTestId: `tunnel-primary-${id}`,
    kindTestId: `tunnel-kind-${id}`,
    addressTestId: `tunnel-address-${id}`,
    reasonTestId: `tunnel-reason-${id}`,
    nextStepTestId: `tunnel-choose-connection-${id}`,
    actionTestIds: {
      start: `tunnel-start-${id}`,
      stop: `tunnel-stop-${id}`,
      stopWaiting: `tunnel-stop-${id}`,
      retry: `tunnel-retry-${id}`,
      copyAddress: `tunnel-copy-address-${id}`,
      openInBrowser: `tunnel-open-browser-${id}`,
      activity: `tunnel-activity-${id}`,
      edit: `tunnel-edit-${id}`,
      restart: `tunnel-reconnect-${id}`,
      duplicate: `tunnel-duplicate-${id}`,
      delete: `tunnel-delete-${id}`,
    },
    menuTestIds: {
      start: `tunnel-ctx-start-${id}`,
      stop: `tunnel-ctx-stop-${id}`,
      stopWaiting: `tunnel-ctx-stop-${id}`,
      retry: `tunnel-ctx-retry-${id}`,
      copyAddress: `tunnel-ctx-copy-address-${id}`,
      openInBrowser: `tunnel-ctx-open-browser-${id}`,
      activity: `tunnel-ctx-activity-${id}`,
      edit: `tunnel-ctx-edit-${id}`,
      restart: `tunnel-ctx-reconnect-${id}`,
      duplicate: `tunnel-ctx-duplicate-${id}`,
      delete: `tunnel-ctx-delete-${id}`,
    },
  };
}

function serverTestIds(id: string): ServiceRowTestIds {
  return {
    rowTestId: `server-item-${id}`,
    nameTestId: `server-name-${id}`,
    statusTestId: `server-status-${id}`,
    descriptionTestId: `server-description-${id}`,
    tooltipTestId: `server-tooltip-${id}`,
    primaryTestId: `server-primary-${id}`,
    kindTestId: `server-kind-${id}`,
    addressTestId: `server-address-${id}`,
    reasonTestId: `server-reason-${id}`,
    nextStepTestId: `server-next-step-${id}`,
    actionTestIds: {
      start: `server-start-${id}`,
      stop: `server-stop-${id}`,
      stopWaiting: `server-stop-${id}`,
      retry: `server-retry-${id}`,
      copyAddress: `server-copy-address-${id}`,
      openInBrowser: `server-open-browser-${id}`,
      activity: `server-activity-toggle-${id}`,
      edit: `server-edit-${id}`,
      restart: `server-restart-${id}`,
      duplicate: `server-duplicate-${id}`,
      delete: `server-delete-${id}`,
    },
    menuTestIds: {
      start: `ctx-start-${id}`,
      stop: `ctx-stop-${id}`,
      stopWaiting: `ctx-stop-${id}`,
      retry: `ctx-retry-${id}`,
      copyAddress: `ctx-copy-url-${id}`,
      openInBrowser: `ctx-open-browser-${id}`,
      activity: `ctx-activity-${id}`,
      edit: `ctx-edit-${id}`,
      restart: `ctx-restart-${id}`,
      duplicate: `ctx-duplicate-${id}`,
      delete: `ctx-delete-${id}`,
    },
  };
}

/** The test ids of the row of service `id`. */
export function serviceRowTestIds(kind: ServiceKind, id: string): ServiceRowTestIds {
  return kind === "tunnel" ? tunnelTestIds(id) : serverTestIds(id);
}
