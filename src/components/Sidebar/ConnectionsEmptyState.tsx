import { Network, Plus } from "lucide-react";
import { Button, EmptyState } from "@/components/ui";
import { useExperimentalFeatures } from "@/hooks/useExperimentalFeatures";
import { ExperimentalSettingLink } from "@/components/Settings/ExperimentalSettingLink";

/**
 * Props for {@link ConnectionsEmptyState}.
 */
export interface ConnectionsEmptyStateProps {
  /** Opens the new-connection editor — wired to the same action as the toolbar button. */
  onNewConnection: () => void;
  /**
   * Render a single compact line instead of the first-run card. Set while
   * another sidebar group (Remote agents) has content, so the card does not
   * push that group half-way down the sidebar (R-077 / R-122, #5702).
   */
  compact?: boolean;
}

/**
 * First-run zero-state for the Connections panel (UX-001/UX-002/UX-004).
 *
 * A brand-new user lands on the Connections view with no saved connections; this
 * gives them a clear call-to-action to create their first connection instead of a
 * blank pane, plus a smaller secondary signpost to the experimental feature areas
 * (SSH tunnels, services, network tools, workflows) that are hidden by default —
 * shown only while those features are still gated off.
 *
 * When the sidebar already shows other content (remote agents), the card
 * collapses to one line with a link, so it stops dominating the column.
 */
export function ConnectionsEmptyState({
  onNewConnection,
  compact = false,
}: ConnectionsEmptyStateProps) {
  const experimental = useExperimentalFeatures();

  if (compact) {
    return (
      <EmptyState
        role={null}
        className="connections-empty--compact"
        data-testid="connections-empty-state"
        title={
          <>
            No saved connections.{" "}
            <button
              type="button"
              className="connections-empty__link"
              onClick={onNewConnection}
              data-testid="connections-empty-new-connection"
            >
              New connection
            </button>
          </>
        }
      />
    );
  }

  return (
    <EmptyState
      variant="card"
      role={null}
      icon={<Network size={28} strokeWidth={1.5} />}
      title="No connections yet"
      description="Create your first connection to get started."
      data-testid="connections-empty-state"
      action={
        <>
          <Button
            variant="primary"
            size="sm"
            icon={<Plus size={14} />}
            onClick={onNewConnection}
            data-testid="connections-empty-new-connection"
          >
            New connection
          </Button>
          {!experimental && (
            // Secondary, smaller signpost. It ends on the link with no trailing
            // period: a lone "." wrapped onto its own line in a narrow sidebar (#5621).
            <p
              className="connections-empty__hint"
              data-testid="connections-empty-experimental-hint"
            >
              SSH tunnels, services, network tools and workflows are behind{" "}
              <ExperimentalSettingLink
                className="connections-empty__link"
                data-testid="connections-empty-experimental-link"
              />
            </p>
          )}
        </>
      }
    />
  );
}
