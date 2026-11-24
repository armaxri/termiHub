import { Network, Plus } from "lucide-react";
import { Button, EmptyState } from "@/components/ui";
import { useExperimentalFeatures } from "@/hooks/useExperimentalFeatures";
import { ExperimentalSettingLink } from "@/components/Settings/ExperimentalSettingLink";

/** The compact line, which points at the header's "New" menu (#5848). */
export const COMPACT_EMPTY_TEXT = "No saved connections. Add one with “New” above.";

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
 * blank pane, plus a smaller secondary signpost to the feature areas still behind
 * the experimental switch (workflows) — shown only while that switch is off. SSH
 * tunnels, services and network tools graduated and are always shown (#5858).
 *
 * When the sidebar already shows other content (remote agents), the card
 * collapses to one line, so it stops dominating the column. That line carries
 * no link of its own: the header's "New ▾" menu sits right above it (#5848).
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
        // No second "New connection" here (#5848, R-096): the header's
        // "New ▾" menu right above is the one place to create from.
        title={COMPACT_EMPTY_TEXT}
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
              Workflows are behind{" "}
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
