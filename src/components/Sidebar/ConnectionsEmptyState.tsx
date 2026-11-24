import { Network, Plus } from "lucide-react";
import { Button, EmptyState } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { useExperimentalFeatures } from "@/hooks/useExperimentalFeatures";
import { EXPERIMENTAL_SETTING_PATH } from "@/utils/experimentalSetting";

/** The compact line, which points at the header's "New" menu (#5848). */
export const COMPACT_EMPTY_TEXT = "No saved connections. Add one with “New” above.";

/** The experimental signpost's sentence: what is still behind the switch (#5873). */
export const EXPERIMENTAL_HINT_TEXT = "Workflows are still experimental.";

/** The signpost's one action, which opens Settings ▸ General (#5873, R-098). */
export const EXPERIMENTAL_HINT_ACTION = "Turn on in Settings";

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
 * the experimental switch (workflows) — shown only while that switch is off. The
 * signpost is a short sentence and one small button that opens Settings ▸
 * General; the old inline "Settings ▸ General ▸ …" link wrapped into several
 * underlined fragments in a narrow sidebar (#5873, R-098). SSH
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
  const openSettingsTab = useAppStore((s) => s.openSettingsTab);

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
            // Secondary, smaller signpost: one sentence, then one action that
            // never splits across lines (#5873). The button's tooltip names the
            // toggle's full path, so the user knows where it leads.
            <div
              className="connections-empty__hint"
              data-testid="connections-empty-experimental-hint"
            >
              <p
                className="connections-empty__hint-text"
                data-testid="connections-empty-experimental-text"
              >
                {EXPERIMENTAL_HINT_TEXT}
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="connections-empty__hint-action"
                title={`Opens ${EXPERIMENTAL_SETTING_PATH}`}
                onClick={() => openSettingsTab({ category: "general" })}
                data-testid="connections-empty-experimental-action"
              >
                {EXPERIMENTAL_HINT_ACTION}
              </Button>
            </div>
          )}
        </>
      }
    />
  );
}
