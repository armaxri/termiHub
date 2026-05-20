/**
 * Module-level registry for live flexlayout Model instances and Layout API handles.
 *
 * Zustand stores serialisable IJsonModel for persistence; this module holds the
 * mutable Model objects that the <Layout> components need at runtime.
 */

import {
  Model,
  TabSetNode,
  TabNode,
  Actions,
  DockLocation,
  type IJsonModel,
  type IJsonTabNode,
  type IJsonTabSetNode,
  type IJsonRowNode,
  type ILayoutApi,
} from "flexlayout-react";

const modelRegistry = new Map<string, Model>();
const layoutApiRegistry = new Map<string, ILayoutApi>();

export function registerModel(groupId: string, model: Model): void {
  modelRegistry.set(groupId, model);
}

export function getModel(groupId: string): Model | undefined {
  return modelRegistry.get(groupId);
}

export function deleteModel(groupId: string): void {
  modelRegistry.delete(groupId);
  layoutApiRegistry.delete(groupId);
}

export function registerLayoutApi(groupId: string, api: ILayoutApi): void {
  layoutApiRegistry.set(groupId, api);
}

export function unregisterLayoutApi(groupId: string): void {
  layoutApiRegistry.delete(groupId);
}

/** Return the ID of the first tabset in the model, or null if there is none. */
export function getFirstTabsetId(model: Model): string | null {
  return model.getFirstTabSet()?.getId() ?? null;
}

/** Return the ID of the first tabset in a JSON model (for pre-mount use). */
export function getFirstTabsetIdFromJson(json: IJsonModel): string | null {
  return findFirstTabsetId(json.layout);
}

function findFirstTabsetId(row: IJsonRowNode): string | null {
  for (const child of row.children ?? []) {
    if ((child as IJsonTabSetNode).type === "tabset") {
      return (child as IJsonTabSetNode).id ?? null;
    }
    const found = findFirstTabsetId(child as IJsonRowNode);
    if (found) return found;
  }
  return null;
}

/** Build the initial single-tabset model JSON for a new empty group. */
export function createInitialModelJson(tabsetId: string): IJsonModel {
  return {
    global: {
      tabEnableRename: false,
      tabEnableRenderOnDemand: false,
      tabSetEnableDeleteWhenEmpty: false,
      tabSetEnableMaximize: false,
      tabSetEnableTabScrollbar: false,
    },
    layout: {
      type: "row",
      children: [
        {
          type: "tabset",
          id: tabsetId,
          children: [],
        },
      ],
    },
  };
}

/** Add a tab node to the matching tabset in the JSON tree (for pre-mount operations). */
export function addTabToModelJson(
  json: IJsonModel,
  tabsetId: string,
  tabJson: IJsonTabNode
): IJsonModel {
  return { ...json, layout: addTabToRow(json.layout, tabsetId, tabJson) };
}

function addTabToRow(row: IJsonRowNode, tabsetId: string, tabJson: IJsonTabNode): IJsonRowNode {
  const newChildren = (row.children ?? []).map((child) => {
    if ((child as IJsonTabSetNode).type === "tabset") {
      const tabset = child as IJsonTabSetNode;
      if (tabset.id === tabsetId) {
        const existing = tabset.children ?? [];
        return { ...tabset, children: [...existing, tabJson], selected: existing.length };
      }
      return tabset;
    }
    return addTabToRow(child as IJsonRowNode, tabsetId, tabJson);
  });
  return { ...row, children: newChildren };
}

/**
 * Add a tab to a live model (via ILayoutApi if available, direct doAction otherwise).
 * Returns the ID of the tabset the tab was added to.
 */
export function addTabToLiveModel(groupId: string, tabsetId: string, tabJson: IJsonTabNode): void {
  const api = layoutApiRegistry.get(groupId);
  if (api) {
    api.addTabToTabSet(tabsetId, tabJson);
    return;
  }
  const model = modelRegistry.get(groupId);
  if (model) {
    model.doAction(Actions.addTab(tabJson, tabsetId, DockLocation.CENTER, -1, true));
  }
}

/**
 * Remove a tab from the live model and return the updated JSON.
 * Caller must sync the result back to the store.
 */
export function removeTabFromLiveModel(groupId: string, tabId: string): IJsonModel | null {
  const model = modelRegistry.get(groupId);
  if (!model) return null;
  model.doAction(Actions.deleteTab(tabId));
  return model.toJson();
}

/**
 * Select a tab in the live model and return the updated JSON.
 */
export function selectTabInLiveModel(groupId: string, tabId: string): IJsonModel | null {
  const model = modelRegistry.get(groupId);
  if (!model) return null;
  model.doAction(Actions.selectTab(tabId));
  return model.toJson();
}

/**
 * Add a new split next to the active tabset.
 * Creates a new terminal tab (whose tabId is given) in a split position.
 * Returns the new tabset ID and updated JSON, or null if model not found.
 */
export function splitActiveTabset(
  groupId: string,
  tabId: string,
  title: string,
  direction: "horizontal" | "vertical"
): { newTabSetId: string; modelJson: IJsonModel } | null {
  const model = modelRegistry.get(groupId);
  if (!model) return null;

  const activeTabSet = model.getActiveTabset();
  if (!activeTabSet) return null;

  const location = direction === "horizontal" ? DockLocation.RIGHT : DockLocation.BOTTOM;
  const tabJson: IJsonTabNode = { id: tabId, name: title };
  const added = model.doAction(
    Actions.addTab(tabJson, activeTabSet.getId(), location, -1, true)
  ) as TabNode | undefined;

  const newTabSetId = (added?.getParent() as TabSetNode | undefined)?.getId() ?? null;
  return newTabSetId ? { newTabSetId, modelJson: model.toJson() } : null;
}
