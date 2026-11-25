import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { ChevronDown, ChevronRight, HardDrive, Plus } from "lucide-react";
import { MiddleEllipsis, ServiceCounts } from "@/components/ServiceListItem";
import { ConfirmDeleteDialog } from "@/components/Sidebar/ConfirmDeleteDialog";
import { SidebarToolbar } from "@/components/Sidebar/SidebarToolbar";
import { Button, ConfirmDialog, EmptyState, SearchInput } from "@/components/ui";
import type { ToolbarMenuEntry } from "@/components/ui";
import { useConnectAgent } from "@/hooks/useConnectAgent";
import { useFlatRovingNav } from "@/hooks/useFlatRovingNav";
import { useServiceContext } from "@/hooks/useServiceContext";
import { useServiceLifecycleConfirm } from "@/hooks/useServiceLifecycleConfirm";
import { t, tf } from "@/i18n/catalog";
import { useAppStore } from "@/store/appStore";
import { useProjectedAgents } from "@/store/useProjectedAgents";
import type { EmbeddedServerConfig } from "@/types/embeddedServer";
import type { TunnelConfig, TunnelState, TunnelStatus } from "@/types/tunnel";
import { isWideBind } from "@/utils/serviceAddress";
import {
  fileServerModel,
  serviceCounts,
  tunnelModel,
  type ServiceHealth,
  type ServiceKind,
} from "@/utils/serviceModel";
import {
  serviceRowKey,
  serviceRows,
  type AgentRow,
  type GroupRow,
  type ServiceEntry,
  type ServiceRow,
} from "@/utils/serviceRows";
import {
  combinedPairStatus,
  findCompanion,
  isCompanionRedundant,
  orderTunnelRows,
  type PairStatus,
} from "@/utils/tunnelChain";
import { EmbeddedServerDialog } from "./EmbeddedServerDialog";
import { EmbeddedServerItem } from "./EmbeddedServerItem";
import { newServiceGroups, type NewServiceEntry } from "./newServiceEntries";
import { useServicesView } from "./servicesView";
import { TunnelListItem } from "./TunnelListItem";
import { useFileServerActions } from "./useFileServerActions";
import { useTunnelActions } from "./useTunnelActions";
import "./ServicesSidebar.css";

const DISCONNECTED: TunnelStatus = "disconnected";

/** Whether a pair works here, as both of its rows tell it; none when unchained. */
function pairStatusOf(
  tunnel: TunnelConfig,
  parent: TunnelConfig | undefined,
  tunnels: TunnelConfig[],
  states: Record<string, TunnelState>
): PairStatus | undefined {
  const companion = parent ? tunnel : findCompanion(tunnels, tunnel.id);
  if (!companion) return undefined;
  return combinedPairStatus(
    states[(parent ?? tunnel).id]?.status ?? DISCONNECTED,
    states[companion.id]?.status ?? DISCONNECTED,
    true
  );
}

/**
 * The Services sidebar (#6028): every SSH tunnel and file server in one list, to
 * find, run, change and make one. It replaces the SSH tunnels and the file
 * servers' sidebar.
 *
 * Two groups in a fixed order; in each the rows that need a look come first, and
 * those of an offline agent stand under one line of it. While the pointer or the
 * focus is in the list, no row changes its place.
 */
export function ServicesSidebar() {
  const tunnels = useAppStore((s) => s.tunnels);
  const tunnelStates = useAppStore((s) => s.tunnelStates);
  const servers = useAppStore((s) => s.embeddedServers);
  const serverStates = useAppStore((s) => s.embeddedServerStates);
  const { remoteAgents: agents } = useProjectedAgents();
  const context = useServiceContext(
    servers.some((server) => isWideBind(server.bindHost)) ||
      tunnels.some(
        ({ tunnelType }) => tunnelType.type !== "remote" && isWideBind(tunnelType.config.localHost)
      )
  );
  const connectAgent = useConnectAgent();

  const entries = useMemo<ServiceEntry[]>(() => {
    const via = (id: string) => context.connections.find((c) => c.id === id)?.name;
    return [
      ...orderTunnelRows(tunnels).map(({ tunnel, parent }): ServiceEntry => {
        const status = pairStatusOf(tunnel, parent, tunnels, tunnelStates);
        return {
          model: tunnelModel(
            tunnel,
            tunnelStates[tunnel.id],
            context,
            status && { role: parent ? "hop" : "parent", status }
          ),
          parentId: parent?.id,
          texts: [tunnel.name, via(tunnel.sshConnectionId), ...portsOf(tunnel)],
        };
      }),
      ...servers.map(
        (server): ServiceEntry => ({
          model: fileServerModel(server, serverStates[server.id], context),
          texts: [server.rootDirectory, String(server.port)],
        })
      ),
    ];
  }, [tunnels, tunnelStates, servers, serverStates, context]);

  const modelOf = useCallback(
    (id: string) =>
      entries.find((entry) => entry.model.id === id)?.model ?? { name: t("service.unnamed") },
    [entries]
  );
  const lifecycle = useServiceLifecycleConfirm();
  const tunnelActions = useTunnelActions(modelOf, lifecycle.request);
  const serverActions = useFileServerActions(modelOf, lifecycle.request);

  // A new file server that was asked for elsewhere, e.g. in the command palette.
  const requested = useServicesView((s) => s.requested);
  const takeRequest = useServicesView((s) => s.takeRequest);
  const { create } = serverActions;
  useEffect(() => {
    if (!requested) return;
    takeRequest();
    create(requested.type);
  }, [requested, takeRequest, create]);

  const closed = useServicesView((s) => s.closed);
  const toggleGroup = useServicesView((s) => s.toggleGroup);
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<ServiceHealth | null>(null);

  const { held, holdProps, show: keepShown } = useHeldOrder();
  const rows = useMemo(
    () => serviceRows({ entries, query, only, closed, held }),
    [entries, query, only, closed, held]
  );
  useEffect(() => keepShown(rows.map(serviceRowKey)), [rows, keepShown]);

  const editService = useCallback(
    (kind: ServiceKind, id: string) =>
      kind === "tunnel" ? tunnelActions.edit(id) : serverActions.edit(id),
    [tunnelActions, serverActions]
  );
  const activate = useCallback(
    (row: ServiceRow) => {
      switch (row.type) {
        case "group":
          return toggleGroup(row.kind);
        case "agent":
          return void connectAgent(row.agentId);
        case "service":
          return editService(row.entry.model.kind, row.entry.model.id);
      }
    },
    [toggleGroup, connectAgent, editService]
  );
  const nav = useFlatRovingNav<ServiceRow, HTMLDivElement>(rows, rowLabel, activate);

  const groups = useMemo(() => newServiceGroups(), []);
  const menu = groups.flatMap(({ id, label, entries: items }): ToolbarMenuEntry[] => [
    { type: "label", id: `label-${id}`, label },
    ...items.map((entry) => ({
      id: entry.id,
      label: <NewEntryLabel entry={entry} />,
      icon: <entry.icon size={14} />,
      onSelect: entry.open,
      testId: `service-new-${entry.id}`,
    })),
  ]);

  const tunnelRow = (row: ServiceRow & { type: "service" }, props: RowProps) => {
    const tunnel = tunnels.find((item) => item.id === row.entry.model.id);
    if (!tunnel) return null;
    const parent = tunnels.find((item) => item.id === row.entry.parentId);
    const companion = parent ? undefined : findCompanion(tunnels, tunnel.id);
    return (
      <TunnelListItem
        tunnel={tunnel}
        state={tunnelStates[tunnel.id]}
        context={context}
        onStart={tunnelActions.start}
        onStop={tunnelActions.stop}
        onReconnect={tunnelActions.restart}
        onEdit={tunnelActions.edit}
        onDuplicate={tunnelActions.duplicate}
        onDelete={tunnelActions.remove}
        onUsePort={tunnelActions.usePort}
        nested={parent !== undefined}
        underAgent={row.underAgent}
        pairStatus={pairStatusOf(tunnel, parent, tunnels, tunnelStates)}
        companionRedundant={companion !== undefined && isCompanionRedundant(tunnel)}
        onRemoveCompanion={companion && (() => tunnelActions.remove(companion.id))}
        {...props}
      />
    );
  };

  const serverRow = (row: ServiceRow & { type: "service" }, props: RowProps) => {
    const server: EmbeddedServerConfig | undefined = servers.find(
      (item) => item.id === row.entry.model.id
    );
    if (!server) return null;
    return (
      <EmbeddedServerItem
        config={server}
        state={serverStates[server.id]}
        agents={agents}
        context={context}
        onStart={serverActions.start}
        onStop={serverActions.stop}
        onRestart={serverActions.restart}
        onEdit={serverActions.edit}
        onDuplicate={serverActions.duplicate}
        onDelete={serverActions.remove}
        onUsePort={serverActions.usePort}
        underAgent={row.underAgent}
        {...props}
      />
    );
  };

  return (
    <div className="services-sidebar" data-testid="services-sidebar">
      <SidebarToolbar
        aria-label={t("service.actions")}
        actions={[
          {
            id: "new",
            label: t("service.new"),
            icon: <Plus size={14} />,
            primary: true,
            testId: "service-new-btn",
            menu,
          },
        ]}
      />
      {entries.length === 0 ? (
        <EmptyState
          className="service-empty"
          title={t("service.empty.title")}
          description={t("service.empty.text")}
          action={<NewButtons groups={groups.map((group) => group)} />}
          data-testid="services-empty"
        />
      ) : (
        <>
          <div className="services-sidebar__search">
            <SearchInput
              value={query}
              onValueChange={setQuery}
              placeholder={t("service.search")}
              aria-label={t("service.search")}
              clearLabel={t("service.search.clear")}
              data-testid="services-search"
            />
          </div>
          <ServiceCounts
            counts={serviceCounts(entries.map((entry) => entry.model))}
            only={only}
            onOnly={setOnly}
            data-testid="services-counts"
          />
          {rows.length === 0 ? (
            <EmptyState
              className="service-empty"
              title={tf("service.search.none", { query: query.trim() })}
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setQuery("");
                    setOnly(null);
                  }}
                  data-testid="services-search-clear"
                >
                  {t("service.search.clear")}
                </Button>
              }
              data-testid="services-none"
            />
          ) : (
            <div
              className="services-sidebar__list"
              data-testid="services-list"
              role="tree"
              aria-label={t("service.list")}
              onKeyDown={nav.onKeyDown}
              {...holdProps}
            >
              {rows.map((row, index) => {
                const { ref, ...item } = nav.getItemProps(index);
                const key = serviceRowKey(row);
                switch (row.type) {
                  case "group":
                    return (
                      <GroupHeader
                        key={key}
                        row={row}
                        onToggle={() => toggleGroup(row.kind)}
                        rowRef={ref}
                        rowProps={item}
                      />
                    );
                  case "agent":
                    return (
                      <AgentHeader
                        key={key}
                        row={row}
                        onConnect={() => connectAgent(row.agentId)}
                        rowRef={ref}
                        rowProps={{ ...item, "aria-level": 2 }}
                      />
                    );
                  case "service": {
                    const level = row.underAgent || row.entry.parentId !== undefined ? 3 : 2;
                    const props = { rowRef: ref, rowProps: { ...item, "aria-level": level } };
                    return (
                      <div
                        key={key}
                        role="none"
                        className={row.underAgent ? "services-sidebar__under-agent" : undefined}
                      >
                        {row.entry.model.kind === "tunnel"
                          ? tunnelRow(row, props)
                          : serverRow(row, props)}
                      </div>
                    );
                  }
                }
              })}
            </div>
          )}
        </>
      )}

      <EmbeddedServerDialog {...serverActions.editDialogProps} agents={agents} />
      <ConfirmDialog
        {...lifecycle.dialogProps}
        variant="danger"
        confirmVariant="danger"
        testIdBase="confirm-service-lifecycle"
        data-testid="confirm-service-lifecycle-dialog"
      />
      <ConfirmDeleteDialog {...tunnelActions.deleteDialogProps} />
      <ConfirmDialog
        {...serverActions.deleteDialogProps}
        variant="danger"
        confirmVariant="danger"
        confirmLabel="Delete"
        data-testid="server-delete-confirm"
      />
    </div>
  );
}

interface RowProps {
  rowRef: (el: HTMLDivElement | null) => void;
  rowProps: React.HTMLAttributes<HTMLDivElement>;
}

/** The ports and hosts of a tunnel, for the search. */
function portsOf({ tunnelType }: TunnelConfig): string[] {
  const { config } = tunnelType;
  return Object.values(config).map(String);
}

const GROUP_LABEL = {
  tunnel: "service.group.tunnels",
  fileServer: "service.group.fileServers",
} as const;

function rowLabel(row: ServiceRow): string {
  switch (row.type) {
    case "group":
      return t(GROUP_LABEL[row.kind]);
    case "agent":
      return row.name;
    case "service":
      return row.entry.model.name;
  }
}

/**
 * The order on screen while the pointer or the focus is in the list, else none:
 * problems move to the top only when nobody is about to press a row.
 */
function useHeldOrder() {
  const shown = useRef<readonly string[]>([]);
  const [held, setHeld] = useState<readonly string[] | null>(null);
  const inside = useRef({ pointer: false, focus: false });
  const update = useCallback((part: Partial<typeof inside.current>) => {
    inside.current = { ...inside.current, ...part };
    const hold = inside.current.pointer || inside.current.focus;
    setHeld((now) => (hold ? (now ?? shown.current) : null));
  }, []);
  const show = useCallback((keys: readonly string[]) => {
    shown.current = keys;
  }, []);
  const holdProps = useMemo(
    () => ({
      onPointerEnter: () => update({ pointer: true }),
      onPointerLeave: () => update({ pointer: false }),
      onFocus: () => update({ focus: true }),
      onBlur: (e: React.FocusEvent<HTMLElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget)) update({ focus: false });
      },
    }),
    [update]
  );
  return { held, holdProps, show };
}

interface GroupHeaderProps extends RowProps {
  row: GroupRow;
  onToggle: () => void;
}

/** The line of a group: its name, how many of it run, and whether it is open. */
function GroupHeader({ row, onToggle, rowRef, rowProps }: GroupHeaderProps) {
  const Chevron = row.open ? ChevronDown : ChevronRight;
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const toggles =
      e.key === " " || (e.key === "ArrowLeft" && row.open) || (e.key === "ArrowRight" && !row.open);
    if (toggles && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) onToggle();
    }
  };
  return (
    <div
      ref={rowRef}
      {...rowProps}
      className="services-sidebar__group"
      aria-expanded={row.open}
      onClick={onToggle}
      onKeyDown={onKeyDown}
      data-testid={`service-group-${row.kind === "tunnel" ? "tunnels" : "file-servers"}`}
    >
      <Chevron size={14} aria-hidden="true" />
      <span className="services-sidebar__group-name">{t(GROUP_LABEL[row.kind])}</span>
      <span className="services-sidebar__group-count">
        {tf("service.counts.running", { running: String(row.running), total: String(row.total) })}
      </span>
    </div>
  );
}

interface AgentHeaderProps extends RowProps {
  row: AgentRow;
  onConnect: () => void | Promise<void>;
}

/** The line of an offline agent: what its services share, said once. */
function AgentHeader({ row, onConnect, rowRef, rowProps }: AgentHeaderProps) {
  return (
    <div
      ref={rowRef}
      {...rowProps}
      className="services-sidebar__agent"
      data-testid={`service-agent-${row.agentId}`}
    >
      <span className="services-sidebar__agent-name">
        <HardDrive size={12} aria-hidden="true" />
        <MiddleEllipsis text={row.name} />
      </span>
      <span className="services-sidebar__agent-text">
        {tf("service.agent.offline", { count: String(row.services) })}{" "}
        <button
          type="button"
          className="service-row__next"
          // The list takes Enter on the line, not on its button.
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            void onConnect();
          }}
          data-testid={`service-agent-connect-${row.agentId}`}
        >
          {t("service.next.connectAgent")}
        </button>
      </span>
    </div>
  );
}

/** "Reach something on a server" with the technical name under it. */
function NewEntryLabel({ entry }: { entry: NewServiceEntry }) {
  return (
    <span className="services-sidebar__new-entry">
      <span>{entry.label}</span>
      <span className="services-sidebar__technical">{entry.technical}</span>
    </span>
  );
}

/** The entries of the New menu as buttons, for a list without rows. */
function NewButtons({ groups }: { groups: ReturnType<typeof newServiceGroups> }) {
  return (
    <div className="services-sidebar__start">
      {groups.map((group) => (
        <div key={group.id} className="services-sidebar__start-group">
          <span className="services-sidebar__start-label">{group.label}</span>
          {group.entries.map((entry) => (
            <Button
              key={entry.id}
              variant="secondary"
              fullWidth
              className="services-sidebar__start-button"
              icon={<entry.icon size={14} />}
              onClick={entry.open}
              data-testid={`services-empty-${entry.id}`}
            >
              <NewEntryLabel entry={entry} />
            </Button>
          ))}
        </div>
      ))}
    </div>
  );
}
