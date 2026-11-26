/**
 * The test ids of a service row, per kind. Literal, so the test-id catalog sees
 * every family; both kinds keep the ids they had before they shared a row.
 */
import type { ServiceActionId, ServiceKind, ServiceNextStepId } from "@/utils/serviceModel";

/** Spread onto the button or the item of an action. */
export type ServiceActionTestIds = Record<ServiceActionId, { "data-testid": string }>;

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
  technicalTestId: string;
  machineTestId: string;
  riskTestId: string;
  /** Beside the reason. */
  nextStepTestIds: Record<ServiceNextStepId, { "data-testid": string }>;
  /** The button of the "…" menu. */
  moreTestId: string;
  /** Buttons on the row. */
  actionTestIds: ServiceActionTestIds;
  /** Items of the "…" menu. */
  moreItemTestIds: ServiceActionTestIds;
  /** Items of the context menu. */
  menuTestIds: ServiceActionTestIds;
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
    technicalTestId: `tunnel-technical-${id}`,
    machineTestId: `tunnel-machine-${id}`,
    riskTestId: `tunnel-risk-${id}`,
    nextStepTestIds: {
      chooseConnection: { "data-testid": `tunnel-choose-connection-${id}` },
      usePort: { "data-testid": `tunnel-use-port-${id}` },
      edit: { "data-testid": `tunnel-edit-port-${id}` },
      connectAgent: { "data-testid": `tunnel-connect-agent-${id}` },
      checkAgain: { "data-testid": `tunnel-check-again-${id}` },
      keepRunning: { "data-testid": `tunnel-keep-running-${id}` },
      letReach: { "data-testid": `tunnel-let-reach-${id}` },
      chooseMachine: { "data-testid": `tunnel-choose-machine-${id}` },
      unlock: { "data-testid": `tunnel-unlock-${id}` },
      editConnection: { "data-testid": `tunnel-edit-connection-${id}` },
      retryNow: { "data-testid": `tunnel-retry-now-${id}` },
    },
    moreTestId: `tunnel-more-${id}`,
    actionTestIds: {
      start: { "data-testid": `tunnel-start-${id}` },
      stop: { "data-testid": `tunnel-stop-${id}` },
      stopWaiting: { "data-testid": `tunnel-stop-${id}` },
      retry: { "data-testid": `tunnel-retry-${id}` },
      copyAddress: { "data-testid": `tunnel-copy-address-${id}` },
      openInBrowser: { "data-testid": `tunnel-open-browser-${id}` },
      activity: { "data-testid": `tunnel-activity-${id}` },
      edit: { "data-testid": `tunnel-edit-${id}` },
      restart: { "data-testid": `tunnel-reconnect-${id}` },
      duplicate: { "data-testid": `tunnel-duplicate-${id}` },
      delete: { "data-testid": `tunnel-delete-${id}` },
    },
    moreItemTestIds: {
      start: { "data-testid": `tunnel-more-start-${id}` },
      stop: { "data-testid": `tunnel-more-stop-${id}` },
      stopWaiting: { "data-testid": `tunnel-more-stop-${id}` },
      retry: { "data-testid": `tunnel-more-retry-${id}` },
      copyAddress: { "data-testid": `tunnel-more-copy-address-${id}` },
      openInBrowser: { "data-testid": `tunnel-more-open-browser-${id}` },
      activity: { "data-testid": `tunnel-more-activity-${id}` },
      edit: { "data-testid": `tunnel-more-edit-${id}` },
      restart: { "data-testid": `tunnel-reconnect-${id}` },
      duplicate: { "data-testid": `tunnel-duplicate-${id}` },
      delete: { "data-testid": `tunnel-delete-${id}` },
    },
    menuTestIds: {
      start: { "data-testid": `tunnel-ctx-start-${id}` },
      stop: { "data-testid": `tunnel-ctx-stop-${id}` },
      stopWaiting: { "data-testid": `tunnel-ctx-stop-${id}` },
      retry: { "data-testid": `tunnel-ctx-retry-${id}` },
      copyAddress: { "data-testid": `tunnel-ctx-copy-address-${id}` },
      openInBrowser: { "data-testid": `tunnel-ctx-open-browser-${id}` },
      activity: { "data-testid": `tunnel-ctx-activity-${id}` },
      edit: { "data-testid": `tunnel-ctx-edit-${id}` },
      restart: { "data-testid": `tunnel-ctx-reconnect-${id}` },
      duplicate: { "data-testid": `tunnel-ctx-duplicate-${id}` },
      delete: { "data-testid": `tunnel-ctx-delete-${id}` },
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
    technicalTestId: `server-technical-${id}`,
    machineTestId: `server-machine-${id}`,
    riskTestId: `server-risk-${id}`,
    nextStepTestIds: {
      chooseConnection: { "data-testid": `server-choose-connection-${id}` },
      usePort: { "data-testid": `server-use-port-${id}` },
      edit: { "data-testid": `server-edit-port-${id}` },
      connectAgent: { "data-testid": `server-connect-agent-${id}` },
      checkAgain: { "data-testid": `server-check-again-${id}` },
      keepRunning: { "data-testid": `server-keep-running-${id}` },
      letReach: { "data-testid": `server-let-reach-${id}` },
      chooseMachine: { "data-testid": `server-choose-machine-${id}` },
      unlock: { "data-testid": `server-unlock-${id}` },
      editConnection: { "data-testid": `server-edit-connection-${id}` },
      retryNow: { "data-testid": `server-retry-now-${id}` },
    },
    moreTestId: `server-more-${id}`,
    actionTestIds: {
      start: { "data-testid": `server-start-${id}` },
      stop: { "data-testid": `server-stop-${id}` },
      stopWaiting: { "data-testid": `server-stop-${id}` },
      retry: { "data-testid": `server-retry-${id}` },
      copyAddress: { "data-testid": `server-copy-address-${id}` },
      openInBrowser: { "data-testid": `server-open-browser-${id}` },
      activity: { "data-testid": `server-open-activity-${id}` },
      edit: { "data-testid": `server-edit-${id}` },
      restart: { "data-testid": `server-restart-${id}` },
      duplicate: { "data-testid": `server-duplicate-${id}` },
      delete: { "data-testid": `server-delete-${id}` },
    },
    moreItemTestIds: {
      start: { "data-testid": `server-more-start-${id}` },
      stop: { "data-testid": `server-more-stop-${id}` },
      stopWaiting: { "data-testid": `server-more-stop-${id}` },
      retry: { "data-testid": `server-more-retry-${id}` },
      copyAddress: { "data-testid": `server-more-copy-address-${id}` },
      openInBrowser: { "data-testid": `server-more-open-browser-${id}` },
      activity: { "data-testid": `server-more-activity-${id}` },
      edit: { "data-testid": `server-more-edit-${id}` },
      restart: { "data-testid": `server-restart-${id}` },
      duplicate: { "data-testid": `server-duplicate-${id}` },
      delete: { "data-testid": `server-delete-${id}` },
    },
    menuTestIds: {
      start: { "data-testid": `ctx-start-${id}` },
      stop: { "data-testid": `ctx-stop-${id}` },
      stopWaiting: { "data-testid": `ctx-stop-${id}` },
      retry: { "data-testid": `ctx-retry-${id}` },
      copyAddress: { "data-testid": `ctx-copy-url-${id}` },
      openInBrowser: { "data-testid": `ctx-open-browser-${id}` },
      activity: { "data-testid": `ctx-activity-${id}` },
      edit: { "data-testid": `ctx-edit-${id}` },
      restart: { "data-testid": `ctx-restart-${id}` },
      duplicate: { "data-testid": `ctx-duplicate-${id}` },
      delete: { "data-testid": `ctx-delete-${id}` },
    },
  };
}

/** The test ids of the row of service `id`. */
export function serviceRowTestIds(kind: ServiceKind, id: string): ServiceRowTestIds {
  return kind === "tunnel" ? tunnelTestIds(id) : serverTestIds(id);
}
