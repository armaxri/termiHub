import { useState, useMemo, useId, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { Modal, SearchInput } from "@/components/ui";
import { useProjectedConnections } from "@/store/useProjectedConnections";
import { useProjectedAgents } from "@/store/useProjectedAgents";
import { WorkspaceTabDef } from "@/types/workspace";
import { itemMatchesQuery } from "@/hooks/useListFilter";
import { useComboboxListNav } from "@/hooks/useComboboxListNav";

interface ConnectionPickerProps {
  onSelect: (tab: WorkspaceTabDef) => void;
  onCancel: () => void;
}

/** One selectable option, in display order (the keyboard navigation order). */
interface PickerOption {
  /** Stable key, also the suffix of the option's DOM id. */
  key: string;
  /** The tab the option adds when chosen. */
  tab: WorkspaceTabDef;
}

/** Make a string safe to embed in a DOM id. */
function idPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * The workspace layout designer's "Add Connection" picker: an inline Local
 * Shell, saved connections (grouped by folder), and per-agent connection
 * definitions.
 *
 * Built on the shared {@link Modal} (A11Y2-005 / UISF2-001), which supplies the
 * dialog role and name, the focus trap, Escape-to-close and focus restore. The
 * search box is an ARIA combobox that drives a listbox through
 * `aria-activedescendant`: focus stays in the search box while ArrowUp/ArrowDown
 * move the active option and Enter picks it. The picker holds no unsaved input
 * beyond the query, so it is not dirty-tracked.
 */
export function ConnectionPicker({ onSelect, onCancel }: ConnectionPickerProps) {
  const { connections, folders } = useProjectedConnections();
  const { remoteAgents, agentDefinitions } = useProjectedAgents();
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const baseId = useId();

  const filtered = useMemo(() => {
    const term = search.trim();
    return connections.filter((c) => itemMatchesQuery(c, (x) => [x.name, x.config.type], term));
  }, [connections, search]);

  const grouped = useMemo(() => {
    const groups: Record<string, typeof filtered> = {};
    const ungrouped: typeof filtered = [];

    for (const conn of filtered) {
      if (conn.folderId) {
        const folder = folders.find((f) => f.id === conn.folderId);
        const folderName = folder?.name ?? "Unknown Folder";
        if (!groups[folderName]) groups[folderName] = [];
        groups[folderName].push(conn);
      } else {
        ungrouped.push(conn);
      }
    }

    return { groups, ungrouped };
  }, [filtered, folders]);

  const filteredAgents = useMemo(() => {
    const term = search.trim();
    if (!term) return remoteAgents;
    return remoteAgents.filter((a) => itemMatchesQuery(a, (x) => [x.name], term));
  }, [remoteAgents, search]);

  // Every selectable option in display order. The agent notices (offline / no
  // definitions) are disabled options and are skipped by keyboard navigation.
  const options = useMemo<PickerOption[]>(() => {
    const list: PickerOption[] = [
      { key: "inline", tab: { inlineConfig: { type: "local", config: {} }, title: "Local Shell" } },
    ];
    const addConnection = (conn: (typeof filtered)[number]) =>
      list.push({ key: `conn-${conn.id}`, tab: { connectionRef: conn.id, title: conn.name } });
    grouped.ungrouped.forEach(addConnection);
    Object.values(grouped.groups).forEach((conns) => conns.forEach(addConnection));
    for (const agent of filteredAgents) {
      if (agent.connectionState !== "connected") continue;
      for (const def of agentDefinitions[agent.id] ?? []) {
        list.push({
          key: `agent-${agent.id}-${def.id}`,
          tab: { agentRef: { agentId: agent.id, definitionId: def.id }, title: def.name },
        });
      }
    }
    return list;
  }, [grouped, filteredAgents, agentDefinitions]);

  const indexByKey = useMemo(() => new Map(options.map((o, i) => [o.key, i])), [options]);
  const nav = useComboboxListNav({
    items: options,
    onSelect: (option) => onSelect(option.tab),
    resetKey: search,
    listId: `${baseId}-listbox`,
    getItemKey: (option) => option.key,
  });

  /** Props for an enabled option row. */
  const optionProps = (key: string) => {
    const props = nav.getOptionProps(indexByKey.get(key) ?? -1);
    return {
      ...props,
      className: `connection-picker__item${props["aria-selected"] ? " connection-picker__item--active" : ""}`,
    };
  };

  const hasConnections = filtered.length > 0;
  const hasAgents = filteredAgents.length > 0;
  const groupLabelId = (name: string) => `${baseId}-group-${idPart(name)}`;

  return (
    <Modal
      open
      onOpenChange={(isOpen) => !isOpen && onCancel()}
      title="Add Connection"
      description="Search, then pick a connection to add as a tab to this panel"
      initialFocusRef={searchRef}
      data-testid="connection-picker"
    >
      <div className="connection-picker">
        <SearchInput
          className="connection-picker__search"
          value={search}
          onValueChange={setSearch}
          placeholder="Search connections…"
          clearLabel="Clear connection search"
          aria-label="Search connections"
          {...nav.inputProps}
          aria-expanded
          ref={searchRef}
          data-testid="connection-picker-search"
        />

        <div
          {...nav.listboxProps}
          className="connection-picker__list"
          aria-label="Connections"
          data-testid="connection-picker-list"
        >
          <div
            {...optionProps("inline")}
            className={`${optionProps("inline").className} connection-picker__item--inline`}
            data-testid="connection-picker-inline"
          >
            <span className="connection-picker__item-name">Local Shell</span>
            <span className="connection-picker__item-type">inline</span>
          </div>

          {grouped.ungrouped.map((conn) => (
            <div
              key={conn.id}
              {...optionProps(`conn-${conn.id}`)}
              data-testid={`connection-picker-item-${conn.id}`}
            >
              <span className="connection-picker__item-name">{conn.name}</span>
              <span className="connection-picker__item-type">{conn.config.type}</span>
            </div>
          ))}

          {Object.entries(grouped.groups).map(([folderName, conns]) => (
            <div
              key={folderName}
              className="connection-picker__group"
              role="group"
              aria-labelledby={groupLabelId(folderName)}
            >
              <div
                id={groupLabelId(folderName)}
                className="connection-picker__group-name"
                role="presentation"
              >
                {folderName}
              </div>
              {conns.map((conn) => (
                <div
                  key={conn.id}
                  {...optionProps(`conn-${conn.id}`)}
                  data-testid={`connection-picker-item-${conn.id}`}
                >
                  <span className="connection-picker__item-name">{conn.name}</span>
                  <span className="connection-picker__item-type">{conn.config.type}</span>
                </div>
              ))}
            </div>
          ))}

          {hasAgents && (
            <>
              <div className="connection-picker__group-name" role="presentation">
                Remote Agents
              </div>
              {filteredAgents.map((agent) => {
                const isConnected = agent.connectionState === "connected";
                const defs = agentDefinitions[agent.id] ?? [];

                if (!isConnected) {
                  return (
                    <div
                      key={agent.id}
                      role="group"
                      aria-label={`Remote agent ${agent.name}`}
                      className="connection-picker__agent-group"
                    >
                      <div
                        role="option"
                        aria-selected={false}
                        aria-disabled
                        className="connection-picker__agent-offline"
                        data-testid={`connection-picker-agent-offline-${agent.id}`}
                      >
                        <div className="connection-picker__agent-header">
                          <span className="connection-picker__item-name">{agent.name}</span>
                          <AlertTriangle
                            size={13}
                            className="connection-picker__agent-warning-icon"
                            aria-hidden="true"
                          />
                        </div>
                        <span className="connection-picker__agent-warning">
                          Agent not connected — available connections cannot be displayed
                        </span>
                      </div>
                    </div>
                  );
                }

                if (defs.length === 0) {
                  return (
                    <div
                      key={agent.id}
                      role="group"
                      aria-label={`Remote agent ${agent.name}`}
                      className="connection-picker__agent-group"
                    >
                      <div
                        role="option"
                        aria-selected={false}
                        aria-disabled
                        className="connection-picker__agent-offline"
                        data-testid={`connection-picker-agent-empty-${agent.id}`}
                      >
                        <span className="connection-picker__item-name">{agent.name}</span>
                        <span className="connection-picker__agent-warning">
                          No connection definitions configured on this agent
                        </span>
                      </div>
                    </div>
                  );
                }

                return (
                  <div
                    key={agent.id}
                    role="group"
                    aria-label={`Remote agent ${agent.name}`}
                    className="connection-picker__agent-group"
                  >
                    <div className="connection-picker__agent-name" role="presentation">
                      {agent.name}
                    </div>
                    {defs.map((def) => {
                      const props = optionProps(`agent-${agent.id}-${def.id}`);
                      return (
                        <div
                          key={def.id}
                          {...props}
                          className={`${props.className} connection-picker__item--agent`}
                          data-testid={`connection-picker-agent-def-${def.id}`}
                        >
                          <span className="connection-picker__item-name">{def.name}</span>
                          <span className="connection-picker__item-type">{def.sessionType}</span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </>
          )}
        </div>

        {!hasConnections && !hasAgents && (
          <p
            className="connection-picker__empty"
            role="status"
            data-testid="connection-picker-empty"
          >
            No connections match your search.
          </p>
        )}
        {!hasConnections && connections.length > 0 && hasAgents && (
          <p
            className="connection-picker__empty"
            role="status"
            data-testid="connection-picker-empty"
          >
            No saved connections match your search.
          </p>
        )}
      </div>
    </Modal>
  );
}
