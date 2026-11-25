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
import { compareNames } from "@/utils/locale";
import { itemMatchesQuery } from "@/hooks/useListFilter";

/** A service of the list; a chained hop (#2597) goes with its parent. */
export interface ServiceEntry {
  model: ServiceModel;
  /** Set on a hop: the tunnel it hangs on. */
  parentId?: string;
  /** What the search looks at besides the model. */
  texts: readonly (string | undefined)[];
}

/** What a group's line says: its services, whether or not they are shown. */
interface Group {
  /** Tells it from the others, and is what the user closes. */
  id: string;
  open: boolean;
  models: readonly ServiceModel[];
  /** How many of them are shown, when something was asked for. */
  shown?: number;
}

export interface GroupRow extends Group {
  type: "group";
  kind: ServiceKind;
}

/** The line of an agent that is offline and has several services. */
export interface AgentRow extends Group {
  type: "agent";
  agentId: string;
  name: string;
}

export interface EntryRow {
  type: "service";
  entry: ServiceEntry;
  underAgent: boolean;
}

export type ServiceRow = GroupRow | AgentRow | EntryRow;

export interface ServiceRowsInput {
  /** A hop right after its parent. */
  entries: readonly ServiceEntry[];
  query: string;
  only: ServiceHealth | null;
  /** The groups the user closed, by id. */
  closed: ReadonlySet<string>;
  /**
   * The order on screen, by row key, while the pointer or the focus is in the
   * list: a row must not move away from under it.
   */
  held?: readonly string[] | null;
}

/** The groups, in the order they always have. */
export const SERVICE_GROUPS: readonly ServiceKind[] = ["tunnel", "fileServer"];

/** What stands and moves together: a service, or a chained pair. */
type Unit = readonly ServiceEntry[];

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
  model.stateLabel,
  model.address?.copy,
  ...texts,
];

/** Whether the user is needed, or cannot tell whether: these come first. */
function needsLook({ health, nextSteps }: ServiceModel): boolean {
  return (
    health === "error" || health === "notKnown" || (health === "waiting" && nextSteps.length > 0)
  );
}

/** What needs a look first, each part by name; `held` keeps what is on screen. */
function ordered(units: readonly Unit[], held: readonly string[] | null | undefined): Unit[] {
  if (held) {
    const at = (unit: Unit) => {
      const index = held.indexOf(unit[0].model.id);
      return index < 0 ? held.length : index;
    };
    return [...units].sort((a, b) => at(a) - at(b));
  }
  const rank = (unit: Unit) => (unit.some(({ model }) => needsLook(model)) ? 0 : 1);
  return [...units].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      SERVICE_GROUPS.indexOf(a[0].model.kind) - SERVICE_GROUPS.indexOf(b[0].model.kind) ||
      compareNames(a[0].model.name, b[0].model.name)
  );
}

/** The filter that applies: a number that is gone shows all rows again. */
export function activeFilter(
  entries: readonly ServiceEntry[],
  only: ServiceHealth | null
): Exclude<ServiceHealth, "quiet"> | null {
  if (only === "quiet") return null;
  return entries.some(({ model }) => model.health === only) ? only : null;
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
  const filter = activeFilter(entries, only);
  const asked = searching || filter !== null;
  const matches = (unit: Unit) =>
    (filter === null || unit.some((entry) => entry.model.health === filter)) &&
    (!searching || unit.some((entry) => itemMatchesQuery(entry, fieldsOf, query.trim())));

  const units = unitsOf(entries);
  const byAgent = new Map<string, Unit[]>();
  for (const unit of units) {
    const agentId = offlineAgentOf(unit[0].model);
    if (agentId !== undefined) byAgent.set(agentId, [...(byAgent.get(agentId) ?? []), unit]);
  }
  for (const [agentId, own] of byAgent) if (own.length < 2) byAgent.delete(agentId);

  /** What the line of a group and its rows need; none when it shows nothing. */
  const group = (id: string, own: readonly Unit[]): { line: Group; shown: Unit[] } | undefined => {
    const shown = own.filter(matches);
    if (shown.length === 0) return undefined;
    const models = own.flat().map((entry) => entry.model);
    const line: Group = {
      id,
      // What was asked for is shown, also in a closed group.
      open: asked || !closed.has(id),
      models,
      ...(asked ? { shown: shown.flat().length } : {}),
    };
    return { line, shown: line.open ? ordered(shown, held) : [] };
  };
  const rowsOf = (shown: readonly Unit[], underAgent: boolean): EntryRow[] =>
    shown.flatMap((unit) =>
      unit.map((entry, index) => ({
        type: "service" as const,
        entry,
        // A hop runs on this computer.
        underAgent: underAgent && index === 0,
      }))
    );

  // An offline agent is said once, with all that is on it, whatever it is.
  const agents = [...byAgent].flatMap(([agentId, own]): ServiceRow[] => {
    const found = group(`agent ${agentId}`, own);
    if (!found) return [];
    const name = own[0][0].model.where.name ?? agentId;
    return [{ type: "agent", agentId, name, ...found.line }, ...rowsOf(found.shown, true)];
  });
  const kinds = SERVICE_GROUPS.flatMap((kind): ServiceRow[] => {
    const own = units.filter(
      (unit) => unit[0].model.kind === kind && !byAgent.has(offlineAgentOf(unit[0].model) ?? "")
    );
    const found = group(kind, own);
    return found ? [{ type: "group", kind, ...found.line }, ...rowsOf(found.shown, false)] : [];
  });
  return [...agents, ...kinds];
}

/** A key for React, and for the order on screen. */
export function serviceRowKey(row: ServiceRow): string {
  return row.type === "service" ? row.entry.model.id : `group ${row.id}`;
}
