import { Network, Plus } from "lucide-react";
import { Button, EmptyState } from "@/components/ui";

import { ICON_SIZE } from "@/components/ui/iconSize";
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
 * blank pane. It says nothing about experimental features: connections need no
 * switch (#5954).
 *
 * When the sidebar already shows other content (remote agents), the card
 * collapses to one line, so it stops dominating the column. That line carries
 * no link of its own: the header's "New ▾" menu sits right above it (#5848).
 */
export function ConnectionsEmptyState({
  onNewConnection,
  compact = false,
}: ConnectionsEmptyStateProps) {
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
      role={null}
      icon={<Network size={ICON_SIZE.md} aria-hidden />}
      title="No connections yet"
      description="Create your first connection to get started."
      data-testid="connections-empty-state"
      action={
        <Button
          variant="primary"
          size="sm"
          icon={<Plus size={ICON_SIZE.sm} />}
          onClick={onNewConnection}
          data-testid="connections-empty-new-connection"
        >
          New connection
        </Button>
      }
    />
  );
}
