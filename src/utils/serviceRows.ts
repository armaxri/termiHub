/**
 * The rows of the Services sidebar (#6028): which services it shows, in which
 * groups and in which order. Pure, so every rule is a table test.
 */
import {
  offlineAgentOf,
  type ServiceHealth,
  type ServiceKind,
  type ServiceModel,
} from "@/utils/serviceModel";
import { itemMatchesQuery } from "@/hooks/useListFilter";

/** A service of the list; a chained hop (#2597) goes with its parent. */
export interface ServiceEntry {
  model: ServiceModel;
  /** Set on a hop: the tunnel it hangs on. */
  parentId?: string;
  /** What the search looks at besides the model. */
  texts: readonly (string | undefined)[];
}

export interface GroupRow {
  type: "group";
  kind: ServiceKind;
  open: boolean;
  running: number;
  total: number;
}

/** The line of an agent that is offline and has several services here. */
export interface AgentRow {
  type: "agent";
  kind: ServiceKind;
  agentId: string;
  name: string;
  services: number;
}

export interface EntryRow {
  type: "service";
  entry: ServiceEntry;
  underAgent: boolean;
}

export type ServiceRow = GroupRow | AgentRow | EntryRow;

export interface ServiceRowsInput {
  /** In saved order, a hop right after its parent. */
  entries: readonly ServiceEntry[];
  query: string;
  only: ServiceHealth | null;
  /** The groups the user closed. */
  closed: ReadonlySet<ServiceKind>;
  /**
   * The order on screen, by service id, while the pointer or the focus is in the
   * list: a row must not move away from under it.
   */
  held?: readonly string[] | null;
}

/** The groups, in the order they always have. */
export const SERVICE_GROUPS: readonly ServiceKind[] = ["tunnel", "fileServer"];

/** What stands and moves together: a service, or a chained pair. */
type Unit = readonly ServiceEntry[];

const PROBLEMS: ReadonlySet<ServiceHealth> = new Set(["error", "notKnown"]);

function unitsOf(entries: readonly ServiceEntry[]): Unit[] {
  const units: ServiceEntry[][] = [];
  for (const entry of entries) {
    const last = units[units.length - 1];
    if (entry.parentId !== undefined && last?.[0].model.id === entry.parentId) last.push(entry);
    else units.push([entry]);
  }
  return units;
}

const fieldsOf = ({ model, texts }: ServiceEntry): (string | undefined)[] => [
  model.name,
  model.description,
  model.what,
  model.technical,
  model.machine,
  model.address?.copy,
  ...texts,
];

/** Problems first, else the saved order; `held` keeps what is on screen. */
function ordered(units: readonly Unit[], held: readonly string[] | null | undefined): Unit[] {
  const isProblem = (unit: Unit) => unit.some(({ model }) => PROBLEMS.has(model.health));
  if (!held) {
    return [...units.filter(isProblem), ...units.filter((unit) => !isProblem(unit))];
  }
  const at = (unit: Unit) => {
    const index = held.indexOf(unit[0].model.id);
    return index < 0 ? held.length : index;
  };
  return [...units].sort((a, b) => at(a) - at(b));
}

/** The rows of one group's units, those of one offline agent under its line. */
function rowsOf(kind: ServiceKind, units: readonly Unit[]): ServiceRow[] {
  const byAgent = new Map<string, Unit[]>();
  for (const unit of units) {
    const agentId = offlineAgentOf(unit[0].model);
    if (agentId !== undefined) byAgent.set(agentId, [...(byAgent.get(agentId) ?? []), unit]);
  }
  const rows: ServiceRow[] = [];
  const done = new Set<string>();
  const push = (unit: Unit, underAgent: boolean) =>
    unit.forEach((entry, index) =>
      // A hop runs on this computer.
      rows.push({ type: "service", entry, underAgent: underAgent && index === 0 })
    );
  for (const unit of units) {
    const { model } = unit[0];
    const agentId = offlineAgentOf(model);
    const shared = agentId === undefined ? undefined : byAgent.get(agentId);
    if (agentId === undefined || shared === undefined || shared.length < 2) {
      push(unit, false);
    } else if (!done.has(agentId)) {
      done.add(agentId);
      const name = model.where.name ?? agentId;
      rows.push({ type: "agent", kind, agentId, name, services: shared.length });
      shared.forEach((one) => push(one, true));
    }
  }
  return rows;
}

/** The rows to show; none when nothing is left. */
export function serviceRows({
  entries,
  query,
  only,
  closed,
  held,
}: ServiceRowsInput): ServiceRow[] {
  const searching = query.trim() !== "";
  // A number that is gone shows all rows again.
  const filter = only !== null && entries.some((e) => e.model.health === only) ? only : null;
  return SERVICE_GROUPS.flatMap((kind): ServiceRow[] => {
    const own = entries.filter((entry) => entry.model.kind === kind);
    const units = unitsOf(own).filter(
      (unit) =>
        (filter === null || unit.some((entry) => entry.model.health === filter)) &&
        (!searching || unit.some((entry) => itemMatchesQuery(entry, fieldsOf, query.trim())))
    );
    if (units.length === 0) return [];
    // What was asked for is shown, also in a closed group.
    const open = searching || filter !== null || !closed.has(kind);
    const header: GroupRow = {
      type: "group",
      kind,
      open,
      running: own.filter((entry) => entry.model.health === "running").length,
      total: own.length,
    };
    return open ? [header, ...rowsOf(kind, ordered(units, held))] : [header];
  });
}

/** A key for React, and for the order on screen. */
export function serviceRowKey(row: ServiceRow): string {
  switch (row.type) {
    case "group":
      return `group ${row.kind}`;
    case "agent":
      return `agent ${row.kind} ${row.agentId}`;
    case "service":
      return row.entry.model.id;
  }
}
