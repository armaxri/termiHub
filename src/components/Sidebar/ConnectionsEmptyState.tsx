import { Network, Plus } from "lucide-react";
import { Button, EmptyState } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { useExperimentalFeatures } from "@/hooks/useExperimentalFeatures";

/**
 * Props for {@link ConnectionsEmptyState}.
 */
export interface ConnectionsEmptyStateProps {
  /** Opens the new-connection editor — wired to the same action as the toolbar button. */
  onNewConnection: () => void;
}

/**
 * First-run zero-state for the Connections panel (UX-001/UX-002/UX-004).
 *
 * A brand-new user lands on the Connections view with no saved connections; this
 * gives them a clear call-to-action to create their first connection instead of a
 * blank pane, plus a lightweight signpost to the experimental feature areas
 * (SSH Tunnels, Services, Network Tools, Workflows) that are hidden by default —
 * shown only while those features are still gated off.
 */
export function ConnectionsEmptyState({ onNewConnection }: ConnectionsEmptyStateProps) {
  const experimental = useExperimentalFeatures();
  const openSettingsTab = useAppStore((s) => s.openSettingsTab);

  const description = experimental ? (
    "Create your first connection to get started."
  ) : (
    <>
      Create your first connection to get started.
      <br />
      More features — SSH Tunnels, Services, Network Tools and Workflows — live behind{" "}
      <button
        type="button"
        className="connections-empty__link"
        onClick={() => openSettingsTab({ category: "general" })}
        data-testid="connections-empty-experimental-link"
      >
        Settings ▸ General ▸ Experimental Features
      </button>
      .
    </>
  );

  return (
    <EmptyState
      variant="card"
      role={null}
      icon={<Network size={28} strokeWidth={1.5} />}
      title="No connections yet"
      description={description}
      data-testid="connections-empty-state"
      action={
        <Button
          variant="primary"
          size="sm"
          icon={<Plus size={14} />}
          onClick={onNewConnection}
          data-testid="connections-empty-new-connection"
        >
          New Connection
        </Button>
      }
    />
  );
}
